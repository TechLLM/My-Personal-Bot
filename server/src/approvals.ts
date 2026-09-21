import { Hono } from "hono";
import { db, uid, now, getSetting } from "./db";
import { describeApproval } from "../../shared/user-facing";
import { currentRootJobId, finalizeCommandIfReady } from "./command-delivery";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { realpathSync, statSync } from "node:fs";
import type { ToolCtx } from "./toolloop";

// ─── 승인 경계 (그록 Auto Review 대응) ───
// 위험한 액션(외부 발신·삭제·결제 류)은 실행 전 사용자 승인을 받는다.
// 규칙 우선순위: require > allow > 기본 위험 패턴. Require가 항상 이김 (그록과 동일)

// 기본 위험 패턴 — 규칙이 없어도 이름만으로 승인 요구 (파괴적·외부 영향 액션)
// skill_save — 스킬은 전 봇이 재사용하는 조직 자산이라 저장 전 사용자 승인
// agent_create/update/reorder/delete — 봇 설정 변경은 사용자 승인 후 반영 (조직 관리 채널)
// shell_run은 이름이 아니라 명령 내용으로 가른다 (아래 isReadOnlyShell)
const DEFAULT_RISKY = /send_email|send_telegram|delete|publish|purchase|payment|pay_|_pay|submit_form|drop|execute_sql|skill_save|agent_(create|update|reorder)|computer_/i;
// 승인 면제 — 이름에 위험 단어가 있어도 실제로는 안전한 도구
const DEFAULT_SAFE = /routine_list|agent_list|read_|list_|_list|search|lookup/i;

// 조회용 셸만 자동 허용한다.
// 2026-09-18에는 ls·find 같은 조회까지 팝업이 떠 승인 51건이 만료되고 업무가 멈춰 shell_run을 통째로 면제했는데,
// 2026-09-19 점검에서 서비스가 공인 도메인(nginx → 5274)으로 인증 없이 열려 있던 것이 확인돼 그 범위를 여기까지 좁혔다.
// 쓰기·삭제·네트워크·인터프리터 실행과 리다이렉션·체이닝·치환은 계속 승인을 받는다.
const READ_ONLY_CMD = /^(ls|cat|head|tail|find|grep|rg|wc|stat|file|du|df|pwd|echo|date|which|tree|sort|uniq|cut|basename|dirname|realpath|jq)\b/;
const SHELL_UNSAFE = /[>`$;&]|\b(rm|mv|cp|ln|chmod|chown|kill|curl|wget|ssh|scp|nc|telnet|python3?|node|bun|deno|sh|bash|zsh|eval|exec|sudo|tee|dd|launchctl|git|npm|pip3?|open|osascript)\b/;

export function isReadOnlyShell(command: unknown): boolean {
  const c = String(command ?? "").trim();
  if (!c || SHELL_UNSAFE.test(c)) return false;
  // 파이프는 허용하되 각 구간이 모두 조회 명령이어야 한다 — `ls | head`는 통과, `cat x | sh`는 차단
  return c.split("|").every((seg) => READ_ONLY_CMD.test(seg.trim()));
}

export function approvalDecision(tool: string, args?: Record<string, unknown>): "require" | "allow" {
  const rules = db.prepare("SELECT pattern, action, cond FROM approval_rules").all() as { pattern: string; action: string; cond: string | null }[];
  let hasAllow = false;
  for (const r of rules) {
    try {
      if (!new RegExp(r.pattern, "i").test(tool)) continue;
      // A12 — 인자 조건 규칙: cond가 있으면 args가 조건을 만족할 때만 규칙 적용
      if (r.cond && !evalCond(r.cond, args ?? {})) continue;
      if (r.action === "require") return "require"; // require는 항상 우선
      hasAllow = true;
    } catch {}
  }
  if (hasAllow) return "allow";
  if (tool === "shell_run") return isReadOnlyShell(args?.command ?? args?.cmd ?? args?.script) ? "allow" : "require";
  if (DEFAULT_SAFE.test(tool)) return "allow";
  return DEFAULT_RISKY.test(tool) ? "require" : "allow";
}

// A12 — 인자 조건 평가: cond = {"field":"to","op":"matches","value":"@외부\\.com$"}
// 지원 op: eq | ne | contains | matches(regex) | gt | lt | exists
function evalCond(condJson: string, args: Record<string, unknown>): boolean {
  const c = JSON.parse(condJson);
  const v = args?.[String(c.field)];
  switch (c.op) {
    case "eq": return v === c.value;
    case "ne": return v !== c.value;
    case "contains": return String(v ?? "").includes(String(c.value));
    case "matches": return new RegExp(String(c.value), "i").test(String(v ?? ""));
    case "gt": return Number(v) > Number(c.value);
    case "lt": return Number(v) < Number(c.value);
    case "exists": return v !== undefined && v !== null && v !== "";
    default: return false;
  }
}

// agent_create 인자에서 생성 예정 수 — bots/names 배열 또는 단일 name
// 빈 배열은 "인자 없음" — {"bots":[],"name":"X"}는 단일 생성 1건으로 센다
function prospectiveCreateCount(args: Record<string, unknown>): number {
  if (Array.isArray(args.bots) && args.bots.length) return args.bots.length;
  if (Array.isArray(args.agents) && args.agents.length) return args.agents.length;
  if (Array.isArray(args.names) && args.names.length) return args.names.length;
  return (args.name ?? args.bot_name ?? args.agent) ? 1 : 0;
}

// 승인 실행 결과가 도구 측 오류 문자열인지 — "봇 생성됨" 같은 성공 결과와 구분해
// 실패 재개 안내·재요청 차단·디듀프 메시지 분기에 쓴다
const TOOL_ERROR_RE = /^(오류|실행 오류|도구 오류|브라우저 오류|권한 없음|알 수 없는 도구|봇 없음|상위 봇 없음|라우팅 규칙|순환 차단|위임 깊이 제한|자기 자신|하위 봇 한도 초과|업무 트리)/;
export const looksLikeToolError = (result: string) => TOOL_ERROR_RE.test(result.trim());

export interface ApprovalGateContext {
  browserKey: string;
  runKey: string;
  fileRoot: string | null;
  depth: number;
  conversationId: string | null;
}

export interface ApprovalExecutionContextV1 extends ApprovalGateContext {
  v: 1;
  agentId: string | null;
  rootJobId: string | null;
  scope: string;
}

export type DecodedApprovalContext = Omit<ApprovalExecutionContextV1, "fileRoot"> & {
  fileRoot?: string; // null은 즉시 실행과 같은 "명시 루트 없음" 의미를 보존한다
  chain: string[];
};

const WORKSPACE_ROOT = resolve(join(import.meta.dir, "..", "data", "workspace"));
const contextScope = (c: Pick<ApprovalExecutionContextV1, "agentId" | "rootJobId" | "browserKey" | "fileRoot" | "conversationId">) =>
  JSON.stringify([c.rootJobId, c.browserKey, c.fileRoot, c.conversationId]);

function requiredContextString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 500) throw new Error(`${field}가 없거나 올바르지 않습니다`);
  return value;
}

function nullableContextString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > 2000) throw new Error(`${field}가 올바르지 않습니다`);
  return value;
}

export function resolveApprovalFileRoot(value: unknown): string {
  const base = realpathSync(WORKSPACE_ROOT);
  if (value === null) return base; // null은 누락이 아니라 승인 당시의 명시적 공유 workspace
  if (typeof value !== "string" || !value.trim() || !isAbsolute(value)) throw new Error("fileRoot가 없거나 절대 경로가 아닙니다");
  const candidate = realpathSync(value);
  if (!statSync(candidate).isDirectory()) throw new Error("fileRoot가 디렉터리가 아닙니다");
  const rel = relative(base, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("fileRoot가 허용 workspace 밖입니다");
  return candidate;
}

function encodeApprovalContext(agentId: string | null, rootJobId: string | null, input: ApprovalGateContext): string {
  const context: ApprovalExecutionContextV1 = {
    v: 1,
    agentId,
    rootJobId,
    browserKey: requiredContextString(input?.browserKey, "browserKey"),
    runKey: requiredContextString(input?.runKey, "runKey"),
    fileRoot: input?.fileRoot === null ? null : nullableContextString(input?.fileRoot, "fileRoot"),
    depth: input?.depth,
    conversationId: nullableContextString(input?.conversationId, "conversationId"),
    scope: "",
  };
  if (!Number.isInteger(context.depth) || context.depth < 0 || context.depth > 64) throw new Error("depth가 올바르지 않습니다");
  // alias 원문을 저장하면 승인 대기 중 symlink를 A→B로 바꿔 실행 대상을 바꿀 수 있다.
  // null은 즉시 실행의 "명시 루트 없음" 의미로 남기고, 실제 경로만 canonical target으로 고정한다.
  if (context.fileRoot === null) resolveApprovalFileRoot(null);
  else context.fileRoot = resolveApprovalFileRoot(context.fileRoot);
  context.scope = contextScope(context);
  return JSON.stringify(context);
}

export function decodeApprovalContext(row: any): DecodedApprovalContext {
  let raw: any;
  try { raw = JSON.parse(row?.execution_context); }
  catch { throw new Error("승인 실행 맥락이 없거나 손상됐습니다 — 원래 작업에서 다시 승인 요청하세요"); }
  if (!raw || Array.isArray(raw) || raw.v !== 1) throw new Error("지원하지 않는 승인 실행 맥락입니다 — 원래 작업에서 다시 승인 요청하세요");
  const context: ApprovalExecutionContextV1 = {
    v: 1,
    agentId: raw.agentId === null ? null : requiredContextString(raw.agentId, "agentId"),
    rootJobId: raw.rootJobId === null ? null : requiredContextString(raw.rootJobId, "rootJobId"),
    browserKey: requiredContextString(raw.browserKey, "browserKey"),
    runKey: requiredContextString(raw.runKey, "runKey"),
    fileRoot: raw.fileRoot === null ? null : nullableContextString(raw.fileRoot, "fileRoot"),
    depth: raw.depth,
    conversationId: nullableContextString(raw.conversationId, "conversationId"),
    scope: requiredContextString(raw.scope, "scope"),
  };
  if (!Number.isInteger(context.depth) || context.depth < 0 || context.depth > 64) throw new Error("승인 실행 depth가 올바르지 않습니다");
  const rowAgent = row?.agent_id ?? null;
  const rowRoot = row?.root_job_id ?? null;
  if (context.agentId !== rowAgent || context.rootJobId !== rowRoot) throw new Error("승인 행과 실행 맥락의 소유자가 일치하지 않습니다");
  if (context.scope !== contextScope(context)) throw new Error("승인 실행 맥락의 범위가 손상됐습니다");
  let chain: unknown;
  try { chain = row?.chain ? JSON.parse(row.chain) : []; }
  catch { throw new Error("승인 실행 위임 사슬이 손상됐습니다"); }
  if (!Array.isArray(chain) || chain.some((id) => typeof id !== "string" || !id)) throw new Error("승인 실행 위임 사슬이 올바르지 않습니다");
  let fileRoot: string | undefined;
  if (context.fileRoot !== null) {
    const canonical = resolveApprovalFileRoot(context.fileRoot);
    if (resolve(context.fileRoot) !== canonical) throw new Error("승인 후 fileRoot 대상이 변경됐습니다 — 원래 작업에서 다시 승인 요청하세요");
    fileRoot = canonical;
  }
  return { ...context, fileRoot, chain: [...chain] };
}

// 도구 실행 전 호출 — 승인 필요면 요청을 만들고 안내 문자열 반환, 아니면 null
export function gateApproval(tool: string, args: Record<string, unknown>, agentId: string | null, resumeTask: string, chain?: string[], explicitRootJobId?: string, execution?: ApprovalGateContext, forceRequire = false): string | null {
  let required = forceRequire || approvalDecision(tool, args) === "require";
  // A6/C7 — 봇 생성은 정원 내면 승인 면제(팀장 포함). 전체 정원(agent_cap_total, 기본 20)
  // 초과분만 승인 대상. 팀장의 max_children 한도는 도구 내부에서 거부하므로 여기선 보지 않는다.
  if (!required && tool === "agent_create") {
    const want = prospectiveCreateCount(args);
    const total = (db.prepare("SELECT COUNT(*) c FROM agents").get() as any).c;
    if (want > 0 && total + want > (Number(getSetting("agent_cap_total")) || 20)) required = true;
  }
  if (!required) return null;
  // 형식이 깨진 호출은 팝업을 만들지 않고 즉시 오류를 돌려준다 — 승인→실행실패→재요청 팝업 루프 방지.
  // 봇은 이 오류를 보고 인자를 고쳐 다시 요청할 수 있다 (사용자 승인을 소모하지 않는다)
  if (tool === "agent_create" && !prospectiveCreateCount(args))
    return '오류: 생성할 봇 이름이 없습니다 — {"name":"메일분석봇","role":"20년 경력의 메일 분석 시니어"} 형식 또는 {"bots":[{"name":"봇1","role":"..."},{"name":"봇2","role":"..."}]} 배치 형식으로 호출하세요';
  const argsJson = canonicalArgs(args);
  const rootJobId = explicitRootJobId ?? currentRootJobId() ?? null;
  if (!execution) return "오류: 승인 실행 맥락이 없습니다 — 원래 작업에서 다시 요청하세요.";
  if (chain !== undefined && (!Array.isArray(chain) || chain.some((id) => typeof id !== "string" || !id)))
    return "오류: 승인 실행 위임 사슬이 올바르지 않습니다 — 원래 작업에서 다시 요청하세요.";
  let executionJson: string;
  let executionScope: string;
  try {
    executionJson = encodeApprovalContext(agentId ?? null, rootJobId, execution);
    executionScope = (JSON.parse(executionJson) as ApprovalExecutionContextV1).scope;
  } catch (e) {
    return `오류: 승인 실행 맥락을 고정할 수 없습니다 — ${(e as Error).message}. 원래 작업에서 다시 요청하세요.`;
  }
  // 최근에 이미 승인·실행된 동일 호출 — 승인 재개 봇의 재시도가 같은 팝업을 반복해 띄우는 것을 차단.
  // 재실행은 하지 않고 이전 실행 결과를 그대로 돌려준다 (비멱등 도구의 이중 실행 방지).
  const done = db.prepare("SELECT result FROM approval_requests WHERE status = 'approved' AND result IS NOT NULL AND tool = ? AND agent_id IS ? AND args = ? AND root_job_id IS ? AND CASE WHEN json_valid(execution_context) THEN json_extract(execution_context, '$.scope') END = ? AND resolved_at > ? ORDER BY resolved_at DESC LIMIT 1")
    .get(tool, agentId ?? null, argsJson, rootJobId, executionScope, now() - 10 * 60_000) as { result: string | null } | undefined;
  if (done && !(done.result ?? "").startsWith("실행 오류") && !deleteTargetStillExists(tool, args)) {
    const res = done.result ?? "";
    return looksLikeToolError(res)
      ? `이전에 승인·실행됐으나 실패한 동일한 호출입니다 — 실패 결과: ${res.slice(0, 500)}\n같은 인자로 재요청하면 같은 실패입니다 — 인자를 수정해 요청하거나, 불가능하면 실패를 보고하세요.`
      : `이미 승인되어 실행 완료된 동일한 호출입니다 — 이전 실행 결과: ${res.slice(0, 500)}\n이 호출을 다시 요청하지 말고 작업을 계속하세요.`;
  }
  // 같은 대상에 대한 승인 실행이 연속 실패했으면 팝업을 더 띄우지 않는다 — 역할 문구만 조금 바꾼 재요청이
  // 인자 디듀프를 우회해 승인 팝업을 무한 반복한 사고(2026-09-18 골든테스트봇, 6회 승인·0건 생성) 방지
  if (tool.startsWith("agent_")) {
    const targetName = String(args.name ?? args.bot_name ?? args.agent ?? args.to ?? args.target ?? "").trim();
    if (targetName) {
      const prev = db.prepare("SELECT result FROM approval_requests WHERE status = 'approved' AND tool = ? AND root_job_id IS ? AND CASE WHEN json_valid(execution_context) THEN json_extract(execution_context, '$.scope') END = ? AND resolved_at > ? AND COALESCE(json_extract(args,'$.name'), json_extract(args,'$.bot_name'), json_extract(args,'$.agent'), json_extract(args,'$.to'), json_extract(args,'$.target')) = ? ORDER BY resolved_at DESC LIMIT 2")
        .all(tool, rootJobId, executionScope, now() - 30 * 60_000, targetName) as { result: string | null }[];
      if (prev.length >= 2 && prev.every((r) => looksLikeToolError(r.result ?? "")))
        return `같은 대상(${targetName})에 대한 승인 실행이 연속 실패했습니다 — 최근 실패: ${(prev[0].result ?? "").slice(0, 300)}\n같은 의도의 재요청을 반복하지 말고, 호출 형식을 바로잡거나 불가능하면 실패를 보고하세요.`;
    }
  }
  // 최근에 거부된 동일 호출 — 거부를 우회하는 재요청 팝업을 차단
  const denied = db.prepare("SELECT id FROM approval_requests WHERE status = 'denied' AND tool = ? AND agent_id IS ? AND args = ? AND root_job_id IS ? AND CASE WHEN json_valid(execution_context) THEN json_extract(execution_context, '$.scope') END = ? AND resolved_at > ? LIMIT 1")
    .get(tool, agentId ?? null, argsJson, rootJobId, executionScope, now() - 10 * 60_000);
  if (denied) {
    return `사용자가 이 호출(${tool})을 이미 거부했습니다 — 같은 호출을 다시 요청하지 말고, 다른 방법이 있으면 그것으로 진행하고 없으면 거부됐다고 보고하세요.`;
  }
  // 같은 봇에 대한 설정 수정이 이미 대기 중이면 최신 요청으로 교체 — 문구만 조금씩 다른 수정 요청이
  // 봇마다 5~7건씩 팝업으로 쌓였던 사고(2026-09-18) 방지. 요청한 봇이 달라도 대상이 같으면 교체한다
  if (tool === "agent_update") {
    const target = String(args.name ?? args.to ?? args.agent ?? args.target ?? args.bot ?? "");
    if (target) db.prepare("UPDATE approval_requests SET status = 'expired', result = '같은 봇에 대한 새 수정 요청으로 대체됨', resolved_at = ? WHERE status = 'pending' AND tool = 'agent_update' AND root_job_id IS ? AND CASE WHEN json_valid(execution_context) THEN json_extract(execution_context, '$.scope') END = ? AND args != ? AND COALESCE(json_extract(args, '$.name'), json_extract(args, '$.to'), json_extract(args, '$.agent'), json_extract(args, '$.target'), json_extract(args, '$.bot')) = ?")
      .run(now(), rootJobId, executionScope, argsJson, target);
  }
  const dup = db.prepare("SELECT id FROM approval_requests WHERE status = 'pending' AND tool = ? AND agent_id IS ? AND args = ? AND root_job_id IS ? AND CASE WHEN json_valid(execution_context) THEN json_extract(execution_context, '$.scope') END = ?").get(tool, agentId ?? null, argsJson, rootJobId, executionScope) as any;
  if (!dup) {
    const summary = summarizeArgs(tool, args);
    db.prepare("INSERT INTO approval_requests (id, tool, args, summary, agent_id, resume, status, created_at, chain, root_job_id, execution_context) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)")
      .run(uid(), tool, argsJson, summary, agentId ?? null, resumeTask.slice(0, 500), now(), chain?.length ? JSON.stringify([...chain]) : null, rootJobId, executionJson);
    const root = rootJobId;
    if (root) void import("./command-delivery").then(({ deliverTelegramActionNeeded }) => deliverTelegramActionNeeded(root));
  }
  return `이 작업(${tool})은 사용자 승인이 필요합니다 — 화면의 승인 팝업에서 승인되면 자동으로 실행되고 작업이 이어집니다. 사용자에게 승인을 기다리고 있다고 알리고, 다른 작업으로 진행하세요. 같은 도구를 다시 호출해 재시도하지 마세요.`;
}

// 삭제 도구의 재승인 디듀프 예외 — 같은 이름으로 새 대상이 생겼으면 이번 호출은 반복이 아니라 새 삭제다
function deleteTargetStillExists(tool: string, args: Record<string, unknown>): boolean {
  if (tool === "routine_delete") {
    return !!db.prepare("SELECT 1 AS x FROM routines WHERE id = ?").get(String(args.id ?? ""));
  }
  if (tool === "agent_delete") {
    const name = String(args.name ?? "");
    const norm = name.replace(/\s+/g, "");
    return (db.prepare("SELECT name FROM agents").all() as { name: string }[])
      .some((a) => a.name === name || a.name.replace(/\s+/g, "") === norm);
  }
  return false;
}

// 키 순서가 다른 동일 인자를 같은 호출로 인식 — 디듀프·재승인 비교용
function canonicalArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args ?? {}).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = (args as any)[k];
  return JSON.stringify(out);
}

function summarizeArgs(tool: string, args: Record<string, unknown>): string {
  // 스킬 저장 승인 — 사용자가 절차 전체를 보고 승인 여부를 판단해야 하므로 잘라내지 않고 표시
  if (tool === "skill_save") {
    const trigger = args.trigger ? `\n적용 조건: ${String(args.trigger).slice(0, 200)}` : "";
    const notes = args.notes ? `\n주의점: ${String(args.notes).slice(0, 300)}` : "";
    return `skill_save — 스킬 "${String(args.name ?? "").slice(0, 60)}"${trigger}\n절차:\n${String(args.steps ?? "").slice(0, 1200)}${notes}`.slice(0, 1800);
  }
  // 조직 변경 승인 — 무엇이 바뀌는지(대상·필드·일괄 생성 목록)를 명확히 표시
  if (tool.startsWith("agent_")) {
    const parts = Object.entries(args ?? {}).map(([k, v]) =>
      k === "bots" && Array.isArray(v)
        ? `bots: ${v.map((b: any) => b?.name ?? "?").join(", ")}`
        : `${k}: ${String(v).slice(0, 300)}`);
    return `${tool}(${parts.join(", ")})`.slice(0, 900);
  }
  // 데스크톱 제어 승인 — 무슨 화면 액션인지 한국어로 표시
  if (tool.startsWith("computer_")) {
    const label: Record<string, string> = { computer_look: "화면 분석", computer_apps: "실행 앱 목록", computer_activate: `앱 전면 전환 (${args.app})`, computer_click: `화면 클릭 (${args.x}, ${args.y})`, computer_doubleclick: `화면 더블클릭 (${args.x}, ${args.y})`, computer_rightclick: `화면 우클릭 (${args.x}, ${args.y})`, computer_type: `텍스트 입력 "${String(args.text ?? "").slice(0, 120)}"`, computer_key: `키 입력 ${args.key}`, computer_scroll: `스크롤 (${args.x}, ${args.y}) ${args.clicks ?? ""}`, computer_drag: `드래그 (${args.x1},${args.y1})→(${args.x2},${args.y2})` };
    return `데스크톱 제어 — ${label[tool] ?? `${tool}(${JSON.stringify(args).slice(0, 200)})`}`;
  }
  const parts = Object.entries(args ?? {}).slice(0, 4).map(([k, v]) => `${k}: ${String(v).slice(0, 120)}`);
  return `${tool}(${parts.join(", ")})`.slice(0, 400);
}

// ─── 봇 간 비동기 메시지 디스패치 (그록 DM 핸드오프 대응) ───
// 받는 봇을 백그라운드로 실행 → 완료되면 보낸 봇 세션에 회신 기록

export function dispatchAgentMessage(msgId: string) {
  (async () => {
    const msg = db.prepare("SELECT * FROM agent_messages WHERE id = ?").get(msgId) as any;
    if (!msg || msg.status !== "pending") return;
    // 원자적 클레임 — pending→processing 전이가 성공한 디스패치만 진행 (동시 디스패치 중복 실행 방지)
    const claimed = db.prepare("UPDATE agent_messages SET status = 'processing' WHERE id = ? AND status = 'pending'").run(msgId);
    if (!claimed.changes) return;
    const { getAgent, runAgentDetached } = await import("./team");
    const target = getAgent(msg.to_agent_id);
    if (!target) {
      const failure = "봇을 찾을 수 없음";
      db.prepare("UPDATE agent_messages SET status = 'failed', reply = ?, done_at = ? WHERE id = ?").run(failure, now(), msgId);
      const { childCommandFinished } = await import("./command-delivery");
      await childCommandFinished(msg.root_job_id, `message:${msgId}`, failure, msg.to_agent_id);
      return;
    }
    const sender = msg.from_agent_id ? getAgent(msg.from_agent_id) : null;
    // 메시지 사슬 = 보낸 봇까지의 상위 봇 id. 받는 봇은 사슬의 봇에게 되돌아 지시·메시지를 보낼 수 없다
    let chain: string[] = [];
    try { chain = JSON.parse(msg.chain ?? "[]"); } catch {}
    runAgentDetached(target, {
      label: `[${sender?.name ?? "사용자"} 메시지] ${msg.content.slice(0, 150)}`,
      task: `[${sender?.name ?? "사용자"} 봇의 비동기 메시지입니다. 처리하고 회신할 내용을 보고하세요 — 회신은 보낸 봇의 세션에 전달됩니다]\n\n${msg.content}`,
      sessionTitle: `[${sender?.name ?? "사용자"} 메시지] ${msg.content}`,
      sessionTask: msg.content,
      replyTo: sender,
      chain,
      verifyIntent: false, // 메시지 본문은 보고·알림 — 지시-실측 검증 대상이 아님 (보고 속 단어를 지시로 오독해 반대 실행을 강제하는 사고 방지)
      rootJobId: msg.root_job_id,
      onDone: async (state) => {
        // 회신을 발신 봇이 실제로 받아 처리하게 재실행 — 세션에 기록만 하면 아무도 읽지 않는 데드레터가 됨
        // 재실행 사슬에 회신한 봇을 넣어, 회신에 다시 메시지로 답하는 보고-회신 핑퐁을 구조적으로 막는다
        // (추가 안전장치: 봇 쌍 메시지 10건/30분 + 봇별 실행 15회/시간 상한)
        if (sender && state.status === "done" && getAgent(sender.id)) {
          runAgentDetached(sender, {
            label: `[${target.name} 회신] ${msg.content.slice(0, 120)}`,
            task: `[${target.name} 봇이 보낸 회신이 도착했습니다 — 내용을 검토해 취합·보고·후속 조치 등 다음 단계를 이어가세요. ${target.name}에게 접수·확인 회신을 다시 보내지 마세요]\n\n${(state.result?.trim() || "(결과 없음)").slice(0, 3000)}`,
            sessionTitle: `[${target.name} 회신] ${msg.content.slice(0, 80)}`,
            sessionTask: msg.content,
            chain: [...chain.filter((id) => id !== sender.id), target.id],
            verifyIntent: false, // 회신 전달은 지시가 아님 — 지시-실측 검증 대상에서 제외
            rootJobId: msg.root_job_id,
          });
        }
        db.prepare("UPDATE agent_messages SET status = ?, reply = ?, done_at = ? WHERE id = ?")
          .run(state.status === "done" ? "done" : "failed", (state.result?.trim() || "(결과 없음)").slice(0, 4000), now(), msgId);
      },
    });
  })().catch(async (e) => {
    const failure = `메시지 처리 실패: ${String((e as Error).message ?? e).slice(0, 500)}`;
    const msg = db.prepare("SELECT * FROM agent_messages WHERE id = ?").get(msgId) as any;
    if (!msg) return;
    db.prepare("UPDATE agent_messages SET status = 'failed', reply = ?, done_at = ? WHERE id = ? AND status IN ('pending','processing')")
      .run(failure, now(), msgId);
    const { childCommandFinished } = await import("./command-delivery");
    await childCommandFinished(msg.root_job_id, `message:${msgId}`, failure, msg.to_agent_id);
  });
}

// ─── 승인 API ───

export const approvalsRoute = new Hono()
  .get("/", (c) => c.json({
    requests: (db.prepare("SELECT r.*, a.name agent_name FROM approval_requests r LEFT JOIN agents a ON a.id = r.agent_id WHERE r.status = 'pending' ORDER BY r.created_at").all() as any[]).map((r) => {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(r.args ?? "{}"); } catch {}
      const p = describeApproval(r.tool, args);
      return { id: r.id, tool: r.tool, agent_name: r.agent_name, created_at: r.created_at, ...p, summary: p.summary };
    }),
    rules: db.prepare("SELECT * FROM approval_rules ORDER BY created_at").all(),
  }))
  .post("/:id/approve", async (c) => {
    const req = db.prepare("SELECT * FROM approval_requests WHERE id = ? AND status = 'pending'").get(c.req.param("id")) as any;
    if (!req) return c.json({ error: "요청 없음 또는 이미 처리됨" }, 404);
    const b = await c.req.json().catch(() => ({})) as { always?: boolean };
    const pattern = `^${String(req.tool).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
    // stale 탭이 본문 파싱을 기다리는 동안 다른 탭이 먼저 처리할 수 있다. CAS와 영구 규칙 변경을
    // 한 트랜잭션에 묶어 실제 처리 소유권을 얻은 요청만 allow 규칙을 만들게 한다.
    const claimed = db.transaction(() => {
      const changed = db.prepare("UPDATE approval_requests SET status = 'executing', resolved_at = ? WHERE id = ? AND status = 'pending'").run(now(), req.id);
      if (!changed.changes) return false;
      if (b.always) {
        db.prepare("INSERT INTO approval_rules (id, pattern, action, created_at) VALUES (?, ?, 'allow', ?)").run(uid(), pattern, now());
        db.prepare("DELETE FROM approval_rules WHERE action = 'require' AND pattern = ?").run(pattern);
      }
      return true;
    })();
    if (!claimed) return c.json({ error: "이미 처리됨" }, 409);
    // 저장된 도구를 실제로 실행한 뒤 봇의 원래 작업을 재개
    executeApproved(req).catch((e) => console.error("[mybot] 승인 작업 실행 실패:", (e as Error).message));
    return c.json({ ok: true });
  })
  .post("/:id/deny", async (c) => {
    const req = db.prepare("SELECT * FROM approval_requests WHERE id = ? AND status = 'pending'").get(c.req.param("id")) as any;
    if (!req) return c.json({ error: "요청 없음 또는 이미 처리됨" }, 404);
    const b = await c.req.json().catch(() => ({})) as { always?: boolean };
    const pattern = `^${String(req.tool).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
    const claimed = db.transaction(() => {
      // 거부도 재개 run 등록이 끝날 때까지 blocker인 executing 상태를 유지한다.
      const changed = db.prepare("UPDATE approval_requests SET status = 'executing', resolved_at = ? WHERE id = ? AND status = 'pending'").run(now(), req.id);
      if (!changed.changes) return false;
      if (b.always)
        db.prepare("INSERT INTO approval_rules (id, pattern, action, created_at) VALUES (?, ?, 'require', ?)").run(uid(), pattern, now());
      return true;
    })();
    if (!claimed) return c.json({ error: "이미 처리됨" }, 409);
    try {
      await notifyDenied(req);
    } catch (e) {
      await failApproval(req, `승인 거부 처리 실패: ${String((e as Error).message ?? e)}`);
    }
    return c.json({ ok: true });
  })
  .post("/rules", async (c) => {
    const b = await c.req.json();
    if (!b.pattern || !["require", "allow"].includes(b.action)) return c.json({ error: "pattern, action(require|allow) 필요" }, 400);
    try { new RegExp(String(b.pattern)); } catch { return c.json({ error: "정규식 오류" }, 400); }
    // A12 — 선택적 인자 조건 {"field","op","value"} — JSON 형식과 op만 검증
    let cond: string | null = null;
    if (b.cond) {
      try {
        const cc = typeof b.cond === "string" ? JSON.parse(b.cond) : b.cond;
        if (!cc.field || !cc.op) return c.json({ error: "cond에는 field와 op가 필요합니다" }, 400);
        cond = JSON.stringify({ field: String(cc.field), op: String(cc.op), value: cc.value });
      } catch { return c.json({ error: "cond JSON 오류" }, 400); }
    }
    const id = uid();
    db.prepare("INSERT INTO approval_rules (id, pattern, action, cond, created_at) VALUES (?, ?, ?, ?, ?)").run(id, String(b.pattern), String(b.action), cond, now());
    return c.json({ rule: db.prepare("SELECT * FROM approval_rules WHERE id = ?").get(id) });
  })
  .delete("/rules/:id", (c) => {
    db.prepare("DELETE FROM approval_rules WHERE id = ?").run(c.req.param("id"));
    return c.json({ ok: true });
  })
  // 감사 뷰 — 봇 활동 이력: 실행 이력(agent_runs) + 승인 요청(approval_requests) 통합 조회
  // 필터: agent_id, tool(tool_log LIKE), days(기본 7일)
  .get("/activity", (c) => {
    const agentId = c.req.query("agent_id") || null;
    const tool = c.req.query("tool") || null;
    const days = Math.min(Math.max(Number(c.req.query("days")) || 7, 1), 90);
    const since = now() - days * 86400_000;
    const runArgs: unknown[] = [since];
    let runSql = `SELECT r.id, r.agent_id, a.name agent_name, a.avatar, r.task, r.status, r.steps, r.routine_id, r.resume_count, r.created_at, r.finished_at
      FROM agent_runs r LEFT JOIN agents a ON a.id = r.agent_id WHERE r.created_at > ?`;
    if (agentId) { runSql += " AND r.agent_id = ?"; runArgs.push(agentId); }
    if (tool) { runSql += " AND r.tool_log LIKE ?"; runArgs.push(`%"tool":"${tool.replace(/"/g, "")}"%`); }
    runSql += " ORDER BY r.created_at DESC LIMIT 200";
    const runs = db.prepare(runSql).all(...(runArgs as any[]));
    const apArgs: unknown[] = [since];
    let apSql = `SELECT r.id, r.agent_id, a.name agent_name, r.tool, r.args, r.status, r.created_at, r.resolved_at
      FROM approval_requests r LEFT JOIN agents a ON a.id = r.agent_id WHERE r.created_at > ?`;
    if (agentId) { apSql += " AND r.agent_id = ?"; apArgs.push(agentId); }
    if (tool) { apSql += " AND r.tool = ?"; apArgs.push(tool); }
    apSql += " ORDER BY r.created_at DESC LIMIT 200";
    const approvals = (db.prepare(apSql).all(...(apArgs as any[])) as any[]).map((r) => {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(r.args ?? "{}"); } catch {}
      const presentation = describeApproval(r.tool, args);
      // 실행용 원본 args와 과거 기술 요약은 감사 API로 내보내지 않는다.
      return {
        id: r.id,
        agent_id: r.agent_id,
        agent_name: r.agent_name,
        tool: r.tool,
        status: r.status,
        created_at: r.created_at,
        resolved_at: r.resolved_at,
        ...presentation,
      };
    });
    return c.json({ runs, approvals });
  });

// 같은 프로세스에서 동일 승인 실행이 겹치는 것을 차단한다. DB가 이미 executing인 UI 경로도
// 있으므로 status만으로 실행 소유권을 구분할 수 없다.
const executingApprovalIds = new Set<string>();

export interface ApprovalExecutionDeps {
  dispatch?: (tool: string, args: Record<string, unknown>, ctx: ToolCtx) => Promise<{ out: string; ok: boolean }>;
  resume?: (req: any, task: string) => Promise<{ registered: boolean; note: string }>;
}

// 승인된 도구를 실제 실행 → 결과 저장 → 봇 작업 재개
export async function executeApproved(req: any, deps: ApprovalExecutionDeps = {}) {
  const id = String(req?.id ?? "");
  if (!id || executingApprovalIds.has(id)) return;
  executingApprovalIds.add(id);
  try {
    // 호출자가 넘긴 객체는 승인 전 상태이거나 오래된 값일 수 있다. 승인된 원본 도구와 인자는
    // 반드시 DB에서 다시 읽고, 과거 evolve 자동 승인 경로의 approved+result=NULL 행만 CAS로 승격한다.
    let stored = db.prepare("SELECT * FROM approval_requests WHERE id = ?").get(id) as any;
    if (!stored || stored.result !== null) return;
    if (stored.status === "approved") {
      const claimed = db.prepare("UPDATE approval_requests SET status = 'executing' WHERE id = ? AND status = 'approved' AND result IS NULL")
        .run(id);
      if (!claimed.changes) return;
      stored = db.prepare("SELECT * FROM approval_requests WHERE id = ?").get(id) as any;
    } else if (stored.status !== "executing") {
      return;
    }
    if (!stored || stored.status !== "executing" || stored.result !== null) return;
    req = stored;

    const execution = decodeApprovalContext(req);
    let args: unknown;
    try { args = JSON.parse(req.args ?? "{}"); }
    catch { throw new Error("승인된 도구 인자가 손상됐습니다 — 원래 작업에서 다시 승인 요청하세요"); }
    if (!args || Array.isArray(args) || typeof args !== "object") throw new Error("승인된 도구 인자가 올바르지 않습니다 — 원래 작업에서 다시 승인 요청하세요");
    const controller = new AbortController();
    const dispatch = deps.dispatch ?? (await import("./toolloop")).dispatchToolCall;
    const dispatched = await dispatch(req.tool, args as Record<string, unknown>, {
      agentId: req.agent_id ?? null,
      context: req.resume ?? "",
      browserKey: execution.browserKey,
      runKey: execution.runKey,
      conversationId: execution.conversationId,
      fileRoot: execution.fileRoot,
      signal: controller.signal,
      depth: execution.depth,
      chain: execution.chain,
      rootJobId: execution.rootJobId ?? undefined,
    });
    const result = dispatched.out;

    // executing을 유지한 채 재개 실행을 먼저 등록한다. terminal 상태가 먼저 공개되면 다른 하위
    // 작업이 루트 명령을 완료해 버려 승인 결과가 최종 메시지에서 빠질 수 있다.
    const resume = await (deps.resume ?? resumeAgent)(req, looksLikeToolError(result)
      ? `사용자가 승인한 작업 "${req.summary}"을 실행했지만 실패했습니다.\n실패 결과:\n${result}\n\n같은 인자로 재요청하면 같은 실패가 발생합니다 — 인자를 수정하거나 다른 방법으로 진행하고, 불가능하면 실패를 보고하세요.\n\n원래 작업: ${req.resume || "(없음)"}`
      : `사용자가 승인한 작업 "${req.summary}"을 실행했습니다. 실행 결과:\n${result}\n\n원래 작업을 이어서 진행하고 결과를 보고하세요.\n\n원래 작업: ${req.resume || "(없음)"}`);
    const finalResult = `${result}${resume.note ? `\n${resume.note}` : ""}`.slice(0, 4000);
    const { recordCommandResult } = await import("./command-delivery");
    db.transaction(() => {
      if (req.root_job_id) recordCommandResult(req.root_job_id, `approval:${req.id}`, finalResult, req.agent_id);
      db.prepare("UPDATE approval_requests SET status = 'approved', result = ? WHERE id = ? AND status = 'executing'").run(finalResult, req.id);
    })();
    if (req.root_job_id) await finalizeCommandIfReady(req.root_job_id);
  } catch (e) {
    await failApproval(req, `승인 작업 처리 실패: ${String((e as Error).message ?? e)}`);
  } finally {
    executingApprovalIds.delete(id);
  }
}

async function notifyDenied(req: any) {
  const resume = await resumeAgent(req, `사용자가 작업 "${req.summary}"을 거부했습니다. 이 액션은 실행하지 마세요. 원래 작업이 다른 방법으로 가능하면 진행하고, 아니면 거부됐다고 보고하세요.\n\n원래 작업: ${req.resume || "(없음)"}`);
  const result = `승인 거부: ${req.summary}${resume.note ? `\n${resume.note}` : ""}`.slice(0, 4000);
  const { recordCommandResult } = await import("./command-delivery");
  db.transaction(() => {
    if (req.root_job_id) recordCommandResult(req.root_job_id, `approval:${req.id}`, result, req.agent_id);
    db.prepare("UPDATE approval_requests SET status = 'denied', result = ?, resolved_at = ? WHERE id = ? AND status = 'executing'")
      .run(result, now(), req.id);
  })();
  if (req.root_job_id) await finalizeCommandIfReady(req.root_job_id);
}

async function failApproval(req: any, message: string) {
  const result = message.slice(0, 4000);
  try {
    const { recordCommandResult, finalizeCommandIfReady: finalize } = await import("./command-delivery");
    db.transaction(() => {
      if (req.root_job_id) recordCommandResult(req.root_job_id, `approval:${req.id}`, result, req.agent_id);
      db.prepare("UPDATE approval_requests SET status = 'failed', result = ?, resolved_at = ? WHERE id = ? AND status = 'executing'")
        .run(result, now(), req.id);
    })();
    if (req.root_job_id) await finalize(req.root_job_id);
  } catch {
    db.prepare("UPDATE approval_requests SET status = 'failed', result = ?, resolved_at = ? WHERE id = ? AND status = 'executing'")
      .run(result, now(), req.id);
  }
}

async function resumeAgent(req: any, task: string): Promise<{ registered: boolean; note: string }> {
  if (!req.agent_id) return { registered: false, note: "업무 자동 재개 불가: 요청한 봇 정보가 없습니다." };
  const { getAgent, runAgentDetached, agentSessionConvId } = await import("./team");
  const agent = getAgent(req.agent_id);
  if (!agent) return { registered: false, note: "업무 자동 재개 불가: 요청한 봇이 삭제되었거나 존재하지 않습니다." };
  // 재개 폭주 방지 — 승인이 한꺼번에 처리되면 "원래 작업 재개" run이 봇당 수십 개 쌓인다.
  // 최근 10분에 재개 run이 3개를 넘으면 run을 새로 돌리지 않고 결과만 세션에 기록한다
  // (결과 자체는 approval_requests.result에도 남아 있고 세션 노트로 맥락이 유지된다).
  const recentResumes = (db.prepare("SELECT COUNT(*) c FROM agent_runs WHERE agent_id = ? AND task LIKE '[승인 처리됨]%' AND created_at > ?").get(agent.id, now() - 10 * 60_000) as any)?.c ?? 0;
  if (recentResumes >= 3) {
    if (req.root_job_id) {
      const { recordCommandResult } = await import("./command-delivery");
      recordCommandResult(req.root_job_id, `resume-cap:${req.id}`, `자동 재개 상한으로 추가 실행하지 않았습니다.\n${task}`, agent.id);
    }
    return { registered: false, note: "업무 자동 재개 불가: 최근 자동 재개 상한에 도달했습니다." };
  }
  // 승인으로 재개된 작업의 결과를 지시 체인으로 돌려보낸다 — 위임한 상위 봇에게 완료 회신을 전달해
  // 사용자의 원래 지시가 "승인 대기"로 끝난 뒤 결과가 사용자 대화에 도착하게 한다 (agent_message 회신 재수화와 같은 패턴)
  let reqChain: string[] = [];
  try { reqChain = JSON.parse(req.chain ?? "[]"); } catch {}
  const parentId = reqChain.filter((id) => id !== agent.id).at(-1);
  const parent = parentId ? getAgent(parentId) : null;
  runAgentDetached(agent, {
    label: `[승인 처리됨] ${req.tool} — 작업 재개`,
    task,
    sessionTitle: `[승인 처리 — 작업 재개] ${req.tool}`,
    sessionTask: req.resume || req.tool,
    rootJobId: req.root_job_id,
    onDone: parent
      ? (state) => {
          if (state.status !== "done" || !getAgent(parent.id)) return;
          runAgentDetached(parent, {
            label: `[승인 작업 회신] ${agent.name} · ${req.tool}`,
            task: `[${agent.name} 봇이 사용자 승인을 받아 실행한 작업 "${req.summary}"의 결과가 도착했습니다 — 내용을 검토해 사용자에게 취합·보고하세요. ${agent.name}에게 접수·확인 회신을 다시 보내지 마세요]\n\n${(state.result?.trim() || "(결과 없음)").slice(0, 3000)}`,
            sessionTitle: `[승인 작업 완료] ${req.tool}`,
            sessionTask: req.resume || req.summary,
            chain: [...reqChain.filter((id) => id !== parent.id), agent.id],
            verifyIntent: false, // 완료 회신 전달은 지시가 아님 — 지시-실측 검증 대상에서 제외
            rootJobId: req.root_job_id,
          });
        }
      : undefined,
  });
  return { registered: true, note: "" };
}
