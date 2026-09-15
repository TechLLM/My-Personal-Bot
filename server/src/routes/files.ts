import { Hono } from "hono";
import { join } from "node:path";
import { existsSync } from "node:fs";

const FILES_DIR = join(import.meta.dir, "..", "..", "data", "files");

export const filesRoute = new Hono().get("/:name", (c) => {
  const name = c.req.param("name").replace(/[^a-zA-Z0-9._-]/g, "");
  const path = join(FILES_DIR, name);
  // ".." 같은 이름이 join으로 상위 디렉터리를 가리키지 못하게 — FILES_DIR 밖이면 차단
  if (!path.startsWith(FILES_DIR + "/") || !existsSync(path)) return c.json({ error: "not found" }, 404);
  const ext = name.split(".").pop() ?? "png";
  const mime = ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "application/octet-stream";
  return new Response(Bun.file(path).stream(), { headers: { "Content-Type": mime, "Cache-Control": "public, max-age=31536000" } });
});
