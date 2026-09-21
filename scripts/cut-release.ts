// 개발 작업을 서비스 배포 후보로 잘라낸다 — dev 워크트리에서 실행한다.
//   bun scripts/cut-release.ts
// 하는 일: 워킹트리 정리 확인 → 테스트·타입검사 → release 브랜치를 현재 브랜치로 전진 → 등급·적용 가능 여부 출력.
// 실제 적용·버전 부여는 서비스가 한다 — 이 스크립트는 "보낼 수 있는 상태"까지만 만든다.
import { join } from "node:path";
import { classifyTier, evaluateRelease } from "../server/src/release";

const ROOT = join(import.meta.dir, "..");
const BUN = process.execPath;

const run = (cmd: string[], cwd = ROOT, env: Record<string, string> = {}) => {
  const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env } });
  const dec = new TextDecoder();
  return { ok: p.exitCode === 0, out: (dec.decode(p.stdout) + dec.decode(p.stderr)).trim() };
};
const git = (...a: string[]) => run(["git", ...a]);
const die = (msg: string): never => { console.error(`✗ ${msg}`); process.exit(1); };

const branch = git("rev-parse", "--abbrev-ref", "HEAD").out;
if (branch !== "dev-env") die(`현재 브랜치가 ${branch}입니다 — dev-env에서 잘라내세요`);
if (git("status", "--porcelain", "--untracked-files=no").out) die("커밋되지 않은 변경이 있습니다 — 먼저 커밋하세요");
if (!git("rev-list", "master..HEAD", "--count").out || git("rev-list", "master..HEAD", "--count").out === "0")
  die("master보다 앞선 커밋이 없습니다 — 보낼 개선이 없습니다");

console.log("① 테스트…");
const t = run([BUN, "test"], join(ROOT, "server"), { NODE_ENV: "test" });
if (!t.ok) die(`테스트 실패 — 컷하지 않습니다\n${t.out.slice(-800)}`);
console.log(`   ${t.out.split("\n").find((l) => l.includes("pass"))?.trim() ?? "통과"}`);

console.log("② 타입검사…");
const c = run([BUN, "x", "tsc", "--noEmit"], join(ROOT, "server"));
if (!c.ok) die(`타입검사 실패 — 컷하지 않습니다\n${c.out.slice(-800)}`);

// release는 현재 HEAD의 조상이어야 ff가 성립한다 — 갈라졌으면 사람이 정리한다
const hasRelease = git("rev-parse", "--verify", "refs/heads/release").ok;
if (hasRelease && !git("merge-base", "--is-ancestor", "release", "HEAD").ok)
  die("release 브랜치가 갈라져 있습니다 — 수동으로 정리 후 다시 실행하세요");
const bf = git("branch", "-f", "release", "HEAD");
if (!bf.ok) die(`release 전진 실패 — ${bf.out}`);

// 서비스가 보게 될 대기 묶음 = master 기준 차이
const subjects = git("log", "--format=%s", "master..release").out.split("\n").filter(Boolean);
const files = git("diff", "--name-only", "master...release").out.split("\n").filter(Boolean);
const dates = git("log", "--format=%cI", "master..release").out.split("\n").filter(Boolean);
const oldest = dates.at(-1), newest = dates[0];
const tier = classifyTier(subjects, files);
const gate = evaluateRelease({ hasChannel: true, pending: subjects.length, clean: true, ff: true, tier, oldestAgeMs: oldest ? Date.now() - Date.parse(oldest) : 0, newestAgeMs: newest ? Date.now() - Date.parse(newest) : 0 });

console.log(`\nrelease 브랜치를 ${git("rev-parse", "--short", "HEAD").out}로 전진했습니다.`);
console.log(`등급: ${{ patch: "긴급패치", minor: "마이너", major: "메이저" }[tier]} · 대기 ${subjects.length}건 · 파일 ${files.length}개`);
console.log(gate.canApply ? "서비스에서 바로 적용할 수 있습니다 — 설정 → 서비스 버전에서 적용하세요." : `주의: ${gate.reason}`);
