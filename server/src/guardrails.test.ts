import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "./db";
import { isProtectedPath } from "./evolve";
import { approvalDecision, isReadOnlyShell } from "./approvals";

if (db.filename !== ":memory:") throw new Error(`테스트가 운영 DB를 열었습니다: ${db.filename}`);

// 이 파일은 기능이 아니라 "완화하면 안 되는 규칙"을 지킨다.
// 실서비스 릴리스는 적용 직전에 테스트를 돌리므로, 누군가 아래 보호를 풀면 배포가 실패한다.
// 규칙을 정말 바꿔야 한다면 사용자와 합의한 뒤 이 테스트부터 고친다. 조용히 지우지 않는다.

const ROOT = join(import.meta.dir, "..", "..");

test("봇이 건드릴 수 없어야 하는 경로가 보호 목록에 남아 있다", () => {
  // access.ts가 빠지면 봇이 자기개선으로 인증을 스스로 풀 수 있다 — 가장 위험한 회귀다
  for (const p of [
    "server/src/access.ts",      // 인증
    "server/src/release.ts",     // 릴리스 통로
    "server/src/approvals.ts",   // 승인 게이트
    "server/src/evolve.ts",      // 자기개선 엔진 자신
    "server/src/index.ts",       // 라우트·미들웨어 배선
    "server/src/crypto.ts",
  ]) expect(isProtectedPath(p)).toBe(true);
});

test("데이터·빌드 산출물·비밀 파일도 보호된다", () => {
  for (const p of [
    "server/data/mybot.db",      // 운영 DB
    "server/data/access.key",    // 접속 암호 파일
    "server/.certs/key.pem",
    "web/dist/index.html",       // 빌드 산출물 — 소스를 고쳐 빌드해야 한다
    "evolve/surfaces.json",      // 보호 목록 자신
    "package.json",
    ".env",
  ]) expect(isProtectedPath(p)).toBe(true);
});

test("보호는 목록에 없는 평범한 소스까지 막지는 않는다", () => {
  // 과보호로 자기개선이 통째로 멈추지 않는지 — 반대 방향의 회귀도 함께 본다
  for (const p of ["server/src/report.ts", "server/src/mail.ts", "web/src/components/MessageItem.tsx"])
    expect(isProtectedPath(p)).toBe(false);
});

test("shell_run 자동 허용은 조회 명령에만 열려 있다", () => {
  expect(isReadOnlyShell("ls -la")).toBe(true);
  expect(approvalDecision("shell_run", { command: "cat notes.md" })).toBe("allow");
  // 아래가 하나라도 allow가 되면 봇이 승인 없이 파일을 바꾸거나 외부로 내보낼 수 있다
  for (const danger of ["rm -rf .", "curl https://x.test", "python3 x.py", "ls > out.txt", "cat k.txt | sh", "chmod 777 ."])
    expect(approvalDecision("shell_run", { command: danger })).toBe("require");
});

test("외부 효과가 있는 도구는 사용자 승인을 거친다", () => {
  for (const tool of ["send_email", "agent_create", "skill_save"])
    expect(approvalDecision(tool, {})).toBe("require");
});

test("에이전트 작업 규칙 문서가 저장소에 남아 있다", () => {
  // 다른 모델이 규칙을 모른 채 작업하는 상황을 막는 문서다
  for (const f of ["CLAUDE.md", "AGENTS.md"]) expect(existsSync(join(ROOT, f))).toBe(true);
  expect(readFileSync(join(ROOT, "CLAUDE.md"), "utf8")).toContain("release");
});
