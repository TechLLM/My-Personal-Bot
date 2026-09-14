import { Hono } from "hono";
import { db, uid, now } from "./db";
import { resolveModel } from "./providers";
import { streamChat } from "./providers/openaiCompat";

// 스케줄 형식: "every:30m" | "every:2h" | "daily:08:30"
function nextRunAt(schedule: string, from = Date.now()): number | null {
  const ev = schedule.match(/^every:(\d+)(m|h)$/);
  if (ev) return from + Number(ev[1]) * (ev[2] === "h" ? 3600_000 : 60_000);
  const d = schedule.match(/^daily:(\d{1,2}):(\d{2})$/);
  if (d) {
    const t = new Date(from);
    t.setHours(Number(d[1]), Number(d[2]), 0, 0);
    if (t.getTime() <= from) t.setDate(t.getDate() + 1);
    return t.getTime();
  }
  return null;
}

export async function runRoutine(r: any): Promise<string> {
  // 루틴이 특정 봇에 배정된 경우 그 봇의 역할·모델로 실행 (봇의 상주 업무)
  const agent = r.agent_id
    ? (db.prepare("SELECT * FROM agents WHERE id = ?").get(r.agent_id) as any)
    : null;
  const useModel = agent?.model ?? r.model ?? "main";
  const { endpoint, model } = resolveModel(useModel);
  const messages = agent
    ? [
        { role: "system" as const, content: `당신은 "${agent.name}" 에이전트입니다. 역할: ${agent.role_prompt}\n예약된 정기 업무를 수행하고 결과를 보고하세요.` },
        { role: "user" as const, content: r.prompt },
      ]
    : [{ role: "user" as const, content: r.prompt }];
  let out = "";
  for await (const ev of streamChat(endpoint, model, messages, { signal: AbortSignal.timeout(300_000) })) {
    if (ev.type === "content") out += ev.text ?? "";
  }
  // 결과를 대화로 저장
  const convId = uid();
  const t = now();
  const title = `⏰ ${agent ? `${agent.avatar ?? "🤖"} ${agent.name} · ` : ""}${r.name}`;
  db.prepare("INSERT INTO conversations (id, title, model, mode, created_at, updated_at) VALUES (?, ?, ?, 'routine', ?, ?)").run(convId, title, useModel, t, t);
  const uId = uid();
  db.prepare("INSERT INTO messages (id, conversation_id, parent_id, role, content, created_at) VALUES (?, ?, NULL, 'user', ?, ?)").run(uId, convId, `[루틴] ${r.prompt}`, t);
  db.prepare("INSERT INTO messages (id, conversation_id, parent_id, role, content, model, created_at) VALUES (?, ?, ?, 'assistant', ?, ?, ?)").run(uid(), convId, uId, out, useModel, t);
  // 루틴 결과도 설정된 알림 채널로 발송
  if (out) {
    const { notifyResult } = await import("./notify");
    notifyResult(title, out);
  }
  return out;
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startScheduler() {
  if (timer) return;
  timer = setInterval(async () => {
    const rows = db.prepare("SELECT * FROM routines WHERE enabled = 1").all() as any[];
    const nowMs = Date.now();
    for (const r of rows) {
      const next = nextRunAt(r.schedule, r.last_run_at ?? r.created_at);
      if (next !== null && nowMs >= next) {
        db.prepare("UPDATE routines SET last_run_at = ? WHERE id = ?").run(nowMs, r.id);
        runRoutine(r).catch((e) => console.error(`[routine ${r.name}]`, e.message));
      }
    }
  }, 30_000);
}

export const routinesRoute = new Hono()
  .get("/", (c) => c.json({ routines: db.prepare("SELECT * FROM routines ORDER BY created_at").all() }))
  .post("/", async (c) => {
    const b = await c.req.json();
    if (!b.name?.trim() || !b.prompt?.trim() || !b.schedule) return c.json({ error: "name/prompt/schedule 필요" }, 400);
    if (!nextRunAt(b.schedule)) return c.json({ error: "schedule 형식: every:30m, every:2h, daily:08:30" }, 400);
    const id = uid();
    db.prepare("INSERT INTO routines (id, name, prompt, schedule, model, agent_id, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)").run(id, b.name, b.prompt, b.schedule, b.model ?? "main", b.agent_id || null, now());
    return c.json({ routine: db.prepare("SELECT * FROM routines WHERE id = ?").get(id) });
  })
  .post("/:id/toggle", (c) => {
    db.prepare("UPDATE routines SET enabled = 1 - enabled WHERE id = ?").run(c.req.param("id"));
    return c.json({ routine: db.prepare("SELECT * FROM routines WHERE id = ?").get(c.req.param("id")) });
  })
  .post("/:id/run", async (c) => {
    const r = db.prepare("SELECT * FROM routines WHERE id = ?").get(c.req.param("id")) as any;
    if (!r) return c.json({ error: "not found" }, 404);
    const out = await runRoutine(r);
    db.prepare("UPDATE routines SET last_run_at = ? WHERE id = ?").run(now(), r.id);
    return c.json({ ok: true, preview: out.slice(0, 500) });
  })
  .delete("/:id", (c) => {
    db.prepare("DELETE FROM routines WHERE id = ?").run(c.req.param("id"));
    return c.json({ ok: true });
  });
