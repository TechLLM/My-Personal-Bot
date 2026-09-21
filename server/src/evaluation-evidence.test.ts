import { test, expect } from "bun:test";
import { evaluationCheck, evaluationStatus, evaluationGate } from "./evaluation-evidence";

test("평가 장애 placeholder 0은 기준 0에서도 통과하지 않는다", () => {
  expect(evaluationCheck({ status: "inconclusive", score: 0 }, 0).pass).toBe(false);
  expect(evaluationCheck({ status: "inconclusive", score: 100 }).evaluationStatus).toBe("inconclusive");
});
test("정상 저점수와 평가 불능을 구분하고 과제별 기준을 적용한다", () => {
  expect(evaluationCheck({ status: "scored", score: 65 }, 60).pass).toBe(true);
  const low = evaluationCheck({ status: "scored", score: 65 }, 70);
  expect(low.pass).toBe(false); expect(low.evaluationStatus).toBe("scored");
});
test("레거시 숫자·누락·범위 밖 값·잘못된 기준은 보류한다", () => {
  for (const value of [100, null, {}, { score: 100 }, { status: "scored", score: "100" }, { status: "scored", score: NaN }, { status: "scored", score: 101 }])
    expect(evaluationCheck(value).evaluationStatus).toBe("inconclusive");
  expect(evaluationCheck({ status: "scored", score: 100 }, NaN).pass).toBe(false);
});
test("한 표본의 평가 장애도 벤치와 채택 판정까지 전파된다", () => {
  const complete = { evaluationStatus: "complete", passRate: 1, avgLatencyMs: 10, samples: [{ checks: [evaluationCheck({ status: "scored", score: 100 })] }] };
  const invalid = { evaluationStatus: "complete", passRate: 0, avgLatencyMs: 1, samples: [{ checks: [evaluationCheck({ status: "inconclusive", score: 0 })] }] };
  expect(evaluationStatus(invalid.samples)).toBe("inconclusive");
  expect(evaluationGate(complete, invalid)).not.toBeNull();
  expect(evaluationGate(invalid, complete)).not.toBeNull();
  expect(evaluationGate(complete, complete)).toBeNull();
});
test("평가 상태가 없는 과거 기준선은 무조건 재측정한다", () => {
  const healthy = { evaluationStatus: "complete", samples: [{ checks: [] }] };
  expect(evaluationGate({ samples: [{ checks: [] }] }, healthy)).toContain("재측정");
});
test("빈 표본이나 누락된 검사는 complete가 아니다", () => {
  expect(evaluationStatus([])).toBe("inconclusive");
  expect(evaluationStatus([{ checks: [] }])).toBe("inconclusive");
  expect(evaluationStatus([{ checks: [{ evaluationStatus: "unknown" }] }])).toBe("inconclusive");
  expect(evaluationStatus([{ checks: null }] as any)).toBe("inconclusive");
});
