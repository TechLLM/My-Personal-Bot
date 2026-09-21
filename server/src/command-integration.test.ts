import { afterEach, beforeEach, expect, test } from "bun:test";
import { approvalResumeOptions, approvalsRoute, executeApproved, gateApproval, resolveApprovalFileRoot, type ApprovalGateContext } from "./approvals";
import { browserApprovalSnapshot, hasBrowserLease, ownsBrowserLease, releaseBrowserLease, sitesRoute } from "./browser";
import { db, now } from "./db";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { dispatchToolCall } from "./toolloop";
import { chatRoute } from "./routes/chat";
import { registeredRunControllerCount } from "./run-control";

if (db.filename !== ":memory:") throw new Error(`테스트가 운영 DB를 열었습니다: ${db.filename}`);

const prefix = "contract-";
const savedFetch = globalThis.fetch;
const scopeHash = (raw: any) => createHash("sha256").update(JSON.stringify([
  raw.rootJobId, raw.browserKey, raw.runKey, raw.fileRoot, raw.depth, raw.conversationId, raw.browserSnapshot, raw.chain,
])).digest("hex");
const approvalCtx = (key: string): ApprovalGateContext => ({ browserKey: key, runKey: key, fileRoot: null, depth: 0, conversationId: null });

function queueApproved(id: string, tool: string, args: Record<string, unknown>) {
  const argsJson = JSON.stringify(args);
  const out = gateApproval(tool, args, null, "contract resume", [], undefined, approvalCtx(id), true);
  expect(out).toContain("사용자 승인이 필요합니다");
  const row = db.prepare("SELECT id FROM approval_requests WHERE tool = ? AND args = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(tool, argsJson) as { id: string };
  db.prepare("UPDATE approval_requests SET id = ?, status = 'approved', resolved_at = ? WHERE id = ?").run(id, now(), row.id);
}

beforeEach(() => {
  db.prepare("DELETE FROM approval_rules WHERE id LIKE ?").run(`${prefix}%`);
  db.prepare("DELETE FROM approval_requests WHERE id LIKE ? OR root_job_id LIKE ?").run(`${prefix}%`, `${prefix}%`);
  db.prepare("DELETE FROM credential_requests WHERE id LIKE ? OR root_job_id LIKE ?").run(`${prefix}%`, `${prefix}%`);
  db.prepare("DELETE FROM site_logins WHERE id LIKE ? OR name LIKE ?").run(`${prefix}%`, `${prefix}%`);
  db.prepare("DELETE FROM command_job_results WHERE root_job_id LIKE ?").run(`${prefix}%`);
  db.prepare("DELETE FROM command_jobs WHERE id LIKE ?").run(`${prefix}%`);
  db.prepare("DELETE FROM memories WHERE content LIKE ?").run(`${prefix}%`);
  globalThis.fetch = (async () => new Response('{"error":"test"}', { status: 400 })) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  db.prepare("DELETE FROM approval_rules WHERE pattern LIKE '%contract%' OR id LIKE ?").run(`${prefix}%`);
  db.prepare("DELETE FROM approval_requests WHERE id LIKE ? OR root_job_id LIKE ?").run(`${prefix}%`, `${prefix}%`);
  db.prepare("DELETE FROM credential_requests WHERE id LIKE ? OR root_job_id LIKE ?").run(`${prefix}%`, `${prefix}%`);
  db.prepare("DELETE FROM site_logins WHERE id LIKE ? OR name LIKE ?").run(`${prefix}%`, `${prefix}%`);
  db.prepare("DELETE FROM command_job_results WHERE root_job_id LIKE ?").run(`${prefix}%`);
  db.prepare("DELETE FROM command_jobs WHERE id LIKE ?").run(`${prefix}%`);
  db.prepare("DELETE FROM memories WHERE content LIKE ?").run(`${prefix}%`);
});

test("동일 승인은 서로 다른 root에서 각각 대기하고 같은 root의 대체만 격리된다", () => {
  gateApproval("agent_update", { name: "contract-target", role: "v1" }, null, "작업", [], "contract-root-a", approvalCtx("contract-browser"));
  gateApproval("agent_update", { name: "contract-target", role: "v1" }, null, "작업", [], "contract-root-b", approvalCtx("contract-browser"));
  expect((db.prepare("SELECT COUNT(*) n FROM approval_requests WHERE status = 'pending' AND root_job_id LIKE 'contract-root-%'").get() as any).n).toBe(2);

  gateApproval("agent_update", { name: "contract-target", role: "v2" }, null, "작업", [], "contract-root-a", approvalCtx("contract-browser"));
  expect((db.prepare("SELECT COUNT(*) n FROM approval_requests WHERE status = 'expired' AND root_job_id = 'contract-root-a'").get() as any).n).toBe(1);
  expect((db.prepare("SELECT COUNT(*) n FROM approval_requests WHERE status = 'pending' AND root_job_id = 'contract-root-b'").get() as any).n).toBe(1);
});

function delayedJson(value: unknown) {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      await wait;
      controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
      controller.close();
    },
  });
  return { body, release };
}

test("동시에 본 stale 승인·거부 중 CAS 패자 규칙은 영구 저장되지 않는다", async () => {
  db.prepare("INSERT INTO approval_requests (id, tool, args, summary, status, created_at) VALUES (?, ?, '{}', 'contract', 'pending', ?)")
    .run("contract-race", "contract_action", now());
  const deny = delayedJson({ always: true });
  const approve = delayedJson({ always: true });
  const denyCall = approvalsRoute.request("/contract-race/deny", { method: "POST", headers: { "content-type": "application/json" }, body: deny.body });
  const approveCall = approvalsRoute.request("/contract-race/approve", { method: "POST", headers: { "content-type": "application/json" }, body: approve.body });
  await Promise.resolve();
  deny.release();
  expect((await denyCall).status).toBe(200);
  approve.release();
  expect((await approveCall).status).toBe(409);
  const rules = db.prepare("SELECT action FROM approval_rules WHERE pattern = '^contract_action$'").all() as { action: string }[];
  expect(rules.map((r) => r.action)).toEqual(["require"]);
});

test("만료되거나 대상 URL이 다른 계정 요청은 기존 계정을 변경하지 않는다", async () => {
  db.prepare("INSERT INTO site_logins (id, name, url, username, password, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("contract-site", "contract-site", "https://safe.example/login", "old-user", "fake-ciphertext", now());
  db.prepare("INSERT INTO credential_requests (id, name, url, status, created_at) VALUES (?, ?, ?, 'pending', ?)")
    .run("contract-cred", "contract-site", "https://safe.example/login", now());
  const res = await sitesRoute.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request_id: "contract-cred", name: "contract-site", url: "https://evil.example/login", username: "new-user", password: "secret" }),
  });
  expect(res.status).toBe(409);
  const site = db.prepare("SELECT url, username, password FROM site_logins WHERE id = 'contract-site'").get() as any;
  expect(site).toEqual({ url: "https://safe.example/login", username: "old-user", password: "fake-ciphertext" });
  expect((db.prepare("SELECT status FROM credential_requests WHERE id = 'contract-cred'").get() as any).status).toBe("pending");
});

test("봇 없는 승인 거부는 pending으로 남지 않고 자동 재개 불가 결과를 기록한다", async () => {
  db.prepare("INSERT INTO approval_requests (id, tool, args, summary, agent_id, status, created_at) VALUES (?, ?, '{}', 'contract deny', NULL, 'pending', ?)")
    .run("contract-null-agent", "contract_action", now());
  const res = await approvalsRoute.request("/contract-null-agent/deny", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(res.status).toBe(200);
  const row = db.prepare("SELECT status, result FROM approval_requests WHERE id = 'contract-null-agent'").get() as any;
  expect(row.status).toBe("denied");
  expect(row.result).toContain("업무 자동 재개 불가");
});

test("activity 응답은 실행 args와 민감한 기술 요약을 노출하지 않는다", async () => {
  db.prepare("INSERT INTO approval_requests (id, tool, args, summary, status, execution_context, created_at) VALUES (?, 'send_email', ?, ?, 'denied', ?, ?)")
    .run("contract-activity", JSON.stringify({ to: "secret@example.com", body: "TOP-SECRET-BODY" }), "raw_summary_TOP_SECRET", '{"sentinel":"PRIVATE-CONTEXT"}', now());
  const res = await approvalsRoute.request("/activity?days=1");
  const text = await res.text();
  expect(text).not.toContain("TOP-SECRET-BODY");
  expect(text).not.toContain("raw_summary_TOP_SECRET");
  expect(text).not.toContain("PRIVATE-CONTEXT");
  expect(text).not.toContain("execution_context");
  expect(text).not.toContain('"args"');
  expect(JSON.parse(text).approvals.some((r: any) => r.id === "contract-activity")).toBe(true);
});

test("pending 승인 목록은 private execution context를 노출하지 않는다", async () => {
  gateApproval("send_email", { to: "pending@example.com", subject: "pending" }, null, "resume", [], "contract-pending-private", {
    browserKey: "PRIVATE-PENDING-BROWSER", runKey: "PRIVATE-PENDING-RUN", fileRoot: null, depth: 1, conversationId: "PRIVATE-PENDING-CONVERSATION",
  });
  const text = await (await approvalsRoute.request("/")).text();
  expect(text).not.toContain("PRIVATE-PENDING");
  expect(text).not.toContain("execution_context");
  expect(text).not.toContain("fileRoot");
});

test("승인 재실행은 호출자가 위조한 값 대신 DB 원본과 저장된 실행 맥락을 공용 dispatcher에 전달한다", async () => {
  const args = { content: "contract-original" };
  const context: ApprovalGateContext = {
    browserKey: "contract-browser-original", runKey: "contract-run-original", fileRoot: null,
    depth: 2, conversationId: "contract-conversation",
  };
  gateApproval("memory_save", args, null, "contract original task", ["parent-a", "parent-b"], undefined, context, true);
  const queued = db.prepare("SELECT id FROM approval_requests WHERE tool = 'memory_save' AND status = 'pending' AND args = ?").get(JSON.stringify(args)) as { id: string };
  db.prepare("UPDATE approval_requests SET id = 'contract-exact-context', status = 'approved', resolved_at = ? WHERE id = ?").run(now(), queued.id);
  let seen: any = null;
  let resumed = 0;
  await executeApproved({ id: "contract-exact-context", tool: "forged_tool", args: '{"content":"forged"}' }, {
    dispatch: async (tool, dispatchedArgs, ctx) => {
      seen = { tool, args: dispatchedArgs, ctx };
      return { out: "contract dispatched", ok: true };
    },
    resume: async () => { resumed++; return { registered: false, note: "" }; },
  });
  expect(seen.tool).toBe("memory_save");
  expect(seen.args).toEqual(args);
  expect(seen.ctx).toMatchObject({
    agentId: null,
    browserKey: "contract-browser-original",
    runKey: "contract-run-original",
    conversationId: "contract-conversation",
    depth: 2,
    chain: ["parent-a", "parent-b"],
  });
  expect(seen.ctx.fileRoot).toBeUndefined();
  expect(seen.ctx.signal).toBeInstanceOf(AbortSignal);
  expect(resumed).toBe(1);
  expect((db.prepare("SELECT status, result FROM approval_requests WHERE id = 'contract-exact-context'").get() as any).status).toBe("approved");
});

test("승인 당시 symlink fileRoot의 canonical 프로젝트를 고정해 alias 재지정이 실행 대상을 바꾸지 못한다", async () => {
  const base = resolveApprovalFileRoot(null);
  const projectA = mkdtempSync(join(base, "contract-project-a-"));
  const projectB = mkdtempSync(join(base, "contract-project-b-"));
  const alias = join(base, `contract-project-link-${Date.now()}`);
  try {
    symlinkSync(projectA, alias);
    const context: ApprovalGateContext = { browserKey: "contract-link-browser", runKey: "contract-link-run", fileRoot: alias, depth: 0, conversationId: null };
    gateApproval("memory_save", { content: "contract-link-target" }, null, "link target", [], undefined, context, true);
    const queued = db.prepare("SELECT id, execution_context FROM approval_requests WHERE status = 'pending' AND args = ?").get('{"content":"contract-link-target"}') as any;
    expect(JSON.parse(queued.execution_context).fileRoot).toBe(projectA);
    db.prepare("UPDATE approval_requests SET id = 'contract-link-approved', status = 'approved', resolved_at = ? WHERE id = ?").run(now(), queued.id);
    rmSync(alias, { force: true });
    symlinkSync(projectB, alias);
    let dispatchedRoot: string | undefined;
    await executeApproved({ id: "contract-link-approved" }, {
      dispatch: async (_tool, _args, ctx) => { dispatchedRoot = ctx.fileRoot; return { out: "ok", ok: true }; },
      resume: async () => ({ registered: false, note: "" }),
    });
    expect(dispatchedRoot).toBe(projectA);
    expect(dispatchedRoot).not.toBe(projectB);
  } finally {
    rmSync(alias, { force: true });
    rmSync(projectA, { recursive: true, force: true });
    rmSync(projectB, { recursive: true, force: true });
  }
});

test("손상·소유권 불일치·workspace 밖 승인 맥락은 dispatch와 resume 없이 실패로 닫힌다", async () => {
  const outside = import.meta.dir;
  const cases = [
    { id: "contract-bad-json", mutate: () => "{" },
    { id: "contract-bad-owner", mutate: (raw: any) => JSON.stringify({ ...raw, agentId: "forged-agent" }) },
    { id: "contract-bad-root", mutate: (raw: any) => {
      const changed = { ...raw, fileRoot: outside };
      changed.scope = scopeHash(changed);
      return JSON.stringify(changed);
    } },
  ];
  let dispatched = 0;
  let resumed = 0;
  for (const item of cases) {
    queueApproved(item.id, "memory_save", { content: item.id });
    const current = db.prepare("SELECT execution_context FROM approval_requests WHERE id = ?").get(item.id) as { execution_context: string };
    const parsed = item.id === "contract-bad-json" ? null : JSON.parse(current.execution_context);
    db.prepare("UPDATE approval_requests SET execution_context = ? WHERE id = ?").run(item.mutate(parsed), item.id);
    await executeApproved({ id: item.id }, {
      dispatch: async () => { dispatched++; return { out: "should-not-run", ok: true }; },
      resume: async () => { resumed++; return { registered: false, note: "" }; },
    });
    const row = db.prepare("SELECT status, result FROM approval_requests WHERE id = ?").get(item.id) as any;
    expect(row.status).toBe("failed");
    expect(row.result).toMatch(/승인|fileRoot|소유자|workspace/);
  }
  expect(dispatched).toBe(0);
  expect(resumed).toBe(0);
});

test("실행 맥락이 없는 레거시 선승인 행은 도구를 실행하지 않고 실패로 닫힌다", async () => {
  const args = JSON.stringify({ content: "contract-legacy-memory" });
  db.prepare("INSERT INTO approval_requests (id, tool, args, summary, status, created_at, resolved_at) VALUES (?, 'memory_save', ?, 'contract legacy', 'approved', ?, ?)")
    .run("contract-legacy-approved", args, now(), now());

  await executeApproved({
    id: "contract-legacy-approved",
    tool: "memory_save",
    args: JSON.stringify({ content: "contract-forged-memory" }),
  });

  const row = db.prepare("SELECT status, result, args FROM approval_requests WHERE id = ?").get("contract-legacy-approved") as any;
  expect(row.status).toBe("failed");
  expect(row.result).toContain("다시 승인 요청");
  expect(row.args).toBe(args);
  expect((db.prepare("SELECT COUNT(*) n FROM memories WHERE content = ?").get("contract-legacy-memory") as any).n).toBe(0);
  expect((db.prepare("SELECT COUNT(*) n FROM memories WHERE content = ?").get("contract-forged-memory") as any).n).toBe(0);
});

test("동일 승인 실행의 동시 호출과 terminal 재호출은 dispatcher·resume을 한 번만 실행한다", async () => {
  queueApproved("contract-concurrent-approved", "memory_save", { content: "contract-concurrent-memory" });
  let entered!: () => void;
  let release!: () => void;
  const dispatchEntered = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let dispatches = 0;
  let resumes = 0;
  const deps = {
    dispatch: async () => { dispatches++; entered(); await blocked; return { out: "contract effect", ok: true }; },
    resume: async () => { resumes++; return { registered: false as const, note: "" }; },
  };
  const first = executeApproved({ id: "contract-concurrent-approved" }, deps);
  await dispatchEntered;
  const second = executeApproved({ id: "contract-concurrent-approved" }, deps);
  await second;
  expect(dispatches).toBe(1);
  expect(resumes).toBe(0);
  release();
  await first;

  let row = db.prepare("SELECT status, result FROM approval_requests WHERE id = ?").get("contract-concurrent-approved") as any;
  expect(row.status).toBe("approved");
  expect(row.result).toBeTruthy();
  expect(dispatches).toBe(1);
  expect(resumes).toBe(1);

  await executeApproved({ id: "contract-concurrent-approved" }, deps);
  row = db.prepare("SELECT status, result FROM approval_requests WHERE id = ?").get("contract-concurrent-approved") as any;
  expect(row.status).toBe("approved");
  expect(row.result).toBeTruthy();
  expect(dispatches).toBe(1);
  expect(resumes).toBe(1);
});

test("대기 및 거부 행은 executeApproved로 실행되지 않고 원본을 유지한다", async () => {
  const pendingArgs = JSON.stringify({ content: "contract-pending-memory" });
  const deniedArgs = JSON.stringify({ content: "contract-denied-memory" });
  db.prepare("INSERT INTO approval_requests (id, tool, args, summary, status, created_at) VALUES (?, 'memory_save', ?, 'contract pending', 'pending', ?)")
    .run("contract-pending-execute", pendingArgs, now());
  db.prepare("INSERT INTO approval_requests (id, tool, args, summary, status, created_at, resolved_at) VALUES (?, 'memory_save', ?, 'contract denied', 'denied', ?, ?)")
    .run("contract-denied-execute", deniedArgs, now(), now());
  const messageCount = (db.prepare("SELECT COUNT(*) n FROM messages").get() as any).n;

  await executeApproved({ id: "contract-pending-execute", tool: "memory_save", args: JSON.stringify({ content: "contract-forged-pending" }) });
  await executeApproved({ id: "contract-denied-execute", tool: "memory_save", args: JSON.stringify({ content: "contract-forged-denied" }) });

  const pending = db.prepare("SELECT status, result, args FROM approval_requests WHERE id = ?").get("contract-pending-execute") as any;
  const denied = db.prepare("SELECT status, result, args FROM approval_requests WHERE id = ?").get("contract-denied-execute") as any;
  expect(pending).toEqual({ status: "pending", result: null, args: pendingArgs });
  expect(denied).toEqual({ status: "denied", result: null, args: deniedArgs });
  expect((db.prepare("SELECT COUNT(*) n FROM memories WHERE content LIKE 'contract-%memory'").get() as any).n).toBe(0);
  expect((db.prepare("SELECT COUNT(*) n FROM messages").get() as any).n).toBe(messageCount);
});

test("실행 소유권이 없는 pending·executing 호출은 dispatch하지 않고 browser lease도 풀지 않는다", async () => {
  const key = `contract-owner-browser-${Date.now()}`;
  const snapshot = browserApprovalSnapshot(key);
  gateApproval("browser_click", { ref: "@1" }, null, "contract", [], undefined, {
    browserKey: key, runKey: key, fileRoot: null, depth: 0, conversationId: "contract-owner-conv", browserSnapshot: snapshot,
  }, true);
  const row = db.prepare("SELECT id FROM approval_requests WHERE status = 'pending' AND tool = 'browser_click' ORDER BY created_at DESC LIMIT 1").get() as { id: string };
  expect(ownsBrowserLease(key, row.id)).toBe(true);
  let dispatches = 0;
  await executeApproved({ id: row.id }, { dispatch: async () => { dispatches++; return { out: "no", ok: true }; } });
  expect((db.prepare("SELECT status FROM approval_requests WHERE id = ?").get(row.id) as any).status).toBe("pending");
  expect(ownsBrowserLease(key, row.id)).toBe(true);
  db.prepare("UPDATE approval_requests SET status = 'executing', execution_owner = 'other-process', execution_decision = 'approve' WHERE id = ?").run(row.id);
  await executeApproved({ id: row.id }, { dispatch: async () => { dispatches++; return { out: "no", ok: true }; } });
  expect(dispatches).toBe(0);
  expect(ownsBrowserLease(key, row.id)).toBe(true);
  await releaseBrowserLease(row.id);
  db.prepare("DELETE FROM approval_requests WHERE id = ?").run(row.id);
});

test("브라우저 승인은 terminal 재호출에도 resume.done이 끝날 때까지 lease를 보존한다", async () => {
  const key = `contract-done-browser-${Date.now()}`;
  gateApproval("browser_open", { url: "https://example.test" }, null, "contract", [], undefined, {
    browserKey: key, runKey: key, fileRoot: null, depth: 0, conversationId: null, browserSnapshot: browserApprovalSnapshot(key),
  }, true);
  const row = db.prepare("SELECT id FROM approval_requests WHERE status = 'pending' AND tool = 'browser_open' ORDER BY created_at DESC LIMIT 1").get() as { id: string };
  db.prepare("UPDATE approval_requests SET status = 'approved', resolved_at = ? WHERE id = ?").run(now(), row.id);
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  await executeApproved({ id: row.id }, {
    dispatch: async (_tool, _args, ctx) => { ctx.onDispatch?.(_tool); return { out: "opened", ok: true }; },
    resume: async () => ({ registered: true, note: "", done }),
  });
  expect(hasBrowserLease(key)).toBe(true);
  await executeApproved({ id: row.id });
  expect(hasBrowserLease(key)).toBe(true);
  finish();
  await done;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(hasBrowserLease(key)).toBe(false);
  db.prepare("DELETE FROM approval_requests WHERE id = ?").run(row.id);
});

test("브라우저 snapshot이 사라진 승인 행은 dispatcher 전에 실패로 닫힌다", async () => {
  const key = `contract-bad-snapshot-${Date.now()}`;
  gateApproval("browser_click", { ref: "@1" }, null, "contract", [], undefined, {
    browserKey: key, runKey: key, fileRoot: null, depth: 0, conversationId: null, browserSnapshot: browserApprovalSnapshot(key),
  }, true);
  const row = db.prepare("SELECT id, execution_context FROM approval_requests WHERE status = 'pending' AND tool = 'browser_click' ORDER BY created_at DESC LIMIT 1").get() as any;
  const raw = JSON.parse(row.execution_context);
  raw.browserSnapshot = null;
  raw.scope = scopeHash(raw);
  db.prepare("UPDATE approval_requests SET status = 'approved', execution_context = ?, resolved_at = ? WHERE id = ?").run(JSON.stringify(raw), now(), row.id);
  let dispatches = 0;
  await executeApproved({ id: row.id }, { dispatch: async () => { dispatches++; return { out: "no", ok: true }; } });
  const terminal = db.prepare("SELECT status, result FROM approval_requests WHERE id = ?").get(row.id) as any;
  expect(dispatches).toBe(0);
  expect(terminal.status).toBe("failed");
  expect(terminal.result).toContain("identity");
  expect(hasBrowserLease(key)).toBe(false);
  db.prepare("DELETE FROM approval_requests WHERE id = ?").run(row.id);
});

test("브라우저 승인 거부는 pending lease를 해제한다", async () => {
  const key = `contract-deny-browser-${Date.now()}`;
  gateApproval("browser_click", { ref: "@1" }, null, "contract", [], undefined, {
    browserKey: key, runKey: key, fileRoot: null, depth: 0, conversationId: null, browserSnapshot: browserApprovalSnapshot(key),
  }, true);
  const row = db.prepare("SELECT id FROM approval_requests WHERE status = 'pending' AND tool = 'browser_click' ORDER BY created_at DESC LIMIT 1").get() as { id: string };
  expect(hasBrowserLease(key)).toBe(true);
  expect((await approvalsRoute.request(`/${row.id}/deny`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(200);
  expect((db.prepare("SELECT status FROM approval_requests WHERE id = ?").get(row.id) as any).status).toBe("denied");
  expect(hasBrowserLease(key)).toBe(false);
  db.prepare("DELETE FROM approval_requests WHERE id = ?").run(row.id);
});

test("onDispatch에서 중지된 builtin은 부수효과 직전 재검사로 실행되지 않는다", async () => {
  const ctl = new AbortController();
  const content = `contract-cancel-before-${Date.now()}`;
  const out = await dispatchToolCall("memory_save", { content }, {
    agentId: null, context: "", browserKey: "contract-cancel-before", signal: ctl.signal,
    onDispatch: () => ctl.abort(new DOMException("사용자 중지", "AbortError")),
  });
  expect(out.ok).toBe(false);
  expect((db.prepare("SELECT COUNT(*) n FROM memories WHERE content = ?").get(content) as any).n).toBe(0);
});

test("대화 stop은 dispatch 중인 승인 작업을 미확인으로 닫고 resume하지 않는다", async () => {
  const conversationId = `contract-stop-conv-${Date.now()}`;
  const id = `contract-stop-approved-${Date.now()}`;
  const context: ApprovalGateContext = { browserKey: `${id}-browser`, runKey: `${id}-run`, fileRoot: null, depth: 1, conversationId };
  gateApproval("memory_save", { content: `${id}-memory` }, null, "contract stop", [], undefined, context, true);
  const queued = db.prepare("SELECT id FROM approval_requests WHERE status = 'pending' AND args = ?").get(JSON.stringify({ content: `${id}-memory` })) as { id: string };
  db.prepare("UPDATE approval_requests SET id = ?, status = 'approved', resolved_at = ? WHERE id = ?").run(id, now(), queued.id);
  let entered!: () => void;
  let finish!: () => void;
  const dispatchEntered = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { finish = resolve; });
  let resumes = 0;
  const baselineControllers = registeredRunControllerCount();
  const running = executeApproved({ id }, {
    dispatch: async (tool, _args, ctx) => { ctx.onDispatch?.(tool); entered(); await blocked; return { out: "late", ok: true }; },
    resume: async () => { resumes++; return { registered: false, note: "" }; },
  });
  await dispatchEntered;
  expect(registeredRunControllerCount()).toBe(baselineControllers + 1);
  const stopped = await chatRoute.request("/stop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId }) });
  expect(stopped.status).toBe(200);
  await running;
  const row = db.prepare("SELECT status, result FROM approval_requests WHERE id = ?").get(id) as any;
  expect(row.status).toBe("failed");
  expect(row.result).toMatch(/미확인|canceled|cancelled|중단/);
  expect(row.result).toContain("자동 재시도하지 마세요");
  expect(resumes).toBe(0);
  expect(registeredRunControllerCount()).toBe(baselineControllers);
  finish();
  await blocked;
});

test("전체 중지는 서로 다른 대화의 승인 dispatch를 모두 취소한다", async () => {
  const ids = [`contract-stop-all-a-${Date.now()}`, `contract-stop-all-b-${Date.now()}`];
  let enteredCount = 0;
  let allEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { allEntered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let resumes = 0;
  for (const [i, id] of ids.entries()) {
    const args = { content: `${id}-memory` };
    gateApproval("memory_save", args, null, "contract stop all", [], undefined, {
      browserKey: `${id}-browser`, runKey: `${id}-run`, fileRoot: null, depth: i, conversationId: `${id}-conv`,
    }, true);
    const queued = db.prepare("SELECT id FROM approval_requests WHERE status = 'pending' AND args = ?").get(JSON.stringify(args)) as { id: string };
    db.prepare("UPDATE approval_requests SET id = ?, status = 'approved', resolved_at = ? WHERE id = ?").run(id, now(), queued.id);
  }
  const baseline = registeredRunControllerCount();
  const runs = ids.map((id) => executeApproved({ id }, {
    dispatch: async (tool, _args, ctx) => {
      ctx.onDispatch?.(tool);
      enteredCount++;
      if (enteredCount === ids.length) allEntered();
      await blocked;
      return { out: "late", ok: true };
    },
    resume: async () => { resumes++; return { registered: false, note: "" }; },
  }));
  await entered;
  const { stopAllRuns } = await import("./team");
  expect(stopAllRuns().runs).toBeGreaterThanOrEqual(2);
  await Promise.all(runs);
  for (const id of ids) expect((db.prepare("SELECT status FROM approval_requests WHERE id = ?").get(id) as any).status).toBe("failed");
  expect(resumes).toBe(0);
  expect(registeredRunControllerCount()).toBe(baseline);
  release();
  await blocked;
});

test("승인 도구 성공 후 대화 stop은 등록된 후속 resume signal을 취소한다", async () => {
  const id = `contract-resume-stop-${Date.now()}`;
  const conversationId = `${id}-conv`;
  const args = { content: `${id}-memory` };
  gateApproval("memory_save", args, null, "contract resume stop", [], undefined, {
    browserKey: `${id}-browser`, runKey: `${id}-run`, fileRoot: null, depth: 0, conversationId,
  }, true);
  const queued = db.prepare("SELECT id FROM approval_requests WHERE status = 'pending' AND args = ?").get(JSON.stringify(args)) as { id: string };
  db.prepare("UPDATE approval_requests SET id = ?, status = 'approved', resolved_at = ? WHERE id = ?").run(id, now(), queued.id);
  const seen: { resumeSignal?: AbortSignal } = {};
  let done!: Promise<void>;
  const baseline = registeredRunControllerCount();
  await executeApproved({ id }, {
    dispatch: async (tool, _args, ctx) => { ctx.onDispatch?.(tool); return { out: "saved", ok: true }; },
    resume: async (_req, _task, _execution, signal) => {
      seen.resumeSignal = signal;
      done = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { registered: true, note: "", done };
    },
  });
  expect((db.prepare("SELECT status FROM approval_requests WHERE id = ?").get(id) as any).status).toBe("approved");
  expect(registeredRunControllerCount()).toBe(baseline + 1);
  await chatRoute.request("/stop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId }) });
  await done;
  await Promise.resolve();
  expect(seen.resumeSignal?.aborted).toBe(true);
  expect(registeredRunControllerCount()).toBe(baseline);
});

test("승인 재개 옵션은 fileRoot null 의미와 depth·chain·root·conversation·browser를 그대로 보존한다", () => {
  const ctl = new AbortController();
  const execution: any = {
    v: 1, agentId: "a", rootJobId: "contract-root", browserKey: "contract-browser", runKey: "contract-run",
    fileRoot: undefined, depth: 3, conversationId: "contract-conv", browserSnapshot: null, scope: "scope", chain: ["p1", "p2"],
  };
  const options = approvalResumeOptions(execution, ctl.signal, true);
  expect(options).toMatchObject({
    fileRoot: null, preserveFileRoot: true, browserKey: "contract-browser", depth: 3,
    conversationId: "contract-conv", rootJobId: "contract-root", chain: ["p1", "p2"], signal: ctl.signal,
  });
  execution.chain.push("mutated");
  expect(options.chain).toEqual(["p1", "p2"]);
  expect(approvalResumeOptions(execution, ctl.signal, false).browserKey).toBeUndefined();
});
