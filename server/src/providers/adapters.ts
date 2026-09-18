// 직접 연결 어댑터 — OpenAI Responses(codex OAuth) / Gemini Code Assist(OAuth) / 로컬 CLI 브릿지
// 각각 MyBot의 chatOnce/streamChat 인터페이스로 변환
import { spawn } from "node:child_process";
import type { Endpoint } from "./index";
import { CLI_PATH_PREFIX, refreshCodexAuth, refreshGeminiAuth } from "./registry";
import type { ChatResult, ToolCall, StreamEvent } from "./openaiCompat";

// 호출별 상한 — 외부 signal이 있어도 개별 호출은 이 상한 안에서 끝나야 한다.
// signal만 넘기면 무응답 프로바이더에 상위 상한(최대 9분)까지 멈춰 보이는 사고가 있었다.
export function callSignal(signal: AbortSignal | undefined, ms = 180_000): AbortSignal {
  const cap = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, cap]) : cap;
}

// ─── 메시지 변환 유틸 (MyBot은 OpenAI chat 형식) ───
type Msg = { role: string; content?: any; tool_calls?: any[]; tool_call_id?: string };

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p.type === "text" ? p.text : "")).join("");
  return "";
}

// ─── OpenAI Responses API (ChatGPT 구독 — codex 백엔드) ───
function toResponsesInput(msgs: Msg[]): { instructions?: string; input: any[] } {
  const instructions: string[] = [];
  const input: any[] = [];
  for (const m of msgs) {
    if (m.role === "system" || m.role === "developer") { instructions.push(textOf(m.content)); continue; }
    if (m.role === "tool") {
      input.push({ type: "function_call_output", call_id: m.tool_call_id, output: textOf(m.content) });
      continue;
    }
    const isAsst = m.role === "assistant";
    const content: any[] = [];
    if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === "text") content.push({ type: isAsst ? "output_text" : "input_text", text: p.text });
        else if (p.type === "image_url" && !isAsst) content.push({ type: "input_image", image_url: p.image_url?.url });
      }
    } else if (m.content) {
      content.push({ type: isAsst ? "output_text" : "input_text", text: m.content });
    }
    if (content.length) input.push({ type: "message", role: m.role, content });
    for (const tc of m.tool_calls ?? []) {
      input.push({ type: "function_call", call_id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments ?? "{}" });
    }
  }
  return { instructions: instructions.filter(Boolean).join("\n\n") || undefined, input };
}

function responsesBody(endpoint: Endpoint, model: string, messages: Msg[], tools: any[], stream: boolean, toolChoice?: string | object, reasoningEffort?: string): any {
  const { instructions, input } = toResponsesInput(messages);
  const body: any = { model, instructions, input, stream: true, store: false }; // codex 백엔드는 stream 필수
  if (reasoningEffort) body.reasoning = { effort: reasoningEffort };
  void stream;
  if (tools?.length) {
    body.tools = tools.map((t) => ({ type: "function", name: t.function.name, description: t.function.description, parameters: t.function.parameters ?? { type: "object" } }));
    // codex 백엔드는 tool_choice "auto" 문자열을 거부 — 미지정(기본 auto)으로 두거나, 강제 시 {type:"function", name}
    if (toolChoice && typeof toolChoice === "object") {
      const fn = (toolChoice as any).function?.name ?? (toolChoice as any).name;
      if (fn) body.tool_choice = { type: "function", name: fn };
    }
  }
  return body;
}

function responsesHeaders(endpoint: Endpoint): Record<string, string> {
  return {
    "content-type": "application/json",
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
    ...(endpoint.accessToken ? { authorization: `Bearer ${endpoint.accessToken}` } : {}),
    ...(endpoint.accountId ? { "chatgpt-account-id": endpoint.accountId } : {}),
  };
}

function fromResponses(j: any): ChatResult {
  const parts: { text: string[]; calls: ToolCall[]; reasoning: string[] } = { text: [], calls: [], reasoning: [] };
  for (const item of j.output ?? []) {
    if (item.type === "reasoning") {
      const t = (item.summary ?? []).map((s: any) => s.text ?? "").join("\n");
      if (t) parts.reasoning.push(t);
    } else if (item.type === "function_call") {
      parts.calls.push({ id: item.call_id ?? item.id, name: item.name, arguments: item.arguments ?? "{}" });
    } else if (item.type === "message") {
      const t = (item.content ?? []).filter((c: any) => c.type === "output_text").map((c: any) => c.text).join("");
      if (t) parts.text.push(t);
    }
  }
  const content = parts.text.join("\n");
  const reasoning = parts.reasoning.join("\n\n");
  return { content: reasoning ? `<think>${reasoning}</think>\n\n${content}` : content, toolCalls: parts.calls.length ? parts.calls : undefined };
}

export async function responsesChatOnce(endpoint: Endpoint, model: string, messages: Msg[], opts: { signal?: AbortSignal; tools?: any[]; toolChoice?: string | object; reasoningEffort?: string } = {}): Promise<ChatResult> {
  const base = (endpoint.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  let lastErr: Error | null = null;
  let effort: string | undefined = opts.reasoningEffort;
  let refreshed = false; // 401 token_expired → OAuth 갱신 후 재시도는 한 번
  for (let attempt = 0; attempt < 3; attempt++) {
    if (opts.signal?.aborted) break;
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
    let res: Response;
    try {
      res = await fetch(`${base}/responses`, {
        method: "POST", headers: responsesHeaders(endpoint),
        body: JSON.stringify(responsesBody(endpoint, model, messages, opts.tools ?? [], true, opts.toolChoice, effort)),
        signal: callSignal(opts.signal),
      });
    } catch (e) {
      if ((e as Error).name === "AbortError" || opts.signal?.aborted) throw e;
      lastErr = e as Error; continue;
    }
    if (!res.ok) {
      const txt = (await res.text()).slice(0, 300);
      const err = new Error(`오류 ${res.status}: ${txt}`);
      // reasoning effort 미지원 → 파라미터를 빼고 재시도 (한 번)
      if (res.status === 400 && effort && /reasoning|effort/i.test(txt)) { effort = undefined; continue; }
      // 구독 OAuth 토큰 만료 — refresh_token으로 갱신한 뒤 같은 요청을 재시도한다
      if (res.status === 401 && /token_expired|unauthorized|invalid.*token/i.test(txt) && !refreshed) {
        refreshed = true;
        const fresh = await refreshCodexAuth();
        if (fresh) { endpoint.accessToken = fresh; continue; }
      }
      if (res.status >= 500 || res.status === 429) { lastErr = err; continue; }
      throw err;
    }
    // stream:true라 SSE로 돌아옴 — 완성 이벤트를 수집해 단일 결과로 조립
    const body = await res.text();
    const events = body.split("\n").filter((l) => l.startsWith("data:")).map((l) => {
      try { return JSON.parse(l.slice(5).trim()); } catch { return null; }
    }).filter(Boolean);
    const completed = events.find((e: any) => e.type === "response.completed" || e.response?.status === "completed");
    // codex 백엔드는 completed.response.output이 비어 오는 경우가 있다 — output_item.done에서 수집
    const items = events.filter((e: any) => e.type === "response.output_item.done" && e.item).map((e: any) => e.item);
    const output = items.length ? items : completed?.response?.output;
    if (output?.length) return fromResponses({ output });
    // SSE가 아니면 완성 JSON으로 파싱 시도
    try { return fromResponses(JSON.parse(body)); } catch {}
    return { content: "" };
  }
  throw lastErr ?? new Error(opts.signal?.aborted ? "작업 중단 — 중지 요청 또는 시간 초과" : "responses 호출 실패");
}

export async function* responsesStream(endpoint: Endpoint, model: string, messages: Msg[], opts: { signal?: AbortSignal; tools?: any[]; reasoningEffort?: string } = {}): AsyncGenerator<StreamEvent> {
  const base = (endpoint.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  // reasoning effort 미지원 시 400 — 파라미터를 빼고 한 번 재시도
  let effort: string | undefined = opts.reasoningEffort;
  const doFetch = () => fetch(`${base}/responses`, {
    method: "POST", headers: responsesHeaders(endpoint),
    body: JSON.stringify(responsesBody(endpoint, model, messages, opts.tools ?? [], true, undefined, effort)),
    signal: callSignal(opts.signal, 300_000),
  });
  let res = await doFetch();
  if (!res.ok && res.status === 400 && effort && /reasoning|effort/i.test(await res.text().catch(() => ""))) {
    effort = undefined;
    res = await doFetch();
  }
  // 구독 OAuth 토큰 만료(401) — refresh_token으로 갱신 후 한 번 재시도
  let errBody = "";
  if (!res.ok && res.status === 401 && /token_expired|unauthorized|invalid.*token/i.test((errBody = await res.text().catch(() => "")))) {
    const fresh = await refreshCodexAuth();
    if (fresh) { endpoint.accessToken = fresh; res = await doFetch(); errBody = ""; }
  }
  if (!res.ok || !res.body) {
    const body = errBody || await res.text().catch(() => "");
    yield { type: "error", error: `${endpoint.name} ${res.status}: ${body.slice(0, 300)}` };
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", event = "", returnedModel: string | undefined;
  const pendingCalls = new Map<number, ToolCall>();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.startsWith("event:")) { event = line.slice(6).trim(); continue; }
        if (!line.startsWith("data:")) continue;
        let j: any;
        try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
        const t = event || j.type;
        event = "";
        if (j.model) returnedModel = j.model;
        switch (t) {
          case "response.output_text.delta": yield { type: "content", text: j.delta ?? "" }; break;
          case "response.reasoning_summary_text.delta":
          case "response.reasoning_text.delta": yield { type: "reasoning", text: j.delta ?? "" }; break;
          case "response.output_item.added":
            if (j.item?.type === "function_call") {
              const tc: ToolCall = { id: j.item.call_id ?? j.item.id, name: j.item.name ?? "", arguments: "" };
              pendingCalls.set(j.output_index ?? pendingCalls.size, tc);
            }
            break;
          case "response.function_call_arguments.delta": {
            const tc = pendingCalls.get(j.output_index ?? 0) ?? [...pendingCalls.values()].at(-1);
            if (tc) tc.arguments += j.delta ?? "";
            break;
          }
          case "response.completed": {
            const u = j.response?.usage;
            if (u) yield { type: "usage", usage: { prompt_tokens: u.input_tokens, completion_tokens: u.output_tokens } };
            if (j.response?.model) returnedModel = j.response.model;
            // 스트림으로 온 function_call도 usage 이벤트 후 확정 — 호출 지시는 content로 되돌려줘야 하므로 완성 output에서도 수집
            for (const item of j.response?.output ?? []) {
              if (item.type === "function_call") {
                yield { type: "content", text: `\n[도구 호출: ${item.name}]` }; // 스트림 경로는 텍스트 표시 — 실제 실행은 chatOnce 경로
              }
            }
            yield { type: "done", model: returnedModel };
            return;
          }
          case "response.failed":
          case "error": {
            yield { type: "error", error: j.response?.error?.message ?? j.message ?? "responses stream error" };
            return;
          }
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  yield { type: "done", model: returnedModel };
}

// ─── Gemini Code Assist (Google 구독 — gemini-cli OAuth) ───
function toGeminiContents(msgs: Msg[]): { system?: any; contents: any[] } {
  const systemParts: any[] = [];
  const contents: any[] = [];
  for (const m of msgs) {
    if (m.role === "system" || m.role === "developer") { systemParts.push({ text: textOf(m.content) }); continue; }
    const role = m.role === "assistant" ? "model" : "user";
    const parts: any[] = [];
    if (m.role === "tool") {
      parts.push({ functionResponse: { name: (m as any).name ?? "tool", response: { result: textOf(m.content) } } });
    } else {
      if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === "text") parts.push({ text: p.text });
          else if (p.type === "image_url" && p.image_url?.url?.startsWith("data:")) {
            const [, mime, b64] = p.image_url.url.match(/^data:([^;]+);base64,(.*)$/) ?? [];
            if (b64) parts.push({ inlineData: { mimeType: mime ?? "image/png", data: b64 } });
          }
        }
      } else if (m.content) parts.push({ text: m.content });
      for (const tc of m.tool_calls ?? []) {
        let args: any = {};
        try { args = JSON.parse(tc.function?.arguments || "{}"); } catch {}
        parts.push({ functionCall: { name: tc.function?.name, args } });
      }
    }
    if (parts.length) contents.push({ role, parts });
  }
  return { system: systemParts.length ? { parts: systemParts } : undefined, contents };
}

function geminiBody(endpoint: Endpoint, model: string, messages: Msg[], tools: any[]): any {
  const { system, contents } = toGeminiContents(messages);
  const inner: any = { contents, generationConfig: {} };
  if (system) inner.systemInstruction = system;
  if (tools?.length) inner.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters ?? { type: "object" } })) }];
  // Code Assist v1internal은 봉투 형식
  return { model, request: inner };
}

function geminiHeaders(endpoint: Endpoint): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(endpoint.apiKey ? { "x-goog-api-key": endpoint.apiKey } : {}),
    ...(endpoint.accessToken ? { authorization: `Bearer ${endpoint.accessToken}` } : {}),
  };
}

function geminiUrl(endpoint: Endpoint, model: string, stream: boolean): string {
  const base = (endpoint.baseUrl ?? "https://cloudcode-pa.googleapis.com").replace(/\/$/, "");
  if (base.includes("cloudcode-pa")) return `${base}/v1internal:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
  const act = stream ? "streamGenerateContent" : "generateContent";
  return `${base}/v1beta/models/${encodeURIComponent(model)}:${act}${stream ? "?alt=sse" : ""}`;
}

function fromGemini(j: any): ChatResult {
  const r = j?.response ?? j;
  const cand = r.candidates?.[0];
  const calls: ToolCall[] = [];
  const text: string[] = [];
  const reasoning: string[] = [];
  for (const p of cand?.content?.parts ?? []) {
    if (p.thought) reasoning.push(p.text ?? "");
    else if (p.text !== undefined) text.push(p.text);
    else if (p.functionCall) calls.push({ id: `call_${Date.now()}_${calls.length}`, name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) });
  }
  const content = text.join("");
  return { content: reasoning.length ? `<think>${reasoning.join("\n")}</think>\n\n${content}` : content, toolCalls: calls.length ? calls : undefined };
}

export async function geminiChatOnce(endpoint: Endpoint, model: string, messages: Msg[], opts: { signal?: AbortSignal; tools?: any[] } = {}): Promise<ChatResult> {
  let lastErr: Error | null = null;
  let refreshed = false; // 401 → OAuth 갱신 후 재시도는 한 번
  for (let attempt = 0; attempt < 3; attempt++) {
    if (opts.signal?.aborted) break;
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
    let res: Response;
    try {
      res = await fetch(geminiUrl(endpoint, model, false), {
        method: "POST", headers: geminiHeaders(endpoint),
        body: JSON.stringify(geminiBody(endpoint, model, messages, opts.tools ?? [])),
        signal: callSignal(opts.signal),
      });
    } catch (e) {
      if ((e as Error).name === "AbortError" || opts.signal?.aborted) throw e;
      lastErr = e as Error; continue;
    }
    if (!res.ok) {
      const txt = (await res.text()).slice(0, 300);
      const err = new Error(`오류 ${res.status}: ${txt}`);
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        const fresh = await refreshGeminiAuth();
        if (fresh) { endpoint.accessToken = fresh; continue; }
      }
      if (res.status >= 500 || res.status === 429) { lastErr = err; continue; }
      throw err;
    }
    return fromGemini(await res.json());
  }
  throw lastErr ?? new Error(opts.signal?.aborted ? "작업 중단 — 중지 요청 또는 시간 초과" : "gemini 호출 실패");
}

export async function* geminiStream(endpoint: Endpoint, model: string, messages: Msg[], opts: { signal?: AbortSignal; tools?: any[] } = {}): AsyncGenerator<StreamEvent> {
  let res = await fetch(geminiUrl(endpoint, model, true), {
    method: "POST", headers: geminiHeaders(endpoint),
    body: JSON.stringify(geminiBody(endpoint, model, messages, opts.tools ?? [])),
    signal: callSignal(opts.signal, 300_000),
  });
  // 구독 OAuth 토큰 만료(401) — refresh_token으로 갱신 후 한 번 재시도
  if (!res.ok && res.status === 401) {
    const fresh = await refreshGeminiAuth();
    if (fresh) {
      endpoint.accessToken = fresh;
      res = await fetch(geminiUrl(endpoint, model, true), {
        method: "POST", headers: geminiHeaders(endpoint),
        body: JSON.stringify(geminiBody(endpoint, model, messages, opts.tools ?? [])),
        signal: callSignal(opts.signal, 300_000),
      });
    }
  }
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    yield { type: "error", error: `${endpoint.name} ${res.status}: ${body.slice(0, 300)}` };
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        let j: any;
        try { j = JSON.parse(line.slice(5).trim()); j = j?.response ?? j; } catch { continue; }
        const cand = j.candidates?.[0];
        for (const p of cand?.content?.parts ?? []) {
          if (p.thought) yield { type: "reasoning", text: p.text ?? "" };
          else if (p.text !== undefined) yield { type: "content", text: p.text };
          else if (p.functionCall) yield { type: "content", text: `\n[도구 호출: ${p.functionCall.name}]` };
        }
        const u = j.usageMetadata;
        if (u) yield { type: "usage", usage: { prompt_tokens: u.promptTokenCount, completion_tokens: u.candidatesTokenCount } };
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  yield { type: "done", model };
}

// ─── CLI 브릿지 (grok / cursor-agent 등 — 로그인은 CLI 자체 자격증명 재사용) ───
// 도구 호출 미지원 — 대화를 단일 프롬프트로 평탄화해 headless 모드로 실행
function toCliPrompt(msgs: Msg[]): string {
  const lines: string[] = [];
  for (const m of msgs) {
    const t = textOf(m.content);
    if (!t) continue;
    if (m.role === "system") lines.push(`<system>\n${t}\n</system>`);
    else if (m.role === "assistant") lines.push(`<assistant>\n${t}\n</assistant>`);
    else if (m.role === "tool") lines.push(`<tool_result>\n${t}\n</tool_result>`);
    else lines.push(t);
  }
  return lines.join("\n\n");
}

function cliArgv(endpoint: Endpoint, model: string, prompt: string): string[] {
  const tpl = endpoint.args ?? ["--print", "--model", "{model}", "--", "{prompt}"];
  return tpl.map((a) => a.replaceAll("{model}", model).replaceAll("{prompt}", prompt));
}

export async function cliChatOnce(endpoint: Endpoint, model: string, messages: Msg[], opts: { signal?: AbortSignal } = {}): Promise<ChatResult> {
  const prompt = toCliPrompt(messages);
  const args = cliArgv(endpoint, model, prompt);
  const out = await new Promise<string>((resolve, reject) => {
    const proc = spawn(endpoint.cmd!, args, { env: { ...process.env, PATH: `${CLI_PATH_PREFIX}:${process.env.PATH ?? ""}` }, signal: opts.signal });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { proc.kill("SIGTERM"); reject(new Error(`${endpoint.cmd} 시간 초과`)); }, 300_000);
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (e) => { clearTimeout(timer); reject(new Error(`${endpoint.cmd} 실행 실패: ${e.message}`)); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${endpoint.cmd} 종료 코드 ${code}: ${stderr.slice(0, 300)}`));
    });
  });
  return { content: out };
}

export async function* cliStream(endpoint: Endpoint, model: string, messages: Msg[], opts: { signal?: AbortSignal } = {}): AsyncGenerator<StreamEvent> {
  const prompt = toCliPrompt(messages);
  const args = cliArgv(endpoint, model, prompt);
  const proc = spawn(endpoint.cmd!, args, { env: { ...process.env, PATH: `${CLI_PATH_PREFIX}:${process.env.PATH ?? ""}` }, signal: opts.signal });
  const queue: string[] = [];
  let stderr = "";
  let finished = false, exitCode: number | null = null;
  const timer = setTimeout(() => { proc.kill("SIGTERM"); }, 300_000);
  proc.stdout.on("data", (d) => queue.push(d.toString()));
  proc.stderr.on("data", (d) => { stderr += d.toString(); });
  proc.on("error", (e) => { stderr = e.message; exitCode = exitCode ?? -1; finished = true; });
  proc.on("close", (code) => { exitCode = code; finished = true; });
  try {
    while (!finished || queue.length) {
      if (queue.length) yield { type: "content", text: queue.shift()! };
      else await new Promise((r) => setTimeout(r, 60));
    }
  } finally {
    clearTimeout(timer);
    if (!finished) proc.kill("SIGTERM");
  }
  if (exitCode !== 0) yield { type: "error", error: `${endpoint.cmd} 종료 코드 ${exitCode}: ${stderr.slice(0, 300)}` };
  yield { type: "done", model };
}
