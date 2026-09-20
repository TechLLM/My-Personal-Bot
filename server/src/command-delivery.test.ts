import { afterEach, beforeEach, expect, test } from "bun:test";
import { db, setSetting } from "./db";
import { completeCommand, createCommandJob, finalizeCommandIfReady, markInterruptedDeliveriesUnknown, recordCommandResult, recoverInterruptedCommands } from "./command-delivery";

if (db.filename !== ":memory:") throw new Error(`테스트가 운영 DB를 열었습니다: ${db.filename}`);
const originalFetch = globalThis.fetch;
const originalEnv = process.env.MYBOT_ENV;
const settingKeys = ["notify_telegram", "notify_email", "telegram_bot_token", "telegram_chat_id"];
let settingSnapshot = new Map<string, string | null>();

beforeEach(() => {
  settingSnapshot = new Map(settingKeys.map((key) => [key, (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null)?.value ?? null]));
  db.prepare("DELETE FROM command_job_results").run();
  db.prepare("DELETE FROM command_deliveries").run();
  db.prepare("DELETE FROM command_jobs").run();
  setSetting("notify_telegram", "0");
  setSetting("notify_email", "0");
  setSetting("telegram_bot_token", "token-a");
  setSetting("telegram_chat_id", "100");
  delete process.env.MYBOT_ENV;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of settingSnapshot) {
    if (value === null) db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    else setSetting(key, value);
  }
  if (originalEnv === undefined) delete process.env.MYBOT_ENV;
  else process.env.MYBOT_ENV = originalEnv;
});

test("root는 실행 중인 자식과 승인 모두 끝날 때까지 완료되지 않는다", async () => {
  const root = createCommandJob({ source: "web", request: "업무" });
  db.prepare("INSERT INTO agent_runs (id, task, status, root_job_id, created_at) VALUES ('cd-run','child','running',?,0)").run(root);
  db.prepare("INSERT INTO approval_requests (id, tool, status, root_job_id, created_at) VALUES ('cd-ap','send_email','pending',?,0)").run(root);
  await completeCommand(root, "승인 대기 중이라는 오래된 본문");
  expect((db.prepare("SELECT status FROM command_jobs WHERE id=?").get(root) as any).status).toBe("waiting_approval");
  db.prepare("UPDATE approval_requests SET status='denied', result='거부됨' WHERE id='cd-ap'").run();
  recordCommandResult(root, "approval:cd-ap", "이메일 발송이 거부됐습니다");
  await finalizeCommandIfReady(root);
  expect((db.prepare("SELECT status FROM command_jobs WHERE id=?").get(root) as any).status).toBe("waiting_children");
  db.prepare("UPDATE agent_runs SET status='error', result='부분 실패' WHERE id='cd-run'").run();
  recordCommandResult(root, "run:cd-run", "자료 수집 일부 실패");
  await Promise.all([finalizeCommandIfReady(root), finalizeCommandIfReady(root)]);
  const row = db.prepare("SELECT status, full_result FROM command_jobs WHERE id=?").get(root) as any;
  expect(row.status).toBe("completed");
  expect(row.full_result).toContain("부분 완료");
  expect(row.full_result).toContain("거부");
  expect(row.full_result).not.toContain("오래된 본문");
});

test("재시작 시 sending 전달은 재전송하지 않고 unknown으로 확정한다", () => {
  const root = createCommandJob({ source: "web", request: "x" });
  db.prepare("INSERT INTO command_deliveries (root_job_id, channel, status, created_at, updated_at) VALUES (?, 'telegram', 'sending', 0, 0)").run(root);
  markInterruptedDeliveriesUnknown();
  expect((db.prepare("SELECT status FROM command_deliveries WHERE root_job_id=?").get(root) as any).status).toBe("delivery_unknown");
});

test("기존 sending_final 영수증은 새 소유권으로 간주하지 않고 재시작 시 unknown만 기록한다", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(); }) as unknown as typeof fetch;
  const root = createCommandJob({ source: "telegram", request: "x" });
  db.prepare("INSERT INTO command_deliveries (root_job_id, channel, status, created_at, updated_at) VALUES (?, 'telegram', 'sending_final', 0, 0)").run(root);
  await completeCommand(root, "완료");
  expect(calls).toBe(0);
  markInterruptedDeliveriesUnknown();
  expect((db.prepare("SELECT status FROM command_deliveries WHERE root_job_id=?").get(root) as any).status).toBe("delivery_unknown");
});

test("같은 본문의 서로 다른 텔레그램 작업은 각각 한 번 전달된다", async () => {
  let calls = 0;
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, result: { message_id: ++calls } }), { status: 200 })) as unknown as typeof fetch;
  const a = createCommandJob({ source: "telegram", request: "같은 요청" });
  const b = createCommandJob({ source: "telegram", request: "같은 요청" });
  await completeCommand(a, "같은 결과");
  await completeCommand(b, "같은 결과");
  expect(calls).toBe(2);
});

test("승인 두 건은 action 한 번만 보내고 최종 결과는 같은 메시지를 한 번 편집한다", async () => {
  const urls: string[] = [];
  const payloads: any[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    payloads.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 });
  }) as unknown as typeof fetch;
  const root = createCommandJob({ source: "telegram", request: "승인 업무" });
  db.prepare("INSERT INTO approval_requests (id, tool, status, root_job_id, created_at) VALUES ('a1','x','pending',?,1),('a2','x','pending',?,2)").run(root, root);
  await completeCommand(root, "대기 문구", "msg:root/run:root");
  expect(urls.filter((u) => u.includes("sendMessage"))).toHaveLength(1);
  db.prepare("UPDATE approval_requests SET status='denied', result='거부됨'").run();
  await Promise.all([finalizeCommandIfReady(root), finalizeCommandIfReady(root)]);
  expect(urls.filter((u) => u.includes("editMessageText"))).toHaveLength(1);
  expect(payloads[1].message_id).toBe(7);
  expect(payloads[1].text.length).toBeLessThanOrEqual(4096);
  expect(payloads[1].parse_mode).toBeUndefined();
  expect((db.prepare("SELECT external_message_id, status FROM command_deliveries WHERE root_job_id=?").get(root) as any)).toEqual(expect.objectContaining({ external_message_id: "7", status: "sent" }));
});

test("action 전달이 미확인이 된 뒤 완료돼도 새 텔레그램 전송을 만들지 않는다", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("timeout"); }) as unknown as typeof fetch;
  const root = createCommandJob({ source: "telegram", request: "승인 업무" });
  db.prepare("INSERT INTO approval_requests (id, tool, status, root_job_id, created_at) VALUES ('timeout-ap','x','pending',?,1)").run(root);
  await completeCommand(root, "대기");
  db.prepare("UPDATE approval_requests SET status='denied' WHERE id='timeout-ap'").run();
  await finalizeCommandIfReady(root);
  expect(calls).toBe(1);
  expect((db.prepare("SELECT status FROM command_deliveries WHERE root_job_id=?").get(root) as any).status).toBe("delivery_unknown");
});

test("최종 전송 결과 미확인은 재호출해도 재전송하지 않는다", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("timeout"); }) as unknown as typeof fetch;
  const root = createCommandJob({ source: "telegram", request: "x" });
  await completeCommand(root, "완료");
  await completeCommand(root, "덮어쓰기 시도");
  expect(calls).toBe(1);
  const row = db.prepare("SELECT status FROM command_deliveries WHERE root_job_id=?").get(root) as any;
  expect(row.status).toBe("delivery_unknown");
  expect((db.prepare("SELECT full_result FROM command_jobs WHERE id=?").get(root) as any).full_result).toBe("완료");
});

test("대상 설정 변경과 dev 억제는 네트워크를 호출하지 않는다", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(); }) as unknown as typeof fetch;
  const changed = createCommandJob({ source: "telegram", request: "x" });
  setSetting("telegram_chat_id", "200");
  await completeCommand(changed, "완료");
  expect(calls).toBe(0);
  const dev = createCommandJob({ source: "telegram", request: "y" });
  process.env.MYBOT_ENV = "dev";
  await completeCommand(dev, "완료");
  expect(calls).toBe(0);
  expect((db.prepare("SELECT status FROM command_deliveries WHERE root_job_id=?").get(dev) as any).status).toBe("suppressed_dev");
});

test("web 작업도 생성 뒤 텔레그램 대상이나 토큰이 바뀌면 전달하지 않는다", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(); }) as unknown as typeof fetch;
  setSetting("notify_telegram", "1");
  const targetChanged = createCommandJob({ source: "web", request: "x" });
  setSetting("telegram_chat_id", "200");
  await completeCommand(targetChanged, "완료");
  setSetting("telegram_chat_id", "100");
  const tokenChanged = createCommandJob({ source: "web", request: "y" });
  setSetting("telegram_bot_token", "token-b");
  await completeCommand(tokenChanged, "완료");
  expect(calls).toBe(0);
});

test("최종 메시지 저장 실패는 완료 전환까지 롤백하고 재마무리할 수 있다", async () => {
  const conversationId = "cd-fault-conversation";
  const messageId = "cd-fault-message";
  const trigger = "cd_synthetic_persist_failure";
  db.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, '내구성 테스트', 0, 0)").run(conversationId);
  db.prepare("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'assistant', '초기 표시', 0)").run(messageId, conversationId);
  const root = createCommandJob({ source: "web", conversationId, assistantMessageId: messageId, request: "원자적 저장 확인" });
  const original = "최종 원문 Ω🙂";

  try {
    db.exec(`CREATE TEMP TRIGGER ${trigger} BEFORE UPDATE ON messages
      WHEN OLD.id = '${messageId}' AND NEW.command_status = 'completed'
      BEGIN SELECT RAISE(ABORT, 'synthetic persist failure'); END`);
    await expect(completeCommand(root, original)).rejects.toThrow();

    expect((db.prepare("SELECT status, full_result FROM command_jobs WHERE id = ?").get(root) as any)).toEqual(expect.objectContaining({
      status: "running",
      full_result: original,
    }));
    expect((db.prepare("SELECT content, full_content, command_status FROM messages WHERE id = ?").get(messageId) as any)).toEqual({
      content: "초기 표시",
      full_content: null,
      command_status: "running",
    });

    db.exec(`DROP TRIGGER ${trigger}`);
    expect(await finalizeCommandIfReady(root)).toBe(true);
    expect((db.prepare("SELECT status, full_result FROM command_jobs WHERE id = ?").get(root) as any)).toEqual(expect.objectContaining({
      status: "completed",
      full_result: original,
    }));
    expect((db.prepare("SELECT content, full_content, command_status FROM messages WHERE id = ?").get(messageId) as any)).toEqual({
      content: original,
      full_content: original,
      command_status: "completed",
    });
    expect((db.prepare("SELECT COUNT(*) n FROM messages WHERE id = ?").get(messageId) as { n: number }).n).toBe(1);
  } finally {
    db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    db.prepare("DELETE FROM command_job_results WHERE root_job_id = ?").run(root);
    db.prepare("DELETE FROM command_deliveries WHERE root_job_id = ?").run(root);
    db.prepare("DELETE FROM command_jobs WHERE id = ?").run(root);
    db.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
    db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId);
  }
});

test("동시 완료는 긴 원문을 보존하고 표시를 축약해 외부 요청을 한 번만 보낸다", async () => {
  const conversationId = "cd-concurrent-conversation";
  const messageId = "cd-concurrent-message";
  const request = "긴 유니코드 결과를 한 번만 완료해 주세요";
  const full = ("원문 보존 가나다 Ω🙂\n").repeat(180);
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 91 } }), { status: 200 });
  }) as unknown as typeof fetch;
  setSetting("notify_telegram", "1");
  db.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, '동시 완료 테스트', 0, 0)").run(conversationId);
  db.prepare("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'assistant', '', 0)").run(messageId, conversationId);
  const root = createCommandJob({ source: "web", conversationId, assistantMessageId: messageId, request });

  try {
    await Promise.all([
      completeCommand(root, full),
      completeCommand(root, "경쟁 호출이 덮어쓰면 안 되는 결과"),
    ]);

    const job = db.prepare("SELECT request, status, full_result FROM command_jobs WHERE id = ?").get(root) as any;
    const message = db.prepare("SELECT content, full_content, command_status FROM messages WHERE id = ?").get(messageId) as any;
    expect(job).toEqual(expect.objectContaining({ request, status: "completed", full_result: full }));
    expect(message.command_status).toBe("completed");
    expect(message.content.length).toBeLessThanOrEqual(1000);
    expect(message.full_content).toBe(full);
    expect((db.prepare("SELECT COUNT(*) n FROM messages WHERE id = ?").get(messageId) as { n: number }).n).toBe(1);
    expect(calls).toBe(1);
  } finally {
    db.prepare("DELETE FROM command_job_results WHERE root_job_id = ?").run(root);
    db.prepare("DELETE FROM command_deliveries WHERE root_job_id = ?").run(root);
    db.prepare("DELETE FROM command_jobs WHERE id = ?").run(root);
    db.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
    db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId);
  }
});

test("재시작은 waiting_children과 waiting_approval을 원자적으로 중단하고 기존 요청을 비활성화한다", async () => {
  const children = createCommandJob({ source: "web", request: "child" });
  db.prepare("INSERT INTO agent_runs (id, task, status, root_job_id, created_at) VALUES ('restart-run','child','running',?,0)").run(children);
  await completeCommand(children, "앞선 결과");
  const approval = createCommandJob({ source: "web", request: "approval" });
  db.prepare("INSERT INTO approval_requests (id, tool, status, root_job_id, created_at) VALUES ('restart-ap','x','pending',?,0)").run(approval);
  await completeCommand(approval, "승인 전 결과");

  expect(recoverInterruptedCommands()).toBe(2);
  expect((db.prepare("SELECT status FROM agent_runs WHERE id='restart-run'").get() as any).status).toBe("interrupted");
  expect((db.prepare("SELECT status FROM approval_requests WHERE id='restart-ap'").get() as any).status).toBe("expired");
  expect((db.prepare("SELECT status FROM command_jobs WHERE id=?").get(children) as any).status).toBe("completed");
  expect((db.prepare("SELECT status FROM command_jobs WHERE id=?").get(approval) as any).status).toBe("completed");
});
