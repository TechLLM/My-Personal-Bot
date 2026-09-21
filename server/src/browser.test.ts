import { expect, test } from "bun:test";
import { db } from "./db";
import { evaluateBrowserVerification } from "./browser";

if (db.filename !== ":memory:") throw new Error(`테스트가 운영 DB를 열었습니다: ${db.filename}`);

const observed = {
  url: "https://example.com/messages/sent/42",
  title: "전송 완료 | Example",
  text: "메시지를 성공적으로 보냈습니다. 받은 사람: 홍길동",
  selectors: { ".success": true, ".error": false },
};

test("browser_verify — 지정한 완료 증거가 모두 맞아야 통과한다", () => {
  const out = evaluateBrowserVerification({
    url_contains: "/sent/",
    title_contains: "전송 완료",
    text: "성공적으로",
    absent_text: "실패",
    selector: ".success",
    selector_absent: ".error",
  }, observed);
  expect(out.ok).toBe(true);
  expect(out.checks.length).toBe(6);
});

test("browser_verify — 조건 하나라도 어긋나면 실패한다", () => {
  const out = evaluateBrowserVerification({ text: "성공적으로", url_contains: "/draft/" }, observed);
  expect(out.ok).toBe(false);
  expect(out.checks.some((c) => !c.ok)).toBe(true);
});

test("browser_verify — 조건이 없으면 fail-closed한다", () => {
  expect(evaluateBrowserVerification({}, observed)).toEqual({ ok: false, checks: [] });
});

test("browser_verify — 본문·선택자 관측 실패를 '없음'으로 오인하지 않는다", () => {
  const out = evaluateBrowserVerification({ absent_text: "오류", selector_absent: "[" }, {
    ...observed,
    text: null,
    selectors: { "[": null },
  });
  expect(out.ok).toBe(false);
  expect(out.checks.every((c) => !c.ok)).toBe(true);
});
