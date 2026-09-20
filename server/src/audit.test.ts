import { test, expect, beforeEach, afterEach } from "bun:test";
import { db, now } from "./db";
import { auditOrg, formatAudit, repeatedParagraph, modelProblem, failRateFinding, isInfraFailure, skillTally, unattendedExpiry, type Run } from "./audit";

if (db.filename !== ":memory:") throw new Error(`테스트가 운영 DB를 열었습니다: ${db.filename}`);

// 이 파일은 조직 전체를 보는 점검을 다루므로 테이블을 비워야 한다.
// bun test는 여러 테스트 파일이 한 프로세스에서 같은 메모리 DB를 쓰므로,
// 비우기 전에 스냅샷을 떠 두고 테스트가 끝나면 그대로 되돌린다 (다른 파일의 데이터를 지우면 그 테스트가 깨진다)
const TABLES = ["agents", "routines", "skills", "skill_runs", "agent_runs", "approval_requests"];
let snapshot: Record<string, Record<string, unknown>[]> = {};
const clear = () => { for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run(); };
const restore = () => {
  clear();
  for (const t of TABLES) for (const row of snapshot[t] ?? []) {
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO ${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...cols.map((c) => row[c] as never));
  }
};
const ins = (over: Record<string, unknown> = {}) => {
  const a = { id: "a" + Math.random().toString(16).slice(2, 8), name: "봇" + Math.random().toString(16).slice(2, 6),
    role_prompt: "이 봇은 무엇을 어떤 기준으로 수행하는지 충분히 설명하는 역할문을 가지고 있습니다. ".repeat(3),
    model: "minimax/MiniMax-M3", is_boss: 0, is_lead: 0, parent_id: null, special_role: null, max_children: null, ...over };
  db.prepare("INSERT INTO agents (id, name, role_prompt, model, is_boss, is_lead, parent_id, special_role, max_children, created_at) VALUES (?,?,?,?,?,?,?,?,?,0)")
    .run(a.id, a.name, a.role_prompt, a.model, a.is_boss, a.is_lead, a.parent_id, a.special_role, a.max_children);
  return a;
};
const ids = (fs: ReturnType<typeof auditOrg>) => fs.map((x) => x.id);

beforeEach(() => {
  snapshot = {};
  for (const t of TABLES) snapshot[t] = db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[];
  clear();
});
afterEach(restore);

test("정상 조직에서는 봇 관련 문제를 찾지 않는다", () => {
  ins({ is_boss: 1, name: "CEO" });
  expect(ids(auditOrg()).filter((i) => i.startsWith("tree.") || i.startsWith("role.") || i.startsWith("model."))).toEqual([]);
});

test("봇 트리 문제를 잡는다 — CEO 없음·고아 참조·3단계·팀장 아닌 상위", () => {
  expect(ids(auditOrg())).toContain("tree.no_boss");
  const boss = ins({ is_boss: 1 });
  const lead = ins({ is_lead: 1, parent_id: boss.id });
  const worker = ins({ parent_id: lead.id });
  ins({ parent_id: worker.id });            // 3단계
  ins({ parent_id: "없는봇id" });            // 고아
  const found = ids(auditOrg());
  expect(found).toContain("tree.depth");
  expect(found).toContain("tree.orphan");
  expect(found).toContain("tree.parent_not_lead"); // worker는 팀장이 아니다
});

test("역할문 문제를 잡는다 — 빈 값·너무 짧음·문단 반복", () => {
  ins({ is_boss: 1 });
  ins({ role_prompt: "" });
  ins({ role_prompt: "짧은 역할문" });
  const dup = "이 문단은 프롬프트를 덧붙이는 코드가 멱등하지 않아 반복해서 쌓인 문단입니다.";
  ins({ role_prompt: `본문입니다.\n\n${dup}\n\n${dup}` });
  const found = ids(auditOrg());
  expect(found).toContain("role.empty");
  expect(found).toContain("role.short");
  expect(found).toContain("role.repeat");
});

test("모델 배정 문제를 잡는다", () => {
  expect(modelProblem("")).toBe("모델 미지정");
  expect(modelProblem("gpt-6-astra")).toContain("형식 오류");
  expect(modelProblem("없는프로바이더/x")).toContain("등록되지 않은");
  expect(modelProblem("minimax/MiniMax-M3")).toBeNull();
});

test("루틴 문제를 잡는다 — 부실 지시문·담당 봇 없음·시각 충돌", () => {
  ins({ is_boss: 1 });
  const r = db.prepare("INSERT INTO routines (id, name, prompt, schedule, enabled, trigger_type, agent_id, created_at) VALUES (?,?,?,?,?,'schedule',?,0)");
  r.run("r1", "부실", "매일 뉴스 요약", "daily:08:30", 1, null);
  r.run("r2", "고아", "실행 시점에 맥락이 없으므로 범위·형식·완료 기준을 모두 담은 충분히 긴 지시문입니다. 완료 기준까지 적습니다.", "daily:08:30", 1, "삭제된봇");
  const found = ids(auditOrg());
  expect(found).toContain("routine.weak");
  expect(found).toContain("routine.orphan");
  expect(found).toContain("routine.collision"); // 08:30에 둘
});

test("운영 지표를 잡는다 — 실패율·승인 적체", () => {
  ins({ is_boss: 1 });
  const run = db.prepare("INSERT INTO agent_runs (id, agent_id, task, status, steps, created_at) VALUES (?,NULL,'t',?,?,?)");
  for (let i = 0; i < 12; i++) run.run("run" + i, i < 4 ? "error" : "done", 3, now() - 1000);
  db.prepare("INSERT INTO approval_requests (id, tool, args, summary, status, created_at) VALUES ('ap1','shell_run','{}','s','pending',?)")
    .run(now() - 30 * 3_600_000);
  const found = ids(auditOrg());
  expect(found).toContain("ops.fail_rate");
  expect(found).toContain("ops.stale_approval");
});

test("보고서는 심각도 순으로 나오고 문제가 없으면 그렇게 적는다", () => {
  ins({ is_boss: 1 });
  expect(formatAudit([])).toContain("발견된 문제 없음");
  const out = formatAudit(auditOrg());
  expect(out).toContain("조직 설계 점검");
  expect(out).toContain("실행 모델과 무관");
});

test("문단 반복 검출은 짧은 줄을 무시한다", () => {
  expect(repeatedParagraph("짧다\n\n짧다")).toBeNull();
  const long = "이 문단은 서른 자가 넘는 충분히 긴 문단이라 반복 검출 대상입니다.";
  expect(repeatedParagraph(`${long}\n\n${long}`)?.count).toBe(2);
});

test("짧은 템플릿 스킬은 적용 조건을 요구하지 않는다", () => {
  ins({ is_boss: 1 });
  const add = db.prepare("INSERT INTO skills (id, name, prompt, created_at, disabled) VALUES (?,?,?,0,0)");
  add.run("s1", "요약", "다음 내용을 핵심만 간결하게 요약해줘:");                       // 템플릿 — 제외
  add.run("s2", "그룹웨어-메일조회", "절차를 길게 설명하는 학습된 스킬 본문입니다. ".repeat(12)); // 절차 스킬 — 요구
  const found = auditOrg().filter((x) => x.id === "skill.no_condition").map((x) => x.detail);
  expect(found).toEqual(["그룹웨어-메일조회"]);
});

// --- 실패율 창 (개선지침서 A-1) ---
// 7일 한 창으로만 보면 이미 고친 문제가 일주일 내내 "위험"으로 남는다.

const NOW = 1_700_000_000_000;
const runs = (n: number, err: number, agoMs: number): Run[] =>
  Array.from({ length: n }, (_, i) => ({ status: i < err ? "error" : "ok", steps: 1, created_at: NOW - agoMs }));

test("어제까지 실패가 몰렸고 오늘은 잠잠하면 위험에서 주의로 낮춘다", () => {
  // 착수 시점 실측과 같은 모양 — 7일 177/1243(14%), 24시간 0/89(0%)
  const f = failRateFinding([...runs(1154, 177, 3 * 86_400_000), ...runs(89, 0, 3600_000)], NOW)!;
  expect(f.severity).toBe("주의");
  expect(f.detail).toContain("24시간 0/89 (0%)");
  expect(f.detail).toContain("개선 중");
  expect(f.fix).toContain("이미 지나간 실패");
});

test("오늘도 비슷하게 실패하고 있으면 위험으로 남긴다", () => {
  const f = failRateFinding([...runs(100, 20, 3 * 86_400_000), ...runs(50, 15, 3600_000)], NOW)!;
  expect(f.severity).toBe("위험");
  expect(f.detail).toContain("비슷한 수준"); // 30%는 23%의 1.5배에 못 미친다
});

test("오늘 실패가 급증하면 악화 중이라고 알린다", () => {
  const f = failRateFinding([...runs(150, 15, 3 * 86_400_000), ...runs(50, 40, 3600_000)], NOW)!;
  expect(f.severity).toBe("위험");
  expect(f.detail).toContain("악화 중");
});

test("최근 24시간 표본이 적으면 섣불리 위험을 낮추지 않는다", () => {
  // 오늘 3건이 다 성공이어도 그것만으로 해결됐다고 볼 수 없다
  const f = failRateFinding([...runs(200, 40, 3 * 86_400_000), ...runs(3, 0, 3600_000)], NOW)!;
  expect(f.severity).toBe("위험");
  expect(f.detail).toContain("표본이 적어");
});

test("7일 실패율이 임계 이하면 아무 소견도 내지 않는다", () => {
  expect(failRateFinding(runs(200, 10, 3 * 86_400_000), NOW)).toBeNull();
});

test("표본이 10건 미만이면 판단하지 않는다", () => {
  expect(failRateFinding(runs(9, 9, 3600_000), NOW)).toBeNull();
});

// --- 인프라 실패와 절차 실패 구분 (개선지침서 A-5) ---
// browser-skill이 "성공률 미달"로 자동 비활성됐지만, 실패 3건은 전부 크레딧 부족·타임아웃이었다.
// 기록된 스킬 실패 6건이 모두 이 종류였고, 절차 잘못으로 실패한 건은 하나도 없었다.

test("프로바이더 크레딧·한도·타임아웃은 인프라 실패로 본다", () => {
  for (const r of [
    '에이전트 오류: 오류 401: {"type":"error","error":{"type":"CreditsError"',
    "에이전트 오류: The operation timed out.",
    "오류 429: rate limit exceeded",
    "오류 503: upstream unavailable",
    "socket hang up",
  ]) expect(isInfraFailure(r)).toBe(true);
});

test("절차가 잘못된 실패는 인프라 실패로 보지 않는다", () => {
  for (const r of ["필수 항목을 찾지 못했습니다", "로그인 화면에서 다음 단계를 못 찾음", "", null])
    expect(isInfraFailure(r)).toBe(false);
});

test("성공률 계산에서 인프라 실패는 분모에서도 빠진다", () => {
  // browser-skill 실제 이력과 같은 모양 — 성공 5, 크레딧 2, 타임아웃 1
  const rows = [
    ...Array(5).fill({ ok: 1, fail_reason: null }),
    { ok: 0, fail_reason: '오류 401: {"type":"error","error":{"type":"CreditsError"' },
    { ok: 0, fail_reason: '오류 401: {"type":"error","error":{"type":"CreditsError"' },
    { ok: 0, fail_reason: "에이전트 오류: The operation timed out." },
  ];
  expect(skillTally(rows)).toEqual({ n: 5, ok: 5 }); // 8건 중 5건만 절차 판단 대상
});

test("절차 실패는 그대로 성공률에 반영한다", () => {
  const rows = [
    { ok: 1, fail_reason: null },
    { ok: 0, fail_reason: "필수 항목을 찾지 못했습니다" },
    { ok: 0, fail_reason: "다음 단계를 못 찾음" },
  ];
  expect(skillTally(rows)).toEqual({ n: 3, ok: 1 }); // 33% — 이건 꺼야 할 절차가 맞다
});

test("인프라 장애만 겪은 스킬은 성공률 경고를 내지 않는다", () => {
  ins({ is_boss: 1 });
  db.prepare("INSERT INTO skills (id, name, prompt, created_at, disabled) VALUES ('sk-inf','브라우저절차','절차 본문',0,0)").run();
  const add = db.prepare("INSERT INTO skill_runs (id, skill_id, run_key, ok, fail_reason, created_at) VALUES (?,?,?,?,?,0)");
  add.run("r1", "sk-inf", "k1", 1, null);
  add.run("r2", "sk-inf", "k2", 0, "오류 401: CreditsError");
  add.run("r3", "sk-inf", "k3", 0, "The operation timed out.");
  add.run("r4", "sk-inf", "k4", 0, "오류 429: rate limit");
  expect(ids(auditOrg())).not.toContain("skill.low_success"); // 판단 대상이 1건뿐이라 아예 판정하지 않는다
});

// --- 만료 승인 구분 (개선지침서 A-7) ---
// expired에는 "방치돼 만료"와 "정상적으로 대체·정리"가 섞여 있다.
// 후자까지 세면 승인 대상이 과하다고 잘못 보고한다.

test("정상적인 대체·정리 만료는 방치로 세지 않는다", () => {
  expect(unattendedExpiry("같은 봇에 대한 새 수정 요청으로 대체됨")).toBe(false);
  expect(unattendedExpiry("만료 — 사용자 요청으로 봇 간 연쇄 실행 정지")).toBe(false);
  expect(unattendedExpiry("E2E 검증 산출물 — 직접 정리")).toBe(false);
});

test("사유 없이 만료된 것은 방치로 본다", () => {
  expect(unattendedExpiry(null)).toBe(true);
  expect(unattendedExpiry("")).toBe(true);
  expect(unattendedExpiry("시간 초과")).toBe(true);
});

test("대체로 만료된 요청이 쌓여도 만료율 경고를 내지 않는다", () => {
  ins({ is_boss: 1 });
  const add = db.prepare("INSERT INTO approval_requests (id, tool, args, summary, status, result, created_at) VALUES (?,'agent_update','{}','s','expired',?,0)");
  for (let i = 0; i < 25; i++) add.run("ex" + i, "같은 봇에 대한 새 수정 요청으로 대체됨");
  expect(ids(auditOrg())).not.toContain("ops.expired_rate");
});

test("방치된 만료가 실제로 많으면 경고한다", () => {
  ins({ is_boss: 1 });
  const add = db.prepare("INSERT INTO approval_requests (id, tool, args, summary, status, result, created_at) VALUES (?,'send_email','{}','s',?,?,0)");
  for (let i = 0; i < 10; i++) add.run("ok" + i, "approved", null);
  for (let i = 0; i < 15; i++) add.run("st" + i, "expired", null); // 사유 없는 만료 = 방치
  expect(ids(auditOrg())).toContain("ops.expired_rate");
});
