import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { db, getSetting, setSetting, now } from "./db";

// ─── 데이터 보존 정리 (업무지침서 C16) ───
// 실행 이력·승인·봇 간 메시지·브라우저 캐시가 무한히 쌓이면 DB와 디스크가 커지고,
// 장기기억 회상(LIKE 스캔) 품질까지 떨어진다. 상한은 그록봇과 같은 기준을 기본값으로 쓴다.
//
// 안전 원칙:
//  - 진행 중(running/pending)인 레코드는 절대 건드리지 않는다
//  - 브라우저 프로필에서는 "캐시"만 지운다 — 쿠키·로그인·로컬스토리지는 보존해야
//    사용자가 수동 로그인한 세션이 살아남는다
//  - 브라우저가 떠 있으면 캐시 정리를 건너뛴다 (실행 중 파일 삭제는 크래시를 부른다)

const DAY = 86_400_000;
const num = (key: string, dflt: number) => Number(getSetting(key) ?? "") || dflt;

// 프로필에서 지워도 안전한 캐시 경로 — 여기 없는 것은 건드리지 않는다.
// 특히 Default/Network(쿠키), Default/Local Storage, Default/Login Data는 제외 대상이다.
const CACHE_PATHS = [
  "Default/Cache",
  "Default/Code Cache",
  "Default/GPUCache",
  "Default/DawnGraphiteCache",
  "Default/DawnWebGPUCache",
  "Default/Service Worker/CacheStorage",
  "Default/Service Worker/ScriptCache",
  "GrShaderCache",
  "ShaderCache",
  "GraphiteDawnCache",
  "component_crx_cache",
  "BrowserMetrics",
];

export function cleanupRecords(): string[] {
  const out: string[] = [];
  const keepPerRoutine = num("keep_runs_per_routine", 20);
  const keepRunDays = num("keep_runs_days", 90);
  const keepApprovalDays = num("keep_approvals_days", 30);

  // 1) 루틴별 최근 N건만 보존 — routine_id가 있는 행만 대상 (일반 실행은 아래 기간 정책으로)
  const perRoutine = db.prepare(`
    DELETE FROM agent_runs WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY routine_id ORDER BY created_at DESC) rn
        FROM agent_runs WHERE routine_id IS NOT NULL AND status != 'running'
      ) WHERE rn > ?
    )`).run(keepPerRoutine);
  if (perRoutine.changes) out.push(`루틴 실행이력 ${perRoutine.changes}건 (루틴당 ${keepPerRoutine}건 유지)`);

  // 2) 오래된 실행 이력 — 진행 중인 것은 제외
  const oldRuns = db.prepare("DELETE FROM agent_runs WHERE status != 'running' AND created_at < ?")
    .run(now() - keepRunDays * DAY);
  if (oldRuns.changes) out.push(`실행이력 ${oldRuns.changes}건 (${keepRunDays}일 경과)`);

  // 3) 처리 완료된 승인 요청 — 대기 중(pending)은 보존
  const appr = db.prepare("DELETE FROM approval_requests WHERE status != 'pending' AND resolved_at IS NOT NULL AND resolved_at < ?")
    .run(now() - keepApprovalDays * DAY);
  if (appr.changes) out.push(`승인 이력 ${appr.changes}건 (${keepApprovalDays}일 경과)`);

  // 4) 처리 완료된 봇 간 메시지 — pending/processing은 보존
  const msgs = db.prepare("DELETE FROM agent_messages WHERE status IN ('done', 'failed') AND done_at IS NOT NULL AND done_at < ?")
    .run(now() - keepApprovalDays * DAY);
  if (msgs.changes) out.push(`봇 간 메시지 ${msgs.changes}건 (${keepApprovalDays}일 경과)`);

  return out;
}

// 브라우저 캐시 정리 — 월 1회, 브라우저가 떠 있지 않을 때만
export async function cleanupBrowserCache(force = false): Promise<string | null> {
  const every = num("browser_cache_clean_days", 30) * DAY;
  const last = Number(getSetting("maintenance_cache_cleaned_at") ?? 0);
  if (!force && last && now() - last < every) return null;

  const { browserRunning } = await import("./browser");
  if (browserRunning()) return null; // 실행 중 삭제는 크래시 위험 — 다음 주기로 미룸

  const profile = join(import.meta.dir, "..", "data", "browser-profile");
  if (!existsSync(profile)) return null;
  let removed = 0;
  for (const rel of CACHE_PATHS) {
    const p = join(profile, rel);
    if (!existsSync(p)) continue;
    try { rmSync(p, { recursive: true, force: true }); removed++; } catch {}
  }
  setSetting("maintenance_cache_cleaned_at", String(now()));
  return removed ? `브라우저 캐시 ${removed}개 경로 정리 (쿠키·로그인 세션은 보존)` : null;
}

async function runOnce() {
  try {
    const parts = cleanupRecords();
    const cache = await cleanupBrowserCache();
    if (cache) parts.push(cache);
    if (parts.length) console.log(`[mybot] 보존 정리 — ${parts.join(", ")}`);
    setSetting("maintenance_last_run_at", String(now()));
  } catch (e) {
    console.error("[mybot] 보존 정리 실패:", (e as Error).message);
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startMaintenance() {
  if (timer) return;
  setTimeout(runOnce, 60_000);          // 부팅 직후 혼잡을 피해 1분 뒤 첫 실행
  timer = setInterval(runOnce, DAY);    // 이후 하루 1회
}
