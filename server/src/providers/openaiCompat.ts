import type { Endpoint } from "./index";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | { type: string; text?: string; image_url?: { url: string } }[];
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
