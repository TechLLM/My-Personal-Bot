import { Hono } from "hono";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getSetting, setSetting } from "./db";

// 서비스 릴리스 — 개발 인스턴스에서 검증을 마친 커밋을 release 브랜치로 밀면
// 관리자가 설정 화면에서 직접 적용한다.
//
// 자기개선 업데이트(evolve)와는 다른 통로다. 저쪽은 봇이 제안한 표면 수정만 받고
// 신규 파일과 보호 경로(인증·승인·빌드 산출물)를 막지만, 이쪽은 코드 전체를 git으로 받는다.
// 그래서 봇에게 도구로 노출하지 않는다 — 사람이 민 커밋을, 사람이 눌러야 들어온다.

const ROOT = join(import.meta.dir, "..", "..");
const CHANNEL = "release";

export interface PendingCommit { sha: string; subject: string; date: string }

// ---------- 버전 등급·원장 ----------
// 세 등급으로 관리한다: 긴급패치(patch)는 즉시, 마이너(minor)는 쌓아서, 메이저(major)는 마일스톤 단위.
export type ReleaseTier = "patch" | "minor" | "major";
export const TIER_LABEL: Record<ReleaseTier, string> = { patch: "긴급패치", minor: "마이너", major: "메이저" };

// 인증·승인·릴리스·자기개선·DB 스키마·의존성을 건드리면 규모와 무관하게 메이저로 분류한다
const CRITICAL_SURFACE = /^(server\/src\/(evolve|approvals|release|access|crypto|db|index)\.|evolve\/|package\.json$|bun\.lock$)/;
const MAJOR_MIN_FILES = 15;
// 마이너는 매 커밋마다 배포하지 않는다 — 3건이 쌓이거나 첫 커밋이 72시간 묵으면 적용 가능하다.
// 그보다 빨리 나가야 하는 수정은 커밋 제목을 "긴급"으로 시작해 긴급패치 등급을 쓴다.
const MINOR_MIN_COMMITS = 3;
const MINOR_MIN_AGE_MS = 72 * 3600_000;

// 대기 커밋 묶음의 등급 — 긴급 접두사 > 핵심 표면·대규모 변경 > 일반 묶음
export function classifyTier(subjects: string[], files: string[]): ReleaseTier {
  if (subjects.some((s) => /긴급|^hotfix[:!]|^fix!/i.test(s.trim()))) return "patch";
  if (files.length >= MAJOR_MIN_FILES || files.some((f) => CRITICAL_SURFACE.test(f))) return "major";
  return "minor";
}

export function nextVersion(current: string | null, tier: ReleaseTier): string {
  const [M, m, p] = (current ?? "0.0.0").split(".").map((n) => Number(n) || 0);
  if (tier === "major") return `${M + 1}.0.0`;
  if (tier === "minor") return `${M}.${m + 1}.0`;
  return `${M}.${m}.${p + 1}`;
}

// 적용된 릴리스의 버전 원장 — 윈백 지점과 적용 이력의 근거다. DB settings에 JSON으로 둔다.
export interface ReleaseRecord {
  version: string;
  tier: ReleaseTier;
  sha: string;        // 이 버전의 커밋
  prevSha: string;    // 적용 직전 커밋 — 이 버전의 윈백 지점
  appliedAt: number;
  subjects: string[];
  status: "applied" | "reverted"; // reverted = 더 과거 버전으로 윈백돼 현재 이력에서 벗어남
}
export function loadHistory(): ReleaseRecord[] {
  try { return JSON.parse(getSetting("release_history") || "[]") as ReleaseRecord[]; } catch { return []; }
}
const saveHistory = (h: ReleaseRecord[]) => setSetting("release_history", JSON.stringify(h.slice(-50)));
const currentRelease = () => loadHistory().filter((r) => r.status === "applied").at(-1) ?? null;

// launchd로 뜬 프로세스는 로그인 셸의 PATH를 물려받지 않는다(기본 /usr/bin:/bin:/usr/sbin:/sbin).
// plist가 절대 경로로 띄워 주므로 서버는 돌지만, 여기서 "bun"을 이름으로 부르면 찾지 못한다.
// 지금 돌고 있는 실행 파일을 그대로 쓰고, 하위 프로세스 PATH에도 그 디렉터리를 얹는다.
export const BUN = process.execPath;
const PATH_WITH_BUN = `${dirname(BUN)}:${process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"}`;

// spawn 자체가 실패해도(실행 파일 없음 등) 예외로 새어나가지 않게 한다.
// 예외가 올라가면 호출부의 롤백을 건너뛰어 반영만 된 채 남는다 — 실제로 그 사고가 있었다.
export function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  try {
    const p = Bun.spawnSync(cmd, { cwd: opts.cwd ?? ROOT, env: { ...process.env, PATH: PATH_WITH_BUN, ...opts.env } });
    const dec = new TextDecoder();
    return { ok: p.exitCode === 0, out: (dec.decode(p.stdout) + dec.decode(p.stderr)).trim() };
  } catch (e) {
    return { ok: false, out: `실행할 수 없습니다: ${cmd[0]} — ${(e as Error).message}` };
  }
}
const git = (...args: string[]) => run(["git", ...args]);
const tail = (s: string, n = 1200) => (s.length > n ? "…" + s.slice(-n) : s);

// 적용 가능 여부 판정 — git 조회 결과만 받는 순수 함수로 두어 규칙을 테스트로 고정한다
export function evaluateRelease(x: { hasChannel: boolean; pending: number; clean: boolean; ff: boolean; tier?: ReleaseTier; oldestAgeMs?: number }): { canApply: boolean; reason: string } {
  if (!x.hasChannel) return { canApply: false, reason: `${CHANNEL} 브랜치가 아직 없습니다 — 개발 인스턴스에서 먼저 밀어 주세요` };
  if (!x.pending) return { canApply: false, reason: "최신 상태입니다" };
  if (!x.clean) return { canApply: false, reason: "서비스 폴더에 커밋되지 않은 변경이 있어 적용할 수 없습니다" };
  // ff가 아니면 서비스에만 있는 커밋이 사라질 수 있다 — 자동으로 합치지 않고 사람에게 넘긴다
  if (!x.ff) return { canApply: false, reason: `${CHANNEL}가 현재 커밋에서 갈라져 있습니다 — 개발 인스턴스에서 정리가 필요합니다` };
  // 마이너는 커밋 단위로 나가지 않는다 — 임계 미만이면 보류하고 사유를 보여준다
  if (x.tier === "minor" && x.pending < MINOR_MIN_COMMITS && (x.oldestAgeMs ?? 0) < MINOR_MIN_AGE_MS)
    return { canApply: false, reason: `개선이 더 쌓이면 적용됩니다 — 마이너 업데이트는 ${MINOR_MIN_COMMITS}건 이상이거나 첫 커밋이 72시간을 넘겨야 나갑니다 (현재 ${x.pending}건)` };
  return { canApply: true, reason: "" };
}

export function releaseStatus() {
  const hasChannel = git("rev-parse", "--verify", `refs/heads/${CHANNEL}`).ok;
  // 추적되지 않는 파일(로그·백업 등)은 fast-forward를 막지 않는다. 그것까지 "더럽다"고 보면
  // 서비스가 스스로 남긴 영수증 한 줄에 이후 모든 배포가 막힌다 — 실제로 그렇게 막혔다.
  const clean = !git("status", "--porcelain", "--untracked-files=no").out;
  const ff = hasChannel && git("merge-base", "--is-ancestor", "HEAD", CHANNEL).ok;
  const pending: PendingCommit[] = hasChannel
    ? git("log", "--format=%h\t%s\t%cI", `HEAD..${CHANNEL}`).out.split("\n").filter(Boolean)
        .map((l) => { const [sha, subject, date] = l.split("\t"); return { sha, subject, date }; })
    : [];
  const files = pending.length
    ? git("diff", "--name-only", "HEAD", CHANNEL).out.split("\n").filter(Boolean)
    : [];
  const tier = pending.length ? classifyTier(pending.map((p) => p.subject), files) : null;
  const oldest = pending.length ? Date.parse(pending[pending.length - 1].date) : 0;
  const history = loadHistory();
  const cur = currentRelease();
  return {
    branch: git("rev-parse", "--abbrev-ref", "HEAD").out,
    current: git("rev-parse", "--short", "HEAD").out,
    currentSubject: git("log", "-1", "--format=%s").out,
    clean, pending, files,
    pendingTier: tier,
    pendingTierLabel: tier ? TIER_LABEL[tier] : null,
    version: cur?.version ?? null,
    nextVersion: tier ? nextVersion(cur?.version ?? null, tier) : null,
    history: history.slice(-10).reverse(), // 최신 버전이 먼저 — 윈백 대상 목록
    ...evaluateRelease({ hasChannel, pending: pending.length, clean, ff, tier: tier ?? undefined, oldestAgeMs: oldest ? Date.now() - oldest : 0 }),
    canRevert: !!cur || !!getSetting("release_prev_sha"),
    prevSha: (cur?.prevSha ?? getSetting("release_prev_sha") ?? "").slice(0, 7),
    appliedAt: cur?.appliedAt ?? (Number(getSetting("release_applied_at")) || 0),
    appVersion: Number(getSetting("app_version")) || 0,
    receipts: readReceipts(5), // 무엇을 언제 적용했고 어떤 검사를 통과했는지
  };
}

// 실패는 문자열 하나로 돌려준다 — 화면이 서버 오류 메시지를 그대로 보여주기 때문이다
type Fail = { ok: false; error: string };
const fail = (stage: string, detail: string): Fail => ({ ok: false, error: `${stage} 단계에서 멈췄습니다 — ${detail}` });

// ---------- 영수증·저널 (개선지침서 R1·R3) ----------

export interface Receipt {
  ts: number;
  from: string;              // 적용 전 커밋
  to: string;                // 적용 대상 커밋
  subjects: string[];        // 적용하려는 커밋 제목
  gates: string[];           // 통과한 검사
  result: "applied" | "rolled-back" | "interrupted" | "winback" | "rejected";
  version?: string;          // 부여된 버전 (예: 1.2.0)
  tier?: ReleaseTier;
  error?: string;
}

// 영수증은 DB가 아니라 파일에 쌓는다 — server/data/**는 보호 경로라 봇이 건드릴 수 없고,
// DB 스키마를 건드리지 않아도 이력이 남는다.
const LOG = join(ROOT, "server", "data", "release-log.jsonl");

// 경로를 인자로 열어 둔다 — 릴리스 적용 때 테스트가 돌므로, 테스트가 운영 영수증에 섞이면 안 된다
export function writeReceipt(r: Receipt, path = LOG) {
  try { appendFileSync(path, JSON.stringify(r) + "\n"); } catch { /* 기록 실패가 배포를 막지는 않는다 */ }
}

export function readReceipts(limit = 20, path = LOG): Receipt[] {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
      .slice(-limit).reverse().map((l) => JSON.parse(l) as Receipt);
  } catch { return []; }
}

// 저널 문자열 → 중단 영수증. 깨진 기록이어도 "중단됐다"는 사실은 남긴다
export function interruptedReceipt(raw: string, now = Date.now()): Receipt {
  let j: Partial<Receipt> = {};
  try { j = JSON.parse(raw) as Partial<Receipt>; } catch { /* 형식이 깨져도 계속 진행한다 */ }
  return {
    ts: now, from: j.from ?? "", to: j.to ?? "", subjects: j.subjects ?? [], gates: [],
    result: "interrupted",
    error: "적용이 끝나기 전에 프로세스가 종료됐습니다. 현재 코드와 실행 버전을 확인하세요.",
  };
}

// 적용을 시작할 때 "무엇을 하려는지"를 먼저 남긴다.
// 재시작 뒤 프로세스가 돌아오지 못하거나 도중에 죽으면 이 기록만 남아,
// 다음 기동에서 완료되지 못한 적용이 있었음을 알 수 있다.
const beginJournal = (j: Omit<Receipt, "ts" | "result" | "gates">) =>
  setSetting("release_inflight", JSON.stringify({ ...j, ts: Date.now() }));
const clearJournal = () => setSetting("release_inflight", "");

// 서버가 뜰 때 한 번 부른다. 끝나지 못한 적용이 있으면 영수증에 남기고 지운다.
export function recoverJournal(): Receipt | null {
  const raw = getSetting("release_inflight");
  if (!raw) return null;
  clearJournal();
  const r = interruptedReceipt(raw);
  writeReceipt(r);
  console.warn(`[mybot] 완료되지 못한 릴리스 적용을 발견했습니다 (${r.from.slice(0, 7)} → ${r.to.slice(0, 7)})`);
  return r;
}

export interface Gate { name: string; run: () => Promise<{ ok: boolean; out: string }> }

// 앞 단계가 실패하면 뒤 단계를 돌리지 않는다 — 깨진 코드로 빌드·기동을 시도해봐야 시간만 쓴다
export async function runGates(gates: Gate[]): Promise<{ ok: true } | { ok: false; stage: string; out: string }> {
  for (const g of gates) {
    const r = await g.run();
    if (!r.ok) return { ok: false, stage: g.name, out: r.out };
  }
  return { ok: true };
}

// 새 코드로 서버가 실제로 뜨는지 임시 포트에서 확인한다.
// 이 단계가 없으면 기동 실패 시 launchd(KeepAlive)가 무한 재시작을 돌고,
// 그때는 화면도 죽어 되돌리기 버튼조차 누를 수 없다.
// NODE_ENV=test로 띄워 메모리 DB를 쓰게 하므로 운영 DB와 외부 채널은 건드리지 않는다.
export async function bootCheck(cwd = join(ROOT, "server")): Promise<{ ok: boolean; out: string }> {
  const port = 5390 + Math.floor(Math.random() * 40);
  const proc = Bun.spawn([BUN, "src/index.ts"], {
    cwd,
    env: { ...process.env, MYBOT_PORT: String(port), MYBOT_HOST: "127.0.0.1", NODE_ENV: "test" },
    stdout: "pipe", stderr: "pipe",
  });
  try {
    for (let i = 0; i < 40; i++) {
      if (proc.exitCode !== null) {
        const err = await new Response(proc.stderr as ReadableStream).text().catch(() => "");
        return { ok: false, out: `새 코드가 기동 중 종료됐습니다 (exit ${proc.exitCode})\n${tail(err, 600)}` };
      }
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
        if (r.ok) return { ok: true, out: "" };
      } catch { /* 아직 안 떴다 — 계속 기다린다 */ }
      await Bun.sleep(250);
    }
    return { ok: false, out: "10초 안에 health 응답이 없었습니다" };
  } finally { proc.kill(); }
}

const cmdGate = (name: string, cmd: string[], dir: string, env?: Record<string, string>): Gate =>
  ({ name, run: async () => run(cmd, { cwd: dir, env }) });

// 기동 시험은 반드시 마지막이다 — 웹 빌드까지 끝난 상태로 띄워야 실제 배포본과 같다
export const defaultGates = (root = ROOT): Gate[] => [
  cmdGate("테스트", [BUN, "test"], join(root, "server"), { NODE_ENV: "test" }),
  cmdGate("타입검사", [BUN, "x", "tsc", "--noEmit"], join(root, "server")),
  cmdGate("웹 빌드", [BUN, "run", "build"], join(root, "web")),
  { name: "기동 시험", run: () => bootCheck(join(root, "server")) },
];

// 반영 뒤에는 배포 산출물과 실기동만 다시 확인한다 — 무거운 검증은 스테이징에서 끝났다
const deployGates = (): Gate[] => [
  cmdGate("웹 빌드", [BUN, "run", "build"], join(ROOT, "web")),
  { name: "기동 시험", run: () => bootCheck(join(ROOT, "server")) },
];

const installDeps = (dir: string) => run([BUN, "install"], { cwd: dir });

// 검증은 반영 "전에", 대상 커밋의 트리를 임시 worktree에서 돌린다.
// 서비스 트리를 merge로 바꾼 뒤 무거운 스위트를 돌리면 실행 중인 서비스와 외장 디스크의
// I/O 경합 속에서 샌드박스·서브프로세스 계열 테스트가 일시적으로 실패해, 멀쩡한
// 업데이트가 롤백되고 트리가 두 번 뒤집히는 사고가 있었다(2026-09-20).
// 스테이징은 빠른 로컬 디스크(tmpdir)에서 돌고, 실패해도 서비스 코드는 한 줄도 안 바뀐다.
export async function applyRelease(gates?: Gate[]): Promise<{ ok: true; version: number; sha: string; release: string; tier: ReleaseTier } | Fail> {
  // 진행 중인 적용이 남아 있으면 겹쳐 돌리지 않는다 — 저널은 다음 기동 때 회수된다
  if (getSetting("release_inflight")) return fail("점검", "이전 적용이 아직 끝나지 않았습니다 — 잠시 후 다시 시도하세요");
  const st = releaseStatus();
  if (!st.canApply) return fail("점검", st.reason);

  const before = git("rev-parse", "HEAD").out;
  const target = git("rev-parse", CHANNEL).out;
  const subjects = st.pending.map((p) => p.subject);
  beginJournal({ from: before, to: target, subjects }); // 손대기 전에 의도를 먼저 남긴다

  // 1단계: 스테이징 검증 — 대상 커밋 그대로의 트리에서 의존성 설치부터 전체 검사를 돌린다.
  const stageDir = mkdtempSync(join(tmpdir(), "mybot-stage-"));
  git("worktree", "prune"); // 이전에 죽은 적용이 남긴 관리 항목을 미리 치운다
  const wt = git("worktree", "add", "--detach", stageDir, target);
  if (!wt.ok) {
    rmSync(stageDir, { recursive: true, force: true });
    clearJournal();
    return fail("준비", tail(wt.out));
  }
  const reject = (stage: string, detail: string): Fail => {
    writeReceipt({ ts: Date.now(), from: before, to: target, subjects, gates: [], result: "rejected", error: `${stage}: ${tail(detail, 800)}` });
    return fail(stage, `${tail(detail)}\n\n서비스 코드는 바뀌지 않았습니다. 일시적인 환경 문제일 수 있으니 다시 시도할 수 있습니다.`);
  };
  const list = gates ?? defaultGates(stageDir);
  try {
    for (const dir of [stageDir, join(stageDir, "web")]) {
      const inst = installDeps(dir);
      if (!inst.ok) return reject("의존성 설치", inst.out);
    }
    const result = await runGates(list);
    if (!result.ok) return reject(result.stage, result.out);
  } catch (e) {
    return reject("검증", `예기치 못한 오류 — ${(e as Error).message}`);
  } finally {
    git("worktree", "remove", "--force", stageDir);
    rmSync(stageDir, { recursive: true, force: true });
  }

  // 2단계: 반영 — 검증을 통과한 바로 그 트리를 받는다.
  const merged = git("merge", "--ff-only", CHANNEL);
  if (!merged.ok) {
    clearJournal();
    return fail("병합", tail(merged.out));
  }

  // 병합한 뒤로는 어떤 경로로 빠져나가든 되돌려야 한다.
  // 예외가 그냥 올라가면 반영만 된 채 재시작도 롤백도 없이 남는다(실제로 겪은 사고다).
  const rollback = (stage: string, detail: string): Fail => {
    git("reset", "--hard", before);
    installDeps(ROOT);
    installDeps(join(ROOT, "web"));
    run([BUN, "run", "build"], { cwd: join(ROOT, "web") }); // 되돌린 소스로 화면도 원상복구
    clearJournal();
    writeReceipt({ ts: Date.now(), from: before, to: target, subjects, gates: [], result: "rolled-back", error: `${stage}: ${tail(detail, 800)}` });
    return fail(stage, `${tail(detail)}\n\n받기 전 상태(${before.slice(0, 7)})로 되돌렸습니다.`);
  };

  try {
    // 의존성 동기화 — 릴리스가 패키지를 바꿨으면 테스트·기동 전에 맞춰야 한다
    for (const dir of [ROOT, join(ROOT, "web")]) {
      const inst = installDeps(dir);
      if (!inst.ok) return rollback("의존성 설치", inst.out);
    }
    for (const g of deployGates()) {
      const r = await g.run();
      if (!r.ok) return rollback(g.name, r.out);
    }
  } catch (e) {
    return rollback("검증", `예기치 못한 오류 — ${(e as Error).message}`);
  }

  setSetting("release_prev_sha", before);
  setSetting("release_applied_at", String(Date.now()));
  const appV = (Number(getSetting("app_version")) || 0) + 1;
  setSetting("app_version", String(appV));

  // 버전 원장 — 대기 묶음의 등급으로 버전을 매기고, 태그·원장·영수증에 같은 번호를 남긴다
  const files = git("diff", "--name-only", before, target).out.split("\n").filter(Boolean);
  const tier = classifyTier(subjects, files);
  const version = nextVersion(currentRelease()?.version ?? null, tier);
  git("tag", `v${version}`, target);
  const history = loadHistory();
  history.push({ version, tier, sha: target, prevSha: before, appliedAt: Date.now(), subjects, status: "applied" });
  saveHistory(history);

  clearJournal();
  writeReceipt({ ts: Date.now(), from: before, to: target, subjects, gates: list.map((g) => g.name), result: "applied", version, tier });
  return { ok: true, version: appV, sha: git("rev-parse", "--short", "HEAD").out, release: version, tier };
}

// 윈백 대상 결정 — 기록된 버전 지점(sha·prevSha)만 허용한다.
// 임의 커밋으로의 리셋은 "어디로 돌아간 건지"를 잃게 만들어 금지한다.
export function pickWinbackTarget(history: ReleaseRecord[], head: string, sha?: string): { sha: string; label: string } | Fail {
  if (!history.length) return fail("점검", "되돌릴 버전 기록이 없습니다");
  const applied = history.filter((r) => r.status === "applied");
  const target = sha ?? applied.at(-1)?.prevSha ?? "";
  const anchors = new Set(history.flatMap((r) => [r.sha, r.prevSha]));
  if (!target || !anchors.has(target)) return fail("점검", "기록된 버전 지점이 아닙니다");
  if (target === head) return fail("점검", "이미 그 버전을 실행 중입니다");
  const label = history.find((r) => r.sha === target)?.version ?? target.slice(0, 7);
  return { sha: target, label };
}

// 문제가 생기면 기록된 어느 버전으로든 되돌린다. 되돌리기도 새 이력으로 남겨
// "지금 어떤 버전인가"가 항상 원장에 걸맞게 유지되게 한다.
export function winbackRelease(targetSha?: string): { ok: true; sha: string; release: string } | Fail {
  if (git("status", "--porcelain", "--untracked-files=no").out) return fail("점검", "커밋되지 않은 변경이 있어 되돌릴 수 없습니다");
  const head = git("rev-parse", "HEAD").out;
  const t = pickWinbackTarget(loadHistory(), head, targetSha);
  if (!("sha" in t)) return t;

  const r = git("reset", "--hard", t.sha);
  if (!r.ok) return fail("되돌리기", tail(r.out));
  installDeps(ROOT);
  installDeps(join(ROOT, "web"));
  const build = run([BUN, "run", "build"], { cwd: join(ROOT, "web") });
  if (!build.ok) return fail("웹 빌드", `코드는 되돌렸지만 화면 빌드에 실패했습니다 — ${tail(build.out)}`);

  const history = loadHistory();
  const from = [...history].reverse().find((rec) => rec.status === "applied") ?? null; // 윈백 전 현재 버전
  // 대상 지점 위에 올라갔던 버전들은 이력에서 벗어났으므로 reverted로 표시한다
  for (const rec of history) {
    if (rec.status === "applied" && rec.sha !== t.sha && !git("merge-base", "--is-ancestor", rec.sha, t.sha).ok) rec.status = "reverted";
  }
  const version = nextVersion(from?.version ?? null, "patch"); // 윈백도 새 버전 — 이력이 선형으로 남는다
  history.push({
    version, tier: "patch", sha: t.sha, prevSha: head, appliedAt: Date.now(),
    subjects: [`윈백: ${from?.version ? `v${from.version}` : head.slice(0, 7)} → v${t.label} 복귀`], status: "applied",
  });
  saveHistory(history);
  setSetting("release_prev_sha", head); // 윈백 직후 한 단계 되돌림 지점도 갱신
  writeReceipt({ ts: Date.now(), from: head, to: t.sha, subjects: [`윈백 → v${t.label}`], gates: [], result: "winback", version, tier: "patch" });
  return { ok: true, sha: git("rev-parse", "--short", t.sha).out, release: version };
}

export function revertRelease(): { ok: true; sha: string; release?: string } | Fail {
  // 예전 방식(직전 커밋 한 단계)은 원장이 없을 때의 폴백 — 기록이 있으면 윈백으로 간다
  if (loadHistory().length) return winbackRelease();
  const prev = getSetting("release_prev_sha");
  if (!prev) return fail("점검", "되돌릴 지점이 없습니다");
  if (git("status", "--porcelain", "--untracked-files=no").out) return fail("점검", "커밋되지 않은 변경이 있어 되돌릴 수 없습니다");

  const r = git("reset", "--hard", prev);
  if (!r.ok) return fail("되돌리기", tail(r.out));
  installDeps(ROOT);
  installDeps(join(ROOT, "web"));
  const build = run([BUN, "run", "build"], { cwd: join(ROOT, "web") });
  if (!build.ok) return fail("웹 빌드", `코드는 되돌렸지만 화면 빌드에 실패했습니다 — ${tail(build.out)}`);

  setSetting("release_prev_sha", "");
  return { ok: true, sha: git("rev-parse", "--short", prev).out };
}

// 응답을 보낸 뒤 프로세스를 끝낸다 — launchd(KeepAlive)가 새 코드로 다시 띄운다
const scheduleRestart = () => setTimeout(() => process.exit(0), 700);

export const releaseRoute = new Hono()
  .get("/", (c) => c.json(releaseStatus()))
  // 예외가 그대로 올라가면 화면에는 뜻을 알 수 없는 "HTTP 500"만 뜬다 — 사유를 실어 보낸다
  .post("/apply", async (c) => {
    try {
      const r = await applyRelease();
      if (!r.ok) return c.json(r, 400);
      scheduleRestart();
      return c.json({ ...r, restarting: true });
    } catch (e) { return c.json({ ok: false, error: `적용 중 오류 — ${(e as Error).message}` }, 500); }
  })
  .post("/revert", (c) => {
    try {
      const r = revertRelease();
      if (!r.ok) return c.json(r, 400);
      scheduleRestart();
      return c.json({ ...r, restarting: true });
    } catch (e) { return c.json({ ok: false, error: `되돌리기 중 오류 — ${(e as Error).message}` }, 500); }
  })
  // 특정 버전으로의 윈백 — 기록된 지점만 받는다
  .post("/winback", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const r = winbackRelease(typeof body?.sha === "string" && body.sha ? body.sha : undefined);
      if (!r.ok) return c.json(r, 400);
      scheduleRestart();
      return c.json({ ...r, restarting: true });
    } catch (e) { return c.json({ ok: false, error: `윈백 중 오류 — ${(e as Error).message}` }, 500); }
  });
