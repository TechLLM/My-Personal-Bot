import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { chmodSync, mkdtempSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessOrigins, installAccessControl, readAccessCode } from "./access";
import { provisionAccessFile } from "../../scripts/provision-access";

const originalCode = process.env.MYBOT_ACCESS_CODE;
afterEach(() => { if (originalCode === undefined) delete process.env.MYBOT_ACCESS_CODE; else process.env.MYBOT_ACCESS_CODE = originalCode; });
function app(key: string | null = "test-code") {
  const h = new Hono();
  installAccessControl(h, () => key, ["http://localhost:5274", "http://127.0.0.1:5274", "https://bot.myxcloud.co.kr"]);
  h.get("/api/health", c => c.json({ ok: true }));
  h.get("/api/access", c => c.json({ authenticated: true }));
  h.post("/api/fixture", c => c.json({ ok: true }));
  return h;
}
test("localhost and HTTPS proxy origin authenticate; no forwarding-header trust needed", async () => {
  const h = app();
  for (const [url, origin] of [["http://localhost:5274/api/access", "http://localhost:5274"], ["http://bot.myxcloud.co.kr/api/access", "https://bot.myxcloud.co.kr"]]) {
    const r = await h.request(url, { headers: { origin, "x-mybot-key": "test-code" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
  }
});
test("missing credentials fail closed while health stays public", async () => {
  expect((await app().request("http://localhost:5274/api/access")).status).toBe(401);
  expect((await app(null).request("http://localhost:5274/api/access")).status).toBe(503);
  expect((await app(null).request("http://localhost:5274/api/health")).status).toBe(200);
});
test("URL query secrets cannot authorize requests", async () => {
  expect((await app().request("http://localhost:5274/api/fixture?key=test-code", { method: "POST" })).status).toBe(401);
});
test("untrusted Origin, Host and spoofed forwarded origin are rejected", async () => {
  const h = app();
  expect((await h.request("http://localhost:5274/api/access", { headers: { origin: "https://untrusted.invalid", "x-mybot-key": "test-code", "x-forwarded-proto": "https" } })).status).toBe(403);
  expect((await h.request("http://untrusted.invalid/api/access", { headers: { "x-mybot-key": "test-code" } })).status).toBe(403);
});
test("preflight grants only configured origins", async () => {
  const h = app();
  expect((await h.request("http://localhost:5274/api/fixture", { method: "OPTIONS", headers: { origin: "https://bot.myxcloud.co.kr" } })).status).toBe(204);
  expect((await h.request("http://localhost:5274/api/fixture", { method: "OPTIONS", headers: { origin: "https://untrusted.invalid" } })).status).toBe(403);
});
test("credential provisioning uses owner-only permissions and does not replace an existing key", () => {
  delete process.env.MYBOT_ACCESS_CODE;
  const dir = mkdtempSync(join(tmpdir(), "mybot-access-fixture-"));
  expect(provisionAccessFile(dir)).toBe("created");
  const path = join(dir, "access.key"), original = readFileSync(path, "utf8");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(original.trim().length).toBeGreaterThanOrEqual(32);
  expect(provisionAccessFile(dir)).toBe("existing");
  expect(readFileSync(path, "utf8")).toBe(original);
  expect(readAccessCode(path, () => "legacy")).toBe(original.trim());
  chmodSync(path, 0o644);
  expect(readAccessCode(path, () => "legacy")).toBeNull();
});
test("an environment credential can override a local file without printing or rewriting it", () => {
  process.env.MYBOT_ACCESS_CODE = "test-env-code";
  expect(readAccessCode("/nonexistent-fixture", () => null)).toBe("test-env-code");
  expect(accessOrigins(5274)).toContain("http://localhost:5274");
});
test("dangling symlinks and empty environment keys cannot fall back to legacy credentials", () => {
  delete process.env.MYBOT_ACCESS_CODE;
  const dir = mkdtempSync(join(tmpdir(), "mybot-access-link-"));
  const path = join(dir, "access.key");
  symlinkSync(join(dir, "missing"), path);
  expect(readAccessCode(path, () => "legacy")).toBeNull();
  process.env.MYBOT_ACCESS_CODE = "   ";
  expect(readAccessCode(join(dir, "other"), () => "legacy")).toBeNull();
});
