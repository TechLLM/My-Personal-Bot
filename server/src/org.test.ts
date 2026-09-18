import { test, expect, beforeAll } from "bun:test";
import { db, now } from "./db";
import { callBuiltin, runAgentDetached, stopAllRuns, getAgent, roundLimitFor } from "./team";
import { gateApproval, approvalDecision } from "./approvals";
import { systemPrompt } from "./routes/chat";

// 봇 간 위임·메시지 연쇄 방지 테스트 — 2026-09-18 보고-회신 폭주(자정 이후 실행 64건·승인 대기 50건) 재발 방지
if (db.filename !== ":memory:") throw new Error(`테스트가 운영 DB를 열었습니다: ${db.filename}`);
// 외부 호출 차단 — 가드가 뚫려 실제 봇 실행으로 넘어가도 네트워크 없이 즉시 실패(400)하게
globalThis.fetch = (async () => new Response('{"error":"test"}', { status: 400 })) as unknown as typeof fetch;

const ids = { lead: "t-lead", a: "t-bot-a", b: "t-bot-b" };
beforeAll(() => {
  const ins = db.prepare("INSERT INTO agents (id, name, role_prompt, model, is_lead, created_at) VALUES (?, ?, '', 'zai/glm-5.3-flash', ?, 0)");
  ins.run(ids.lead, "테스트팀장", 1);
  ins.run(ids.a, "테스트봇A", 0);
  ins.run(ids.b, "테스트봇B", 0);
});

test("봇별 시간당 실행 상한(15회)이 실제로 위임을 막는다", async () => {
  const ins = db.prepare("INSERT INTO agent_runs (id, agent_id, task, status, created_at) VALUES (?, ?, 'x', 'done', ?)");
  for (let i = 0; i < 15; i++) ins.run(`t-run-${i}`, ids.b, now() - 10 * 60_000);
  // 수정 전 비교식 — 정수 ms와 datetime 문자열 비교라 항상 0건이었다
  const old = db.prepare("SELECT COUNT(*) c FROM agent_runs WHERE agent_id = ? AND created_at > datetime('now', '-1 hour')").get(ids.b) as { c: number };
  expect(old.c).toBe(0);
  const out = await callBuiltin("agent_direct", { name: "테스트봇B", instruction: "작업" }, ids.a);
  expect(out).toContain("추가 위임이 차단");
  db.prepare("DELETE FROM agent_runs WHERE id LIKE 't-run-%'").run();
});

test("봇 쌍 메시지 상한(30분 10건)이 실제로 메시지를 막는다", async () => {
  const ins = db.prepare("INSERT INTO agent_messages (id, from_agent_id, to_agent_id, content, status, created_at) VALUES (?, ?, ?, 'x', 'done', ?)");
  for (let i = 0; i < 10; i++) ins.run(`t-msg-${i}`, i % 2 ? ids.a : ids.b, i % 2 ? ids.b : ids.a, now() - 5 * 60_000);
  const out = await callBuiltin("agent_message", { to: "테스트봇B", content: "확인 회신" }, ids.a);
  expect(out).toContain("루프 방지를 위해 차단");
  db.prepare("DELETE FROM agent_messages WHERE id LIKE 't-msg-%'").run();
});

test("위임 사슬의 상위 봇에게 되돌아가는 지시·메시지는 순환으로 차단된다", async () => {
  // 테스트봇A가 테스트봇B에게 위임한 실행 안에서 B가 A에게 보고·회신하려는 상황
  const direct = await callBuiltin("agent_direct", { name: "테스트봇A", instruction: "결과 보고" }, ids.b, undefined, 1, undefined, undefined, undefined, [ids.a]);
  expect(direct).toContain("순환 차단");
  const msg = await callBuiltin("agent_message", { to: "테스트봇A", content: "회신 접수 확인" }, ids.b, undefined, 1, undefined, undefined, undefined, [ids.a]);
  expect(msg).toContain("순환 차단");
  expect((db.prepare("SELECT COUNT(*) c FROM agent_messages WHERE to_agent_id = ?").get(ids.a) as { c: number }).c).toBe(0);
});

test("봇 메시지는 보낸 쪽 사슬을 저장해 받는 봇에게 넘긴다", async () => {
  const out = await callBuiltin("agent_message", { to: "테스트봇B", content: "자료 정리" }, ids.a, undefined, 0, undefined, undefined, undefined, [ids.lead]);
  expect(out).toContain("메시지 전달됨");
  const row = db.prepare("SELECT chain FROM agent_messages WHERE to_agent_id = ? ORDER BY created_at DESC LIMIT 1").get(ids.b) as { chain: string };
  expect(JSON.parse(row.chain)).toEqual([ids.lead, ids.a]);
});

test("같은 봇에 대한 설정 수정 승인 요청은 최신 1건만 대기로 남는다", () => {
  const pending = () => db.prepare("SELECT args FROM approval_requests WHERE status = 'pending' AND tool = 'agent_update' AND json_extract(args, '$.name') = '테스트봇B'").all() as { args: string }[];
  // 요청한 봇이 달라도(연쇄 실행 때 Eggbot·비서실장봇이 번갈아 제출) 대상이 같으면 교체
  gateApproval("agent_update", { name: "테스트봇B", role: "역할 초안 1" }, ids.a, "역할 반영");
  gateApproval("agent_update", { name: "테스트봇B", role: "역할 초안 2" }, ids.lead, "역할 반영");
  gateApproval("agent_update", { role: "역할 초안 3", name: "테스트봇B" }, ids.a, "역할 반영");
  const rows = pending();
  expect(rows.length).toBe(1);
  expect(JSON.parse(rows[0].args).role).toBe("역할 초안 3");
  // 다른 봇 대상 요청은 건드리지 않는다
  gateApproval("agent_update", { name: "테스트봇A", role: "다른 봇" }, ids.a, "역할 반영");
  expect(pending().length).toBe(1);
  expect((db.prepare("SELECT COUNT(*) c FROM approval_requests WHERE status = 'expired' AND tool = 'agent_update'").get() as { c: number }).c).toBe(2);
});

test("전체 중지는 진행 중인 봇 실행을 끊고 대기 중인 봇 메시지를 취소한다", async () => {
  const blocked = globalThis.fetch;
  let inFlight = false;
  // 모델 호출이 응답 없이 매달린 상황 — 중지 신호로만 끝나야 한다
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => new Promise((_, rej) => {
    inFlight = true;
    init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")), { once: true });
  })) as unknown as typeof fetch;
  try {
    db.prepare("INSERT INTO agent_messages (id, from_agent_id, to_agent_id, content, status, created_at) VALUES ('t-pending', ?, ?, '대기 메시지', 'pending', ?)").run(ids.a, ids.b, now());
    const run = runAgentDetached(getAgent(ids.a)!, { label: "중지 테스트", task: "보고서 초안을 작성하세요" });
    for (let i = 0; i < 100 && !inFlight; i++) await Bun.sleep(20);
    expect(inFlight).toBe(true);
    const stopped = stopAllRuns();
    expect(stopped.runs).toBeGreaterThanOrEqual(1);
    const state = await run.done;
    expect(state.status).toBe("error");
    expect((db.prepare("SELECT status FROM agent_runs WHERE id = ?").get(run.runId) as { status: string }).status).toBe("error");
    expect((db.prepare("SELECT status FROM agent_messages WHERE id = 't-pending'").get() as { status: string }).status).toBe("failed");
  } finally {
    globalThis.fetch = blocked;
  }
});

test("위임 결과는 세션 기록용 보고서 정리(LLM)를 기다리지 않고 바로 돌아온다", async () => {
  const blocked = globalThis.fetch;
  let releaseFormatter!: () => void;
  const formatterGate = new Promise<void>((r) => { releaseFormatter = r; });
  let formatterCalled = false;
  const answer = "## 결과\n" + "요약 내용입니다. ".repeat(30); // 200자 이상 — 보고서 정리 LLM 호출 대상
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (String(init?.body ?? "").includes("업무 보고서 포맷터")) {
      formatterCalled = true;
      await formatterGate; // 보고서 정리 호출은 테스트가 끝날 때까지 응답하지 않는다
      return new Response('{"error":"test"}', { status: 400 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: answer } }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  try {
    const started = Date.now();
    const out = await Promise.race([
      callBuiltin("agent_direct", { name: "테스트봇B", instruction: "요약해 주세요" }, ids.lead),
      Bun.sleep(5000).then(() => "시간 초과 — 보고서 정리를 기다림"),
    ]);
    expect(out).toContain("테스트봇B 실행 결과 — 완료");
    expect(Date.now() - started).toBeLessThan(5000);
    // 보고서 정리 호출 자체는 백그라운드에서 실제로 일어나야 한다 (정리 생략이 아니라 순서만 뒤로)
    for (let i = 0; i < 50 && !formatterCalled; i++) await Bun.sleep(20);
    expect(formatterCalled).toBe(true);
  } finally {
    releaseFormatter();
    globalThis.fetch = blocked;
  }
});

test("중계 실행(위임)은 보고서 재작성·품질 평가를 생략하고, 사용자에게 가는 실행은 유지한다", async () => {
  const blocked = globalThis.fetch;
  const count = { rewrite: 0, evaluate: 0 };
  const final = "## 요약\n봇 목록을 확인했습니다.\n## 결과\n" + "- 확인한 봇 항목입니다.\n".repeat(12) + "## 미확인\n없음\n## 다음 단계\n없음";
  let toolTurn = true;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    const reply = (message: object) => new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { "content-type": "application/json" } });
    if (body.includes("업무 보고서 포맷터")) return new Response('{"error":"test"}', { status: 400 });
    if (body.includes("품질 평가자")) { count.evaluate++; return reply({ content: '{"score":90,"issues":[]}' }); }
    if (body.includes("도구 수집이 끝났습니다")) { count.rewrite++; return reply({ content: final }); }
    // 의도 분류는 실행 첫 라운드와 병렬로 돈다 — 도구 호출 응답을 가로채지 않게 중립 응답
    if (body.includes("의도를 분류하세요")) return reply({ content: '{"verb":null,"object":null,"all":false}' });
    // 봇 실행 라운드 — 첫 라운드는 도구 호출, 다음 라운드는 최종 보고
    if (toolTurn) { toolTurn = false; return reply({ content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "agent_list", arguments: "{}" } }] }); }
    return reply({ content: final });
  }) as unknown as typeof fetch;
  try {
    const task = "현재 봇 목록을 도구로 확인하고, 각 봇의 역할을 표로 정리해서 결과를 보고해 주세요.";
    const delegated = await callBuiltin("agent_direct", { name: "테스트봇B", instruction: task }, ids.lead);
    expect(delegated).toContain("실행 결과 — 완료");
    expect(count).toEqual({ rewrite: 0, evaluate: 0 });

    // 루틴처럼 사용자에게 결과가 가는 실행(사슬 없음·깊이 0)은 기존대로 재작성·평가를 거친다
    toolTurn = true;
    const state = await runAgentDetached(getAgent(ids.b)!, { label: "루틴 테스트", task }).done;
    expect(state.status).toBe("done");
    expect(count.rewrite).toBe(1);
    expect(count.evaluate).toBe(1);
  } finally {
    globalThis.fetch = blocked;
  }
});

test("CEO·Eggbot은 브라우저·데스크톱 도구와 안내 없이, 실무 봇은 그대로 받고 비서실장 경유 규칙은 없다", async () => {
  const blocked = globalThis.fetch;
  const seen = new Map<string, { tools: string[]; system: string }>();
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    const reply = (message: object) => new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { "content-type": "application/json" } });
    if (body.includes("의도를 분류하세요")) return reply({ content: '{"verb":null,"object":null,"all":false}' });
    try {
      const j = JSON.parse(body);
      const system = String(j.messages?.[0]?.content ?? "");
      const name = system.match(/^당신은 "([^"]+)"/)?.[1];
      if (name && !seen.has(name)) seen.set(name, { tools: (j.tools ?? []).map((t: { function: { name: string } }) => t.function.name), system });
    } catch {}
    return reply({ content: "## 요약\n확인했습니다.\n## 결과\n없음\n## 미확인\n없음\n## 다음 단계\n없음" });
  }) as unknown as typeof fetch;
  db.prepare("INSERT INTO agents (id, name, role_prompt, model, is_boss, created_at) VALUES ('t-ceo', '테스트CEO', '총괄', 'zai/glm-5.3-flash', 1, 0)").run();
  db.prepare("INSERT INTO agents (id, name, role_prompt, model, special_role, created_at) VALUES ('t-egg', '테스트Eggbot', '조직관리', 'zai/glm-5.3-flash', 'org_admin', 0)").run();
  try {
    for (const id of ["t-ceo", "t-egg", ids.b]) await runAgentDetached(getAgent(id)!, { label: "도구 세트 테스트", task: "간단히 상태를 확인해 주세요" }).done;
    const ceo = seen.get("테스트CEO")!, egg = seen.get("테스트Eggbot")!, worker = seen.get("테스트봇B")!;
    for (const r of [ceo, egg]) {
      expect(r.tools.some((t) => t.startsWith("browser_") || t.startsWith("computer_"))).toBe(false);
      expect(r.system).not.toContain("[브라우저 도구 선택]");
      expect(r.tools).toContain("agent_update"); // 관리 도구는 유지
    }
    expect(worker.tools.some((t) => t.startsWith("browser_"))).toBe(true);
    expect(worker.tools.some((t) => t.startsWith("computer_"))).toBe(true);
    expect(worker.system).toContain("[브라우저 도구 선택]");
    for (const r of [ceo, egg, worker]) expect(r.system).not.toContain("비서실장");
    expect(ceo.system).toContain("agent_direct로 직접 배정");
    expect(ceo.system).not.toContain("상향 보고");
    // 채팅 경로의 시스템 프롬프트도 비서실장 경유 규칙이 없어야 한다
    expect(systemPrompt("auto", null, null, "t-ceo")).not.toContain("비서실장");
  } finally {
    globalThis.fetch = blocked;
    db.prepare("DELETE FROM agents WHERE id IN ('t-ceo', 't-egg')").run();
  }
});

// ─── 2026-09-18 업무 중단 3대 원인 재발 방지 ───
// 실측(서비스 DB): 승인 만료 51건(읽기 전용 ls까지 팝업 대기), 단계 상한 도달 실행 114건,
// 그 실행들의 도구 호출 1336회 중 agent_list 219회(한 실행에서 3~5회 반복이 36건)

test("shell_run은 승인 팝업 없이 실행된다 — 외부 발신·삭제류는 그대로 승인 대상", () => {
  expect(approvalDecision("shell_run", { command: "ls -R agents" })).toBe("allow");
  expect(gateApproval("shell_run", { command: "ls -R agents" }, ids.a, "파일 조사")).toBeNull();
  expect(approvalDecision("send_email", { to: "x@y.z" })).toBe("require");
  expect(approvalDecision("agent_delete", { name: "X" })).toBe("require");
});

test("봇 생성·삭제 결과가 현재 조직 현황을 함께 돌려준다 — agent_list 재조회 불필요", async () => {
  db.prepare("INSERT INTO agents (id, name, role_prompt, model, is_boss, created_at) VALUES ('t-ceo2', '테스트CEO2', '총괄', 'zai/glm-5.3-flash', 1, 0)").run();
  try {
    const created = await callBuiltin("agent_create", { name: "임시조직봇", role: "임시 역할" }, "t-ceo2");
    expect(created).toContain("[현재 조직]");
    expect(created.split("[현재 조직]")[1]).toContain("임시조직봇");
    const deleted = await callBuiltin("agent_delete", { name: "임시조직봇" }, "t-ceo2");
    const org = deleted.split("[현재 조직]")[1] ?? "";
    expect(org).toContain("테스트CEO2");
    expect(org).not.toContain("임시조직봇"); // 삭제 결과가 곧 최신 조직도 — 다시 조회할 이유가 없다
  } finally {
    db.prepare("DELETE FROM agents WHERE id = 't-ceo2' OR name = '임시조직봇'").run();
  }
});

test("같은 봇이 agent_list를 다시 부르면 재조회가 불필요하다고 알린다", async () => {
  const first = await callBuiltin("agent_list", {}, "t-list-probe");
  const second = await callBuiltin("agent_list", {}, "t-list-probe");
  expect(first).not.toContain("재조회");
  expect(second).toContain("재조회");
});

test("브라우저·데스크톱 조작을 쓴 실행은 도구 라운드 상한이 늘어난다", () => {
  expect(roundLimitFor(new Set(["read_file", "agent_list"]))).toBe(12);
  expect(roundLimitFor(new Set(["read_file", "browser_open"]))).toBe(20);
  expect(roundLimitFor(new Set(["bsk"]))).toBe(20);
});
