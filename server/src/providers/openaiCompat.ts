import type { Endpoint } from "./index";

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
  opts: { signal?: AbortSignal; tools?: { type: string; function: { name: string; description?: string; parameters?: object } }[] } = {},
): Promise<ChatResult> {
  const body = JSON.stringify({ model, messages, stream: false, ...(opts.tools?.length ? { tools: opts.tools, tool_choice: "auto" } : {}) });
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
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
        body,
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
      if (res.status >= 500 || res.status === 429) { lastErr = err; continue; } // transient만 재시도
      throw err; // 4xx는 즉시 실패
    }
    const data = await res.json();
    const msg = data.choices?.[0]?.message ?? {};
    const toolCalls = (msg.tool_calls ?? []).map((tc: any, i: number) => ({ id: tc.id ?? `call_${i}`, name: tc.function?.name, arguments: tc.function?.arguments ?? "{}" }));
    return { content: msg.content ?? "", toolCalls: toolCalls.length ? toolCalls : undefined };
  }
  throw lastErr ?? new Error("chatOnce 실패");
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
