// E2-B credential broker — 격리 worker가 API 키를 들지 않고 모델을 쓰는 유일한 통로.
// 부모(dev 서버) 프로세스가 127.0.0.1:<랜덤포트>에 열고, 샌드박스 정책이 그 포트로의
// outbound만 허용한다. API 키는 부모에만 있고 worker는 토큰만 든다.
// 여기서 모델 허용목록·호출 수·토큰 상한을 집행하고 호출당 비용을 계측한다 (E4 지점).
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";

export interface BrokerUsage {
  calls: number;
  estTokens: number; // usage 미제공 프로바이더용 추정치(문자/4) — E4에서 실제 usage로 대체 가능
  byTag: Record<string, { calls: number; estTokens: number; models: string[] }>;
}

export interface BrokerHandle {
  url: string;
  port: number;
  token: string;
  usage(): BrokerUsage;
  close(): Promise<void>;
}

// 실제 모델 호출 — 테스트에서는 스텁을 주입한다
export type BrokerUpstream = (
  model: string,
  messages: unknown[],
  opts: Record<string, unknown>,
) => Promise<{ content: string; toolCalls?: { id?: string; name: string; arguments: string }[]; usage?: { total_tokens?: number } }>;

async function realUpstream(model: string, messages: unknown[], opts: Record<string, unknown>) {
  const { resolveModel } = await import("../providers");
  const { chatOnce } = await import("../providers/openaiCompat");
  const { endpoint, model: resolved } = resolveModel(model);
  const res = await chatOnce(endpoint, resolved, messages as any, opts as any);
  return { content: res.content ?? "", toolCalls: res.toolCalls, usage: (res as any).usage };
}

// 허용 목록은 풀 id("prov/model")로 관리한다 — worker가 보낸 bare 이름은
// 목록 중 그 접미사와 정확히 하나만 일치할 때 해석된다.
function resolveAllowed(allowed: Set<string>, requested: string): string | null {
  if (allowed.has(requested)) return requested;
  const hits = [...allowed].filter((id) => id.endsWith(`/${requested}`) || id === requested);
  return hits.length === 1 ? hits[0] : null;
}

export function startBroker(opts: {
  models: string[];                 // 이 사이클에서 허용할 모델 id (풀 id 형식)
  maxCalls?: number;                // 기본 40 — 벤치 무한 루프 방지
  maxEstTokens?: number;            // 기본 200_000 — 사이클 토큰 예산 상한
  upstream?: BrokerUpstream;        // 테스트 주입용 — 기본은 실제 프로바이더 경로
}): Promise<BrokerHandle> {
  const token = randomUUID();
  const allowed = new Set(opts.models);
  const maxCalls = opts.maxCalls ?? 40;
  const maxEstTokens = opts.maxEstTokens ?? 200_000;
  const upstream = opts.upstream ?? realUpstream;
  const usage: BrokerUsage = { calls: 0, estTokens: 0, byTag: {} };
  const tagUsage = (tag: string) => (usage.byTag[tag] ??= { calls: 0, estTokens: 0, models: [] });

  const server: Server = createServer((req, res) => {
    const reply = (code: number, body: object) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const isChat = req.method === "POST" && req.url === "/chat";
    const isOpenAI = req.method === "POST" && req.url === "/v1/chat/completions";
    const isUsage = req.method === "GET" && req.url === "/usage";
    if (!isChat && !isOpenAI && !isUsage) return reply(404, { error: "not_found" });
    // 토큰 뒤에 ":태그"를 붙이면 호출이 그 태그로 계측된다 — 격리 비교는 팔(arm)별
    // 토큰 태그를 써서 같은 브로커를 공유하면서도 팔별 비용을 분리해 기록한다.
    const auth = req.headers.authorization ?? "";
    const [bearer, tag = "default"] = auth.startsWith("Bearer ") ? auth.slice(7).split(":") : ["", "default"];
    if (bearer !== token) return reply(401, { error: "unauthorized" });
    if (isUsage) return reply(200, usage);
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 512 * 1024) { reply(413, { error: "request_too_large" }); req.destroy(); }
    });
    req.on("end", async () => {
      let parsed: any;
      try { parsed = JSON.parse(body); } catch { return reply(400, { error: "invalid_json" }); }
      if (typeof parsed?.model !== "string" || !Array.isArray(parsed?.messages)) return reply(400, { error: "invalid_request" });
      const resolvedModel = resolveAllowed(allowed, parsed.model);
      if (!resolvedModel) return reply(403, { error: "model_not_allowed" });
      if (usage.calls >= maxCalls) return reply(429, { error: "call_limit" });
      if (usage.estTokens >= maxEstTokens) return reply(429, { error: "token_budget" });
      usage.calls++;
      const per = tagUsage(tag);
      try {
        // /v1은 OpenAI 요청 형식을 받는다 — tools·tool_choice·reasoning_effort를 그대로 전달
        const opts = isOpenAI
          ? { tools: parsed.tools, toolChoice: parsed.tool_choice, reasoningEffort: parsed.reasoning_effort }
          : (parsed.opts ?? {});
        const out = await upstream(resolvedModel, parsed.messages, opts);
        const inChars = parsed.messages.reduce((n: number, m: any) => n + String(m?.content ?? "").length, 0);
        const spent = out.usage?.total_tokens ?? Math.ceil((inChars + out.content.length) / 4);
        usage.estTokens += spent;
        per.calls++;
        per.estTokens += spent;
        if (!per.models.includes(resolvedModel)) per.models.push(resolvedModel);
        if (isOpenAI) {
          reply(200, {
            id: `broker-${randomUUID()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: resolvedModel,
            choices: [{
              index: 0, finish_reason: out.toolCalls?.length ? "tool_calls" : "stop",
              message: {
                role: "assistant", content: out.content,
                ...(out.toolCalls?.length ? { tool_calls: out.toolCalls.map((tc, i) => ({ id: tc.id ?? `call_${i}`, type: "function", function: { name: tc.name, arguments: tc.arguments ?? "{}" } })) } : {}),
              },
            }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: out.usage?.total_tokens ?? 0 },
          });
        } else {
          reply(200, { content: out.content, model: resolvedModel });
        }
      } catch (e) {
        reply(502, { error: `upstream_error: ${(e as Error).message.slice(0, 200)}` });
      }
    });
  });

  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolvePromise({
        url: `http://127.0.0.1:${port}`,
        port,
        token,
        usage: () => ({ ...usage }),
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
