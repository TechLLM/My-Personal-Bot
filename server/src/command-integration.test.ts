import { afterEach, beforeEach, expect, test } from "bun:test";
import { approvalsRoute, executeApproved, gateApproval } from "./approvals";
import { sitesRoute } from "./browser";
import { db, now } from "./db";

if (db.filename !== ":memory:") throw new Error(`테스트가 운영 DB를 열었습니다: ${db.filename}`);

const prefix = "contract-";
const savedFetch = globalThis.fetch;

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
  gateApproval("agent_update", { name: "contract-target", role: "v1" }, null, "작업", [], "contract-root-a");
  gateApproval("agent_update", { name: "contract-target", role: "v1" }, null, "작업", [], "contract-root-b");
  expect((db.prepare("SELECT COUNT(*) n FROM approval_requests WHERE status = 'pending' AND root_job_id LIKE 'contract-root-%'").get() as any).n).toBe(2);

  gateApproval("agent_update", { name: "contract-target", role: "v2" }, null, "작업", [], "contract-root-a");
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
  db.prepare("INSERT INTO approval_requests (id, tool, args, summary, status, created_at) VALUES (?, 'send_email', ?, ?, 'denied', ?)")
    .run("contract-activity", JSON.stringify({ to: "secret@example.com", body: "TOP-SECRET-BODY" }), "raw_summary_TOP_SECRET", now());
  const res = await approvalsRoute.request("/activity?days=1");
  const text = await res.text();
  expect(text).not.toContain("TOP-SECRET-BODY");
  expect(text).not.toContain("raw_summary_TOP_SECRET");
  expect(text).not.toContain('"args"');
  expect(JSON.parse(text).approvals.some((r: any) => r.id === "contract-activity")).toBe(true);
});

test("레거시 선승인 행은 저장된 원본 인자로 실행되고 결과가 기록된다", async () => {
  const args = JSON.stringify({ content: "contract-legacy-memory" });
  db.prepare("INSERT INTO approval_requests (id, tool, args, summary, status, created_at, resolved_at) VALUES (?, 'memory_save', ?, 'contract legacy', 'approved', ?, ?)")
    .run("contract-legacy-approved", args, now(), now());

  await executeApproved({
    id: "contract-legacy-approved",
    tool: "memory_save",
    args: JSON.stringify({ content: "contract-forged-memory" }),
  });

  const row = db.prepare("SELECT status, result, args FROM approval_requests WHERE id = ?").get("contract-legacy-approved") as any;
  expect(row.status).toBe("approved");
  expect(row.result).toBeTruthy();
  expect(row.args).toBe(args);
  expect((db.prepare("SELECT COUNT(*) n FROM memories WHERE content = ?").get("contract-legacy-memory") as any).n).toBe(1);
  expect((db.prepare("SELECT COUNT(*) n FROM memories WHERE content = ?").get("contract-forged-memory") as any).n).toBe(0);
});

test("동일 승인 실행이 동시에 호출돼도 도구 효과는 한 번만 발생한다", async () => {
  const args = JSON.stringify({ content: "contract-concurrent-memory" });
  db.prepare("INSERT INTO approval_requests (id, tool, args, summary, status, created_at, resolved_at) VALUES (?, 'memory_save', ?, 'contract concurrent', 'approved', ?, ?)")
    .run("contract-concurrent-approved", args, now(), now());

  await Promise.all([
    executeApproved({ id: "contract-concurrent-approved" }),
    executeApproved({ id: "contract-concurrent-approved" }),
  ]);

  let row = db.prepare("SELECT status, result FROM approval_requests WHERE id = ?").get("contract-concurrent-approved") as any;
  expect(row.status).toBe("approved");
  expect(row.result).toBeTruthy();
  expect((db.prepare("SELECT COUNT(*) n FROM memories WHERE content = ?").get("contract-concurrent-memory") as any).n).toBe(1);

  await executeApproved({ id: "contract-concurrent-approved" });
  row = db.prepare("SELECT status, result FROM approval_requests WHERE id = ?").get("contract-concurrent-approved") as any;
  expect(row.status).toBe("approved");
  expect(row.result).toBeTruthy();
  expect((db.prepare("SELECT COUNT(*) n FROM memories WHERE content = ?").get("contract-concurrent-memory") as any).n).toBe(1);
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
