import { test, expect } from "bun:test";
import { db } from "./db";
import { approvalDecision, isReadOnlyShell, looksLikeToolError } from "./approvals";

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

// --- 중복 요청 교체·거부 우회 차단 (개선지침서 A-4) ---
// 2026-09-18 사고: 문구만 조금씩 다른 수정 요청이 봇마다 5~7건씩 팝업으로 쌓였다.

import { gateApproval } from "./approvals";
import { now } from "./db";

const pending = (tool: string) =>
  db.prepare("SELECT args, status FROM approval_requests WHERE tool = ? AND status = 'pending'").all(tool) as { args: string; status: string }[];
const clearApprovals = () => db.prepare("DELETE FROM approval_requests").run();

test("같은 봇에 대한 수정 요청이 또 오면 대기 중인 것을 대체하고 하나만 남긴다", () => {
  clearApprovals();
  try {
    gateApproval("agent_update", { name: "메일분석봇", role: "역할문 초안 A" }, "boss", "작업");
    gateApproval("agent_update", { name: "메일분석봇", role: "역할문 초안 B" }, "boss", "작업");
    gateApproval("agent_update", { name: "메일분석봇", role: "역할문 초안 C" }, "boss", "작업");
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
    gateApproval("agent_update", { name: "메일분석봇", role: "A" }, "boss", "작업");
    gateApproval("agent_update", { name: "뉴스브리핑봇", role: "B" }, "boss", "작업");
    expect(pending("agent_update").length).toBe(2);   // 서로 다른 봇의 요청까지 지우면 안 된다
  } finally { clearApprovals(); }
});

test("완전히 같은 호출이 다시 와도 대기 요청을 늘리지 않는다", () => {
  clearApprovals();
  try {
    const args = { to: "x@y.z", subject: "보고" };
    gateApproval("send_email", args, "boss", "작업");
    gateApproval("send_email", args, "boss", "작업");
    expect(pending("send_email").length).toBe(1);
  } finally { clearApprovals(); }
});

test("사용자가 거부한 호출은 다시 팝업을 만들지 않는다", () => {
  clearApprovals();
  try {
    const args = { to: "x@y.z", subject: "보고" };
    // 실제 흐름대로 — 팝업이 생기고, 사용자가 그것을 거부한 상태를 만든다
    gateApproval("send_email", args, "boss", "작업");
    db.prepare("UPDATE approval_requests SET status = 'denied', resolved_at = ? WHERE tool = 'send_email' AND status = 'pending'").run(now() - 60_000);
    const out = gateApproval("send_email", args, "boss", "작업");
    expect(out).toContain("이미 거부했습니다");
    expect(pending("send_email").length).toBe(0);     // 거부를 우회하는 재요청이 생기지 않는다
  } finally { clearApprovals(); }
});
