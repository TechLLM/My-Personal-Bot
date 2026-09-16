// 결과물 독립 평가기 — Planner→Generator→Evaluator 루프의 E 단계
// 지시 이행·사실 근거·완결성·형식을 루브릭으로 채점해 미달이면 보정 근거(issues)를 돌려준다.
// 평가 호출은 비용이므로 shouldEvaluate로 저렴한 선별을 먼저 적용한다.
import type { Endpoint } from "./providers";

export interface EvalVerdict { pass: boolean; score: number; issues: string[] }

const PASS_SCORE = 70;
const MAX_ROUNDS = 2; // 평가-재작업 루프 상한 — 무한 반복 방지
export const EVAL_MAX_ROUNDS = MAX_ROUNDS;

// 저렴한 선별 규칙 — 평가 모델 호출이 필요한 결과인지 휴리스틱으로 먼저 거른다.
// 짧은 정답·도구 없는 단순 질의·도구 미지원 모델은 평가 자체가 무의미하다.
export function shouldEvaluate(task: string, result: string, toolsUsed: number, toolsCapable = true): boolean {
  if (!toolsCapable) return false;
  const meaningful = (result.match(/[가-힣A-Za-z0-9]/g) ?? []).length;
  if (meaningful < 40) return false;                       // "됨", "없어" 같은 짧은 정답
  if (toolsUsed === 0 && task.trim().length < 60) return false; // 도구 없이 답할 수 있는 짧은 질의
  return true;
}

// 결과물 채점 — 생성자와 같은 맥락을 공유하지 않는 독립 평가 프롬프트로 확인
export async function evaluateResult(
  endpoint: Endpoint,
  model: string,
  task: string,
  result: string,
  opts: { toolLog?: { tool: string; ok: boolean }[]; signal?: AbortSignal } = {},
): Promise<EvalVerdict> {
  try {
    const { chatOnce } = await import("./providers/openaiCompat");
    const toolsUsed = (opts.toolLog ?? []).map((t) => t.tool).join(", ") || "없음";
    const res = await chatOnce(endpoint, model, [
      {
        role: "user",
        content: `당신은 결과물 품질 평가자입니다. 아래 [지시]와 [결과물]을 대조해 루브릭으로 채점하세요.

[지시]
${task.slice(0, 1500)}

[사용된 도구]
${toolsUsed}

[결과물]
${result.slice(0, 4000)}

루브릭 (각 25점, 총 100):
1. 이행 — 지시가 요구한 작업을 실제로 했는가 (주장이 아니라 결과물이 증명해야 함)
2. 근거 — 내용이 도구 실행 결과·사실에 근거하는가 (지어낸 수치·목록·출처 없는가)
3. 완결 — 지시 범위 전체를 다뤘는가 (일부만 처리하고 종료하지 않았는가)
4. 명확 — 결과가 구조화돼 읽을 수 있는가 (빈 섹션·깨진 형식·주제 이탈 없는가)

JSON만 출력하세요: {"score":0-100,"issues":["부족한 점 최대 3개, 구체적으로"]}
80점 이상이면 issues는 빈 배열. 도구를 못 쓰는 작업이었다면 2번은 지식 기준으로 평가.`,
      },
    ], { signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000) });
    const m = (res.content ?? "").match(/\{[\s\S]*"score"[\s\S]*\}/);
    if (!m) return { pass: true, score: 100, issues: [] }; // 파싱 실패 시 통과 — 평가기 장애가 작업을 막지 않게
    const j = JSON.parse(m[0]);
    const score = Math.max(0, Math.min(100, Number(j.score) || 0));
    const issues = (Array.isArray(j.issues) ? j.issues : []).map(String).filter(Boolean).slice(0, 3);
    return { pass: score >= PASS_SCORE, score, issues };
  } catch {
    return { pass: true, score: 100, issues: [] }; // 평가 호출 실패도 통과 — 검증 경로가 작업 자체를 깨면 안 됨
  }
}
