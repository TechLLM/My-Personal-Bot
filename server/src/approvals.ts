import { Hono } from "hono";
import { db, uid, now, getSetting } from "./db";

// ─── 승인 경계 (그록 Auto Review 대응) ───
// 위험한 액션(외부 발신·삭제·결제 류)은 실행 전 사용자 승인을 받는다.
// 규칙 우선순위: require > allow > 기본 위험 패턴. Require가 항상 이김 (그록과 동일)

// 기본 위험 패턴 — 규칙이 없어도 이름만으로 승인 요구 (파괴적·외부 영향 액션)
const DEFAULT_RISKY = /send_email|send_telegram|delete|publish|purchase|payment|pay_|_pay|submit_form|drop|execute_sql/i;
// 승인 면제 — 이름에 위험 단어가 있어도 실제로는 안전한 도구
const DEFAULT_SAFE = /routine_list|agent_list|read_|list_|_list|search|lookup/i;

export function approvalDecision(tool: string, args?: Record<string, unknown>): "require" | "allow" {
  const rules = db.prepare("SELECT pattern, action, cond FROM approval_rules").all() as { pattern: string; action: string; cond: string | null }[];
  let hasAllow = false;
  for (const r of rules) {
    try {
      if (!new RegExp(r.pattern, "i").test(tool)) continue;
      // A12 — 인자 조건 규칙: cond가 있으면 args가 조건을 만족할 때만 규칙 적용
      if (r.cond && !evalCond(r.cond, args ?? {})) continue;
      if (r.action === "require") return "require"; // require는 항상 우선
      hasAllow = true;
    } catch {}
  }
  if (hasAllow) return "allow";
  if (DEFAULT_SAFE.test(tool)) return "allow";
  return DEFAULT_RISKY.test(tool) ? "require" : "allow";
}

// A12 — 인자 조건 평가: cond = {"field":"to","op":"matches","value":"@외부\\.com$"}
// 지원 op: eq | ne | contains | matches(regex) | gt | lt | exists
function evalCond(condJson: string, args: Record<string, unknown>): boolean {
  const c = JSON.parse(condJson);
  const v = args?.[String(c.field)];
  switch (c.op) {
    case "eq": return v === c.value;
    case "ne": return v !== c.value;
    case "contains": return String(v ?? "").includes(String(c.value));
    case "matches": return new RegExp(String(c.value), "i").test(String(v ?? ""));
    case "gt": return Number(v) > Number(c.value);
    case "lt": return Number(v) < Number(c.value);
    case "exists": return v !== undefined && v !== null && v !== "";
    default: return false;
  }
}

// agent_create 인자에서 생성 예정 수 — bots/names 배열 또는 단일 name
function prospectiveCreateCount(args: Record<string, unknown>): number {
  if (Array.isArray(args.bots)) return args.bots.length;
  if (Array.isArray(args.agents)) return args.agents.length;
  if (Array.isArray(args.names)) return args.names.length;
  return (args.name ?? args.bot_name ?? args.agent) ? 1 : 0;
}

// 도구 실행 전 호출 — 승인 필요면 요청을 만들고 안내 문자열 반환, 아니면 null
export function gateApproval(tool: string, args: Record<string, unknown>, agentId: string | null, resumeTask: string): string | null {
  let required = approvalDecision(tool, args) === "require";
  // A6/C7 — 봇 생성은 정원 내면 승인 면제(팀장 포함). 전체 정원(agent_cap_total, 기본 20)
  // 초과분만 승인 대상. 팀장의 max_children 한도는 도구 내부에서 거부하므로 여기선 보지 않는다.
  if (!required && tool === "agent_create") {
    const want = prospectiveCreateCount(args);
    const total = (db.prepare("SELECT COUNT(*) c FROM agents").get() as any).c;
    if (want > 0 && total + want > (Number(getSetting("agent_cap_total")) || 20)) required = true;
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
    // 원자적 클레임 — pending→processing 전이가 성공한 디스패치만 진행 (동시 디스패치 중복 실행 방지)
    const claimed = db.prepare("UPDATE agent_messages SET status = 'processing' WHERE id = ? AND status = 'pending'").run(msgId);
    if (!claimed.changes) return;
    const { getAgent, runAgentDetached } = await import("./team");
    const target = getAgent(msg.to_agent_id);
    if (!target) { db.prepare("UPDATE agent_messages SET status = 'failed', reply = '봇을 찾을 수 없음', done_at = ? WHERE id = ?").run(now(), msgId); return; }
    const sender = msg.from_agent_id ? getAgent(msg.from_agent_id) : null;
    runAgentDetached(target, {
      label: `[${sender?.name ?? "사용자"} 메시지] ${msg.content.slice(0, 150)}`,
      task: `[${sender?.name ?? "사용자"} 봇의 비동기 메시지입니다. 처리하고 회신할 내용을 보고하세요 — 회신은 보낸 봇의 세션에 전달됩니다]\n\n${msg.content}`,
      sessionTitle: `[${sender?.name ?? "사용자"} 메시지] ${msg.content}`,
      sessionTask: msg.content,
      replyTo: sender,
      verifyIntent: false, // 메시지 본문은 보고·알림 — 지시-실측 검증 대상이 아님 (보고 속 단어를 지시로 오독해 반대 실행을 강제하는 사고 방지)
      onDone: (state) => {
        db.prepare("UPDATE agent_messages SET status = ?, reply = ?, done_at = ? WHERE id = ?")
          .run(state.status === "done" ? "done" : "failed", (state.result?.trim() || "(결과 없음)").slice(0, 4000), now(), msgId);
      },
    });
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
    // A12 — 선택적 인자 조건 {"field","op","value"} — JSON 형식과 op만 검증
    let cond: string | null = null;
    if (b.cond) {
      try {
        const cc = typeof b.cond === "string" ? JSON.parse(b.cond) : b.cond;
        if (!cc.field || !cc.op) return c.json({ error: "cond에는 field와 op가 필요합니다" }, 400);
        cond = JSON.stringify({ field: String(cc.field), op: String(cc.op), value: cc.value });
      } catch { return c.json({ error: "cond JSON 오류" }, 400); }
    }
    const id = uid();
    db.prepare("INSERT INTO approval_rules (id, pattern, action, cond, created_at) VALUES (?, ?, ?, ?, ?)").run(id, String(b.pattern), String(b.action), cond, now());
    return c.json({ rule: db.prepare("SELECT * FROM approval_rules WHERE id = ?").get(id) });
  })
  .delete("/rules/:id", (c) => {
    db.prepare("DELETE FROM approval_rules WHERE id = ?").run(c.req.param("id"));
    return c.json({ ok: true });
  })
  // 감사 뷰 — 봇 활동 이력: 실행 이력(agent_runs) + 승인 요청(approval_requests) 통합 조회
  // 필터: agent_id, tool(tool_log LIKE), days(기본 7일)
  .get("/activity", (c) => {
    const agentId = c.req.query("agent_id") || null;
    const tool = c.req.query("tool") || null;
    const days = Math.min(Math.max(Number(c.req.query("days")) || 7, 1), 90);
    const since = now() - days * 86400_000;
    const runArgs: unknown[] = [since];
    let runSql = `SELECT r.id, r.agent_id, a.name agent_name, a.avatar, r.task, r.status, r.steps, r.routine_id, r.resume_count, r.created_at, r.finished_at
      FROM agent_runs r LEFT JOIN agents a ON a.id = r.agent_id WHERE r.created_at > ?`;
    if (agentId) { runSql += " AND r.agent_id = ?"; runArgs.push(agentId); }
    if (tool) { runSql += " AND r.tool_log LIKE ?"; runArgs.push(`%"tool":"${tool.replace(/"/g, "")}"%`); }
    runSql += " ORDER BY r.created_at DESC LIMIT 200";
    const runs = db.prepare(runSql).all(...(runArgs as any[]));
    const apArgs: unknown[] = [since];
    let apSql = `SELECT r.id, r.agent_id, a.name agent_name, r.tool, r.summary, r.status, r.created_at, r.resolved_at
      FROM approval_requests r LEFT JOIN agents a ON a.id = r.agent_id WHERE r.created_at > ?`;
    if (agentId) { apSql += " AND r.agent_id = ?"; apArgs.push(agentId); }
    if (tool) { apSql += " AND r.tool = ?"; apArgs.push(tool); }
    apSql += " ORDER BY r.created_at DESC LIMIT 200";
    const approvals = db.prepare(apSql).all(...(apArgs as any[]));
    return c.json({ runs, approvals });
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
  const { getAgent, runAgentDetached, agentSessionConvId } = await import("./team");
  const agent = getAgent(req.agent_id);
  if (!agent) return;
  // 재개 폭주 방지 — 승인이 한꺼번에 처리되면 "원래 작업 재개" run이 봇당 수십 개 쌓인다.
  // 최근 10분에 재개 run이 3개를 넘으면 run을 새로 돌리지 않고 결과만 세션에 기록한다
  // (결과 자체는 approval_requests.result에도 남아 있고 세션 노트로 맥락이 유지된다).
  const recentResumes = (db.prepare("SELECT COUNT(*) c FROM agent_runs WHERE agent_id = ? AND task LIKE '[승인 처리됨]%' AND created_at > ?").get(agent.id, now() - 10 * 60_000) as any)?.c ?? 0;
  if (recentResumes >= 3) {
    const { appendToAgentSession } = await import("./routes/chat");
    const { normalizeReport } = await import("./report");
    appendToAgentSession(agentSessionConvId(agent.id), `[승인 처리 — 결과 기록] ${req.tool}`, await normalizeReport(agent.name, req.resume || req.tool, task), agent.model, null);
    return;
  }
  runAgentDetached(agent, {
    label: `[승인 처리됨] ${req.tool} — 작업 재개`,
    task,
    sessionTitle: `[승인 처리 — 작업 재개] ${req.tool}`,
    sessionTask: req.resume || req.tool,
  });
}
