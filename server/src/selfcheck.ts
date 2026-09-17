// 자가교정 규칙 테이블 — chat.ts 보정 루프의 정규식 조건 10개를 {name, detect, fixPrompt} 객체로 분리.
// 조건 하나를 고쳐도 다른 조건과 얽히지 않게, 각 규칙은 독립 객체다. fixPrompt 선택은
// 배열 순서 = 우선순위(위쪽 규칙이 먼저 매칭되면 그 프롬프트 사용)로 결정된다.
import { parseLeaked, type LeakedCall } from "./toolloop";
import { verifyMutation, snapshot, type Intent } from "./intent";

export interface SelfcheckInput {
  content: string;          // 스트리밍된 최종 응답
  calledTools: Set<string>; // 이번 라운드에 실제 호출된 도구
  gatedTools: Set<string>;  // 승인 게이트에 걸린 도구
  intent: Intent;           // LLM 의도 분류 결과
  beforeCount: number;      // 지시 전 엔티티 수
  lastUserText: string;     // 마지막 사용자 지시문 ([시스템] 제외)
}

interface Flags {
  degenerate: boolean;
  leakedCalls: LeakedCall[];
  claimsPopup: boolean;
  claimsAction: boolean;
  actionMismatch: boolean;
  jsonLeak: boolean;
  dodges: boolean;
  stateUnmet: boolean;
  pendingMisreport: boolean;
  verdict: ReturnType<typeof verifyMutation>;
}

interface Rule {
  name: string;
  detect: (f: Flags, i: SelfcheckInput) => boolean;
  fixPrompt: (f: Flags, i: SelfcheckInput) => string;
}

// 배열 순서 = fixPrompt 선택 우선순위 (원래 삼항 체인의 순서와 동일)
export const SELF_CHECKS: Rule[] = [
  {
    name: "leaked_calls", // 도구 호출이 <invoke> 텍스트로 새어나옴 — 서버가 대신 실행한 뒤 계속 진행시킴
    detect: (f) => f.leakedCalls.length > 0,
    fixPrompt: () => "[시스템] 방금 도구 호출이 텍스트 형식으로 출력되어 서버가 대신 실행했습니다. 위 도구 결과를 확인하고 작업을 계속하세요 — 추가 도구는 반드시 정식 도구 호출(function call)로 사용하고, 완료되면 정상 문장으로 답변하세요.",
  },
  {
    name: "popup_claimed", // 계정 팝업을 띄우겠다고 주장했는데 request_credentials 미호출
    detect: (f, i) => f.claimsPopup && !i.calledTools.has("request_credentials"),
    fixPrompt: () => "[시스템] 방금 응답에서 계정 입력 팝업을 띄우겠다고 했지만 request_credentials 도구가 실제로 호출되지 않았습니다. 지금 즉시 request_credentials를 호출해 팝업을 실제로 띄우세요. site에는 언급된 서비스 이름을 넣으세요.",
  },
  {
    name: "state_unmet", // DB 실측 검증 — 지시된 변경이 실제로 일어나지 않음
    detect: (f) => f.stateUnmet,
    fixPrompt: (f, i) => `[시스템] DB 실측 검증 결과 지시가 이행되지 않았습니다 — ${f.verdict.detail} 현재 실제 상태:\n${snapshot(i.intent.object).text}\n이 지적이 실제 지시 내용과 맞지 않으면(지시 해석 오류 가능) 지시문을 다시 읽고 실제 요청만 수행한 뒤 사실대로 보고하세요 — 억지로 이행 상태를 맞추지 마세요.`,
  },
  {
    name: "pending_misreport", // 승인 대기 작업을 "완료"로 보고
    detect: (f) => f.pendingMisreport,
    fixPrompt: () => "[시스템] 삭제 도구는 호출됐지만 사용자 승인 대기 상태입니다 — '삭제 완료'가 아니라 '사용자 승인 대기 중'임을 명확히 보고하세요. 승인 팝업에서 승인되면 자동 실행됩니다.",
  },
  {
    name: "action_mismatch", // 삭제 지시인데 삭제 계열 도구 미호출
    detect: (f) => f.actionMismatch,
    fixPrompt: (_f, i) => `[시스템] 사용자는 삭제/제거를 지시했지만 삭제 계열 도구(*_delete)가 호출되지 않았습니다 — 실제 호출된 도구: ${[...i.calledTools].join(", ") || "없음"}. routine_list로 삭제 대상 ID를 확인한 뒤 지금 즉시 *_delete 도구를 호출해 실제로 삭제하고, 삭제 후 목록을 다시 조회해 결과를 보고하세요. 호출 없이 "삭제했다"고 주장하면 안 됩니다.`,
  },
  {
    name: "json_leak", // 도구 호출 JSON 조각이 응답 텍스트로 누출
    detect: (f) => f.jsonLeak,
    fixPrompt: () => "[시스템] 방금 응답에 도구 호출 JSON이 텍스트로 출력됐습니다. JSON 조각을 출력하지 말고, 필요한 작업은 정식 도구 호출(function call)로 수행한 뒤 정상적인 문장으로 답변하세요.",
  },
  {
    name: "degenerate", // 빈/손상 응답
    detect: (f) => f.degenerate,
    fixPrompt: () => "[시스템] 방금 응답이 비어 있거나 손상된 문자열이었습니다. 사용자의 요청을 다시 처리하세요 — 작업이 필요하면 도구를 실제로 호출해 수행하고 결과를 확인한 뒤, 정상적인 문장으로 답변하세요.",
  },
  {
    name: "dodges", // 명시 지시에 되묻기·보류만 한 회피 응답
    detect: (f) => f.dodges,
    fixPrompt: () => "[시스템] 사용자가 명시적으로 작업을 지시했는데 되묻거나 보류만 했습니다. 되묻지 말고 지금 도구를 호출해 지시된 작업을 실제로 수행하고 결과를 보고하세요.",
  },
  {
    name: "action_claimed", // 도구 없이 작업 완료 주장 (캐치올 — 마지막)
    detect: (f) => f.claimsAction,
    fixPrompt: () => "[시스템] 방금 응답에서 작업을 수행했다고 주장했지만 도구 호출이 전혀 없었습니다. 주장한 작업을 지금 실제 도구로 수행하고, 수행할 수 없는 부분은 없다고 정직하게 정정하세요.",
  },
];

export interface SelfcheckResult extends Flags {
  needsFix: boolean;
  fixPrompt: string | null;
  fired: string[]; // 발화한 규칙 이름 — 로그·디버깅용
}

export function selfcheck(i: SelfcheckInput): SelfcheckResult {
  const content = i.content;
  // URL·링크 문법을 제거하고 의미 문자를 셈 — '](http://…)' 같은 링크 조각 응답도 손상으로 잡음
  const stripped = content.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").replace(/\]\([^)]*\)/g, "]").replace(/https?:\/\/\S+/g, "");
  const meaningfulLen = (stripped.match(/[가-힣A-Za-z0-9]/g) ?? []).length;
  // 스트리밍된 최종 응답에 텍스트 형식으로 새어나온 도구 호출이 있으면 서버가 대신 실행
  const leakedCalls = parseLeaked(content);
  const degenerate = meaningfulLen === 0; // 의미 문자가 하나도 없을 때만 — "됨" 같은 짧은 정상 답변은 유효
  const claimsPopup = !degenerate && !leakedCalls.length && /팝업|보안.{0,6}입력|입력.{0,4}(창|띄)/.test(content) && /계정|비밀번호|로그인|아이디/.test(content);
  // 명시적 작업 지시를 받고도 도구 없이 되묻거나 보류·제안만 한 회피 응답 감지
  const imperatives = /(알려|확인|처리|조회|정리|보내|만들|검색|읽어|살펴|보고|답변|해라|해줘|시켜)/.test(i.lastUserText);
  // 변경 계열 도구가 실제로 호출됐는지 — 조회 도구만 호출하고 "삭제/등록했다"고 주장하는 것을 잡음
  const mutatingCall = [...i.calledTools].some((t) => /_delete|_add|_create|_update|_remove|send_|approve/i.test(t));
  const claimsAction = !degenerate && !leakedCalls.length && !mutatingCall && /(삭제|생성|지시|등록|전송|예약|전달|수정|처리|만들|보내|제거)[가-힣]{0,3}\s*(했|함|됐|됨|할게|하겠|진행|완료|대상|요청|전송)/.test(content);
  // 지시 동사와 호출된 도구의 불일치 — "삭제해라"에 add/list만 호출하거나 삭제 주장만 한 경우
  const wantsDelete = i.intent.verb === "delete" && !!i.intent.object; // LLM 의도 분류 기준 — 키워드 존재가 아니라 실제 삭제 명령일 때만
  const deleteCalled = [...i.calledTools].some((t) => /_delete|_remove/i.test(t));
  const claimsDeleted = /(삭제|제거|지워|없애)[가-힣]{0,4}\s*(했|함|됐|됨|완료|처리|요청|전송)/.test(content);
  const actionMismatch = !degenerate && !leakedCalls.length && wantsDelete && !deleteCalled && (claimsDeleted || mutatingCall || /(할까요|주시면|선택해 주세요|원하시는|명시해|동작을 선택)/.test(content));
  // 도구 호출 JSON이 텍스트로 새어나온 응답 — 요청 데이터에 {...,"action":"add"} 같은 조각
  const jsonLeak = !degenerate && !leakedCalls.length && /"(action|arguments|assigned_bot)"\s*:\s*"|\{\s*"name"\s*:\s*"[^"]{2,}"\s*,\s*"trigger"/.test(content);
  const dodges = !degenerate && !leakedCalls.length && i.calledTools.size === 0 && imperatives && /(있나요|할까|드릴까|보낼까|처리할까|진행할까|마무리할게|종료할까|어떻게 할까|주시면|해 주시면)/.test(content);
  // ─── 하네스 사후 검증: 내부 엔티티 변경 지시는 DB 상태 변화로 이행 여부 확인 ───
  // 반대 결과(삭제 지시인데 수가 늘음)·미실행·승인 대기를 완료로 보고하는 것을 차단
  const verdict = verifyMutation(i.intent, i.beforeCount, i.calledTools, i.gatedTools);
  const stateUnmet = !degenerate && !leakedCalls.length && !verdict.ok;
  const approvalPending = !degenerate && !leakedCalls.length && !!verdict.pendingApproval;
  // 승인 대기인데 "삭제 완료"로 보고하는 것도 불일치 — 승인 대기임을 명시해야 함
  const pendingMisreport = approvalPending && !/승인|대기|팝업/.test(content) && /(삭제|제거|완료|처리)[가-힣]{0,3}\s*(했|함|됐|됨|완료)/.test(content);

  const flags: Flags = { degenerate, leakedCalls, claimsPopup, claimsAction, actionMismatch, jsonLeak, dodges, stateUnmet, pendingMisreport, verdict };
  const firedRules = SELF_CHECKS.filter((r) => r.detect(flags, i));
  return {
    ...flags,
    fired: firedRules.map((r) => r.name),
    needsFix: firedRules.length > 0,
    fixPrompt: firedRules[0] ? firedRules[0].fixPrompt(flags, i) : null,
  };
}
