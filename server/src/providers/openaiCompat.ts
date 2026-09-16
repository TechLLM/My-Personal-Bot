import type { Endpoint } from "./index";
import { responsesChatOnce, responsesStream, geminiChatOnce, geminiStream, cliChatOnce, cliStream } from "./adapters";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | { type: string; text?: string; image_url?: { url: string } }[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatResult {
  content: string;
  toolCalls?: ToolCall[];
}

// 비스트리밍 호출 (도구 루프·내부용)
// HTTP 오류는 content로 위장하지 않고 throw — 네트워크/5xx/429는 1회 재시도 (사용자 abort 제외)
export async function chatOnce(
  endpoint: Endpoint,
  model: string,
  messages: any[],
  opts: { signal?: AbortSignal; tools?: { type: string; function: { name: string; description?: string; parameters?: object } }[]; toolChoice?: string | object } = {},
): Promise<ChatResult> {
  // kind별 어댑터 디스패치 — responses(codex OAuth) / gemini(OAuth) / cli(로컬 브릿지)
  switch (endpoint.kind) {
    case "responses": return responsesChatOnce(endpoint, model, messages, { signal: opts.signal, tools: opts.tools, toolChoice: opts.toolChoice });
    case "gemini": return geminiChatOnce(endpoint, model, messages, { signal: opts.signal, tools: opts.tools });
    case "cli": return cliChatOnce(endpoint, model, messages, { signal: opts.signal });
  }
  // tool_choice 객체 형식은 프록시마다 다름 — airoute는 Responses식 평탄 형식만 받아 nested 형식을 400으로 거부.
  // 거부되면 tool_choice 없이 재시도 (호출 지시는 프롬프트·서버 폴백이 커버)
  let toolChoice: unknown = opts.toolChoice ?? "auto";
  const makeBody = () => JSON.stringify({ model, messages, stream: false, ...(opts.tools?.length ? { tools: opts.tools, tool_choice: toolChoice } : {}) });
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (opts.signal?.aborted) break;
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
    let res: Response;
    try {
      res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
        },
        body: makeBody(),
        signal: opts.signal ?? AbortSignal.timeout(120000),
      });
    } catch (e) {
      if ((e as Error).name === "AbortError" || opts.signal?.aborted) throw e;
      lastErr = e as Error; // 네트워크 오류 → 재시도
      continue;
    }
    if (!res.ok) {
      const txt = (await res.text()).slice(0, 300);
      const err = new Error(`오류 ${res.status}: ${txt}`);
      // tool_choice 형식 거부 → 형식을 빼고 재시도
      if (res.status === 400 && /tool_choice/i.test(txt) && toolChoice !== "auto") { toolChoice = "auto"; continue; }
      if (res.status >= 500 || res.status === 429) { lastErr = err; continue; } // transient만 재시도
      throw err; // 나머지 4xx는 즉시 실패
    }
    const data = await res.json();
    const msg = data.choices?.[0]?.message ?? {};
    const toolCalls = (msg.tool_calls ?? []).map((tc: any, i: number) => ({ id: tc.id ?? `call_${i}`, name: tc.function?.name, arguments: tc.function?.arguments ?? "{}" }));
    // 추론 모델이 content에 <think> 태그를 섞어 보내는 경우 제거 — 보고서에 추론 원문이 새지 않게
    const content = String(msg.content ?? "").replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
    return { content, toolCalls: toolCalls.length ? toolCalls : undefined };
  }
  throw lastErr ?? new Error(opts.signal?.aborted ? "작업 중단 — 중지 요청 또는 시간 초과" : "chatOnce 실패");
}

export interface StreamEvent {
  type: "content" | "reasoning" | "usage" | "error" | "done";
  text?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
  error?: string;
}

// OpenAI 호환 스트리밍. reasoning_content(DeepSeek계열), reasoning(일부), <think> 태그 모두 처리.
export async function* streamChat(
  endpoint: Endpoint,
  model: string,
  messages: ChatMessage[],
  opts: { signal?: AbortSignal; temperature?: number; maxTokens?: number } = {},
): AsyncGenerator<StreamEvent> {
  // kind별 어댑터 디스패치
  if (endpoint.kind === "responses") { yield* responsesStream(endpoint, model, messages, { signal: opts.signal }); return; }
  if (endpoint.kind === "gemini") { yield* geminiStream(endpoint, model, messages, { signal: opts.signal }); return; }
  if (endpoint.kind === "cli") { yield* cliStream(endpoint, model, messages, { signal: opts.signal }); return; }

  const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      stream_options: { include_usage: true },
    }),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    yield { type: "error", error: `${endpoint.name} ${res.status}: ${body.slice(0, 300)}` };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let inThink = false;
  let returnedModel: string | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          yield { type: "done", model: returnedModel };
          return;
        }
        let json: any;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        if (json.model) returnedModel = json.model;
        if (json.usage) yield { type: "usage", usage: json.usage, model: returnedModel };
        const delta = json.choices?.[0]?.delta;
        if (!delta) continue;

        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (reasoning) yield { type: "reasoning", text: reasoning };

        let content: string | undefined = delta.content;
        if (content) {
          // <think> 태그로 추론을 흘리는 모델 처리
          while (content.length) {
            if (inThink) {
              const end = content.indexOf("</think>");
              if (end === -1) {
                yield { type: "reasoning", text: content };
                content = "";
              } else {
                yield { type: "reasoning", text: content.slice(0, end) };
                content = content.slice(end + 8);
                inThink = false;
              }
            } else {
              const start = content.indexOf("<think>");
              if (start === -1) {
                yield { type: "content", text: content };
                content = "";
              } else {
                if (start > 0) yield { type: "content", text: content.slice(0, start) };
                content = content.slice(start + 7);
                inThink = true;
              }
            }
          }
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  yield { type: "done", model: returnedModel };
}
