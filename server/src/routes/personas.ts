import { Hono } from "hono";
import { db, uid, now } from "../db";

const BUILTIN = [
  { name: "기본", prompt: "", avatar: "🤖" },
  { name: "Fun", prompt: "유머와 재치를 섞어 답변한다. 가벼운 밈이나 위트를 사용하고, 딱딱한 표현을 피한다. 그래도 정확성은 유지한다.", avatar: "😜" },
  { name: "번역가", prompt: "사용자가 보낸 텍스트를 한국어↔영어로 번역한다. 자연스럽고 문맥에 맞는 번역을 하고, 번역만 출력한다.", avatar: "🌐" },
  { name: "코드리뷰어", prompt: "코드를 분석할 때 버그, 성능, 가독성, 보안 순으로 지적한다. 개선 코드는 diff나 수정 예시로 보여준다.", avatar: "🔍" },
  { name: "선생님", prompt: "개념을 쉬운 비유와 단계별 설명으로 가르친다. 이해했는지 확인 질문을 덧붙인다.", avatar: "📚" },
];

export function seedPersonas() {
  const count = (db.prepare("SELECT COUNT(*) as n FROM personas").get() as any).n;
  if (count === 0) {
    for (const p of BUILTIN) {
      db.prepare("INSERT INTO personas (id, name, prompt, avatar, builtin, created_at) VALUES (?, ?, ?, ?, 1, ?)").run(uid(), p.name, p.prompt, p.avatar, now());
    }
  }
}

export const personasRoute = new Hono()
  .get("/", (c) => c.json({ personas: db.prepare("SELECT * FROM personas ORDER BY builtin DESC, created_at").all() }))
  .post("/", async (c) => {
    const body = await c.req.json();
    if (!body.name?.trim()) return c.json({ error: "name 필요" }, 400);
    const id = uid();
    db.prepare("INSERT INTO personas (id, name, prompt, avatar, builtin, created_at) VALUES (?, ?, ?, ?, 0, ?)").run(
      id, body.name.trim(), body.prompt ?? "", body.avatar ?? "🧑", now(),
    );
    return c.json({ persona: db.prepare("SELECT * FROM personas WHERE id = ?").get(id) });
  })
  .delete("/:id", (c) => {
    const p = db.prepare("SELECT builtin FROM personas WHERE id = ?").get(c.req.param("id")) as any;
    if (p?.builtin) return c.json({ error: "기본 페르소나는 삭제 불가" }, 400);
    db.prepare("DELETE FROM personas WHERE id = ?").run(c.req.param("id"));
    return c.json({ ok: true });
  });
