import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "./db";
import {
  evaluateRelease, runGates, defaultGates, bootCheck, run, BUN,
  writeReceipt, readReceipts, interruptedReceipt, type Gate,
} from "./release";

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

// 2026-09-19 회귀: launchd로 뜬 서버가 "bun"을 PATH에서 찾지 못해 spawn이 예외를 던졌고,
// 그 예외가 롤백을 건너뛰어 병합만 된 채 재시작도 되돌리기도 없이 HTTP 500만 남았다.

test("하위 명령은 PATH가 아니라 지금 돌고 있는 실행 파일로 부른다", () => {
  expect(BUN.startsWith("/")).toBe(true);
  // 게이트가 "bun"을 이름으로 부르면 launchd 환경에서 다시 같은 사고가 난다
  expect(BUN).not.toBe("bun");
});

test("실행 파일을 찾지 못해도 예외 대신 실패로 돌려준다", () => {
  const r = run(["/nonexistent/definitely-not-here"], {});
  expect(r.ok).toBe(false);
  expect(r.out).toContain("실행할 수 없습니다");
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

// --- 영수증·저널 (개선지침서 R1·R3) ---

test("영수증은 쌓이고 최신이 먼저 나온다", () => {
  const dir = mkdtempSync(join(tmpdir(), "mybot-receipt-"));
  const path = join(dir, "log.jsonl");
  try {
    writeReceipt({ ts: 1, from: "a", to: "b", subjects: ["첫 적용"], gates: ["테스트"], result: "applied" }, path);
    writeReceipt({ ts: 2, from: "b", to: "c", subjects: ["둘째"], gates: [], result: "rolled-back", error: "테스트 실패" }, path);
    const rs = readReceipts(10, path);
    expect(rs.map((r) => r.ts)).toEqual([2, 1]);
    expect(rs[0].result).toBe("rolled-back");
    expect(rs[0].error).toContain("테스트 실패");
    expect(rs[1].gates).toEqual(["테스트"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("영수증 파일이 없으면 빈 목록이다 — 조회가 실패하지 않는다", () => {
  expect(readReceipts(10, join(tmpdir(), "mybot-no-such-file.jsonl"))).toEqual([]);
});

test("끝나지 못한 적용은 중단 영수증으로 남는다", () => {
  const r = interruptedReceipt(JSON.stringify({ from: "aaa1111", to: "bbb2222", subjects: ["기동 시험 추가"], ts: 1 }), 99);
  expect(r.result).toBe("interrupted");
  expect(r.from).toBe("aaa1111");
  expect(r.subjects).toEqual(["기동 시험 추가"]);
  expect(r.ts).toBe(99);
  expect(r.error).toContain("프로세스가 종료");
});

test("저널이 깨져 있어도 중단 사실은 남긴다", () => {
  // 기록이 망가졌다고 조용히 넘어가면, 반영만 된 채 재시작이 안 된 상태를 놓친다
  const r = interruptedReceipt("{깨진 JSON", 99);
  expect(r.result).toBe("interrupted");
  expect(r.from).toBe("");
  expect(r.error).toContain("프로세스가 종료");
});

test("여러 조건이 동시에 어긋나면 가장 먼저 막아야 할 사유를 알린다", () => {
  // 브랜치 자체가 없으면 나머지를 따질 필요가 없다
  expect(evaluateRelease({ hasChannel: false, pending: 0, clean: false, ff: false }).reason).toContain("아직 없습니다");
  // 브랜치는 있으나 더티하고 갈라진 경우 — 먼저 해결해야 하는 쪽은 작업 폴더다
  expect(evaluateRelease({ hasChannel: true, pending: 1, clean: false, ff: false }).reason).toContain("커밋되지 않은 변경");
});
