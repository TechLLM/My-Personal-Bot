// 결과물 독립 평가기 — Planner→Generator→Evaluator 루프의 E 단계
// 지시 이행·사실 근거·완결성·형식을 루브릭으로 채점해 미달이면 보정 근거(issues)를 돌려준다.
// 평가 호출은 비용이므로 shouldEvaluate로 저렴한 선별을 먼저 적용한다.
import type { Endpoint } from "./providers";

export interface EvalVerdict {
  pass: boolean;
  score: number;
  issues: string[];
  status: "scored" | "inconclusive";
  reasonCode?: "provider_error" | "invalid_response" | "aborted";
}

const PASS_SCORE = 70;
const MAX_ROUNDS = 2; // 평가-재작업 루프 상한 — 무한 반복 방지
export const EVAL_MAX_ROUNDS = MAX_ROUNDS;

function inconclusive(reasonCode: NonNullable<EvalVerdict["reasonCode"]>): EvalVerdict {
  // score 0은 실패 시 자리표시자이며, 실제 채점 결과가 아니다.
  return { pass: false, score: 0, issues: ["평가를 완료하지 못했습니다."], status: "inconclusive", reasonCode };
}

export function parseEvaluationResponse(content: string): EvalVerdict {
  try {
    const text = content.trim();
    const fence = /^```json[\t ]*\r?\n([\s\S]*?)\r?\n```$/.exec(text);
    const value = JSON.parse(fence ? fence[1] : text);
    if (
      value === null || typeof value !== "object" || Array.isArray(value) ||
      typeof value.score !== "number" || !Number.isFinite(value.score) ||
      value.score < 0 || value.score > 100 ||
      !Array.isArray(value.issues) || !value.issues.every((issue: unknown) => typeof issue === "string")
    ) return inconclusive("invalid_response");
    return { pass: value.score >= PASS_SCORE, score: value.score, issues: value.issues.slice(0, 3), status: "scored" };
  } catch {
    return inconclusive("invalid_response");
  }
}

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
  opts: {
    toolLog?: { tool: string; ok: boolean }[];
    signal?: AbortSignal;
    callModel?: (endpoint: Endpoint, model: string, messages: any[], opts: any) => Promise<{ content: string }>;
  } = {},
): Promise<EvalVerdict> {
  if (opts.signal?.aborted) return inconclusive("aborted");
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(60_000)])
    : AbortSignal.timeout(60_000);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("Evaluation aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  // 주입 함수가 동기적으로 취소 후 throw해도 취소 rejection을 방치하지 않는다.
  void aborted.catch(() => {});
  try {
    const callModel = opts.callModel ?? (await Promise.race([import("./providers/openaiCompat"), aborted])).chatOnce;
    if (signal.aborted) return inconclusive("aborted");
    const toolsUsed = (opts.toolLog ?? []).map((t) => t.tool).join(", ") || "없음";
    const res = await Promise.race([callModel(endpoint, model, [
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
    ], { signal, reasoningEffort: "low" }), aborted]);
    if (signal.aborted) return inconclusive("aborted");
    return parseEvaluationResponse(res?.content);
  } catch {
    return inconclusive(signal.aborted ? "aborted" : "provider_error");
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
