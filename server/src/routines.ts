import { Hono } from "hono";
import { db, uid, now } from "./db";

// 스케줄 형식: "every:30m" | "every:2h" | "daily:08:30"
export function nextRunAt(schedule: string, from = Date.now()): number | null {
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
  // 모든 루틴은 봇 세션으로 실행 — 담당 봇, 없으면 대장 봇. 봇의 도구(검색/브라우저/파일/MCP) 사용 가능
  const { ensureBossAgent, getAgent, runAgent } = await import("./team");
  type TeamAgentState = import("./team").TeamAgentState;
  const agent = (r.agent_id ? getAgent(r.agent_id) : null) ?? ensureBossAgent();
  const useModel = agent.model ?? r.model ?? "main";

  const runId = uid();
  db.prepare("INSERT INTO agent_runs (id, agent_id, conversation_id, task, status, created_at) VALUES (?, ?, NULL, ?, 'running', ?)")
    .run(runId, agent.id, `[루틴] ${r.name}: ${r.prompt}`, now());
  const state: TeamAgentState = {
    id: agent.id, runId,
    name: agent.name, avatar: agent.avatar ?? "🤖",
    role: agent.role_prompt, task: `예약된 정기 업무입니다. 수행하고 결과를 보고하세요.\n\n${r.prompt}`,
    model: useModel, status: "running", steps: 0, toolLog: [], depth: 0,
  };
  await runAgent(state, agent, () => {}, AbortSignal.timeout(540_000));
  db.prepare("UPDATE agent_runs SET status = ?, result = ?, steps = ?, tool_log = ?, finished_at = ? WHERE id = ?")
    .run(state.status, state.result ?? null, state.steps, JSON.stringify(state.toolLog), now(), runId);
  const out = state.result ?? "(결과 없음)";

  // 결과를 담당 봇의 메인 세션에 기록 — 봇 세션을 열면 루틴 수행 내역(도구 칩 포함)이 보임
  const title = `루틴 · ${agent.name} · ${r.name}`;
  {
    const { appendToAgentSession } = await import("./routes/chat");
    const { agentSessionConvId } = await import("./team");
    const runMeta = JSON.stringify({ type: "tools", events: state.toolLog.map((l) => ({ type: "read", title: l.tool, url: "" })) });
    const { normalizeReport } = await import("./report");
    appendToAgentSession(agentSessionConvId(agent.id), `[루틴] ${r.name}\n${r.prompt}`, await normalizeReport(agent.name, r.prompt, out), useModel, runMeta);
  }
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
