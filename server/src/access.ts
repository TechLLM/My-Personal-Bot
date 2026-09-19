import { timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import type { Hono } from "hono";

export function readAccessCode(path: string, legacy: () => string | null): string | null {
  if (process.env.MYBOT_ACCESS_CODE !== undefined) return process.env.MYBOT_ACCESS_CODE.trim() || null;
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? legacy() : null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) return null;
    return readFileSync(fd, "utf8").trim() || null;
  } finally { closeSync(fd); }
}

export function accessOrigins(port: number): string[] {
  return [
    `http://localhost:${port}`, `http://127.0.0.1:${port}`,
    ...(process.env.MYBOT_ALLOWED_ORIGINS ?? "https://bot.myxcloud.co.kr").split(",").map(s => s.trim()).filter(Boolean),
  ];
}

function matches(actual: string | undefined, expected: string): boolean {
  if (!actual || !expected) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function installAccessControl(app: Hono, readCode: () => string | null, origins: string[]) {
  const allowedOrigins = new Set(origins);
  const hosts = new Set(origins.map(o => new URL(o).hostname));
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!hosts.has(new URL(c.req.url).hostname)) return c.json({ error: "허용되지 않은 호스트입니다" }, 403);
    const origin = c.req.header("origin");
    if (origin && !allowedOrigins.has(origin)) return c.json({ error: "허용되지 않은 요청 출처입니다" }, 403);
    if (origin) { c.header("Access-Control-Allow-Origin", origin); c.header("Vary", "Origin"); }
    if (c.req.method === "OPTIONS") {
      c.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
      c.header("Access-Control-Allow-Headers", "Content-Type,X-Mybot-Key");
      return c.body(null, 204);
    }
    if (c.req.path === "/api/health" && c.req.method === "GET") return next();
    let code: string | null;
    try { code = readCode(); } catch { code = null; }
    if (!code) return c.json({ error: "접속 암호가 설정되지 않아 API가 잠겼습니다. 운영자가 접속 암호를 준비해야 합니다." }, 503);
    if (!matches(c.req.header("x-mybot-key"), code)) return c.json({ error: "접속 암호를 확인해 주세요" }, 401);
    return next();
  });
}
