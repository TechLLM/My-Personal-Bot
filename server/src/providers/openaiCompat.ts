import type { Endpoint, Resolved } from "./index";
import { resolveModel, nextInChain } from "./index";
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
  model?: string;        // 실제로 응답한 모델 — 폴백 시 요청한 것과 다를 수 있음
  fallbackFrom?: string; // 폴백이 일어났으면 최초 실패한 모델 id
}

// A4 — transient 판정: 429/5xx/네트워크 단절/잔액부족(1113). TimeoutError도 포함하되
// 호출자 신호가 abort된 경우는 호출 지점에서 먼저 걸러진다(실행 상한이면 전파해야 함)
function isTransientErr(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e);
  return /\b(429|5\d\d)\b/.test(m) // chatOnce는 "오류 429:", 스트림은 "이름 429:" 형식 — 둘 다 잡는다
    || /1113|insufficient|잔액|balance|rate.?limit/i.test(m)
    || /fetch failed|unable to connect|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|network|socket hang/i.test(m)
    || (e as Error)?.name === "TimeoutError";
}

// 인증 실패(401/403·토큰 만료·키 오류)는 재시도로 풀리지 않지만 다른 프로바이더로는 넘어가야 한다
// 실측 2026-09-18: codex 토큰 만료 401에서 폴백 없이 봇 실행이 통째로 실패했다 (429·잔액부족은 이미 폴백 대상)
function isAuthErr(e: unknown): boolean {
  return /\b(401|403)\b|token_expired|invalid.?api.?key|unauthorized|authentication token/i.test(String((e as Error)?.message ?? e));
}
const shouldFallback = (e: unknown) => isTransientErr(e) || isAuthErr(e);

// 프로바이더 원문 오류(JSON 덩어리)를 원인과 조치가 보이는 한 줄로 — 폴백까지 모두 실패해 사용자에게 갈 때 쓴다
// ("에이전트 오류: 오류 401: {"error":{...}}"만 남아 실패 이유를 알 수 없다는 보고가 있었다)
export function friendlyProviderError(msg: string): string {
  if (/\b1311\b|subscription plan|does not (yet )?include/i.test(msg)) return `현재 구독 플랜에 포함되지 않은 모델이라 호출이 거부됐습니다 — 설정 > 프로바이더에서 플랜에 맞는 모델로 바꾸세요 (원문: ${msg.slice(0, 200)})`;
  if (/insufficient|balance|1113|CreditsError/i.test(msg)) return `모델 제공자 잔액이 부족해 호출이 거부됐습니다 — 결제 후 다시 시도하세요 (원문: ${msg.slice(0, 200)})`;
  if (isAuthErr(msg)) return `모델 제공자 인증이 만료됐습니다 — 설정 > 프로바이더에서 재인증하세요 (원문: ${msg.slice(0, 200)})`;
  if (/\b429\b|rate.?limit|1302/i.test(msg)) return `모델 제공자 요청 한도에 걸렸습니다 — 잠시 후 다시 시도하거나 다른 모델을 배정하세요 (원문: ${msg.slice(0, 200)})`;
  return msg;
}

// 폴백을 부른 모델은 잠시 건너뛴다 — 예전엔 호출마다 같은 모델에서 백오프 재시도(1초·4초)를
// 반복한 뒤에야 폴백해, 봇 호출 하나하나가 수 초씩 늦어지고 제한도 더 오래 풀리지 않았다.
// 처음엔 429만 대상이었는데, 2026-09-18 devin 미로그인 모델이 호출마다 502를 맞고 폴백해 같은 실패가
// 18회 반복됐다 — 폴백이 일어났다는 것 자체가 "이 모델은 지금 못 쓴다"는 신호라 실패 종류를 가리지 않는다.
// 폴백할 다음 모델이 없으면 건너뛰지 않고 그대로 시도한다.
const FAIL_COOLDOWN_MS = 120_000;
// 플랜 미지원(z.ai 1311)·모델 자체 부재 같은 영구 오류는 120초 쿨다운으로는 회복되지 않는다 —
// 쿨다운이 풀릴 때마다 같은 실패를 반복해 폴백이 무한히 이어진 실측이 있다 (2026-09-19 flashx 사고).
// 영구 오류는 1시간 건너뛰어 반복 호출을 끊고, 설정이 고쳐진 뒤에는 재시작으로 바로 해소된다.
const PERM_COOLDOWN_MS = 3_600_000;
const isPermanentModelErr = (e: unknown) =>
  /\b1311\b|subscription plan|does not (yet )?include|model.{0,20}(not.{0,10}(supported|available|found)|does not exist)/i.test(String((e as Error)?.message ?? e));
// 잔액 소진은 시간이 지난다고 풀리지 않고, 모델 하나가 아니라 그 프로바이더 전체가 거부된다.
// 모델 단위로만 건너뛰면 같은 프로바이더의 다른 모델을 차례로 두드리며 같은 실패를 반복한다 —
// 실측에서 스킬 실패 원인 1위가 이 오류였다 (2026-09-17 CreditsError 4건).
export const isCreditsErr = (e: unknown) =>
  /insufficient|\bbalance\b|CreditsError|\b1113\b/i.test(String((e as Error)?.message ?? e));
const skipUntil = new Map<string, number>();
const coolingDown = (key: string) => (skipUntil.get(key) ?? 0) > Date.now();
// 실패한 모델을 건너뛸 기간·대상을 정한다. 잔액 오류면 엔드포인트 전체를 오래 건너뛴다
export function cooldownFor(endpointId: string, modelKey: string, e: unknown): { key: string; ms: number } {
  if (isCreditsErr(e)) return { key: endpointId, ms: PERM_COOLDOWN_MS };
  return { key: modelKey, ms: isPermanentModelErr(e) ? PERM_COOLDOWN_MS : FAIL_COOLDOWN_MS };
}

// 폴백 체인에서 실제로 쓸 수 있는 다음 모델 — 해석 불가 항목과, 도구가 필요할 때 도구 미지원(CLI) 모델은 건너뛴다
function nextUsable(key: string, needsTools: boolean): Resolved | null {
  for (let next = nextInChain(key); next; next = nextInChain(next)) {
    try {
      const r = resolveModel(next);
      if (coolingDown(r.endpoint.id)) continue; // 잔액이 마른 프로바이더는 모델을 바꿔도 똑같이 거부된다
      if (!needsTools || r.endpoint.caps?.tools !== false) return r;
    } catch {}
  }
  return null;
}

// 비스트리밍 호출 (도구 루프·내부용) — 프로바이더 폴백 체인 포함
// HTTP 오류는 content로 위장하지 않고 throw — transient는 백오프 재시도 후 폴백 (사용자 abort 제외)
export async function chatOnce(
  endpoint: Endpoint,
  model: string,
  messages: any[],
  opts: { signal?: AbortSignal; tools?: { type: string; function: { name: string; description?: string; parameters?: object } }[]; toolChoice?: string | object; reasoningEffort?: string } = {},
): Promise<ChatResult> {
  let ep = endpoint, mdl = model, origin: string | null = null;
  const needsTools = !!opts.tools?.length;
  for (;;) {
    const key = `${ep.id}/${mdl}`;
    let next: Resolved | null = null;
    let failure: unknown;
    if ((coolingDown(key) || coolingDown(ep.id)) && (next = nextUsable(key, needsTools))) {
      failure = new Error("최근 실패로 건너뜀 — 대기 없이 다음 모델로");
    } else {
      try {
        const r = await chatOnceAttempt(ep, mdl, messages, opts);
        r.model = mdl;
        if (origin) r.fallbackFrom = origin;
        return r;
      } catch (e) {
        if (opts.signal?.aborted || !shouldFallback(e)) throw e;
        const cd = cooldownFor(ep.id, key, e);
        skipUntil.set(cd.key, Date.now() + cd.ms);
        next = nextUsable(key, needsTools);
        if (!next) throw e;
        failure = e;
      }
    }
    console.warn(`[mybot] 모델 폴백: ${key} → ${next.endpoint.id}/${next.model} (${String((failure as Error).message).slice(0, 80)})`);
    origin ??= `${endpoint.id}/${model}`;
    ({ endpoint: ep, model: mdl } = next);
  }
}

async function chatOnceAttempt(
  endpoint: Endpoint,
  model: string,
  messages: any[],
  opts: { signal?: AbortSignal; tools?: { type: string; function: { name: string; description?: string; parameters?: object } }[]; toolChoice?: string | object; reasoningEffort?: string } = {},
): Promise<ChatResult> {
  // kind별 어댑터 디스패치 — responses(codex OAuth) / gemini(OAuth) / cli(로컬 브릿지)
  switch (endpoint.kind) {
    case "responses": return responsesChatOnce(endpoint, model, messages, { signal: opts.signal, tools: opts.tools, toolChoice: opts.toolChoice, reasoningEffort: opts.reasoningEffort });
    case "gemini": return geminiChatOnce(endpoint, model, messages, { signal: opts.signal, tools: opts.tools });
    case "cli": return cliChatOnce(endpoint, model, messages, { signal: opts.signal });
  }
  // tool_choice 객체 형식은 프록시마다 다름 — airoute는 Responses식 폴백 형식만 받아 nested 형식을 400으로 거부.
  // 거부되면 tool_choice 없이 재시도 (호출 지시는 프롬프트·서버 폴백이 커버)
  let toolChoice: unknown = opts.toolChoice ?? "auto";
  // 추론 강도 — 추론 모델이 매 호출 생성하는 숨은 thinking 토큰을 줄여 지연을 줄인다.
  // 지원 안 하는 프로바이더는 무시하거나 400이므로 실패 시 파라미터를 빼고 재시도한다.
  let effort: string | undefined = opts.reasoningEffort;
  const makeBody = () => JSON.stringify({ model, messages, stream: false, ...(opts.tools?.length ? { tools: opts.tools, tool_choice: toolChoice } : {}), ...(effort ? { reasoning_effort: effort } : {}) });
  let lastErr: Error | null = null;
  const BACKOFF = [1000, 4000, 10_000]; // C9 — 지수 백오프
  let pendingWait: number | undefined; // Retry-After 헤더가 지정한 대기
  for (let attempt = 0; attempt < 3; attempt++) {
    if (opts.signal?.aborted) break;
    if (attempt > 0) await new Promise((r) => setTimeout(r, pendingWait ?? BACKOFF[attempt - 1] ?? 10_000));
    let res: Response;
    try {
      res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
        },
        body: makeBody(),
        // 호출별 상한은 외부 signal과 무관하게 항상 적용 — signal만 있으면 프로바이더
        // 무응답 시 상위 상한(최대 9분)까지 멈춰 보이는 사고가 있었다
        signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
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
      // reasoning_effort 미지원 → 파라미터를 빼고 재시도 (한 번만)
      if (res.status === 400 && effort && /reasoning|effort/i.test(txt)) { effort = undefined; continue; }
      if (res.status >= 500 || res.status === 429) {
        lastErr = err;
        // C9 — Retry-After 헤더 준수 (지정 없으면 위 백오프 적용)
        const ra = Number(res.headers.get("retry-after"));
        pendingWait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30_000) : undefined;
        continue;
      }
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
// A4 — 본문이 시작되기 전 transient 실패면 fallback_chain의 다음 모델로 자동 전환하고
// 폴백 사실을 reasoning 이벤트로 화면에 표기한다.
export async function* streamChat(
  endpoint: Endpoint,
  model: string,
  messages: ChatMessage[],
  opts: { signal?: AbortSignal; temperature?: number; maxTokens?: number; reasoningEffort?: string } = {},
): AsyncGenerator<StreamEvent> {
  let ep = endpoint, mdl = model, origin: string | null = null;
  for (;;) {
    const key = `${ep.id}/${mdl}`;
    let failMsg: string | null = null;
    let next: Resolved | null = null;
    if ((coolingDown(key) || coolingDown(ep.id)) && (next = nextUsable(key, false))) {
      failMsg = "최근 실패로 건너뜀 — 대기 없이 다음 모델로";
    } else {
      let produced = false;
      let noted = !origin;
      try {
        for await (const ev of streamChatOnce(ep, mdl, messages, opts)) {
          if (!noted) { yield { type: "reasoning", text: `⚠️ ${origin} 실패 — ${ep.id}/${mdl}로 폴백했습니다\n` }; noted = true; }
          if (ev.type === "error" && !produced && shouldFallback(new Error(ev.error ?? ""))) { failMsg = ev.error ?? "오류"; break; }
          if (ev.type === "content") produced = true;
          yield ev;
        }
      } catch (e) {
        if (opts.signal?.aborted || produced || !shouldFallback(e)) throw e; // 본문 출력이 시작된 뒤엔 중간 전환 금지
        failMsg = String((e as Error).message);
      }
      if (!failMsg) return;
      const cd = cooldownFor(ep.id, key, new Error(failMsg));
      skipUntil.set(cd.key, Date.now() + cd.ms);
      next = nextUsable(key, false);
      if (!next) { yield { type: "error", error: failMsg }; return; }
    }
    console.warn(`[mybot] 스트림 폴백: ${key} → ${next.endpoint.id}/${next.model} (${failMsg.slice(0, 80)})`);
    origin ??= `${endpoint.id}/${model}`;
    ({ endpoint: ep, model: mdl } = next);
  }
}

async function* streamChatOnce(
  endpoint: Endpoint,
  model: string,
  messages: ChatMessage[],
  opts: { signal?: AbortSignal; temperature?: number; maxTokens?: number; reasoningEffort?: string } = {},
): AsyncGenerator<StreamEvent> {
  // kind별 어댑터 디스패치
  if (endpoint.kind === "responses") { yield* responsesStream(endpoint, model, messages, { signal: opts.signal, reasoningEffort: opts.reasoningEffort }); return; }
  if (endpoint.kind === "gemini") { yield* geminiStream(endpoint, model, messages, { signal: opts.signal }); return; }
  if (endpoint.kind === "cli") { yield* cliStream(endpoint, model, messages, { signal: opts.signal }); return; }

  // 추론 강도 — 미지원 프로바이더는 400으로 거부하므로 실패 시 파라미터를 빼고 한 번 재시도
  let effort: string | undefined = opts.reasoningEffort;
  const doFetch = () => fetch(`${endpoint.baseUrl}/chat/completions`, {
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
      ...(effort ? { reasoning_effort: effort } : {}),
      stream_options: { include_usage: true },
    }),
    // 호출별 상한은 외부 signal과 무관하게 항상 적용 — 무응답 프로바이더 hang 방지
    signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
  });
  let res = await doFetch();
  if (!res.ok && res.status === 400 && effort && /reasoning|effort/i.test(await res.text().catch(() => ""))) {
    effort = undefined;
    res = await doFetch();
  }

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
