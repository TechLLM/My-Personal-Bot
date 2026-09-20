// 평가 불능은 낮은 점수와 다르다. 이 상태를 계측·채택 판정까지 보존한다.
export interface EvaluationCheck {
  pass: boolean;
  detail: string;
  evaluationStatus: "scored" | "inconclusive";
}

export function evaluationCheck(value: unknown, threshold = 70): EvaluationCheck {
  const v = value as { status?: unknown; score?: unknown } | null;
  if (v?.status !== "scored" || typeof v.score !== "number" || !Number.isFinite(v.score)
      || v.score < 0 || v.score > 100 || !Number.isFinite(threshold) || threshold < 0 || threshold > 100)
    return { pass: false, detail: "평가 근거 미확인 — 채택 보류", evaluationStatus: "inconclusive" };
  return { pass: v.score >= threshold, detail: `평가 ${v.score}점 (기준 ${threshold})`, evaluationStatus: "scored" };
}

interface EvidenceSample { checks: { evaluationStatus?: string }[] }
interface EvidenceBench { evaluationStatus?: string; passRate?: number; avgLatencyMs?: number; samples: EvidenceSample[] }

export function evaluationStatus(samples: EvidenceSample[]): "complete" | "inconclusive" {
  if (!Array.isArray(samples) || samples.length === 0) return "inconclusive";
  return samples.some(s => !s || !Array.isArray(s.checks) || s.checks.length === 0 || s.checks.some(c =>
    !c || (c.evaluationStatus !== undefined && c.evaluationStatus !== "scored"))) ? "inconclusive" : "complete";
}

export function evaluationGate(baseline: EvidenceBench, candidate: EvidenceBench = baseline): string | null {
  for (const [label, bench] of [["기준선", baseline], ["후보", candidate]] as const) {
    // 이전 원장처럼 상태가 없는 계측도 평가 정상성을 입증하지 못하므로 재측정한다.
    if (!bench || bench.evaluationStatus !== "complete" || evaluationStatus(bench.samples) !== "complete")
      return `${label} 평가가 완료되지 않았습니다 — 평가 오류 또는 이전 계측, 재측정 필요`;
    if (typeof bench.passRate !== "number" || !Number.isFinite(bench.passRate) || bench.passRate < 0 || bench.passRate > 1
        || typeof bench.avgLatencyMs !== "number" || !Number.isFinite(bench.avgLatencyMs) || bench.avgLatencyMs < 0)
      return `${label} 계측값이 유효하지 않습니다 — 재측정 필요`;
  }
  return null;
}
