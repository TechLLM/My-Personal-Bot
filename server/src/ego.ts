import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ego lite (citrolabs/ego-lite) — 사용자의 실제 로그인 상태를 공유하는 Chromium 브라우저.
// 에이전트는 ego-browser CLI(Node 런타임)로 제어하고, 작업은 전용 Task Space에서 실행돼
// 사용자의 탭을 건드리지 않는다. 자세한 헬퍼 목록은 skills/ego-browser/SKILL.md 참고.
const EGO_BIN = join(process.env.HOME ?? "~", ".local", "bin", "ego-browser");

export function egoAvailable(): boolean {
  return existsSync(EGO_BIN);
}

// ego-browser nodejs 런타임에 스크립트를 stdin으로 전달 — cliLog() 출력을 모아 반환
function egoExec(script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const wrapped = script;
    const proc = spawn(EGO_BIN, ["nodejs"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(`브라우저 오류: ego 실행 시간 초과(${Math.round(timeoutMs / 1000)}초)`);
    }, timeoutMs);
    proc.stdout.on("data", (d) => { out += d; });
    proc.stderr.on("data", (d) => { err += d; });
    proc.on("close", () => {
      clearTimeout(timer);
      const text = out.trim() || err.trim();
      resolve(text.slice(0, 8000) || "(출력 없음 — 스크립트는 cliLog()로 결과를 출력해야 합니다)");
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      resolve(`브라우저 오류: ego 실행 실패 — ${e.message}`);
    });
    proc.stdin.write(wrapped);
    proc.stdin.end();
  });
}

// 에이전트 스크립트 — 전용 Task Space에서 실행 (같은 공간 재사용 시 탭·상태가 이어짐)
export function egoRun(script: string, space: string, timeoutMs = 60_000): Promise<string> {
  return egoExec(`const task = await useOrCreateTaskSpace(${JSON.stringify(space)});\n${script}`, timeoutMs);
}

// 작업 종료 시 Task Space 정리 — 공간과 안의 탭을 완전히 닫는다 (공간이 없어도 조용히 통과)
export async function egoCloseSpace(space: string): Promise<void> {
  if (!egoAvailable()) return;
  await egoExec(`await completeTaskSpace(${JSON.stringify(space)}, { keep: false }).catch(() => {});`, 20_000).catch(() => {});
}

// DeepSearch용 페이지 읽기 — 실제 로그인된 브라우저라 JS 렌더링·로그인 필요 페이지도 읽음
export async function egoReadPage(url: string, maxChars = 6000): Promise<{ title: string; text: string } | null> {
  if (!egoAvailable()) return null;
  const out = await egoRun(
    `await openOrReuseTab(${JSON.stringify(url)}, { wait: true, timeout: 20 });
const info = await pageInfo().catch(() => ({}));
const snap = await snapshotText().catch(() => "");
await closeTab().catch(() => {});
cliLog(JSON.stringify({ title: info.title ?? "", text: String(snap) }));`,
    "mybot-deepsearch",
    45_000,
  );
  // 읽기가 끝나면 공간 자체를 닫아 mybot-* 공간이 브라우저에 누적되지 않게 함
  void egoCloseSpace("mybot-deepsearch");
  try {
    const line = out.trim().split("\n").filter(Boolean).pop() ?? "";
    const d = JSON.parse(line) as { title?: string; text?: string };
    const text = String(d.text ?? "").replace(/\n{3,}/g, "\n\n").trim();
    if (text.length < 100) return null;
    return { title: String(d.title ?? ""), text: text.slice(0, maxChars) };
  } catch {
    return null;
  }
}
