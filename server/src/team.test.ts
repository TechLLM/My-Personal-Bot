import { test, expect, beforeEach } from "bun:test";
import { db } from "./db";
import { ensureBossAgent } from "./team";
import { systemPrompt } from "./routes/chat";

// 아래 테스트는 CEO 봇의 역할문을 덮어쓴다 — 운영 DB가 열렸으면 즉시 중단
if (db.filename !== ":memory:") throw new Error(`테스트가 운영 DB를 열었습니다: ${db.filename}`);

// CEO 봇을 직접 넣는다 — 시드 경로(defaultModelId)는 프로바이더 인증 조회를 하므로 타지 않게
const BOSS_ID = "test-boss";
db.prepare("INSERT INTO agents (id, name, is_boss, created_at) VALUES (?, 'CEO', 1, 0)").run(BOSS_ID);
// 같은 메모리 DB를 쓰는 다른 테스트 파일(audit 등)이 is_boss 봇을 먼저 넣으면
// ensureBossAgent의 LIMIT 1 선택이 그쪽을 잡는다 — 이 파일의 검증 대상은 항상 test-boss여야 한다
beforeEach(() => db.prepare("UPDATE agents SET is_boss = 0 WHERE is_boss = 1 AND id != ?").run(BOSS_ID));
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

test("bsk·ego_run 도구가 브라우저 경로로 디스패치된다 (MCP 새움 방지)", async () => {
  const { isBrowserish } = await import("./toolloop");
  expect(isBrowserish("bsk")).toBe(true);
  expect(isBrowserish("ego_run")).toBe(true);
  expect(isBrowserish("browser_open")).toBe(true);
  expect(isBrowserish("shell_run")).toBe(false);
  expect(isBrowserish("agent_list")).toBe(false);
});

// 2026-09-18 승인 루프 사고 회귀 — {"bots":[],"name":"X"} 형태의 호출이 빈 배열 때문에
// "이름이 없습니다"로 실패해 승인→실행실패→재요청 팝업이 6회 반복됐다
test("agent_create — 빈 bots 배열과 함께 온 단일 name은 단일 생성으로 처리된다", async () => {
  const { callBuiltin } = await import("./team");
  const out = await callBuiltin("agent_create", { bots: [], model: "", name: "회귀테스트봇", role: "테스트 역할" }, BOSS_ID);
  expect(out).toContain("봇 생성됨: 회귀테스트봇");
  db.prepare("DELETE FROM agents WHERE name = '회귀테스트봇'").run();
});

test("execToolCall — 빈 배열 인자가 제거돼 승인 게이트가 단일 생성으로 인식한다", async () => {
  const { execToolCall } = await import("./toolloop");
  const r = await execToolCall(
    { id: "t1", name: "agent_create", arguments: JSON.stringify({ bots: [], name: "회귀테스트봇2", role: "역할" }) },
    { agentId: BOSS_ID, context: "", browserKey: "k" },
  );
  expect(r.out).toContain("사용자 승인이 필요합니다");
  const pend = db.prepare("SELECT COUNT(*) c FROM approval_requests WHERE status = 'pending' AND tool = 'agent_create'").get() as { c: number };
  expect(pend.c).toBe(1);
  db.prepare("DELETE FROM approval_requests").run();
});

test("gateApproval — 이름이 진짜 없는 agent_create는 팝업 없이 즉시 오류를 돌려준다", async () => {
  const { gateApproval } = await import("./approvals");
  const out = gateApproval("agent_create", { role: "역할만 있음" }, BOSS_ID, "테스트");
  expect(out).toContain("이름이 없습니다");
  const pend = db.prepare("SELECT COUNT(*) c FROM approval_requests WHERE status = 'pending'").get() as { c: number };
  expect(pend.c).toBe(0);
});

test("agent_direct — instructions 빈 배열과 지시 없음은 실행 없이 오류를 돌려준다", async () => {
  const { execToolCall } = await import("./toolloop");
  const r = await execToolCall(
    { id: "t2", name: "agent_direct", arguments: JSON.stringify({ names: ["누군가"], instructions: [] }) },
    { agentId: BOSS_ID, context: "", browserKey: "k" },
  );
  expect(r.out).toContain("지시 내용이 없습니다");
});

test("같은 대상의 승인 실행이 연속 실패하면 추가 팝업 없이 실패를 돌려준다", async () => {
  const { gateApproval } = await import("./approvals");
  const ins = db.prepare("INSERT INTO approval_requests (id, tool, args, summary, agent_id, status, result, created_at, resolved_at) VALUES (?, 'agent_create', ?, 's', ?, 'approved', '오류: 생성할 봇 이름이 없습니다', ?, ?)");
  ins.run("e1", JSON.stringify({ name: "실패봇" }), BOSS_ID, 1, Date.now());
  ins.run("e2", JSON.stringify({ name: "실패봇", role: "다른 문구" }), BOSS_ID, 2, Date.now());
  const out = gateApproval("agent_create", { name: "실패봇", role: "또 다른 문구" }, BOSS_ID, "테스트");
  expect(out).toContain("연속 실패");
  const pend = db.prepare("SELECT COUNT(*) c FROM approval_requests WHERE status = 'pending'").get() as { c: number };
  expect(pend.c).toBe(0);
  db.prepare("DELETE FROM approval_requests").run();
});

test("looksLikeToolError — 도구 오류 문자열과 성공 문자열을 구분한다", async () => {
  const { looksLikeToolError } = await import("./approvals");
  expect(looksLikeToolError("오류: 생성할 봇 이름이 없습니다")).toBe(true);
  expect(looksLikeToolError("권한 없음: 봇 생성은 Eggbot만 수행합니다")).toBe(true);
  expect(looksLikeToolError("실행 오류: UNIQUE constraint failed")).toBe(true);
  expect(looksLikeToolError("봇 생성됨: 골든테스트봇")).toBe(false);
  expect(looksLikeToolError("봇 삭제됨: X [알림] 조직 관리는 Eggbot 전담입니다")).toBe(false);
});
