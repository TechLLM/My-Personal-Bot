import { Hono } from "hono";
import { appendFileSync, readFileSync } from "node:fs";
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
export function evaluateRelease(x: { hasChannel: boolean; pending: number; clean: boolean; ff: boolean }): { canApply: boolean; reason: string } {
  if (!x.hasChannel) return { canApply: false, reason: `${CHANNEL} 브랜치가 아직 없습니다 — 개발 인스턴스에서 먼저 밀어 주세요` };
  if (!x.pending) return { canApply: false, reason: "최신 상태입니다" };
  if (!x.clean) return { canApply: false, reason: "서비스 폴더에 커밋되지 않은 변경이 있어 적용할 수 없습니다" };
  // ff가 아니면 서비스에만 있는 커밋이 사라질 수 있다 — 자동으로 합치지 않고 사람에게 넘긴다
  if (!x.ff) return { canApply: false, reason: `${CHANNEL}가 현재 커밋에서 갈라져 있습니다 — 개발 인스턴스에서 정리가 필요합니다` };
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
  const prev = getSetting("release_prev_sha") ?? "";
  return {
    branch: git("rev-parse", "--abbrev-ref", "HEAD").out,
    current: git("rev-parse", "--short", "HEAD").out,
    currentSubject: git("log", "-1", "--format=%s").out,
    clean, pending,
    ...evaluateRelease({ hasChannel, pending: pending.length, clean, ff }),
    canRevert: !!prev,
    prevSha: prev.slice(0, 7),
    appliedAt: Number(getSetting("release_applied_at")) || 0,
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
  result: "applied" | "rolled-back" | "interrupted";
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

const cmdGate = (name: string, cmd: string[], cwd: string, env?: Record<string, string>): Gate =>
  ({ name, run: async () => run(cmd, { cwd: join(ROOT, cwd), env }) });

// 기동 시험은 반드시 마지막이다 — 웹 빌드까지 끝난 상태로 띄워야 실제 배포본과 같다
export const defaultGates = (): Gate[] => [
  cmdGate("테스트", [BUN, "test"], "server", { NODE_ENV: "test" }),
  cmdGate("타입검사", [BUN, "x", "tsc", "--noEmit"], "server"),
  cmdGate("웹 빌드", [BUN, "run", "build"], "web"),
  { name: "기동 시험", run: bootCheck },
];

// 검증은 반영 뒤에 돌린다 — 새 코드로 통과해야 의미가 있기 때문이다.
// 하나라도 실패하면 받기 전 커밋으로 되돌려 서비스를 원래 상태로 남긴다.
export async function applyRelease(gates?: Gate[]): Promise<{ ok: true; version: number; sha: string } | Fail> {
  const st = releaseStatus();
  if (!st.canApply) return fail("점검", st.reason);

  const before = git("rev-parse", "HEAD").out;
  const target = git("rev-parse", CHANNEL).out;
  const subjects = st.pending.map((p) => p.subject);
  beginJournal({ from: before, to: target, subjects }); // 손대기 전에 의도를 먼저 남긴다

  const merged = git("merge", "--ff-only", CHANNEL);
  if (!merged.ok) {
    clearJournal();
    return fail("병합", tail(merged.out));
  }

  // 병합한 뒤로는 어떤 경로로 빠져나가든 되돌려야 한다.
  // 예외가 그냥 올라가면 반영만 된 채 재시작도 롤백도 없이 남는다(실제로 겪은 사고다).
  const rollback = (stage: string, detail: string): Fail => {
    git("reset", "--hard", before);
    run([BUN, "run", "build"], { cwd: join(ROOT, "web") }); // 되돌린 소스로 화면도 원상복구
    clearJournal();
    writeReceipt({ ts: Date.now(), from: before, to: target, subjects, gates: [], result: "rolled-back", error: `${stage}: ${tail(detail, 400)}` });
    return fail(stage, `${tail(detail)}\n\n받기 전 상태(${before.slice(0, 7)})로 되돌렸습니다.`);
  };

  const list = gates ?? defaultGates();
  try {
    const result = await runGates(list);
    if (!result.ok) return rollback(result.stage, result.out);
  } catch (e) {
    return rollback("검증", `예기치 못한 오류 — ${(e as Error).message}`);
  }

  setSetting("release_prev_sha", before);
  setSetting("release_applied_at", String(Date.now()));
  const version = (Number(getSetting("app_version")) || 0) + 1;
  setSetting("app_version", String(version));
  clearJournal();
  writeReceipt({ ts: Date.now(), from: before, to: target, subjects, gates: list.map((g) => g.name), result: "applied" });
  return { ok: true, version, sha: git("rev-parse", "--short", "HEAD").out };
}

export function revertRelease(): { ok: true; sha: string } | Fail {
  const prev = getSetting("release_prev_sha");
  if (!prev) return fail("점검", "되돌릴 지점이 없습니다");
  if (git("status", "--porcelain", "--untracked-files=no").out) return fail("점검", "커밋되지 않은 변경이 있어 되돌릴 수 없습니다");

  const r = git("reset", "--hard", prev);
  if (!r.ok) return fail("되돌리기", tail(r.out));
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
  });
