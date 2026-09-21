import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { db, now, ensureApprovalExecutionContextColumn } from "./db";
import { approvalDecision, gateApproval, isReadOnlyShell, looksLikeToolError, resolveApprovalFileRoot, type ApprovalGateContext } from "./approvals";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

if (db.filename !== ":memory:") throw new Error(`테스트가 운영 DB를 열었습니다: ${db.filename}`);

// 승인 게이트는 인증이 뚫렸을 때 남는 마지막 방어선이라 규칙을 테스트로 고정한다 (개선지침서 A-4)

test("조회용 셸만 자동 허용한다", () => {
  for (const ok of ["ls -la", "cat notes.md", "find . -name '*.md'", "grep -rn todo .", "ls -la | head -20", "wc -l report.csv"])
    expect(isReadOnlyShell(ok)).toBe(true);
});

test("쓰기·실행·네트워크·셸 확장은 승인을 받는다", () => {
  for (const no of [
    "rm -rf build", "mv a b", "chmod 777 .", "tee out.txt",        // 쓰기·삭제
    "curl https://x.test", "wget http://x.test", "ssh host",        // 외부 전송
    "python3 x.py", "bun run x.ts", "sh -c 'ls'",                   // 인터프리터
    "ls > out.txt", "ls && rm x", "ls; rm x", "echo `whoami`", "echo $(id)", "ls &", // 리다이렉션·체이닝·치환
    "cat secrets.txt | sh",                                          // 파이프 끝이 실행
    "", "   ",
  ]) expect(isReadOnlyShell(no)).toBe(false);
});

test("shell_run 승인 여부는 도구 이름이 아니라 명령 내용으로 정해진다", () => {
  expect(approvalDecision("shell_run", { command: "ls -la agents" })).toBe("allow");
  expect(approvalDecision("shell_run", { command: "rm -rf agents" })).toBe("require");
  expect(approvalDecision("shell_run", {})).toBe("require"); // 명령이 없으면 안전한 쪽으로
  expect(approvalDecision("shell_run", { cmd: "pwd" })).toBe("allow"); // 인자 별칭도 본다
});

test("기존 승인 규칙은 그대로다", () => {
  expect(approvalDecision("send_email", { to: "x@y.z" })).toBe("require");
  expect(approvalDecision("agent_create", { name: "X" })).toBe("require");
  expect(approvalDecision("skill_save", { name: "S" })).toBe("require");
  expect(approvalDecision("agent_list", {})).toBe("allow");
  expect(approvalDecision("read_file", { path: "x" })).toBe("allow");
  expect(approvalDecision("web_search", { q: "x" })).toBe("allow");
});

test("사용자가 만든 규칙이 기본값보다 우선한다 — require가 최우선", () => {
  const ins = db.prepare("INSERT INTO approval_rules (id, pattern, action, created_at) VALUES (?, ?, ?, 0)");
  try {
    ins.run("r-allow", "^send_email$", "allow");
    expect(approvalDecision("send_email", {})).toBe("allow");
    ins.run("r-req", "^send_email$", "require");
    expect(approvalDecision("send_email", {})).toBe("require"); // require가 allow를 이긴다
  } finally {
    db.prepare("DELETE FROM approval_rules WHERE id IN ('r-allow','r-req')").run();
  }
});

test("도구 오류 문자열과 성공 문자열을 구분한다", () => {
  expect(looksLikeToolError("오류: 생성할 봇 이름이 없습니다")).toBe(true);
  expect(looksLikeToolError("권한 없음: Eggbot만 수행합니다")).toBe(true);
  expect(looksLikeToolError("봇 생성됨: 테스트봇")).toBe(false);
});

test("구형 승인 테이블 마이그레이션은 context 열을 한 번만 더하고 기존 행을 보존한다", () => {
  const legacy = new Database(":memory:");
  try {
    legacy.exec("CREATE TABLE approval_requests (id TEXT PRIMARY KEY, args TEXT, status TEXT, result TEXT)");
    legacy.prepare("INSERT INTO approval_requests VALUES ('legacy', '{}', 'pending', NULL)").run();
    ensureApprovalExecutionContextColumn(legacy);
    ensureApprovalExecutionContextColumn(legacy);
    const columns = legacy.prepare("PRAGMA table_info(approval_requests)").all() as { name: string }[];
    expect(columns.filter((c) => c.name === "execution_context").length).toBe(1);
    expect(legacy.prepare("SELECT id, args, status, result, execution_context FROM approval_requests").get()).toEqual({
      id: "legacy", args: "{}", status: "pending", result: null, execution_context: null,
    });
  } finally { legacy.close(); }
});

test("승인 fileRoot는 공유 루트·실제 하위만 허용하고 symlink 탈출을 거부한다", () => {
  const base = resolveApprovalFileRoot(null);
  const child = mkdtempSync(join(base, "approval-root-"));
  const outside = mkdtempSync(join(import.meta.dir, "approval-outside-"));
  const link = join(base, `approval-link-${Date.now()}`);
  try {
    expect(resolveApprovalFileRoot(base)).toBe(base);
    expect(resolveApprovalFileRoot(child)).toBe(child);
    expect(() => resolveApprovalFileRoot(outside)).toThrow("workspace 밖");
    symlinkSync(outside, link);
    expect(() => resolveApprovalFileRoot(link)).toThrow("workspace 밖");
  } finally {
    rmSync(link, { force: true });
    rmSync(child, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// --- 중복 요청 교체·거부 우회 차단 (개선지침서 A-4) ---
// 2026-09-18 사고: 문구만 조금씩 다른 수정 요청이 봇마다 5~7건씩 팝업으로 쌓였다.

const pending = (tool: string) =>
  db.prepare("SELECT args, status FROM approval_requests WHERE tool = ? AND status = 'pending'").all(tool) as { args: string; status: string }[];
const clearApprovals = () => db.prepare("DELETE FROM approval_requests").run();
const approvalCtx = (key = "approvals-test"): ApprovalGateContext => ({ browserKey: key, runKey: key, fileRoot: null, depth: 0, conversationId: null });
const gated = (tool: string, args: Record<string, unknown>, agentId = "boss") =>
  gateApproval(tool, args, agentId, "작업", [], undefined, approvalCtx());

test("같은 봇에 대한 수정 요청이 또 오면 대기 중인 것을 대체하고 하나만 남긴다", () => {
  clearApprovals();
  try {
    gated("agent_update", { name: "메일분석봇", role: "역할문 초안 A" });
    gated("agent_update", { name: "메일분석봇", role: "역할문 초안 B" });
    gated("agent_update", { name: "메일분석봇", role: "역할문 초안 C" });
    const left = pending("agent_update");
    expect(left.length).toBe(1);                      // 팝업이 쌓이지 않는다
    expect(left[0].args).toContain("초안 C");          // 가장 최근 것만 남는다
    const replaced = db.prepare("SELECT COUNT(*) c FROM approval_requests WHERE status = 'expired'").get() as { c: number };
    expect(replaced.c).toBe(2);                        // 앞의 둘은 만료로 정리된다
  } finally { clearApprovals(); }
});

test("대상 봇이 다르면 교체하지 않는다", () => {
  clearApprovals();
  try {
    gated("agent_update", { name: "메일분석봇", role: "A" });
    gated("agent_update", { name: "뉴스브리핑봇", role: "B" });
    expect(pending("agent_update").length).toBe(2);   // 서로 다른 봇의 요청까지 지우면 안 된다
  } finally { clearApprovals(); }
});

test("완전히 같은 호출이 다시 와도 대기 요청을 늘리지 않는다", () => {
  clearApprovals();
  try {
    const args = { to: "x@y.z", subject: "보고" };
    gated("send_email", args);
    gated("send_email", args);
    expect(pending("send_email").length).toBe(1);
  } finally { clearApprovals(); }
});

test("같은 root와 인자여도 브라우저 실행 범위가 다르면 별도 승인을 만든다", () => {
  clearApprovals();
  try {
    const args = { to: "scope@example.com", subject: "범위" };
    gateApproval("send_email", args, "boss", "작업", [], "scope-root", approvalCtx("scope-a"));
    gateApproval("send_email", args, "boss", "작업", [], "scope-root", approvalCtx("scope-b"));
    expect(pending("send_email").length).toBe(2);
  } finally { clearApprovals(); }
});

test("같은 root·브라우저·인자여도 fileRoot가 다르면 별도 승인을 만든다", () => {
  clearApprovals();
  const base = resolveApprovalFileRoot(null);
  const rootA = mkdtempSync(join(base, "approval-scope-a-"));
  const rootB = mkdtempSync(join(base, "approval-scope-b-"));
  try {
    const args = { to: "scope-file@example.com", subject: "범위" };
    gateApproval("send_email", args, "boss", "작업", [], "scope-file-root", { ...approvalCtx("scope-file-browser"), fileRoot: rootA });
    gateApproval("send_email", args, "boss", "작업", [], "scope-file-root", { ...approvalCtx("scope-file-browser"), fileRoot: rootB });
    expect(pending("send_email").length).toBe(2);
  } finally {
    clearApprovals();
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test("완료·거부 dedupe는 다른 실행 범위의 동일 호출을 억제하지 않는다", () => {
  const args = { to: "scope-terminal@example.com", subject: "범위" };
  const ctxA = approvalCtx("scope-terminal-a");
  const ctxB = approvalCtx("scope-terminal-b");
  clearApprovals();
  try {
    gateApproval("send_email", args, "boss", "작업", [], "scope-terminal-root", ctxA);
    db.prepare("UPDATE approval_requests SET status = 'approved', result = '전송 완료', resolved_at = ?").run(now());
    gateApproval("send_email", args, "boss", "작업", [], "scope-terminal-root", ctxB);
    expect(pending("send_email").length).toBe(1);
    clearApprovals();
    gateApproval("send_email", args, "boss", "작업", [], "scope-terminal-root", ctxA);
    db.prepare("UPDATE approval_requests SET status = 'denied', result = '거부', resolved_at = ?").run(now());
    gateApproval("send_email", args, "boss", "작업", [], "scope-terminal-root", ctxB);
    expect(pending("send_email").length).toBe(1);
  } finally { clearApprovals(); }
});

test("실행 맥락이 없으면 승인 행을 만들지 않는다", () => {
  clearApprovals();
  const out = gateApproval("send_email", { to: "x@y.z" }, "boss", "작업");
  expect(out).toContain("실행 맥락이 없습니다");
  expect(pending("send_email").length).toBe(0);
});

test("손상된 execution_context 행 하나가 정상 신규 승인을 막지 않는다", () => {
  clearApprovals();
  try {
    const args = JSON.stringify({ subject: "malformed-scope", to: "x@y.z" });
    db.prepare("INSERT INTO approval_requests (id, tool, args, summary, agent_id, status, execution_context, created_at) VALUES ('malformed-scope', 'send_email', ?, 'bad', 'boss', 'pending', '{', ?)")
      .run(args, now());
    expect(() => gated("send_email", { to: "x@y.z", subject: "malformed-scope" })).not.toThrow();
    expect((db.prepare("SELECT COUNT(*) c FROM approval_requests WHERE tool = 'send_email' AND status = 'pending'").get() as { c: number }).c).toBe(2);
  } finally { clearApprovals(); }
});

test("사용자가 거부한 호출은 다시 팝업을 만들지 않는다", () => {
  clearApprovals();
  try {
    const args = { to: "x@y.z", subject: "보고" };
    // 실제 흐름대로 — 팝업이 생기고, 사용자가 그것을 거부한 상태를 만든다
    gated("send_email", args);
    db.prepare("UPDATE approval_requests SET status = 'denied', resolved_at = ? WHERE tool = 'send_email' AND status = 'pending'").run(now() - 60_000);
    const out = gated("send_email", args);
    expect(out).toContain("이미 거부했습니다");
    expect(pending("send_email").length).toBe(0);     // 거부를 우회하는 재요청이 생기지 않는다
  } finally { clearApprovals(); }
});
