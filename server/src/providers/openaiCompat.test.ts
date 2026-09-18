import { test, expect } from "bun:test";
import { db, setSetting } from "../db";
import { resolveModel } from "./index";
import { chatOnce, streamChat, friendlyProviderError } from "./openaiCompat";

if (db.filename !== ":memory:") throw new Error(`테스트가 운영 DB를 열었습니다: ${db.filename}`);

test("429를 받은 모델은 쿨다운 동안 재시도 없이 바로 폴백한다", async () => {
  // 실제 인증 정보에 기대지 않도록 키를 가진 사용자 정의 프로바이더 두 개로 폴백 체인을 만든다
  setSetting("custom_providers", JSON.stringify([
    { id: "t-slow", baseUrl: "http://slow.test/v1", apiKey: "k", models: ["m"] },
    { id: "t-fast", baseUrl: "http://fast.test/v1", apiKey: "k", models: ["m"] },
  ]));
  setSetting("fallback_chain", "t-slow → t-fast");
  const calls = { slow: 0, fast: 0 };
  const saved = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).includes("slow.test")) {
      calls.slow++;
      // Retry-After를 짧게 줘 첫 호출의 백오프 재시도가 테스트를 늦추지 않게 한다
      return new Response('{"error":{"code":"1302","message":"Rate limit reached for requests"}}', { status: 429, headers: { "retry-after": "0.01" } });
    }
    calls.fast++;
    if (String(init?.body ?? "").includes('"stream":true'))
      return new Response('data: {"choices":[{"delta":{"content":"스트림 응답"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
    return new Response(JSON.stringify({ choices: [{ message: { content: "빠른 응답" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  try {
    const { endpoint, model } = resolveModel("t-slow/m");
    const first = await chatOnce(endpoint, model, [{ role: "user", content: "안녕" }]);
    expect(first.content).toBe("빠른 응답");
    expect(first.fallbackFrom).toBe("t-slow/m");
    const slowAfterFirst = calls.slow; // 첫 호출은 제한을 모르므로 재시도 후 폴백
    expect(slowAfterFirst).toBeGreaterThanOrEqual(1);

    const second = await chatOnce(endpoint, model, [{ role: "user", content: "다시" }]);
    expect(second.content).toBe("빠른 응답");
    expect(calls.slow).toBe(slowAfterFirst); // 쿨다운 중 — 느린 모델을 다시 부르지 않는다

    let text = "";
    for await (const ev of streamChat(endpoint, model, [{ role: "user", content: "스트림" }])) if (ev.type === "content") text += ev.text;
    expect(text).toBe("스트림 응답");
    expect(calls.slow).toBe(slowAfterFirst);
  } finally {
    globalThis.fetch = saved;
    setSetting("custom_providers", "[]");
    setSetting("fallback_chain", "");
  }
});

// 2026-09-18 실측: codex 토큰 만료 401에서 폴백 없이 봇 실행이 통째로 실패했다(오류 3건).
// 429·잔액부족은 이미 폴백 대상이었지만 인증 만료만 빠져 있었다
test("인증 만료(401)도 다음 프로바이더로 폴백한다", async () => {
  setSetting("custom_providers", JSON.stringify([
    { id: "t-expired", baseUrl: "http://expired.test/v1", apiKey: "k", models: ["m"] },
    { id: "t-live", baseUrl: "http://live.test/v1", apiKey: "k", models: ["m"] },
  ]));
  setSetting("fallback_chain", "t-expired → t-live");
  const saved = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => String(url).includes("expired.test")
    ? new Response('{"error":{"message":"Provided authentication token is expired. Please try signing in again.","code":"token_expired"}}', { status: 401 })
    : new Response(JSON.stringify({ choices: [{ message: { content: "살아있는 모델 응답" } }] }), { status: 200, headers: { "content-type": "application/json" } })
  ) as unknown as typeof fetch;
  try {
    const { endpoint, model } = resolveModel("t-expired/m");
    const r = await chatOnce(endpoint, model, [{ role: "user", content: "안녕" }]);
    expect(r.content).toBe("살아있는 모델 응답");
    expect(r.fallbackFrom).toBe("t-expired/m");
  } finally {
    globalThis.fetch = saved;
  }
});

test("프로바이더 인증·한도 오류는 원인과 조치가 보이는 안내로 바뀐다", () => {
  expect(friendlyProviderError('오류 401: {"error":{"message":"Provided authentication token is expired.","code":"token_expired"}}')).toContain("재인증");
  expect(friendlyProviderError('오류 401: {"error":{"type":"CreditsError","message":"Insufficient balance."}}')).toContain("잔액");
  expect(friendlyProviderError('오류 429: {"error":{"code":"1302","message":"Rate limit reached"}}')).toContain("요청 한도");
  expect(friendlyProviderError("도구 실행 시간 초과(120초)")).toBe("도구 실행 시간 초과(120초)");
});
