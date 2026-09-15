import { Hono } from "hono";
import { db, uid, now } from "../db";

// 그룹채팅 — 여러 봇(2~6)이 하나의 대화에 참여. 그록봇 group chat 대응
export function groupConvId(groupId: string): string | null {
  const conv = db.prepare("SELECT id FROM conversations WHERE group_id = ? ORDER BY created_at LIMIT 1").get(groupId) as any;
  if (conv) return conv.id;
  const g = db.prepare("SELECT * FROM groups WHERE id = ?").get(groupId) as any;
  if (!g) return null;
  const id = uid();
  db.prepare("INSERT INTO conversations (id, title, group_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, g.name, groupId, now(), now());
  return id;
}

export function groupMembers(groupId: string): any[] {
  const g = db.prepare("SELECT * FROM groups WHERE id = ?").get(groupId) as any;
  if (!g) return [];
  const ids: string[] = JSON.parse(g.agent_ids ?? "[]");
  return ids.map((id) => db.prepare("SELECT * FROM agents WHERE id = ?").get(id)).filter(Boolean);
}

const shape = (g: any) => ({ ...g, agent_ids: JSON.parse(g.agent_ids ?? "[]"), members: groupMembers(g.id).map((a) => ({ id: a.id, name: a.name, avatar: a.avatar, role_prompt: a.role_prompt, model: a.model })) });

export const groupsRoute = new Hono()
  .get("/", (c) => c.json({ groups: (db.prepare("SELECT * FROM groups ORDER BY created_at").all() as any[]).map(shape) }))
  .post("/", async (c) => {
    const b = await c.req.json();
    const ids: string[] = Array.isArray(b.agent_ids) ? b.agent_ids.map(String).filter((id: string) => db.prepare("SELECT 1 FROM agents WHERE id = ?").get(id)) : [];
    if (!b.name?.trim() || ids.length < 1) return c.json({ error: "name과 agent_ids(1개 이상) 필요" }, 400);
    const id = uid();
    db.prepare("INSERT INTO groups (id, name, agent_ids, created_at) VALUES (?, ?, ?, ?)").run(id, String(b.name).slice(0, 50), JSON.stringify(ids.slice(0, 6)), now());
    return c.json({ group: shape(db.prepare("SELECT * FROM groups WHERE id = ?").get(id)) });
  })
  .post("/:id/conversation", (c) => {
    const convId = groupConvId(c.req.param("id"));
    return convId ? c.json({ conversation_id: convId }) : c.json({ error: "그룹 없음" }, 404);
  })
  .patch("/:id", async (c) => {
    const g = db.prepare("SELECT * FROM groups WHERE id = ?").get(c.req.param("id")) as any;
    if (!g) return c.json({ error: "그룹 없음" }, 404);
    const b = await c.req.json();
    if (b.agent_ids !== undefined) {
      // 존재하는 봇만 멤버로 — 삭제된 봇 ID가 멤버로 남지 않게 생성 시와 같은 필터 적용
      b.agent_ids = (b.agent_ids as string[]).map(String).filter((id: string) => db.prepare("SELECT 1 FROM agents WHERE id = ?").get(id));
      if (b.agent_ids.length < 1) return c.json({ error: "agent_ids(유효한 봇 1개 이상) 필요" }, 400);
    }
    db.prepare("UPDATE groups SET name = ?, agent_ids = ? WHERE id = ?").run(
      b.name ? String(b.name).slice(0, 50) : g.name,
      b.agent_ids ? JSON.stringify((b.agent_ids as string[]).slice(0, 6)) : g.agent_ids, g.id);
    return c.json({ group: shape(db.prepare("SELECT * FROM groups WHERE id = ?").get(g.id)) });
  })
  .delete("/:id", (c) => {
    db.prepare("DELETE FROM groups WHERE id = ?").run(c.req.param("id"));
    db.prepare("UPDATE conversations SET group_id = NULL WHERE group_id = ?").run(c.req.param("id"));
    return c.json({ ok: true });
  });
