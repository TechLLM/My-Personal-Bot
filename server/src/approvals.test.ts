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
