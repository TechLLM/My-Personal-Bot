// BrowserSkill (Tencent) — bsk CLI로 사용자의 실제 로그인된 Chrome/Edge를 제어.
// 데몬은 unix socket으로 IPC하므로 shell_run 샌드박스를 쓰지 않고 서버가 직접 spawn한다.
// 상세 사용법은 skills 테이블의 browser-skill 스킬(Tencent SKILL.md)을 참고.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const BSK_BIN = join(process.env.HOME ?? "~", ".local", "bin", "bsk");

export function bskAvailable(): boolean {
  return existsSync(BSK_BIN);
}

// 허용 서브커맨드 — 브라우저 조작·조회·세션 관리만. daemon/update/install-skill 같은
// 호스트 관리 명령과 임의 셸 실행을 막기 위해 화이트리스트 + 셸 메타문자 차단.
const ALLOWED = /^(session|navigate|observe|click|fill|press|select|hover|scroll-to|wheel|focus|blur|snapshot|get-html|screenshot|tab|request-help|status|browsers|logs)\b/;
const SHELL_META = /[;&|`$(){}<>\\]/;

export function bskExec(cmd: string, timeoutMs = 90_000): Promise<string> {
  return new Promise((resolve) => {
    const trimmed = cmd.trim().replace(/^bsk\s+/, ""); // "bsk " 접두사는 벗겨 받는다
    if (!ALLOWED.test(trimmed)) return resolve(`오류: 허용되지 않는 bsk 명령 — 브라우저 조작·조회·세션 명령만 가능합니다 (입력: ${trimmed.slice(0, 60)})`);
    if (SHELL_META.test(trimmed)) return resolve("오류: 셸 연결자(& ; | ` $ 등)는 사용할 수 없습니다 — bsk 명령 하나만 넣으세요");
    const proc = spawn("sh", ["-c", `${BSK_BIN} ${trimmed}`], { env: { ...process.env, PATH: `${join(process.env.HOME ?? "~", ".local", "bin")}:${process.env.PATH ?? ""}` } });
    let out = "", err = "";
    const timer = setTimeout(() => { proc.kill("SIGKILL"); resolve(`브라우저 오류: bsk 실행 시간 초과(${Math.round(timeoutMs / 1000)}초)`); }, timeoutMs);
    proc.stdout.on("data", (d) => { out += d; });
    proc.stderr.on("data", (d) => { err += d; });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const text = (out.trim() || err.trim()).slice(0, 8000);
      resolve(text || `(출력 없음 — exit ${code})`);
    });
    proc.on("error", (e) => { clearTimeout(timer); resolve(`브라우저 오류: bsk 실행 실패 — ${e.message}`); });
  });
}
