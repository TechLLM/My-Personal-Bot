import { Hono } from "hono";
import { db, uid, now } from "../db";

// workspaces + skills + routines 통합 라우트
export const workspacesRoute = new Hono()
  .get("/", (c) => c.json({ workspaces: db.prepare("SELECT * FROM workspaces ORDER BY created_at").all() }))
  .post("/", async (c) => {
    const b = await c.req.json();
    if (!b.name?.trim()) return c.json({ error: "name 필요" }, 400);
    const id = uid();
    db.prepare("INSERT INTO workspaces (id, name, instructions, created_at) VALUES (?, ?, ?, ?)").run(id, b.name.trim(), b.instructions ?? "", now());
    return c.json({ workspace: db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) });
  })
  .patch("/:id", async (c) => {
    const b = await c.req.json();
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(c.req.param("id")) as any;
    if (!w) return c.json({ error: "not found" }, 404);
    db.prepare("UPDATE workspaces SET name = ?, instructions = ? WHERE id = ?").run(b.name ?? w.name, b.instructions ?? w.instructions, w.id);
    return c.json({ workspace: db.prepare("SELECT * FROM workspaces WHERE id = ?").get(w.id) });
  })
  .delete("/:id", (c) => {
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(c.req.param("id"));
    db.prepare("UPDATE conversations SET workspace_id = NULL WHERE workspace_id = ?").run(c.req.param("id"));
    return c.json({ ok: true });
  });

// 스킬 테이블 (없으면 생성)
db.exec(`CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, prompt TEXT NOT NULL, created_at INTEGER NOT NULL
)`);
db.exec(`INSERT OR IGNORE INTO skills (id, name, prompt, created_at) VALUES
  ('sk_summary', '요약', '다음 내용을 핵심만 간결하게 요약해줘:\n\n', ${now()}),
  ('sk_translate', '번역', '다음 내용을 자연스러운 한국어로 번역해줘 (이미 한국어면 영어로):\n\n', ${now()}),
  ('sk_review', '리뷰', '다음 코드를 리뷰해줘. 버그-성능-가독성-보안 순으로:\n\n', ${now()})`);

export const skillsRoute = new Hono()
  .get("/", (c) => c.json({ skills: db.prepare("SELECT * FROM skills ORDER BY created_at").all() }))
  .post("/", async (c) => {
    const b = await c.req.json();
    if (!b.name?.trim()) return c.json({ error: "name 필요" }, 400);
    const id = uid();
    try {
      db.prepare("INSERT INTO skills (id, name, prompt, created_at) VALUES (?, ?, ?, ?)").run(id, b.name.trim().replace(/^\//, ""), b.prompt ?? "", now());
    } catch {
      return c.json({ error: "같은 이름의 스킬이 있습니다" }, 400);
    }
    return c.json({ skill: db.prepare("SELECT * FROM skills WHERE id = ?").get(id) });
  })
  .delete("/:id", (c) => {
    db.prepare("DELETE FROM skills WHERE id = ?").run(c.req.param("id"));
    return c.json({ ok: true });
  });

export function getSkill(name: string): { prompt: string } | null {
  return (db.prepare("SELECT * FROM skills WHERE name = ?").get(name) as any) ?? null;
}
