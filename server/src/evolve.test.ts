import { test, expect, afterEach } from "bun:test";
import { db } from "./db";
import { liveTargets, targetExists } from "./evolve";

if (db.filename !== ":memory:") throw new Error(`테스트가 운영 DB를 열었습니다: ${db.filename}`);

// 2026-09-19 회귀: 탐색 봇이 존재하지 않는 스킬명을 지어내
// "preflight 실패: 대상 없음: skills.자기개선-실패점검과중단복구"로 사이클 한 건이 통째로 버려졌다.
// 하루 한 번뿐인 사이클이라 한 건의 비용이 크다 (개선지침서 A-2).

const ids: string[] = [];
const addSkill = (name: string, disabled = 0) => {
  const id = "sk-" + Math.random().toString(16).slice(2, 8);
  db.prepare("INSERT INTO skills (id, name, prompt, created_at, disabled) VALUES (?,?,?,0,?)").run(id, name, "본문", disabled);
  ids.push(id);
  return id;
};
afterEach(() => { for (const id of ids.splice(0)) db.prepare("DELETE FROM skills WHERE id = ?").run(id); });

const SKILL_SURFACE = { kind: "db", table: "skills" };

test("실재하지 않는 대상은 후보가 될 수 없다", () => {
  // 실제로 사이클을 날린 그 이름
  expect(targetExists(SKILL_SURFACE, "자기개선-실패점검과중단복구")).toBe(false);
});

test("실재하는 대상은 이름으로도 id로도 찾는다", () => {
  const id = addSkill("뉴스브리핑-전문가형식");
  expect(targetExists(SKILL_SURFACE, "뉴스브리핑-전문가형식")).toBe(true);
  expect(targetExists(SKILL_SURFACE, id)).toBe(true);
});

test("코드 표면은 여기서 막지 않는다 — 파일 존재·보호 검사가 따로 있다", () => {
  expect(targetExists({ kind: "code" }, "server/src/report.ts")).toBe(true);
  expect(targetExists({ kind: "db" }, "무엇이든")).toBe(true); // 테이블이 없으면 판단하지 않는다
});

test("테이블 이름이 식별자 형식이 아니면 통과시키지 않는다", () => {
  // 표면 정의가 오염돼도 쿼리로 새어 들어가지 않게 한다
  expect(targetExists({ kind: "db", table: "skills; DROP TABLE skills" }, "x")).toBe(false);
});

test("프롬프트에 넣을 실재 목록에서 비활성 스킬은 빠진다", () => {
  addSkill("살아있는스킬");
  addSkill("꺼진스킬", 1);
  const skills = liveTargets().find((g) => g.table === "skills")!.names;
  expect(skills).toContain("살아있는스킬");
  expect(skills).not.toContain("꺼진스킬");
});

test("봇·루틴 목록도 함께 제공한다", () => {
  expect(liveTargets().map((g) => g.table)).toEqual(["skills", "agents", "routines"]);
});
