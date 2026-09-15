import { Hono } from "hono";
import { db, uid, now } from "./db";

// ─── 승인 경계 (그록 Auto Review 대응) ───
// 위험한 액션(외부 발신·삭제·결제 류)은 실행 전 사용자 승인을 받는다.
// 규칙 우선순위: require > allow > 기본 위험 패턴. Require가 항상 이김 (그록과 동일)

// 기본 위험 패턴 — 규칙이 없어도 이름만으로 승인 요구 (파괴적·외부 영향 액션)
const DEFAULT_RISKY = /send_email|send_telegram|delete|publish|purchase|payment|pay_|_pay|submit_form|drop|execute_sql/i;
// 승인 면제 — 이름에 위험 단어가 있어도 실제로는 안전한 도구
const DEFAULT_SAFE = /routine_list|agent_list|read_|list_|_list|search|lookup/i;

export function approvalDecision(tool: string): "require" | "allow" {
  const rules = db.prepare("SELECT pattern, action FROM approval_rules").all() as { pattern: string; action: string }[];
  let hasAllow = false;
  for (const r of rules) {
    try {
      if (new RegExp(r.pattern, "i").test(tool)) {
        if (r.action === "require") return "require"; // require는 항상 우선
        hasAllow = true;
      }
    } catch {}
  }
  if (hasAllow) return "allow";
  if (DEFAULT_SAFE.test(tool)) return "allow";
  return DEFAULT_RISKY.test(tool) ? "require" : "allow";
}

// 도구 실행 전 호출 — 승인 필요면 요청을 만들고 안내 문자열 반환, 아니면 null
export function gateApproval(tool: string, args: Record<string, unknown>, agentId: string | null, resumeTask: string): string | null {
  let required = approvalDecision(tool) === "require";
  // 팀장의 봇 생성은 승인 필요 — 팝업 없이 봇이 폭증하는 것을 차단. 관리자(CEO)는 면제
  if (!required && tool === "agent_create" && agentId) {
    const a = db.prepare("SELECT is_boss FROM agents WHERE id = ?").get(agentId) as any;
    if (a && !a.is_boss) required = true;
  }
  if (!required) return null;
  const argsJson = canonicalArgs(args);
  // 최근에 이미 승인·실행된 동일 호출 — 승인 재개 봇의 재시도가 같은 팝업을 반복해 띄우는 것을 차단.
  // 재실행은 하지 않고 이전 실행 결과를 그대로 돌려준다 (비멱등 도구의 이중 실행 방지).
  const done = db.prepare("SELECT result FROM approval_requests WHERE status = 'approved' AND tool = ? AND agent_id IS ? AND args = ? AND resolved_at > ? ORDER BY resolved_at DESC LIMIT 1")
    .get(tool, agentId ?? null, argsJson, now() - 10 * 60_000) as { result: string | null } | undefined;
  if (done && !(done.result ?? "").startsWith("실행 오류") && !deleteTargetStillExists(tool, args)) {
    return `이미 승인되어 실행 완료된 동일한 호출입니다 — 이전 실행 결과: ${(done.result ?? "").slice(0, 500)}\n이 호출을 다시 요청하지 말고 작업을 계속하세요.`;
  }
  // 최근에 거부된 동일 호출 — 거부를 우회하는 재요청 팝업을 차단
  const denied = db.prepare("SELECT id FROM approval_requests WHERE status = 'denied' AND tool = ? AND agent_id IS ? AND args = ? AND resolved_at > ? LIMIT 1")
    .get(tool, agentId ?? null, argsJson, now() - 10 * 60_000);
  if (denied) {
    return `사용자가 이 호출(${tool})을 이미 거부했습니다 — 같은 호출을 다시 요청하지 말고, 다른 방법이 있으면 그것으로 진행하고 없으면 거부됐다고 보고하세요.`;
  }
  const dup = db.prepare("SELECT id FROM approval_requests WHERE status = 'pending' AND tool = ? AND agent_id IS ? AND args = ?").get(tool, agentId ?? null, argsJson) as any;
  if (!dup) {
    const summary = summarizeArgs(tool, args);
    db.prepare("INSERT INTO approval_requests (id, tool, args, summary, agent_id, resume, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)")
      .run(uid(), tool, argsJson, summary, agentId ?? null, resumeTask.slice(0, 500), now());
  }
  return `이 작업(${tool})은 사용자 승인이 필요합니다 — 화면의 승인 팝업에서 승인되면 자동으로 실행되고 작업이 이어집니다. 사용자에게 승인을 기다리고 있다고 알리고, 다른 작업으로 진행하세요. 같은 도구를 다시 호출해 재시도하지 마세요.`;
}

// 삭제 도구의 재승인 디듀프 예외 — 같은 이름으로 새 대상이 생겼으면 이번 호출은 반복이 아니라 새 삭제다
function deleteTargetStillExists(tool: string, args: Record<string, unknown>): boolean {
  if (tool === "routine_delete") {
    return !!db.prepare("SELECT 1 AS x FROM routines WHERE id = ?").get(String(args.id ?? ""));
  }
  if (tool === "agent_delete") {
    const name = String(args.name ?? "");
    const norm = name.replace(/\s+/g, "");
    return (db.prepare("SELECT name FROM agents").all() as { name: string }[])
      .some((a) => a.name === name || a.name.replace(/\s+/g, "") === norm);
  }
  return false;
}

// 키 순서가 다른 동일 인자를 같은 호출로 인식 — 디듀프·재승인 비교용
function canonicalArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args ?? {}).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = (args as any)[k];
  return JSON.stringify(out);
}

function summarizeArgs(tool: string, args: Record<string, unknown>): string {
  const parts = Object.entries(args ?? {}).slice(0, 4).map(([k, v]) => `${k}: ${String(v).slice(0, 120)}`);
  return `${tool}(${parts.join(", ")})`.slice(0, 400);
}

// ─── 봇 간 비동기 메시지 디스패치 (그록 DM 핸드오프 대응) ───
// 받는 봇을 백그라운드로 실행 → 완료되면 보낸 봇 세션에 회신 기록

export function dispatchAgentMessage(msgId: string) {
  (async () => {
    const msg = db.prepare("SELECT * FROM agent_messages WHERE id = ?").get(msgId) as any;
    if (!msg || msg.status !== "pending") return;
    const { getAgent, runAgent, agentSessionConvId, defaultModel } = await import("./team");
    const target = getAgent(msg.to_agent_id);
    if (!target) { db.prepare("UPDATE agent_messages SET status = 'failed', reply = '봇을 찾을 수 없음', done_at = ? WHERE id = ?").run(now(), msgId); return; }
    const sender = msg.from_agent_id ? getAgent(msg.from_agent_id) : null;
    const runId = uid();
    db.prepare("INSERT INTO agent_runs (id, agent_id, conversation_id, task, status, created_at) VALUES (?, ?, NULL, ?, 'running', ?)")
      .run(runId, target.id, `[${sender?.name ?? "사용자"} 메시지] ${msg.content.slice(0, 150)}`, now());
    db.prepare("UPDATE agent_messages SET status = 'processing' WHERE id = ?").run(msgId);
    const state: any = {
      id: target.id, runId, name: target.name, avatar: target.avatar ?? "🤖", role: target.role_prompt,
      task: `[${sender?.name ?? "사용자"} 봇의 비동기 메시지입니다. 처리하고 회신할 내용을 보고하세요 — 회신은 보낸 봇의 세션에 전달됩니다]\n\n${msg.content}`,
      model: target.model ?? defaultModel(), status: "running", steps: 0, toolLog: [], depth: 0,
    };
    try {
      await runAgent(state, target, () => {}, AbortSignal.timeout(540_000));
      db.prepare("UPDATE agent_runs SET status = ?, result = ?, steps = ?, tool_log = ?, finished_at = ? WHERE id = ?")
        .run(state.status, state.result ?? null, state.steps, JSON.stringify(state.toolLog), now(), runId);
      db.prepare("UPDATE agent_messages SET status = ?, reply = ?, done_at = ? WHERE id = ?")
        .run(state.status === "done" ? "done" : "failed", (state.result ?? "").slice(0, 4000), now(), msgId);
      // 양쪽 봇 세션에 기록 — 받는 봇은 처리 내역, 보낸 봇은 회신
      const { appendToAgentSession } = await import("./routes/chat");
      const { normalizeReport } = await import("./report");
      const meta = JSON.stringify({ type: "tools", events: state.toolLog.map((l: any) => ({ type: "read", title: l.tool, url: "" })) });
      const report = await normalizeReport(target.name, msg.content, state.result ?? "(결과 없음)", state.toolLog.map((l: any) => l.tool));
      appendToAgentSession(agentSessionConvId(target.id), `[${sender?.name ?? "사용자"} 메시지] ${msg.content}`, report, target.model, meta);
      if (sender) appendToAgentSession(agentSessionConvId(sender.id), `[${target.name} 회신 도착] ${msg.content.slice(0, 100)}`, report, target.model, meta);
    } catch (e) {
      db.prepare("UPDATE agent_messages SET status = 'failed', reply = ?, done_at = ? WHERE id = ?").run((e as Error).message, now(), msgId);
    }
  })().catch(() => {});
}

// ─── 승인 API ───

export const approvalsRoute = new Hono()
  .get("/", (c) => c.json({
    requests: db.prepare("SELECT r.*, a.name agent_name FROM approval_requests r LEFT JOIN agents a ON a.id = r.agent_id WHERE r.status = 'pending' ORDER BY r.created_at").all(),
    rules: db.prepare("SELECT * FROM approval_rules ORDER BY created_at").all(),
  }))
  .post("/:id/approve", async (c) => {
    const req = db.prepare("SELECT * FROM approval_requests WHERE id = ? AND status = 'pending'").get(c.req.param("id")) as any;
    if (!req) return c.json({ error: "요청 없음 또는 이미 처리됨" }, 404);
    const b = await c.req.json().catch(() => ({})) as { always?: boolean };
    if (b.always) {
      // 항상 허용 → 이 도구명에 allow 규칙 추가 (require 규칙이 있어도 require가 우선하므로 해당 규칙 삭제)
      db.prepare("INSERT INTO approval_rules (id, pattern, action, created_at) VALUES (?, ?, 'allow', ?)").run(uid(), `^${req.tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, now());
      db.prepare("DELETE FROM approval_rules WHERE action = 'require' AND pattern = ?").run(`^${req.tool}$`);
    }
    db.prepare("UPDATE approval_requests SET status = 'approved', resolved_at = ? WHERE id = ?").run(now(), req.id);
    // 저장된 도구를 실제로 실행한 뒤 봇의 원래 작업을 재개
    executeApproved(req).catch((e) => console.error("[mybot] 승인 작업 실행 실패:", (e as Error).message));
    return c.json({ ok: true });
  })
  .post("/:id/deny", async (c) => {
    const req = db.prepare("SELECT * FROM approval_requests WHERE id = ? AND status = 'pending'").get(c.req.param("id")) as any;
    if (!req) return c.json({ error: "요청 없음 또는 이미 처리됨" }, 404);
    const b = await c.req.json().catch(() => ({})) as { always?: boolean };
    if (b.always)
      db.prepare("INSERT INTO approval_rules (id, pattern, action, created_at) VALUES (?, ?, 'require', ?)").run(uid(), `^${req.tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, now());
    db.prepare("UPDATE approval_requests SET status = 'denied', resolved_at = ? WHERE id = ?").run(now(), req.id);
    notifyDenied(req).catch(() => {});
    return c.json({ ok: true });
  })
  .post("/rules", async (c) => {
    const b = await c.req.json();
    if (!b.pattern || !["require", "allow"].includes(b.action)) return c.json({ error: "pattern, action(require|allow) 필요" }, 400);
    try { new RegExp(String(b.pattern)); } catch { return c.json({ error: "정규식 오류" }, 400); }
    const id = uid();
    db.prepare("INSERT INTO approval_rules (id, pattern, action, created_at) VALUES (?, ?, ?, ?)").run(id, String(b.pattern), String(b.action), now());
    return c.json({ rule: db.prepare("SELECT * FROM approval_rules WHERE id = ?").get(id) });
  })
  .delete("/rules/:id", (c) => {
    db.prepare("DELETE FROM approval_rules WHERE id = ?").run(c.req.param("id"));
    return c.json({ ok: true });
  });

// 승인된 도구를 실제 실행 → 결과 저장 → 봇 작업 재개
async function executeApproved(req: any) {
  const { callBuiltin } = await import("./team");
  const { browserTool, BROWSER_TOOLS } = await import("./browser");
  const { mcpCall, mcpTools } = await import("./mcp");
  const args = JSON.parse(req.args ?? "{}");
  let result: string;
  try {
    if (BROWSER_TOOLS.some((t: any) => t.function.name === req.tool)) result = await browserTool(req.id, req.tool, args);
    else {
      const mcpNames = (await mcpTools().catch(() => [] as any[])).map((t: any) => t.function?.name ?? t.name);
      if (mcpNames.includes(req.tool)) result = await mcpCall(req.tool, args);
      else result = await callBuiltin(req.tool, args, req.agent_id);
    }
  } catch (e) { result = `실행 오류: ${(e as Error).message}`; }
  db.prepare("UPDATE approval_requests SET result = ? WHERE id = ?").run(result.slice(0, 4000), req.id);
  resumeAgent(req, `사용자가 승인한 작업 "${req.summary}"을 실행했습니다. 실행 결과:\n${result}\n\n원래 작업을 이어서 진행하고 결과를 보고하세요.\n\n원래 작업: ${req.resume || "(없음)"}`);
}

async function notifyDenied(req: any) {
  resumeAgent(req, `사용자가 작업 "${req.summary}"을 거부했습니다. 이 액션은 실행하지 마세요. 원래 작업이 다른 방법으로 가능하면 진행하고, 아니면 거부됐다고 보고하세요.\n\n원래 작업: ${req.resume || "(없음)"}`);
}

async function resumeAgent(req: any, task: string) {
  if (!req.agent_id) return;
  const { getAgent, runAgent, agentSessionConvId, defaultModel } = await import("./team");
  const agent = getAgent(req.agent_id);
  if (!agent) return;
  const runId = uid();
  db.prepare("INSERT INTO agent_runs (id, agent_id, conversation_id, task, status, created_at) VALUES (?, ?, NULL, ?, 'running', ?)")
    .run(runId, agent.id, `[승인 처리됨] ${req.tool} — 작업 재개`, now());
  const state: any = { id: agent.id, runId, name: agent.name, avatar: agent.avatar ?? "🤖", role: agent.role_prompt, task, model: agent.model ?? defaultModel(), status: "running", steps: 0, toolLog: [], depth: 0 };
  await runAgent(state, agent, () => {}, AbortSignal.timeout(540_000));
  db.prepare("UPDATE agent_runs SET status = ?, result = ?, steps = ?, tool_log = ?, finished_at = ? WHERE id = ?")
    .run(state.status, state.result ?? null, state.steps, JSON.stringify(state.toolLog), now(), runId);
  const { appendToAgentSession } = await import("./routes/chat");
  const { normalizeReport } = await import("./report");
  const meta = JSON.stringify({ type: "tools", events: state.toolLog.map((l: any) => ({ type: "read", title: l.tool, url: "" })) });
  appendToAgentSession(agentSessionConvId(agent.id), `[승인 처리 — 작업 재개] ${req.tool}`, await normalizeReport(agent.name, req.resume || req.tool, state.result ?? "(결과 없음)", state.toolLog.map((l: any) => l.tool)), agent.model, meta);
}
