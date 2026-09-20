import { test, expect } from "bun:test";
import { db } from "./db";
import { checkTask, judge, isProtectedPath, parseProposals, pickWinner, sandboxToolOk, type BenchResult, type GoldenTask, type RunOutcome } from "./evolve";
if (db.filename !== ":memory:") throw new Error("메모리 DB에서만 테스트");

const task: GoldenTask = { id: "G-fixture", holdout: false, env: true, prompt: "fixture", checks: [{ type: "eval_min", score: 0 }] };
const out: RunOutcome = { content: "fixture", toolLog: [], latencyMs: 10, tokensIn: 0, tokensOut: 0 };
test("새 근거 게이트는 봇의 자기개선 수정 대상이 아니다", () => {
  expect(isProtectedPath("server/src/evaluation-evidence.ts")).toBe(true);
});
function bench(passRate: number, latency: number): BenchResult {
  return { passRate, avgLatencyMs: latency, evaluationStatus: "complete", byTask: {}, samples: Array.from({length: 3}, () => ({ taskId: "G-fixture", pass: true, latencyMs: latency, checks: [{ pass: true, detail: "fixture" }] })) };
}
test("평가 callback 예외는 환경 과제에서도 표본에 평가 불능으로 남는다", async () => {
  const result = await checkTask(task, out, 0, async () => { throw new Error("PRIVATE_PROVIDER_DETAILS"); });
  expect(result.pass).toBe(false);
  expect(result.checks[0].evaluationStatus).toBe("inconclusive");
  expect(JSON.stringify(result)).not.toContain("PRIVATE_PROVIDER_DETAILS");
});
test("평가 상태 없는 이전 점수 객체도 통과시키지 않는다", async () => {
  const result = await checkTask(task, out, 0, async () => ({pass:true,score:100,issues:[]}) as any);
  expect(result.pass).toBe(false);
  expect(result.checks[0].evaluationStatus).toBe("inconclusive");
});
test("수치가 좋아도 후보나 기준선의 평가 오류가 있으면 keep 금지", () => {
  const baseline = bench(0.5, 100), candidate = bench(1, 50);
  expect(judge(baseline, candidate).verdict).toBe("keep");
  candidate.samples[0].checks.push({pass:false,detail:"평가 불능",evaluationStatus:"inconclusive"});
  expect(judge(baseline, candidate).verdict).toBe("inconclusive");
  expect(judge(candidate, baseline).verdict).toBe("inconclusive");
});
test("이전 원장의 평가 상태 없는 기준선은 keep 대신 재측정", () => {
  const baseline = bench(0, 999999), candidate = bench(0.3, 44520);
  delete baseline.evaluationStatus;
  expect(judge(baseline, candidate).verdict).toBe("inconclusive");
});
test("complete라고 해도 양쪽의 NaN·Infinity·누락 수치는 keep할 수 없다", () => {
  for (const side of ["baseline", "candidate"] as const) {
    for (const key of ["passRate", "avgLatencyMs"] as const) {
      for (const value of [NaN, Infinity, -Infinity, undefined]) {
        const baseline = bench(0.5, 100), candidate = bench(1, 50);
        (side === "baseline" ? baseline : candidate)[key] = value as number;
        expect(judge(baseline, candidate).verdict).toBe("inconclusive");
      }
    }
  }
});
test("빈 검사 표본과 도메인 밖 수치는 비교할 수 없다", () => {
  const baseline = bench(0.5, 100), candidate = bench(1, 50);
  candidate.samples[0].checks = [];
  expect(judge(baseline, candidate).verdict).toBe("inconclusive");
  expect(judge(bench(-1,100), bench(1,50)).verdict).toBe("inconclusive");
  expect(judge(bench(0.5,100), bench(1,-10)).verdict).toBe("inconclusive");
});

// lifecycle 체크 — 생성이 "실행"된 증거만 인정한다. 부모 실행 프롬프트가 봇 이름을
// 포함해 agent_runs.task LIKE %name%은 항상 매칭되는 허점이 있었다 (시도 없이 보고만 해도 pass).
// sinceMs로 증거 범위를 한정해 다른 테스트의 행이 섞이지 않게 한다.
const LIFE_SINCE = 9_000_000_000_000, LIFE_AT = LIFE_SINCE + 1;
const lifeTask: GoldenTask = { id: "G-life", holdout: false, prompt: "봇 '수명주기테스트봇' 생성→지시→삭제", checks: [{ type: "lifecycle", name: "수명주기테스트봇" }] };
const lifeOut = (toolLog: RunOutcome["toolLog"]): RunOutcome => ({ content: "완료", toolLog, latencyMs: 10, tokensIn: 0, tokensOut: 0 });
test("lifecycle — 이름이 든 실행 기록만으로는 생성 증거가 아니다", async () => {
  db.prepare("INSERT INTO agent_runs (id, agent_id, task, status, created_at) VALUES ('r-life-1', 'a1', ?, 'done', ?)").run("테스트용 봇 '수명주기테스트봇'을 만들고 상태 확인 뒤 삭제해줘", LIFE_AT);
  const r = await checkTask(lifeTask, lifeOut([]), LIFE_SINCE, async () => null as any);
  expect(r.checks[0].pass).toBe(false);
  db.prepare("DELETE FROM agent_runs WHERE id = 'r-life-1'").run();
});
test("lifecycle — 실행된 agent_create(tool_log ok)와 최종 부재면 통과", async () => {
  const r = await checkTask(lifeTask, lifeOut([{ tool: "agent_create", ok: true }, { tool: "agent_delete", ok: true }]), LIFE_SINCE, async () => null as any);
  expect(r.checks[0].pass).toBe(true);
});
test("lifecycle — 위임 실행의 tool_log에 있는 생성도 증거로 인정", async () => {
  db.prepare("INSERT INTO agent_runs (id, agent_id, task, status, tool_log, created_at) VALUES ('r-life-2', 'a2', '봇 만들어줘', 'done', ?, ?)")
    .run(JSON.stringify([{ tool: "agent_create", ok: true }]), LIFE_AT);
  const r = await checkTask(lifeTask, lifeOut([]), LIFE_SINCE, async () => null as any);
  expect(r.checks[0].pass).toBe(true);
  db.prepare("DELETE FROM agent_runs WHERE id = 'r-life-2'").run();
});
test("lifecycle — 승인 경로로 실행된 생성 요청은 증거, 대기 요청은 아니다", async () => {
  db.prepare("INSERT INTO approval_requests (id, tool, args, agent_id, status, created_at) VALUES ('ap-life-1', 'agent_create', '{\"name\":\"수명주기테스트봇\"}', 'a1', 'pending', ?)").run(LIFE_AT);
  const pending = await checkTask(lifeTask, lifeOut([]), LIFE_SINCE, async () => null as any);
  expect(pending.checks[0].pass).toBe(false);
  db.prepare("UPDATE approval_requests SET status = 'approved', result = '봇 생성됨', resolved_at = ? WHERE id = 'ap-life-1'").run(LIFE_AT);
  const approved = await checkTask(lifeTask, lifeOut([]), LIFE_SINCE, async () => null as any);
  expect(approved.checks[0].pass).toBe(true);
  db.prepare("DELETE FROM approval_requests WHERE id = 'ap-life-1'").run();
});
test("lifecycle — 생성 증거가 있어도 봇이 남아 있으면 실패", async () => {
  db.prepare("INSERT INTO agents (id, name, role_prompt, created_at) VALUES ('a-life', '수명주기테스트봇', '', ?)").run(LIFE_AT);
  const r = await checkTask(lifeTask, lifeOut([{ tool: "agent_create", ok: true }]), LIFE_SINCE, async () => null as any);
  expect(r.checks[0].pass).toBe(false);
  db.prepare("DELETE FROM agents WHERE id = 'a-life'").run();
});

// ---------- 다방법 경쟁: 토큰 축 판정·승자 순위·복수 제안 파싱 ----------

const benchT = (passRate: number, latency: number, avgTokens?: number): BenchResult => ({ ...bench(passRate, latency), avgTokens });

test("judge — 통과율·지연이 같아도 토큰 10% 이상 절약이면 채택 근거가 된다", () => {
  expect(judge(benchT(0.5, 100, 1000), benchT(0.5, 100, 800)).verdict).toBe("keep");
});
test("judge — 토큰 절약이 미세하면 개선 근거로 인정하지 않는다", () => {
  expect(judge(benchT(0.5, 100, 1000), benchT(0.5, 100, 950)).verdict).toBe("inconclusive");
});
test("judge — 토큰이 더 들어도 통과율이 오르면 채택 — 정확도가 비용보다 우선", () => {
  expect(judge(benchT(0.5, 100, 1000), benchT(0.8, 100, 2000)).verdict).toBe("keep");
});
test("judge — 토큰 정보가 없으면 기존과 같이 통과율·지연만 본다", () => {
  expect(judge(bench(0.5, 100), bench(0.5, 100)).verdict).toBe("inconclusive");
  expect(judge(bench(0.5, 100), bench(0.5, 50)).verdict).toBe("keep");
});
test("pickWinner — 통과율 → 지연 → 토큰 순으로만 가린다", () => {
  const slow = benchT(0.9, 500, 100), fast = benchT(0.9, 300, 500), cheapFast = benchT(0.9, 300, 100), better = benchT(1, 600, 900);
  expect(pickWinner([slow, fast, cheapFast])).toBe(2);          // 같은 통과율·지연에서 토큰 최소
  expect(pickWinner([fast, better, cheapFast])).toBe(1);        // 통과율이 지연·토큰 역전을 이긴다
  expect(pickWinner([cheapFast, slow])).toBe(0);                // 지연이 토큰보다 우선
  expect(pickWinner([])).toBe(-1);
});
test("parseProposals — 배열·단일 객체·보고서 문장을 모두 받는다", () => {
  const p = (n: number) => `{"surface":"skill.prompt","target":"s${n}","intent":"i","summary":"s"}`;
  expect(parseProposals(`[${p(1)},${p(2)}]`).length).toBe(2);
  expect(parseProposals(p(1)).length).toBe(1);
  expect(parseProposals(`설명\n[${p(1)}, {"surface":"x"}]\n뒷말`).length).toBe(1); // target 없는 항목 제외
  expect(parseProposals("제안 없음")).toEqual([]);
});
test("sandboxToolOk — 읽기 전용 브라우저·선언 MCP만 샌드박스에 연다", () => {
  for (const ok of ["web_search", "browser_open", "browser_read", "browser_scroll", "browser_wait", "browser_back", "myserver__lookup"])
    expect(sandboxToolOk(ok)).toBe(true);
  for (const denied of ["browser_click", "browser_type", "browser_eval", "browser_login", "browser_handoff", "browser_look", "ego_run", "bsk", "computer_look", "shell_run", "agent_create", "__orphan", "plain_name"])
    expect(sandboxToolOk(denied)).toBe(false);
});
