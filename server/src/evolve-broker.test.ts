import { describe, expect, test } from "bun:test";
import { startBroker, type BrokerUpstream } from "./evolve/broker";

const stub: BrokerUpstream = async (model, messages) => ({
  content: `stub:${model}:${(messages as any[]).map((m) => m?.content).join(",")}`,
});

const post = (url: string, body: object, token?: string) =>
  fetch(`${url}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

describe("evolve credential broker", () => {
  test("토큰 없는 요청은 401", async () => {
    const b = await startBroker({ models: ["m/1"], upstream: stub });
    try {
      expect((await post(b.url, { model: "m/1", messages: [] })).status).toBe(401);
      expect(b.usage().calls).toBe(0);
    } finally { await b.close(); }
  });

  test("허용 목록 밖 모델은 403 — 호출이 집행 전에 차단된다", async () => {
    const b = await startBroker({ models: ["m/1"], upstream: stub });
    try {
      expect((await post(b.url, { model: "other/9", messages: [] }, b.token)).status).toBe(403);
      expect(b.usage().calls).toBe(0);
    } finally { await b.close(); }
  });

  test("정상 호출은 upstream 응답을 전달하고 usage에 계측된다", async () => {
    const b = await startBroker({ models: ["m/1"], upstream: stub });
    try {
      const res = await post(b.url, { model: "m/1", messages: [{ role: "user", content: "ping" }] }, b.token);
      expect(res.status).toBe(200);
      expect((await res.json()).content).toBe("stub:m/1:ping");
      const u = b.usage();
      expect(u.calls).toBe(1);
      expect(u.estTokens).toBeGreaterThan(0);
    } finally { await b.close(); }
  });

  test("호출 상한을 넘으면 429로 끊는다", async () => {
    const b = await startBroker({ models: ["m/1"], maxCalls: 1, upstream: stub });
    try {
      await post(b.url, { model: "m/1", messages: [] }, b.token);
      expect((await post(b.url, { model: "m/1", messages: [] }, b.token)).status).toBe(429);
      expect(b.usage().calls).toBe(1);
    } finally { await b.close(); }
  });

  test("토큰 예산을 넘으면 429로 끊는다", async () => {
    const b = await startBroker({ models: ["m/1"], maxEstTokens: 1, upstream: stub });
    try {
      await post(b.url, { model: "m/1", messages: [{ role: "user", content: "some input text" }] }, b.token);
      expect((await post(b.url, { model: "m/1", messages: [] }, b.token)).status).toBe(429);
    } finally { await b.close(); }
  });

  test("upstream 실패는 502로 전파되고 호출은 집계된다", async () => {
    const b = await startBroker({ models: ["m/1"], upstream: async () => { throw new Error("provider down"); } });
    try {
      const res = await post(b.url, { model: "m/1", messages: [] }, b.token);
      expect(res.status).toBe(502);
      expect((await res.json()).error).toContain("provider down");
      expect(b.usage().calls).toBe(1);
    } finally { await b.close(); }
  });

  const tool = (url: string, body: object, token: string) =>
    fetch(`${url}/tool`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  test("/tool — 허용된 도구는 핸들러를 실행하고 팔별로 계측된다", async () => {
    const b = await startBroker({
      models: ["m/1"], tools: ["web_search"], upstream: stub,
      toolHandler: async (t, args) => ({ provider: "stub", results: [`${t}:${args.query}`] }),
    });
    try {
      const res = await tool(b.url, { tool: "web_search", args: { query: "뉴스" } }, `${b.token}:baseline`);
      expect(res.status).toBe(200);
      expect((await res.json()).result.results[0]).toBe("web_search:뉴스");
      expect(b.usage().byTag.baseline?.toolCalls).toBe(1);
      expect(b.usage().calls).toBe(0); // 도구 호출은 모델 호출 수에 섞이지 않는다
    } finally { await b.close(); }
  });

  test("/tool — 허용 목록 밖 도구는 403, 호출은 계측되지 않는다", async () => {
    const b = await startBroker({ models: ["m/1"], upstream: stub }); // tools 미지정 = 전면 닫힘
    try {
      const res = await tool(b.url, { tool: "web_search", args: { query: "x" } }, b.token);
      expect(res.status).toBe(403);
      expect(b.usage().toolCalls).toBe(0);
    } finally { await b.close(); }
  });

  test("/tool — 팔별 상한을 넘으면 429", async () => {
    const b = await startBroker({
      models: ["m/1"], tools: ["web_search"], maxToolCallsPerTag: 1, upstream: stub,
      toolHandler: async () => ({ ok: true }),
    });
    try {
      expect((await tool(b.url, { tool: "web_search", args: {} }, `${b.token}:candidate`)).status).toBe(200);
      expect((await tool(b.url, { tool: "web_search", args: {} }, `${b.token}:candidate`)).status).toBe(429);
      expect((await tool(b.url, { tool: "web_search", args: {} }, `${b.token}:baseline`)).status).toBe(200); // 다른 팔 예산은 별도
    } finally { await b.close(); }
  });

  test("팔별 모델 호출 상한 — 후보가 기준선보다 많이 쓰는 걸 막는다", async () => {
    const b = await startBroker({ models: ["m/1"], maxCallsPerTag: 1, upstream: stub });
    try {
      expect((await post(b.url, { model: "m/1", messages: [] }, `${b.token}:baseline`)).status).toBe(200);
      expect((await post(b.url, { model: "m/1", messages: [] }, `${b.token}:baseline`)).status).toBe(429);
      expect((await post(b.url, { model: "m/1", messages: [] }, `${b.token}:candidate`)).status).toBe(200);
    } finally { await b.close(); }
  });

  // 샌드박스 도구 정책 — 과제가 선언(허용 목록 통과)해도 기본 핸들러의 고정 집합이 상한이다.
  // 변형·자격증명·임의 실행 도구는 샌드박스에 열리지 않는다.
  test("/tool — 기본 핸들러는 읽기 전용 브라우저·MCP만 대행하고 나머지를 거부한다", async () => {
    const b = await startBroker({
      models: ["m/1"], upstream: stub,
      tools: ["browser_click", "browser_eval", "browser_login", "ego_run", "bsk", "computer_look", "srv__read"],
    });
    try {
      for (const denied of ["browser_click", "browser_eval", "browser_login", "ego_run", "bsk", "computer_look"]) {
        const res = await tool(b.url, { tool: denied, args: {} }, b.token);
        expect(`${denied} → ${res.status}`).toBe(`${denied} → 502`);
        expect((await res.json()).error).toContain("unsupported_tool");
      }
      // MCP 이름은 허용 목록을 통과하면 부모의 mcpCall로 라우팅된다 — 서버 미설정이면 "알 수 없는 도구"
      const res = await tool(b.url, { tool: "srv__read", args: {} }, b.token);
      expect(res.status).toBe(200);
      expect((await res.json()).result).toContain("알 수 없는 도구");
    } finally { await b.close(); }
  });

  test("/tool — 핸들러에 팔 태그가 전달된다", async () => {
    const seen: string[] = [];
    const b = await startBroker({
      models: ["m/1"], tools: ["web_search"], upstream: stub,
      toolHandler: async (_t, _a, tag) => { seen.push(tag); return { ok: true }; },
    });
    try {
      await tool(b.url, { tool: "web_search", args: { query: "x" } }, `${b.token}:candidate-2`);
      expect(seen).toEqual(["candidate-2"]);
    } finally { await b.close(); }
  });
});

describe("e2 도구 브로커 라우팅", () => {
  // worker(browserTool·mcpCall)는 샌드박스 안에서 브로커 /tool로만 외부 도구에 닿는다.
  const withStubBroker = async (fn: (url: string, seen: any[]) => Promise<void>) => {
    const seen: any[] = [];
    const { createServer } = await import("node:http");
    const srv = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || "{}") });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ result: "stub-result" }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as any).port;
    const prev = { env: process.env.MYBOT_ENV, url: process.env.E2_BROKER_URL, tok: process.env.E2_BROKER_TOKEN };
    process.env.MYBOT_ENV = "e2";
    process.env.E2_BROKER_URL = `http://127.0.0.1:${port}`;
    process.env.E2_BROKER_TOKEN = "tok:candidate-0";
    try { await fn(process.env.E2_BROKER_URL, seen); }
    finally {
      process.env.MYBOT_ENV = prev.env; process.env.E2_BROKER_URL = prev.url; process.env.E2_BROKER_TOKEN = prev.tok;
      await new Promise<void>((r) => srv.close(() => r()));
    }
  };

  test("browserTool은 브로커로 라우팅하고 페이지 키를 args.__key로 넘긴다", async () => {
    const { browserTool } = await import("./browser");
    await withStubBroker(async (_url, seen) => {
      const out = await browserTool("run-7", "browser_open", { url: "https://example.com" });
      expect(out).toBe("stub-result");
      expect(seen[0].auth).toBe("Bearer tok:candidate-0");
      expect(seen[0].body).toEqual({ tool: "browser_open", args: { url: "https://example.com", __key: "run-7" } });
    });
  });

  test("mcpCall은 도구 이름 그대로 브로커로 라우팅한다", async () => {
    const { mcpCall } = await import("./mcp");
    await withStubBroker(async (_url, seen) => {
      const out = await mcpCall("srv__lookup", { q: "x" });
      expect(out).toBe("stub-result");
      expect(seen[0].body).toEqual({ tool: "srv__lookup", args: { q: "x" } });
    });
  });

  test("브로커 거부는 도구 오류로 변한다", async () => {
    const { browserTool } = await import("./browser");
    const { createServer } = await import("node:http");
    const srv = createServer((_req, res) => { res.writeHead(403).end(); });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as any).port;
    const prev = { env: process.env.MYBOT_ENV, url: process.env.E2_BROKER_URL };
    process.env.MYBOT_ENV = "e2"; process.env.E2_BROKER_URL = `http://127.0.0.1:${port}`;
    try {
      await expect(browserTool("k", "browser_click", {})).rejects.toThrow("broker_tool_403");
    } finally {
      process.env.MYBOT_ENV = prev.env; process.env.E2_BROKER_URL = prev.url;
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});
