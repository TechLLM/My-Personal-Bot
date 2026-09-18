import { test, expect } from "bun:test";
import { db } from "./db";
import { searchCriteria, pickTextPart, attachmentNames, htmlToText } from "./mail";

if (db.filename !== ":memory:") throw new Error(`테스트가 운영 DB를 열었습니다: ${db.filename}`);

test("검색 조건 — today는 오늘 0시부터, 안읽음·발신자·제목 필터", () => {
  const today = searchCriteria({ since: "today" }) as { since: Date };
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  expect(today.since.getTime()).toBe(midnight.getTime());
  expect(searchCriteria({ since: "2026-09-18", unseen: true })).toMatchObject({ seen: false });
  expect(searchCriteria({ from: "boss@kcc.co.kr", subject: "견적" })).toEqual({ from: "boss@kcc.co.kr", subject: "견적" });
  expect(searchCriteria({})).toEqual({ all: true }); // 조건이 없으면 사서함 전체
  expect(searchCriteria({ since: "말도 안 되는 날짜" })).toEqual({ all: true });
});

test("본문 파트 — text/plain을 먼저 고르고 없으면 html을 고른다", () => {
  const multipart = {
    type: "multipart/alternative",
    childNodes: [
      { type: "text/html", part: "1.2", parameters: { charset: "utf-8" } },
      { type: "text/plain", part: "1.1", parameters: { charset: "euc-kr" } },
    ],
  };
  expect(pickTextPart(multipart)).toEqual({ part: "1.1", type: "text/plain", charset: "euc-kr" });
  expect(pickTextPart({ type: "multipart/mixed", childNodes: [{ type: "text/html", part: "2", parameters: {} }] }))
    .toMatchObject({ part: "2", type: "text/html" });
  expect(pickTextPart({ type: "application/pdf", part: "1" })).toBeNull();
  expect(pickTextPart(null)).toBeNull();
});

test("첨부 파일명만 뽑는다 — 인라인 이미지는 제외", () => {
  const structure = {
    type: "multipart/mixed",
    childNodes: [
      { type: "text/plain", part: "1" },
      { type: "application/pdf", part: "2", disposition: "attachment", dispositionParameters: { filename: "견적서.pdf" } },
      { type: "image/png", part: "3", disposition: "inline", parameters: { name: "logo.png" } },
      { type: "application/vnd.ms-excel", part: "4", disposition: "ATTACHMENT", dispositionParameters: { filename: "수금현황.xlsx" } },
    ],
  };
  expect(attachmentNames(structure)).toEqual(["견적서.pdf", "수금현황.xlsx"]);
});

test("html 본문은 읽을 수 있는 텍스트로 정리한다", () => {
  const html = `<style>p{color:red}</style><div>안녕하세요<br/>제주항공 견적 건입니다.</div><p>기한: 9/22</p><script>x()</script>`;
  expect(htmlToText(html)).toBe("안녕하세요\n제주항공 견적 건입니다.\n기한: 9/22");
  expect(htmlToText("<p>A&nbsp;&amp;&nbsp;B</p>")).toBe("A & B");
});
