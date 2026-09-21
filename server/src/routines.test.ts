import { test, expect } from "bun:test";
import { db, uid, now } from "./db";
import { routinesRoute, runRoutine } from "./routines";

if (db.filename !== ":memory:") throw new Error(`테스트가 운영 DB를 열었습니다: ${db.filename}`);

// 루틴 제안 — 같은 지시가 14일 안에 3회 이상 실행되면 제안 목록에 오른다 (Aside식 routine suggestions)

test("제안 — 반복 실행된 수동 작업만 올리고 루틴 실행·단발 작업은 제외한다", async () => {
  const agentId = uid();
  db.prepare("INSERT INTO agents (id, name, role_prompt, created_at) VALUES (?, '제안봇', '', ?)").run(agentId, now());
  // 같은 지시 3회 (수동 — routine_id 없음)
  for (let i = 0; i < 3; i++)
    db.prepare("INSERT INTO agent_runs (id, agent_id, task, status, created_at) VALUES (?, ?, '주간 리포트 작성해줘', 'done', ?)").run(uid(), agentId, now() - i * 1000);
  // 2회만 실행된 작업은 제외
  for (let i = 0; i < 2; i++)
    db.prepare("INSERT INTO agent_runs (id, agent_id, task, status, created_at) VALUES (?, ?, '단발 작업입니다', 'done', ?)").run(uid(), agentId, now() - i * 1000);
  // 루틴이 만든 실행은 제외
  for (let i = 0; i < 4; i++)
    db.prepare("INSERT INTO agent_runs (id, agent_id, task, status, routine_id, created_at) VALUES (?, ?, '루틴이 돌린 작업', 'done', ?, ?)").run(uid(), agentId, "r1", now() - i * 1000);

  const res = await routinesRoute.request("/suggestions");
  const j = await res.json();
  const tasks = (j.suggestions as any[]).map((s) => s.task);
  expect(tasks).toContain("주간 리포트 작성해줘");
  expect(tasks).not.toContain("단발 작업입니다");
  expect(tasks).not.toContain("루틴이 돌린 작업");
  const s = j.suggestions.find((x: any) => x.task === "주간 리포트 작성해줘");
  expect(s.runs).toBe(3);
  expect(s.agent_name).toBe("제안봇");
});

test("겹침 건너뛰기 — 대상 봇이 실행 중이면 루틴 발화를 건너뛴다", async () => {
  const agentId = uid();
  db.prepare("INSERT INTO agents (id, name, role_prompt, created_at) VALUES (?, '바쁜봇', '', ?)").run(agentId, now());
  db.prepare("INSERT INTO agent_runs (id, agent_id, task, status, created_at) VALUES (?, ?, '진행 중인 작업', 'running', ?)").run(uid(), agentId, now());
  const out = await runRoutine({ id: `rt-${uid()}`, name: "겹침테스트", prompt: "주간 보고", agent_id: agentId });
  expect(out).toContain("건너뜀");
});

test("스티어 — 실행 중인 run에 지시를 주입하고 실행 중이 아니면 거부한다", async () => {
  const { chatRoute } = await import("./routes/chat");
  const agentId = uid();
  db.prepare("INSERT INTO agents (id, name, role_prompt, created_at) VALUES (?, '스티어봇', '', ?)").run(agentId, now());
  const runId = uid();
  db.prepare("INSERT INTO agent_runs (id, agent_id, task, status, created_at) VALUES (?, ?, '실행 중 작업', 'running', ?)").run(runId, agentId, now());

  const ok = await chatRoute.request("/steer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId, content: "방향 바꿔줘" }) });
  expect(ok.status).toBe(200);
  const row = db.prepare("SELECT * FROM run_steers WHERE run_id = ?").get(runId) as any;
  expect(row.content).toBe("방향 바꿔줘");
  expect(row.consumed_at).toBeNull();

  // 실행 중이 아닌 봇은 404
  const idle = uid();
  db.prepare("INSERT INTO agents (id, name, role_prompt, created_at) VALUES (?, '빈봇', '', ?)").run(idle, now());
  const no = await chatRoute.request("/steer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: idle, content: "x" }) });
  expect(no.status).toBe(404);
});
