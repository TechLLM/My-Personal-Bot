import { db } from "./db";

// ─── 지시 의도 → 도구 계약 → DB 상태 검증 (검증 하네스) ───
// 모델이 아니라 서버가 진실의 원천: 내부 엔티티(루틴·봇)에 대한 지시는
// 실행 전 현재 상태를 실측해 주입하고, 실행 후 DB 상태 변화로 이행 여부를 검증한다.

export type IntentVerb = "delete" | "create" | "update" | "read" | null;
export type IntentObject = "routines" | "agents" | null;

export interface Intent {
  verb: IntentVerb;
  object: IntentObject;
  all: boolean; // "모두/전부/전체" 지시
}

// 동사 어간 뒤 관형형 어미(된·되·할·한·하는·하던·는·라는)는 명령이 아니라 수식 —
// "등록된 루틴이 뭐가 있어?"는 조회이지 등록 지시가 아니다. 부정 지시("삭제하지 마")는
// 강제 검증 자체가 반대 실행을 유발할 수 있어 의도 자체를 잡지 않는다.
const ADNOMINAL = "(?!된|되|됐|됨|함|할|한|하는|하던|는|라는)";
const VERB_RULES: [RegExp, IntentVerb][] = [
  [new RegExp(`삭제${ADNOMINAL}|제거${ADNOMINAL}|지워|없애|날려|정리해`), "delete"],
  [new RegExp(`수정${ADNOMINAL}|변경${ADNOMINAL}|바꿔|고쳐|바꾸(?!는|라)`), "update"],
  [new RegExp(`등록${ADNOMINAL}|추가${ADNOMINAL}|생성${ADNOMINAL}|만들어(?!진)|새로(?!운)`), "create"],
  [/목록|리스트|보여|알려|확인|조회|몇|뭐|있나|있어|어떤/, "read"],
];
const NEGATED = /지\s*마|지\s*말|지\s*못|말고|말아/;

const OBJECT_RULES: [RegExp, IntentObject][] = [
  [/루틴|예약\s*작업|스케줄/, "routines"],
  [/봇|에이전트/, "agents"],
];

export function parseIntent(text: string): Intent {
  const t = text.slice(0, 500);
  let verb: IntentVerb = null;
  let object: IntentObject = null;
  for (const [re, v] of VERB_RULES) if (re.test(t)) { verb = v; break; }
  for (const [re, o] of OBJECT_RULES) if (re.test(t)) { object = o; break; }
  // 부정 표현이 있으면 어떤 동작 강제도 위험 — 검증 없이 주입만 한다
  if (NEGATED.test(t)) verb = null;
  return { verb, object, all: /모두|모든|전부|전체|다\s|싹/.test(t) };
}

// 의도별 도구 계약 — 이 지시가 이행됐다고 말하려면 해당 계열 도구 호출이 필요
export const TOOL_CONTRACT: Record<string, Partial<Record<NonNullable<IntentVerb>, RegExp>>> = {
  routines: { read: /^routine_list$/, delete: /^routine_delete$/, create: /^routine_add$/ },
  agents: { read: /^agent_list$/, delete: /^agent_delete$/, create: /^agent_create$/, update: /^agent_(update|reorder)$/ },
};

// 현재 상태 실측 — 모델에게 주입해 "이 데이터만이 사실"임을 고정
export function snapshot(object: IntentObject): { text: string; count: number; rows: { id: string; name: string }[] } {
  if (object === "routines") {
    const rows = db.prepare("SELECT r.id, r.name, r.schedule, r.enabled, r.trigger_type, a.name agent_name FROM routines r LEFT JOIN agents a ON a.id = r.agent_id ORDER BY r.created_at").all() as any[];
    return {
      text: rows.length ? rows.map((r) => `- [${r.id}] ${r.name} · ${r.trigger_type === "email" ? `메일트리거` : r.schedule} · ${r.enabled ? "활성" : "비활성"} · 담당: ${r.agent_name ?? "대장"}`).join("\n") : "(등록된 루틴 없음 — 0건)",
      count: rows.length,
      rows: rows.map((r) => ({ id: String(r.id), name: String(r.name) })),
    };
  }
  if (object === "agents") {
    const rows = db.prepare("SELECT a.id, a.name, a.is_boss, a.is_lead, a.model FROM agents a LEFT JOIN agents p ON a.parent_id = p.id ORDER BY a.is_boss DESC, a.pinned DESC, COALESCE(CASE WHEN p.id IS NOT NULL AND p.is_boss = 0 THEN p.sort_order END, a.sort_order, a.created_at), CASE WHEN p.id IS NOT NULL AND p.is_boss = 0 THEN 1 ELSE 0 END, COALESCE(a.sort_order, a.created_at)").all() as any[];
    return {
      text: rows.map((a) => `- ${a.name}${a.is_boss ? " [CEO]" : a.is_lead ? " [팀장]" : ""} · 모델: ${a.model}`).join("\n"),
      count: rows.length,
      rows: rows.map((a) => ({ id: String(a.id), name: String(a.name) })),
    };
  }
  return { text: "", count: 0, rows: [] };
}

// 이 실행에서 해당 객체의 변경 도구가 실제로(게이트 통과해) 실행됐는가 — 조회 지시 중 발생한
// 변경의 귀속 판정에 사용. 다른 세션의 동시 변경을 이 실행 탓으로 되돌리지 않기 위함이다.
export function mutationExecuted(object: IntentObject, calledTools: Set<string>, gatedTools: Set<string>): boolean {
  const c = TOOL_CONTRACT[object!];
  if (!c) return false;
  return [...calledTools].some((t) => !gatedTools.has(t) && (c.delete?.test(t) || c.create?.test(t) || c.update?.test(t)));
}

// 조회 지시인데 변경이 실행된 경우(반대 동작) — 요청 없이 생성된 행을 되돌린다.
// 삭제된 행은 복구할 수 없으므로 개수만 보고한다. exec는 게이트를 거치지 않는 직접 실행이어야 한다
// (승인 없이 일어난 변경을 원상태로 돌리는 정리 작업이므로 새 승인 팝업을 만들면 안 된다).
export async function undoUnrequestedChanges(
  object: IntentObject,
  beforeIds: Set<string>,
  exec: (tool: string, args: Record<string, unknown>) => Promise<string>,
): Promise<{ created: number; undone: number; removed: number }> {
  const after = snapshot(object).rows;
  const afterIds = new Set(after.map((r) => r.id));
  const created = after.filter((r) => !beforeIds.has(r.id));
  const removed = [...beforeIds].filter((id) => !afterIds.has(id)).length;
  let undone = 0;
  for (const row of created) {
    const tool = object === "routines" ? "routine_delete" : "agent_delete";
    const args = object === "routines" ? { id: row.id } : { name: row.name };
    try {
      const out = await exec(tool, args);
      if (!out.includes("없음") && !out.startsWith("도구 오류")) undone++;
    } catch { /* 다음 행 계속 */ }
  }
  return { created: created.length, undone, removed };
}

// 모델이 이행하지 못한 지시를 서버가 직접 실행할 대상으로 해석 — 삭제는 ID 목록을 서버가 실측하므로 완전히 결정 가능
// 이름 매칭: 전체 일치·공백 제거 일치·이름의 의미 토큰(2자+)이 지시문에 포함되면 매칭 — 부분 명칭("테스트 루틴")도 해석
const nameHit = (name: string, text: string) =>
  text.includes(name) || text.includes(name.replace(/\s+/g, ""))
  || name.split(/\s+/).some((w) => w.length >= 2 && text.includes(w));

export function resolveTargets(intent: Intent, userText: string): { tool: string; args: Record<string, unknown> }[] | null {
  if (intent.verb !== "delete") return null;
  if (intent.object === "routines") {
    const rows = db.prepare("SELECT id, name FROM routines").all() as { id: string; name: string }[];
    const targets = intent.all ? rows : rows.filter((r) => userText.includes(r.id) || nameHit(r.name, userText));
    return targets.length ? targets.map((r) => ({ tool: "routine_delete", args: { id: r.id } })) : null;
  }
  if (intent.object === "agents") {
    const rows = (db.prepare("SELECT id, name, is_boss FROM agents").all() as { id: string; name: string; is_boss: number }[]).filter((a) => !a.is_boss);
    const targets = intent.all ? rows : rows.filter((a) => nameHit(a.name, userText));
    return targets.length ? targets.map((a) => ({ tool: "agent_delete", args: { name: a.name } })) : null;
  }
  return null;
}

export interface StateVerdict {
  ok: boolean;
  pendingApproval?: boolean; // 도구는 호출됐지만 승인 게이트에 걸려 대기 중 — "승인 대기"로 보고해야 함
  detail?: string;           // 불이행 시 교정 라운드에 넣을 설명
}

// 실행 후 DB 상태 변화로 이행 여부를 검증 — 모델 주장이 아니라 실제 상태가 기준
export function verifyMutation(
  intent: Intent,
  beforeCount: number,
  calledTools: Set<string>,
  gatedTools: Set<string>,
): StateVerdict {
  if (!intent.verb || !intent.object || intent.verb === "read") return { ok: true };
  const contract = TOOL_CONTRACT[intent.object]?.[intent.verb];
  const called = [...calledTools].filter((t) => contract?.test(t));
  const gated = called.some((t) => gatedTools.has(t));
  const after = snapshot(intent.object).count;

  // 승인 게이트에 걸린 경우 — 미실행이지만 실패가 아니라 "승인 대기"가 정답
  if (gated) return { ok: true, pendingApproval: true };

  if (intent.verb === "delete") {
    // "모두 삭제"라도 삭제 불가 대상(CEO 등)이 남을 수 있어 0을 요구하면 안 됨 — 감소 여부로 판정
    const gone = after < beforeCount;
    if (gone && intent.all && intent.object === "agents") {
      // 전체 삭제 지시인데 삭제 가능한 대상(비-CEO)이 아직 남아 있으면 부분 이행 — 미완료로 판정
      const remaining = (db.prepare("SELECT COUNT(*) c FROM agents WHERE is_boss = 0").get() as any)?.c ?? 0;
      if (remaining > 0) return { ok: false, detail: `전체 삭제 지시였지만 삭제 가능한 봇이 ${remaining}개 남아 있습니다 — agent_list로 남은 봇을 확인하고 모두 삭제하세요.` };
    }
    if (gone) return { ok: true };
    if (after > beforeCount)
      return { ok: false, detail: `삭제 지시였는데 오히려 ${intent.object}가 ${beforeCount}건 → ${after}건으로 늘었습니다 — 반대 동작(등록)이 수행됐습니다. 이전 동작은 롤백할 수 없으니 사실대로 보고하고, 지금 routine_list로 ID를 확인해 *_delete로 실제 삭제하세요.` };
    return { ok: false, detail: `삭제 지시였지만 ${intent.object} 수가 ${beforeCount}건에서 변하지 않았습니다 — 실제 삭제가 이뤄지지 않았습니다. 목록 조회 후 *_delete 도구로 실제 삭제하고 결과를 보고하세요. "삭제했다"고 주장만 하면 안 됩니다.` };
  }
  if (intent.verb === "create") {
    if (after > beforeCount) return { ok: true };
    if (after < beforeCount)
      return { ok: false, detail: `등록/생성 지시였는데 오히려 ${intent.object}가 ${beforeCount}건 → ${after}건으로 줄었습니다 — 반대 동작(삭제)이 수행됐습니다. 사실대로 보고하고 지시된 등록을 다시 수행하세요.` };
    return { ok: false, detail: `등록/생성 지시였지만 ${intent.object} 수가 ${beforeCount}건에서 변하지 않았습니다 — 실제 등록이 이뤄지지 않았습니다. *_add/*_create 도구로 실제 등록하거나, 못 한다면 이유를 보고하세요.` };
  }
  // update는 상태 비교가 애매 — 도구 호출 여부만 계약으로 검증
  if (intent.verb === "update") {
    if (called.length) return { ok: true };
    return { ok: false, detail: `수정 지시였지만 *_update 도구가 호출되지 않았습니다 — 실제 수정이 이뤄지지 않았습니다. 수정 도구로 실제 수행하세요.` };
  }
  return { ok: true };
}
