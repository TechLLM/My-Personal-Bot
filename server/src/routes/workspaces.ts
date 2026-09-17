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
    // C19 — 봇 배정: agent_ids가 오면 그 봇들의 workspace_id를 이 프로젝트로 동기화
    if (Array.isArray(b.agent_ids)) {
      db.prepare("UPDATE agents SET workspace_id = NULL WHERE workspace_id = ?").run(w.id);
      const ins = db.prepare("UPDATE agents SET workspace_id = ? WHERE id = ?");
      for (const aid of b.agent_ids) if (typeof aid === "string") ins.run(w.id, aid);
    }
    return c.json({ workspace: db.prepare("SELECT * FROM workspaces WHERE id = ?").get(w.id) });
  })
  .delete("/:id", (c) => {
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(c.req.param("id"));
    db.prepare("UPDATE conversations SET workspace_id = NULL WHERE workspace_id = ?").run(c.req.param("id"));
    return c.json({ ok: true });
  });

// 스킬 테이블 (없으면 생성)
// 스킬 테이블 정의는 db.ts로 이관됨 (스키마 단일 소스) — 이 파일은 기본 스킬 시드만 담당
db.exec(`INSERT OR IGNORE INTO skills (id, name, prompt, created_at) VALUES
  ('sk_summary', '요약', '다음 내용을 핵심만 간결하게 요약해줘:\n\n', ${now()}),
  ('sk_translate', '번역', '다음 내용을 자연스러운 한국어로 번역해줘 (이미 한국어면 영어로):\n\n', ${now()}),
  ('sk_review', '리뷰', '다음 코드를 리뷰해줘. 버그-성능-가독성-보안 순으로:\n\n', ${now()})`);

export const skillsRoute = new Hono()
  .get("/", (c) => c.json({ skills: db.prepare(`SELECT s.*, a.name agent_name,
    (SELECT COUNT(*) FROM skill_runs r WHERE r.skill_id = s.id AND r.ok IS NOT NULL) run_count,
    (SELECT COALESCE(SUM(r.ok),0) FROM skill_runs r WHERE r.skill_id = s.id AND r.ok IS NOT NULL) ok_count,
    (SELECT r.fail_reason FROM skill_runs r WHERE r.skill_id = s.id AND r.ok = 0 ORDER BY r.finished_at DESC LIMIT 1) last_fail
    FROM skills s LEFT JOIN agents a ON a.id = s.agent_id ORDER BY s.created_at`).all() }))
  .post("/", async (c) => {
    const b = await c.req.json();
    if (!b.name?.trim()) return c.json({ error: "name 필요" }, 400);
    const id = uid();
    try {
      db.prepare("INSERT INTO skills (id, name, prompt, agent_id, created_at) VALUES (?, ?, ?, ?, ?)").run(id, b.name.trim().replace(/^\//, ""), b.prompt ?? "", b.agent_id ?? null, now());
    } catch {
      return c.json({ error: "같은 이름의 스킬이 있습니다" }, 400);
    }
    return c.json({ skill: db.prepare("SELECT * FROM skills WHERE id = ?").get(id) });
  })
  // 봇별 활성화 — agent_id 지정 시 그 봇 전용, null이면 전체 공유. disabled로 비활성 해제 가능
  .patch("/:id", async (c) => {
    const s = db.prepare("SELECT * FROM skills WHERE id = ?").get(c.req.param("id")) as any;
    if (!s) return c.json({ error: "not found" }, 404);
    const b = await c.req.json();
    db.prepare("UPDATE skills SET prompt = ?, agent_id = ?, disabled = ? WHERE id = ?")
      .run(b.prompt ?? s.prompt, b.agent_id === undefined ? s.agent_id : b.agent_id, b.disabled === undefined ? s.disabled : (b.disabled ? 1 : 0), s.id);
    return c.json({ skill: db.prepare("SELECT * FROM skills WHERE id = ?").get(s.id) });
  })
  .delete("/:id", (c) => {
    db.prepare("DELETE FROM skills WHERE id = ?").run(c.req.param("id"));
    return c.json({ ok: true });
  });

// agentId 지정 시: 공유 스킬(agent_id NULL) + 해당 봇 전용 스킬만 사용 가능
export function getSkill(name: string, agentId?: string | null): { prompt: string } | null {
  return (db.prepare("SELECT * FROM skills WHERE name = ? AND disabled = 0 AND (agent_id IS NULL OR agent_id IS ?)").get(name, agentId ?? null) as any) ?? null;
}
