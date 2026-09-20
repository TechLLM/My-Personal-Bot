import { test, expect } from "bun:test";
import { db } from "./db";
import { checkTask, judge, isProtectedPath, type BenchResult, type GoldenTask, type RunOutcome } from "./evolve";
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
