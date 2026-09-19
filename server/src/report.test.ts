import { test, expect } from "bun:test";
import { db } from "./db";
import { cleanOutput, hanjaToHangul } from "./report";

if (db.filename !== ":memory:") throw new Error(`테스트가 운영 DB를 열었습니다: ${db.filename}`);

// 모델이 신문 제목 투로 한자 약어를 쓴다 — 실측 2026-09-19 브리핑에 與·國·靑·李·前·美가 섞였다
test("언론 관용 한자 약어를 한글로 되돌린다", () => {
  expect(hanjaToHangul("美 국무장관 방한")).toBe("미국 국무장관 방한");
  expect(hanjaToHangul("與 지도부와 野 대표 회동")).toBe("여당 지도부와 야당 대표 회동");
  expect(hanjaToHangul("靑, 人事 검증 강화")).toBe("대통령실, 인사 검증 강화");
  expect(hanjaToHangul("前 총재 자문료")).toBe("전 총재 자문료");
  expect(hanjaToHangul("韓美 외교장관 회담")).toBe("한미 외교장관 회담"); // 두 글자 조합이 먼저
  expect(hanjaToHangul("美中 갈등과 對北 제재")).toBe("미중 갈등과 대북 제재");
  expect(hanjaToHangul("檢, 前 대표 소환")).toBe("검찰, 전 대표 소환");
});

test("뜻을 모르는 한자는 건드리지 않는다 — 임의 변환이 더 위험하다", () => {
  expect(hanjaToHangul("誤選 논란")).toBe("誤選 논란");
  expect(hanjaToHangul("北京 특파원")).toBe("北京 특파원"); // 지명은 매핑에 없으면 그대로
});

test("코드블록과 인라인 코드 안은 손대지 않는다", () => {
  const md = "美 발표\n\n```html\n<div>美</div>\n```\n\n`美` 코드";
  const out = cleanOutput(md);
  expect(out).toContain("미국 발표");
  expect(out).toContain("<div>美</div>"); // 코드블록은 원문 유지
  expect(out).toContain("`美`");
});

test("기존 정리 기능은 그대로 동작한다", () => {
  expect(cleanOutput("<think>속으로</think>답변")).toBe("답변");
  expect(cleanOutput("완료 ✅")).toBe("완료 [완료]"); // ✅는 기존 마커 규칙대로 [완료]로 바뀐다
  expect(cleanOutput("진행 🚀")).toBe("진행");            // 마커가 아닌 장식 이모지는 제거
});

test("한글 뒤 괄호 병기는 이미 올바른 표기다 — 건드리지 않는다", () => {
  expect(hanjaToHangul("비(非)AI 분야 투자")).toBe("비(非)AI 분야 투자");
  expect(hanjaToHangul("대인(對人) 차량 돌진")).toBe("대인(對人) 차량 돌진");
  expect(hanjaToHangul("한미(韓美) 외교장관 회담")).toBe("한미(韓美) 외교장관 회담");
  expect(hanjaToHangul("이창용(前 총재)")).toBe("이창용(前 총재)"); // 괄호 안은 그대로
  // 괄호 밖 제목 투는 계속 바꾼다
  expect(hanjaToHangul("美 국무장관, 韓美 회담")).toBe("미국 국무장관, 한미 회담");
});
