// 도구 루프 공용 유틸 — routes/chat.ts(일반 대화)와 team.ts(봇 실행)가 함께 쓴다.
// 두 곳에 같은 코드가 복붙돼 있어 한쪽만 고치면 다른 경로에서 도구 누수 응답이
// 그대로 통과하는 문제가 있었다. 여기 한 곳만 고치면 양쪽이 같이 고쳐진다.
// (Phase 21에서 루프 본체까지 이 파일로 통합 예정)

export interface LeakedCall {
  id: string;
  name: string;
  arguments: string;
}

// 모델이 도구 호출을 텍스트 형식(<invoke name=…>)으로 새어내면 파싱해 실제 호출로 전환
export function parseLeaked(text: string): LeakedCall[] {
  const calls: LeakedCall[] = [];
  const invRe = /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g;
  let inv; let i = 0;
  while ((inv = invRe.exec(text ?? ""))) {
    const args: Record<string, string> = {};
    const pRe = /<(\w+)>([\s\S]*?)<\/\1>/g;
    let pm; while ((pm = pRe.exec(inv[2]))) args[pm[1]] = pm[2];
    calls.push({ id: `leaked-${i++}`, name: inv[1], arguments: JSON.stringify(args) });
  }
  return calls;
}

// ─── 단일 도구 디스패치 (C10) — chat.ts·team.ts가 각자 복붙하던 실행 경로의 공통 엔진 ───
// 인자 파싱 → 승인 게이트 → builtin/browser/MCP 라우팅 → 타임아웃 정책 → 오류 정규화.
// 라운드 루프·검증·평가는 경로별로 달라 각 호출자에 남긴다.
export interface ToolCall { id: string; name: string; arguments: string }

const DELEGATION = new Set(["agent_direct", "agent_message"]); // 중첩 실행 — 자체 시간 상한으로 관리
// 작업 권한 모드의 읽기 전용 집합 (Aside식: readonly=이 집합만, guard=집합 밖은 전부 승인).
// 위임 도구는 허용 — 하위 봇 실행도 같은 rootJobId로 같은 모드를 물려받아 안전하다.
// shell_run은 명령 내용이 조회용일 때만 읽기로 인정한다.
const READONLY_TOOLS = new Set([
  "web_search", "read_file", "list_files", "mail_list", "mail_read",
  "agent_list", "routine_list", "skill_list", "org_audit", "memory_save",
  "agent_direct", "agent_message",
  "browser_open", "browser_read", "browser_scroll", "browser_wait", "browser_back", "browser_look",
]);
function isReadOnlyCall(name: string, args: Record<string, unknown>, isReadOnlyShell: (c: unknown) => boolean): boolean {
  if (name === "shell_run") return isReadOnlyShell(args.command ?? args.cmd ?? args.script);
  return READONLY_TOOLS.has(name);
}
// 병렬 안전 — 서로 상태를 공유하지 않는 읽기·독립 작업. 브라우저(페이지 공유)·쓰기(경로 공유)는 순차 유지
export const PARALLEL_SAFE = new Set(["agent_direct", "agent_message", "web_search", "read_file", "list_files", "agent_list", "routine_list", "skill_list"]);
// 프롬프트에 안내할 조회 도구 이름 — 위임·메시지는 프롬프트에서 따로 설명하므로 뺀다.
// 목록을 손으로 적지 않고 위에서 파생시켜, 병렬 대상이 바뀌어도 안내가 어긋나지 않게 한다.
// (실측 2026-09-21: 이 도구들의 연속 호출 815회가 병렬로 묶일 수 있는데 한 라운드씩 소모됐다)
export const parallelQueryHint = () => [...PARALLEL_SAFE].filter((n) => n !== "agent_direct" && n !== "agent_message").join("·");
const LONG_RUNNING = /^browser_(handoff|login)$/; // 테이크오버·로그인 인계 — 사용자 완료까지 최대 5분 블로킹이 정상
export const isBrowserish = (n: string) => n.startsWith("browser_") || n === "ego_run" || n === "bsk";

export interface ToolCtx {
  agentId: string | null;            // 승인 게이트·builtin에 넘길 봇 id
  context: string;                   // gateApproval의 조건 평가에 쓸 지시문
  browserKey: string;                // 브라우저 페이지 스택 키 (runId 또는 convId:msgId)
  fileRoot?: string;                 // C19 — 프로젝트 파일 네임스페이스
  signal?: AbortSignal;
  depth?: number;
  chain?: string[];                  // 이 실행을 일으킨 상위 봇 id — 되돌아가는 위임·메시지 차단용
  rootJobId?: string;                // 최초 사용자 명령의 전달 단위
  emit?: (ev: any) => void;          // 하위 위임의 진행 이벤트 통로
  onStart?: (name: string) => void;  // 인자 파싱 성공 직후 (게이트 전)
  onGate?: (name: string) => void;   // 승인 큐로 반환됐을 때
  onDispatch?: (name: string) => void; // 게이트 통과 후 실제 실행 직전
  onEnd?: (name: string, out: string, ok: boolean, ms: number) => void; // 모든 경로의 종료 시점 (toolLog용)
}

export async function execToolCall(tc: ToolCall, ctx: ToolCtx): Promise<{ out: string; ok: boolean }> {
  const t0 = Date.now();
  const finish = (out: string, ok: boolean) => { ctx.onEnd?.(tc.name, out, ok, Date.now() - t0); return { out, ok }; };
  let args: Record<string, unknown>;
  try { args = JSON.parse(tc.arguments || "{}"); }
  catch { return finish(`도구 오류: ${tc.name}의 인자 JSON이 깨져 있습니다(길이 ${tc.arguments.length}자). content가 크면 짧게 나눠 쓰고, 따옴표·줄바꿈을 올바르게 이스케이프한 유효한 JSON으로 다시 호출하세요.`, false); }
  // 빈 배열 인자는 "인자 없음"으로 정규화 — 스키마의 모든 필드를 채우는 모델이 {"bots":[]} 같은 빈 배열을
  // 함께 보내면 배치 모드로 오인돼 동봉된 단일 인자(name 등)가 무시되는 결정적 실패를 낳는다 (승인→실행실패 루프의 근본 원인)
  for (const k of Object.keys(args)) if (Array.isArray(args[k]) && !(args[k] as unknown[]).length) delete args[k];
  ctx.onStart?.(tc.name);
  // 승인 경계 — 위험 액션은 실행하지 않고 사용자 승인 큐에 올림
  const { gateApproval, isReadOnlyShell } = await import("./approvals");
  // 작업 권한 모드 — 명령 루트(command_jobs.task_mode)에 저장돼 위임된 하위 봇에게도 상속된다
  if (ctx.rootJobId) {
    const { db } = await import("./db");
    const mode = (db.prepare("SELECT task_mode FROM command_jobs WHERE id = ?").get(ctx.rootJobId) as { task_mode: string | null } | undefined)?.task_mode;
    if ((mode === "readonly" || mode === "guard") && !isReadOnlyCall(tc.name, args, isReadOnlyShell)) {
      if (mode === "readonly")
        return finish(`[읽기 전용 작업] ${tc.name} 도구는 이 작업에서 비활성입니다 — 조회·읽기 도구로만 진행하거나, 불가하면 그 사유를 보고하세요.`, true);
      const g = gateApproval(tc.name, args, ctx.agentId, ctx.context, ctx.chain, ctx.rootJobId, true);
      if (g) { ctx.onGate?.(tc.name); return finish(g, true); }
    }
  }
  const gate = gateApproval(tc.name, args, ctx.agentId, ctx.context, ctx.chain, ctx.rootJobId);
  if (gate) { ctx.onGate?.(tc.name); return finish(gate, true); }
  ctx.onDispatch?.(tc.name);
  try {
    const { callBuiltin, withToolTimeout, BUILTIN_TOOLS, MANAGE_TOOLS } = await import("./team");
    const isBuiltin = new Set([...BUILTIN_TOOLS, ...MANAGE_TOOLS].map((t) => t.function.name)).has(tc.name);
    const inner = isBuiltin
      ? callBuiltin(tc.name, args, ctx.agentId, ctx.signal, ctx.depth ?? 0, ctx.emit, ctx.browserKey, ctx.fileRoot, ctx.chain, ctx.rootJobId)
      : isBrowserish(tc.name)
        ? (await import("./browser")).browserTool(ctx.browserKey, tc.name, args)
        : tc.name.startsWith("computer_")
          ? (await import("./computer")).computerTool(tc.name, args)
          : (await import("./mcp")).mcpCall(tc.name, args);
    const out = DELEGATION.has(tc.name) ? await inner : await withToolTimeout(inner, LONG_RUNNING.test(tc.name) ? 400_000 : undefined);
    if (/^(도구 오류|알 수 없는 도구|브라우저 오류):/.test(out)) { console.error(`[mybot] 도구 실패 — 도구:${tc.name} ${out.slice(0, 120)}`); return finish(out, false); }
    return finish(out, true);
  } catch (e) {
    console.error(`[mybot] 도구 예외 — 도구:${tc.name} ${(e as Error).message}`);
    return finish(`도구 오류: ${(e as Error).message}`, false);
  }
}

// 한 배치의 도구 호출 실행 — 위임·읽기 전용 호출은 병렬, 나머지는 순차 유지 (페이지·경로 공유 충돌 방지)
export async function execToolBatch(tcs: ToolCall[], ctx: ToolCtx): Promise<{ out: string; ok: boolean }[]> {
  const outs: ({ out: string; ok: boolean } | undefined)[] = new Array(tcs.length);
  const parIdx = tcs.map((tc, i) => (PARALLEL_SAFE.has(tc.name) ? i : -1)).filter((i) => i >= 0);
  if (parIdx.length > 1) await Promise.all(parIdx.map((i) => execToolCall(tcs[i], ctx).then((r) => { outs[i] = r; })));
  for (let i = 0; i < tcs.length; i++) if (outs[i] === undefined) outs[i] = await execToolCall(tcs[i], ctx);
  return outs as { out: string; ok: boolean }[];
}
