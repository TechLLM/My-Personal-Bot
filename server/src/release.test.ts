import { test, expect } from "bun:test";
import { db } from "./db";
import { evaluateRelease } from "./release";

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

test("여러 조건이 동시에 어긋나면 가장 먼저 막아야 할 사유를 알린다", () => {
  // 브랜치 자체가 없으면 나머지를 따질 필요가 없다
  expect(evaluateRelease({ hasChannel: false, pending: 0, clean: false, ff: false }).reason).toContain("아직 없습니다");
  // 브랜치는 있으나 더티하고 갈라진 경우 — 먼저 해결해야 하는 쪽은 작업 폴더다
  expect(evaluateRelease({ hasChannel: true, pending: 1, clean: false, ff: false }).reason).toContain("커밋되지 않은 변경");
});
