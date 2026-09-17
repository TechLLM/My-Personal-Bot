import { Hono } from "hono";
import { db, uid, now } from "./db";
import { defaultModelId } from "./providers";

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

const runningRoutines = new Set<string>(); // 같은 루틴의 중복 실행 방지 — 스케줄러와 수동 실행이 겹치지 않게
export async function runRoutine(r: any): Promise<string> {
  if (runningRoutines.has(r.id)) return `루틴 "${r.name}"은(는) 이미 실행 중입니다`;
  runningRoutines.add(r.id);
  try { return await runRoutineInner(r); } finally { runningRoutines.delete(r.id); }
}
async function runRoutineInner(r: any): Promise<string> {
  // 모든 루틴은 봇 세션으로 실행 — 담당 봇, 없으면 대장 봇. 봇의 도구(검색/브라우저/파일/MCP) 사용 가능
  const { ensureBossAgent, getAgent, runAgent } = await import("./team");
  type TeamAgentState = import("./team").TeamAgentState;
  const agent = (r.agent_id ? getAgent(r.agent_id) : null) ?? ensureBossAgent();
  const useModel = agent.model ?? r.model ?? defaultModelId();

  const runId = uid();
  db.prepare("INSERT INTO agent_runs (id, agent_id, conversation_id, task, status, routine_id, created_at) VALUES (?, ?, NULL, ?, 'running', ?, ?)")
    .run(runId, agent.id, `[루틴] ${r.name}: ${r.prompt}`, r.id ?? null, now());
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

// 이메일 트리거 — IMAP으로 새 메일을 폴링해 필터(from/subject) 매칭 시 루틴 발화 (그록 이벤트 트리거 대응)
let emailChecking = false;
async function checkEmailTriggers() {
  const rows = db.prepare("SELECT * FROM routines WHERE enabled = 1 AND trigger_type = 'email'").all() as any[];
  if (!rows.length) return;
  const { getSetting } = await import("./db");
  const host = getSetting("imap_host"), user = getSetting("imap_user"), pass = getSetting("imap_pass");
  if (!host || !user || !pass) return;
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({ host, port: Number(getSetting("imap_port") || 993), secure: getSetting("imap_tls") !== "0", auth: { user, pass }, logger: false });
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      for (const r of rows) {
        const filter = JSON.parse(r.email_filter ?? "{}") as { from?: string; subject?: string };
        const criteria: any = { seen: false };
        if (filter.from) criteria.from = filter.from;
        if (filter.subject) criteria.subject = filter.subject;
        const uids = await client.search(criteria);
        if (!uids || !(uids as number[]).length) continue;
        for (const uidN of (uids as number[]).slice(0, 5)) {
          const msg = await client.fetchOne(String(uidN), { envelope: true });
          const subj = (msg && msg.envelope?.subject) || "";
          const from = (msg && msg.envelope?.from?.[0]?.address) || "";
          // 실제 메일 내용을 프롬프트에 포함해 봇이 맥락을 알고 작업
          const task = { ...r, prompt: `${r.prompt}\n\n[트리거된 메일]\n발신: ${from}\n제목: ${subj}` };
          db.prepare("UPDATE routines SET last_run_at = ? WHERE id = ?").run(Date.now(), r.id);
          await client.messageFlagsAdd(String(uidN), ["\\Seen"]).catch(() => {});
          runRoutine(task).catch((e) => console.error(`[routine ${r.name}]`, (e as Error).message));
        }
      }
    } finally { lock.release(); }
    await client.logout();
  } catch (e) {
    console.error("[mybot] 이메일 트리거 확인 실패:", (e as Error).message);
    try { await client.logout(); } catch {}
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startScheduler() {
  if (timer) return;
  timer = setInterval(async () => {
    const rows = db.prepare("SELECT * FROM routines WHERE enabled = 1 AND trigger_type != 'email'").all() as any[];
    const nowMs = Date.now();
    for (const r of rows) {
      const next = nextRunAt(r.schedule, r.last_run_at ?? r.created_at);
      if (next !== null && nowMs >= next) {
        db.prepare("UPDATE routines SET last_run_at = ? WHERE id = ?").run(nowMs, r.id);
        runRoutine(r).catch((e) => console.error(`[routine ${r.name}]`, e.message));
      }
    }
    if (!emailChecking) {
      emailChecking = true;
      checkEmailTriggers().finally(() => { emailChecking = false; });
    }
  }, 30_000);
}

export const routinesRoute = new Hono()
  .get("/", (c) => c.json({ routines: db.prepare("SELECT * FROM routines ORDER BY created_at").all() }))
  .post("/", async (c) => {
    const b = await c.req.json();
    const isEmail = b.trigger_type === "email";
    if (!b.name?.trim() || !b.prompt?.trim()) return c.json({ error: "name/prompt 필요" }, 400);
    if (isEmail) {
      const f = b.email_filter ?? {};
      if (!f.from && !f.subject) return c.json({ error: "email_filter의 from 또는 subject 필요" }, 400);
    } else if (!b.schedule || !nextRunAt(b.schedule)) {
      return c.json({ error: "schedule 형식: every:30m, every:2h, daily:08:30" }, 400);
    }
    if (b.agent_id && !db.prepare("SELECT 1 FROM agents WHERE id = ?").get(String(b.agent_id))) return c.json({ error: "agent_id에 해당하는 봇이 없습니다" }, 400);
    const id = uid();
    db.prepare("INSERT INTO routines (id, name, prompt, schedule, model, agent_id, enabled, trigger_type, email_filter, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)")
      .run(id, b.name, b.prompt, isEmail ? "email" : b.schedule, b.model ?? defaultModelId(), b.agent_id || null, isEmail ? "email" : "schedule", isEmail ? JSON.stringify(b.email_filter) : null, now());
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
