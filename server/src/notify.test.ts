import { afterEach, beforeEach, expect, test } from "bun:test";
import { db, setSetting } from "./db";
import { sendTelegramDetailed } from "./notify";

if (db.filename !== ":memory:") throw new Error(`테스트가 운영 DB를 열었습니다: ${db.filename}`);
const originalFetch = globalThis.fetch;
const originalEnv = process.env.MYBOT_ENV;
const settingKeys = ["telegram_bot_token", "telegram_chat_id"];
let settingSnapshot = new Map<string, string | null>();
beforeEach(() => {
  settingSnapshot = new Map(settingKeys.map((key) => [key, (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null)?.value ?? null]));
  delete process.env.MYBOT_ENV;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of settingSnapshot) {
    if (value === null) db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    else setSetting(key, value);
  }
  if (originalEnv === undefined) delete process.env.MYBOT_ENV;
  else process.env.MYBOT_ENV = originalEnv;
});

test("텔레그램 HTTP 200의 ok:false도 실패이며 원문 오류를 노출하지 않는다", async () => {
  setSetting("telegram_bot_token", "secret-token");
  setSetting("telegram_chat_id", "100");
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, description: "secret-token leaked" }), { status: 200 })) as unknown as typeof fetch;
  const out = await sendTelegramDetailed("hello");
  expect(out.error).toContain("API 오류");
  expect(out.error).not.toContain("secret-token");
});

test("텔레그램 편집은 editMessageText 한 번만 호출하고 실패 시 send 폴백하지 않는다", async () => {
  setSetting("telegram_bot_token", "t");
  setSetting("telegram_chat_id", "100");
  const urls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ ok: false }), { status: 200 });
  }) as unknown as typeof fetch;
  const out = await sendTelegramDetailed("final", { chatId: "100", messageId: "7" });
  expect(out.error).not.toBeNull();
  expect(urls).toHaveLength(1);
  expect(urls[0]).toContain("editMessageText");
  expect(urls[0]).not.toContain("sendMessage");
});

test("HTTP 200의 비정상 JSON과 성공 응답의 message_id 누락은 미확인이다", async () => {
  setSetting("telegram_bot_token", "t");
  setSetting("telegram_chat_id", "100");
  globalThis.fetch = (async () => new Response("not-json", { status: 200 })) as unknown as typeof fetch;
  expect((await sendTelegramDetailed("hello")).unknown).toBe(true);
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })) as unknown as typeof fetch;
  expect((await sendTelegramDetailed("hello")).unknown).toBe(true);
});

test("dev 가드는 호출 시점의 환경을 읽고 fetch를 호출하지 않는다", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(); }) as unknown as typeof fetch;
  process.env.MYBOT_ENV = "dev";
  expect((await sendTelegramDetailed("hello")).error).toBe("suppressed_dev");
  expect(calls).toBe(0);
});
