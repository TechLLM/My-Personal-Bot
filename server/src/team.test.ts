import { test, expect } from "bun:test";
import { db } from "./db";
import { ensureBossAgent } from "./team";
import { systemPrompt } from "./routes/chat";

// 아래 테스트는 CEO 봇의 역할문을 덮어쓴다 — 운영 DB가 열렸으면 즉시 중단
if (db.filename !== ":memory:") throw new Error(`테스트가 운영 DB를 열었습니다: ${db.filename}`);

// CEO 봇을 직접 넣는다 — 시드 경로(defaultModelId)는 프로바이더 인증 조회를 하므로 타지 않게
const BOSS_ID = "test-boss";
db.prepare("INSERT INTO agents (id, name, is_boss, created_at) VALUES (?, 'CEO', 1, 0)").run(BOSS_ID);
const setRole = (role: string) => db.prepare("UPDATE agents SET role_prompt = ? WHERE id = ?").run(role, BOSS_ID);
const getRole = () => (db.prepare("SELECT role_prompt FROM agents WHERE id = ?").get(BOSS_ID) as { role_prompt: string }).role_prompt;
const count = (s: string, sub: string) => s.split(sub).length - 1;

// 사용자가 직접 쓴 역할문 — "MyBot의 CEO" 기본 역할문이 아니라서 BOSS_ROLE로 교체되지 않는 경로
const USER_ROLE = "CEO / MyBot 총괄 책임자로서 업무 위임과 최종 종합 보고를 담당한다.";

test("ensureBossAgent를 두 번 실행해도 [CEO 권한] 문단이 누적되지 않는다", () => {
  setRole(USER_ROLE);
  ensureBossAgent();
  ensureBossAgent();
  expect(count(getRole(), "[CEO 권한]")).toBeLessThanOrEqual(1);
});

test("이미 누적된 [CEO 권한] 문단은 걷어내고 사용자 역할문은 그대로 둔다", () => {
  const oldGrant = "\n\n[CEO 권한] 당신은 모든 봇의 관리자입니다. agent_create(봇 생성), agent_list(봇 현황) 도구를 사용할 수 있습니다. 팀장은 자기 하위 봇을 생성·지시·취합해 당신에게 보고합니다.";
  const newGrant = "\n\n[CEO 권한] 당신은 모든 봇의 관리자입니다. agent_list(봇 현황), agent_direct(봇에게 즉시 지시), routine_add(예약 등록) 도구를 사용할 수 있습니다.";
  setRole(USER_ROLE + oldGrant.repeat(18) + newGrant.repeat(2));
  ensureBossAgent();
  expect(getRole()).toBe(USER_ROLE);
});

test("CEO 권한 안내는 시스템 프롬프트를 조립할 때 한 번만 들어간다", () => {
  setRole(USER_ROLE);
  ensureBossAgent();
  ensureBossAgent();
  const p = systemPrompt("auto", null, null, BOSS_ID);
  expect(count(p, "당신은 관리자(CEO)입니다")).toBe(1);
  expect(p).not.toContain("[CEO 권한]");
});

test("조직 유지 지침이 없는 옛 기본 역할문은 최신 기본 역할문으로 갱신한다", () => {
  setRole("당신은 MyBot의 CEO(총괄 관리자) 봇입니다. 사용자의 모든 업무 지시를 받는 총괄 책임자입니다.");
  ensureBossAgent();
  expect(getRole()).toContain("조직 유지");
  expect(getRole()).not.toContain("[CEO 권한]");
});
