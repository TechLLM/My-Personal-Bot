import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "./db";
import { evaluateRelease, runGates, defaultGates, bootCheck, type Gate } from "./release";

if (db.filename !== ":memory:") throw new Error(`테스트가 운영 DB를 열었습니다: ${db.filename}`);

// 릴리스 적용은 실서비스의 코드를 통째로 바꾸고 재시작까지 한다.
// 어떤 상태에서 버튼이 열리는지를 테스트로 고정해 둔다.

const ok = { hasChannel: true, pending: 2, clean: true, ff: true };

test("검증된 커밋이 대기 중이고 작업 폴더가 깨끗하면 적용할 수 있다", () => {
  expect(evaluateRelease(ok)).toEqual({ canApply: true, reason: "" });
});

test("release 브랜치가 아직 없으면 적용할 수 없다", () => {
  const r = evaluateRelease({ ...ok, hasChannel: false });
  expect(r.canApply).toBe(false);
  expect(r.reason).toContain("아직 없습니다");
});

test("대기 중인 커밋이 없으면 최신 상태로 알린다", () => {
  const r = evaluateRelease({ ...ok, pending: 0 });
  expect(r.canApply).toBe(false);
  expect(r.reason).toBe("최신 상태입니다");
});

test("서비스 폴더에 커밋되지 않은 변경이 있으면 적용하지 않는다", () => {
  // 적용 실패 시 reset --hard로 되돌리므로, 남아 있는 변경은 그때 사라진다
  const r = evaluateRelease({ ...ok, clean: false });
  expect(r.canApply).toBe(false);
  expect(r.reason).toContain("커밋되지 않은 변경");
});

test("release가 갈라져 있으면 자동으로 합치지 않고 사람에게 넘긴다", () => {
  const r = evaluateRelease({ ...ok, ff: false });
  expect(r.canApply).toBe(false);
  expect(r.reason).toContain("갈라져");
});

// --- 검증 게이트: 실패를 주입해 멈추는지 본다 (개선지침서 R2) ---

const gate = (name: string, ok: boolean, log: string[]): Gate =>
  ({ name, run: async () => { log.push(name); return { ok, out: ok ? "" : `${name} 실패` }; } });

test("모든 단계를 통과하면 적용을 진행한다", async () => {
  const log: string[] = [];
  const r = await runGates([gate("테스트", true, log), gate("웹 빌드", true, log)]);
  expect(r.ok).toBe(true);
  expect(log).toEqual(["테스트", "웹 빌드"]);
});

test("한 단계가 실패하면 거기서 멈추고 뒤 단계를 돌리지 않는다", async () => {
  const log: string[] = [];
  const r = await runGates([gate("테스트", false, log), gate("웹 빌드", true, log), gate("기동 시험", true, log)]);
  expect(r.ok).toBe(false);
  if (!r.ok) { expect(r.stage).toBe("테스트"); expect(r.out).toContain("실패"); }
  expect(log).toEqual(["테스트"]); // 깨진 코드로 빌드·기동을 시도하지 않는다
});

test("마지막 단계의 실패도 놓치지 않는다", async () => {
  const log: string[] = [];
  const r = await runGates([gate("테스트", true, log), gate("기동 시험", false, log)]);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.stage).toBe("기동 시험");
  expect(log).toEqual(["테스트", "기동 시험"]);
});

test("기동 시험은 뜨지 못하는 코드를 잡아낸다", async () => {
  // 이 단계가 없으면 기동 실패 코드가 그대로 배포되고, launchd가 무한 재시작을 돌아
  // 화면이 죽은 탓에 되돌리기조차 누를 수 없게 된다
  const dir = mkdtempSync(join(tmpdir(), "mybot-boot-"));
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), 'throw new Error("기동 실패 주입");\n');
    const r = await bootCheck(dir);
    expect(r.ok).toBe(false);
    expect(r.out).toContain("종료");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30000);

test("기동 시험은 웹 빌드까지 끝난 뒤 마지막에 돌린다", () => {
  // 순서가 바뀌면 빌드 전 코드로 띄우게 되어 실제 배포본을 검증하지 못한다
  const names = defaultGates().map((g) => g.name);
  expect(names).toEqual(["테스트", "타입검사", "웹 빌드", "기동 시험"]);
});

test("여러 조건이 동시에 어긋나면 가장 먼저 막아야 할 사유를 알린다", () => {
  // 브랜치 자체가 없으면 나머지를 따질 필요가 없다
  expect(evaluateRelease({ hasChannel: false, pending: 0, clean: false, ff: false }).reason).toContain("아직 없습니다");
  // 브랜치는 있으나 더티하고 갈라진 경우 — 먼저 해결해야 하는 쪽은 작업 폴더다
  expect(evaluateRelease({ hasChannel: true, pending: 1, clean: false, ff: false }).reason).toContain("커밋되지 않은 변경");
});
