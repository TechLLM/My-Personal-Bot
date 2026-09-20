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
});
