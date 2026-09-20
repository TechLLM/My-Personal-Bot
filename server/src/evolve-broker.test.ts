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
});
