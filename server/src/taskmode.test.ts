import { test, expect } from "bun:test";
import { db, uid, now } from "./db";
import { execToolCall } from "./toolloop";
import { createCommandJob } from "./command-delivery";

if (db.filename !== ":memory:") throw new Error(`테스트가 운영 DB를 열었습니다: ${db.filename}`);

// 작업별 권한 모드 — 명령 루트(command_jobs.task_mode)가 도구 게이트를 좁힌다.
// readonly는 읽기 도구만, guard는 읽기 외 전부 승인 큐로 보낸다.

function ctxFor(rootJobId: string) {
  return { agentId: null, context: "테스트", browserKey: `t-${uid()}`, rootJobId };
}

test("readonly — 쓰기·브라우저 조작·셸 쓰기를 차단하고 읽기는 허용한다", async () => {
  const job = createCommandJob({ source: "web", request: "읽기 전용 작업", taskMode: "readonly" });
  const ctx = ctxFor(job);

  for (const denied of ["browser_click", "browser_eval", "write_file", "send_email", "agent_create", "ego_run"]) {
    const r = await execToolCall({ id: "t", name: denied, arguments: "{}" }, ctx);
    expect(r.out).toContain("읽기 전용 작업");
    expect(r.ok).toBe(true);
  }
  // 셸은 명령 내용으로 가른다 — 조회는 허용, 쓰기는 차단
  const ro = await execToolCall({ id: "t", name: "shell_run", arguments: '{"command":"ls -la"}' }, ctx);
  expect(ro.out).not.toContain("읽기 전용 작업");
  const rw = await execToolCall({ id: "t", name: "shell_run", arguments: '{"command":"rm -rf x"}' }, ctx);
  expect(rw.out).toContain("읽기 전용 작업");
});

test("guard — allow 규칙이 있어도 읽기 외 도구는 승인 큐로 간다", async () => {
  // write_file에 allow 규칙을 둬도 guard 작업에서는 승인을 요구해야 한다
  db.prepare("INSERT INTO approval_rules (id, pattern, action, created_at) VALUES (?, 'write_file', 'allow', ?)").run(uid(), now());
  const job = createCommandJob({ source: "web", request: "승인 강화 작업", taskMode: "guard" });
  const ctx = ctxFor(job);

  const r = await execToolCall({ id: "t", name: "write_file", arguments: '{"path":"a.txt","content":"x"}' }, ctx);
  const pending = db.prepare("SELECT id FROM approval_requests WHERE tool = 'write_file' AND status = 'pending'").all();
  expect(pending.length).toBeGreaterThan(0);
  expect(r.out).not.toContain("읽기 전용 작업");
});

test("모드 없음(기본) — 기존 게이트 동작 그대로", async () => {
  const job = createCommandJob({ source: "web", request: "일반 작업" });
  const ctx = ctxFor(job);
  const r = await execToolCall({ id: "t", name: "shell_run", arguments: '{"command":"ls"}' }, ctx);
  expect(r.out).not.toContain("읽기 전용 작업");
});

test("모드 상속 — 같은 rootJobId의 하위 호출에도 같은 모드가 적용된다", async () => {
  const job = createCommandJob({ source: "web", request: "읽기 전용", taskMode: "readonly" });
  // 위임된 하위 봇은 agentId만 다르고 rootJobId는 같다
  const child = await execToolCall({ id: "t", name: "browser_eval", arguments: '{"script":"1"}' }, { ...ctxFor(job), agentId: "child-bot" });
  expect(child.out).toContain("읽기 전용 작업");
});
