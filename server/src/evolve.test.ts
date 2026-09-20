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

// --- preflight 안전 검사 (개선지침서 A-4) ---
// 자기개선이 스스로 안전장치를 무르게 만들지 못하도록 막는 마지막 관문이다.
// 아래 검사가 하나라도 빠지면 봇이 테스트를 지우거나 보호 코드를 고쳐 통과시킬 수 있다.

import { preflightCandidate } from "./evolve";

const codeCandidate = (over: Record<string, unknown> = {}) =>
  ({ surface: "src", target: "server/src/report.ts", filePath: "server/src/report.ts", newContent: "export const x = 1;\n", summary: "s", ...over }) as any;

test("보호 경로는 후보가 될 수 없다", async () => {
  const fails = await preflightCandidate(codeCandidate({ target: "server/src/access.ts", filePath: "server/src/access.ts" }));
  expect(fails.some((f) => f.includes("보호 경로"))).toBe(true);
});

test("테스트 파일은 표면이 될 수 없다 — 테스트를 지워 통과시키는 길을 막는다", async () => {
  const fails = await preflightCandidate(codeCandidate({ target: "server/src/audit.test.ts", filePath: "server/src/audit.test.ts" }));
  expect(fails.some((f) => f.includes("테스트 파일"))).toBe(true);
});

test("비밀값처럼 보이는 내용이 들어오면 거부한다", async () => {
  const fails = await preflightCandidate(codeCandidate({ newContent: 'const key = "sk-abcdefghijklmnop1234";\nexport const api_key = "AKIA1234567890ABCDEF";\n' }));
  expect(fails.some((f) => f.includes("비밀값"))).toBe(true);
});

test("빈 내용은 거부한다", async () => {
  expect(await preflightCandidate(codeCandidate({ newContent: "   " }))).toContain("newContent 비어 있음");
});

test("없는 파일은 거부한다", async () => {
  const fails = await preflightCandidate(codeCandidate({ target: "server/src/없는파일.ts", filePath: "server/src/없는파일.ts" }));
  expect(fails.some((f) => f.includes("파일 없음"))).toBe(true);
});

test("db 표면 — 대상이 없거나 값이 비면 거부한다", async () => {
  const fails = await preflightCandidate({ surface: "skill.prompt", target: "없는스킬이름", newValue: "본문", summary: "s" } as any);
  expect(fails.some((f) => f.includes("대상 없음"))).toBe(true);
  const empty = await preflightCandidate({ surface: "skill.prompt", target: addSkill("있는스킬"), newValue: "  ", summary: "s" } as any);
  expect(empty).toContain("newValue 비어 있음");
});

test("역할문에서 전문가 기준 프레임이 빠지면 약화로 본다", async () => {
  const id = "ag-" + Math.random().toString(16).slice(2, 8);
  db.prepare("INSERT INTO agents (id, name, role_prompt, created_at) VALUES (?,?,?,0)").run(id, "테스트봇" + id, "역할문");
  try {
    const weak = await preflightCandidate({ surface: "agent.role", target: id, newValue: "그냥 잘 하세요", summary: "s" } as any);
    expect(weak.some((f) => f.includes("약화"))).toBe(true);
    const kept = await preflightCandidate({ surface: "agent.role", target: id, newValue: "[전문가 수행 기준] 기준을 지켜 수행합니다", summary: "s" } as any);
    expect(kept.some((f) => f.includes("약화"))).toBe(false);
  } finally { db.prepare("DELETE FROM agents WHERE id = ?").run(id); }
});
