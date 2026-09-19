import { test, expect, beforeEach } from "bun:test";
import { db, now } from "./db";
import { auditOrg, formatAudit, repeatedParagraph, modelProblem } from "./audit";

if (db.filename !== ":memory:") throw new Error(`테스트가 운영 DB를 열었습니다: ${db.filename}`);

const clear = () => {
  for (const t of ["agents", "routines", "skills", "skill_runs", "agent_runs", "approval_requests"]) db.prepare(`DELETE FROM ${t}`).run();
};
const ins = (over: Record<string, unknown> = {}) => {
  const a = { id: "a" + Math.random().toString(16).slice(2, 8), name: "봇" + Math.random().toString(16).slice(2, 6),
    role_prompt: "이 봇은 무엇을 어떤 기준으로 수행하는지 충분히 설명하는 역할문을 가지고 있습니다. ".repeat(3),
    model: "minimax/MiniMax-M3", is_boss: 0, is_lead: 0, parent_id: null, special_role: null, max_children: null, ...over };
  db.prepare("INSERT INTO agents (id, name, role_prompt, model, is_boss, is_lead, parent_id, special_role, max_children, created_at) VALUES (?,?,?,?,?,?,?,?,?,0)")
    .run(a.id, a.name, a.role_prompt, a.model, a.is_boss, a.is_lead, a.parent_id, a.special_role, a.max_children);
  return a;
};
const ids = (fs: ReturnType<typeof auditOrg>) => fs.map((x) => x.id);

beforeEach(clear);

test("정상 조직에서는 봇 관련 문제를 찾지 않는다", () => {
  ins({ is_boss: 1, name: "CEO" });
  expect(ids(auditOrg()).filter((i) => i.startsWith("tree.") || i.startsWith("role.") || i.startsWith("model."))).toEqual([]);
});

test("봇 트리 문제를 잡는다 — CEO 없음·고아 참조·3단계·팀장 아닌 상위", () => {
  expect(ids(auditOrg())).toContain("tree.no_boss");
  const boss = ins({ is_boss: 1 });
  const lead = ins({ is_lead: 1, parent_id: boss.id });
  const worker = ins({ parent_id: lead.id });
  ins({ parent_id: worker.id });            // 3단계
  ins({ parent_id: "없는봇id" });            // 고아
  const found = ids(auditOrg());
  expect(found).toContain("tree.depth");
  expect(found).toContain("tree.orphan");
  expect(found).toContain("tree.parent_not_lead"); // worker는 팀장이 아니다
});

test("역할문 문제를 잡는다 — 빈 값·너무 짧음·문단 반복", () => {
  ins({ is_boss: 1 });
  ins({ role_prompt: "" });
  ins({ role_prompt: "짧은 역할문" });
  const dup = "이 문단은 프롬프트를 덧붙이는 코드가 멱등하지 않아 반복해서 쌓인 문단입니다.";
  ins({ role_prompt: `본문입니다.\n\n${dup}\n\n${dup}` });
  const found = ids(auditOrg());
  expect(found).toContain("role.empty");
  expect(found).toContain("role.short");
  expect(found).toContain("role.repeat");
});

test("모델 배정 문제를 잡는다", () => {
  expect(modelProblem("")).toBe("모델 미지정");
  expect(modelProblem("gpt-6-astra")).toContain("형식 오류");
  expect(modelProblem("없는프로바이더/x")).toContain("등록되지 않은");
  expect(modelProblem("minimax/MiniMax-M3")).toBeNull();
});

test("루틴 문제를 잡는다 — 부실 지시문·담당 봇 없음·시각 충돌", () => {
  ins({ is_boss: 1 });
  const r = db.prepare("INSERT INTO routines (id, name, prompt, schedule, enabled, trigger_type, agent_id, created_at) VALUES (?,?,?,?,?,'schedule',?,0)");
  r.run("r1", "부실", "매일 뉴스 요약", "daily:08:30", 1, null);
  r.run("r2", "고아", "실행 시점에 맥락이 없으므로 범위·형식·완료 기준을 모두 담은 충분히 긴 지시문입니다. 완료 기준까지 적습니다.", "daily:08:30", 1, "삭제된봇");
  const found = ids(auditOrg());
  expect(found).toContain("routine.weak");
  expect(found).toContain("routine.orphan");
  expect(found).toContain("routine.collision"); // 08:30에 둘
});

test("운영 지표를 잡는다 — 실패율·승인 적체", () => {
  ins({ is_boss: 1 });
  const run = db.prepare("INSERT INTO agent_runs (id, agent_id, task, status, steps, created_at) VALUES (?,NULL,'t',?,?,?)");
  for (let i = 0; i < 12; i++) run.run("run" + i, i < 4 ? "error" : "done", 3, now() - 1000);
  db.prepare("INSERT INTO approval_requests (id, tool, args, summary, status, created_at) VALUES ('ap1','shell_run','{}','s','pending',?)")
    .run(now() - 30 * 3_600_000);
  const found = ids(auditOrg());
  expect(found).toContain("ops.fail_rate");
  expect(found).toContain("ops.stale_approval");
});

test("보고서는 심각도 순으로 나오고 문제가 없으면 그렇게 적는다", () => {
  ins({ is_boss: 1 });
  expect(formatAudit([])).toContain("발견된 문제 없음");
  const out = formatAudit(auditOrg());
  expect(out).toContain("조직 설계 점검");
  expect(out).toContain("실행 모델과 무관");
});

test("문단 반복 검출은 짧은 줄을 무시한다", () => {
  expect(repeatedParagraph("짧다\n\n짧다")).toBeNull();
  const long = "이 문단은 서른 자가 넘는 충분히 긴 문단이라 반복 검출 대상입니다.";
  expect(repeatedParagraph(`${long}\n\n${long}`)?.count).toBe(2);
});
