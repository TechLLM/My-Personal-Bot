// mkcert로 로컬 HTTPS 인증서를 생성한다 — server/.certs/{cert,key}.pem
// 대상: localhost·127.0.0.1·::1 + 이 Mac의 .local 호스트명·LAN IP (LAN에서도 경고 없이 접속)
// 브라우저 신뢰에는 각 기기에서 mkcert 루트 CA 설치가 필요하다 (이 Mac: `mkcert -install` 1회)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "..", "server", ".certs");
mkdirSync(dir, { recursive: true });

const run = (cmd: string, args: string[]) =>
  spawnSync(cmd, args, { encoding: "utf8" }).stdout?.trim() ?? "";

const mkcert = spawnSync("which", ["mkcert"], { encoding: "utf8" });
if (mkcert.status !== 0) {
  console.error("mkcert가 없습니다 — `brew install mkcert` 후 다시 실행하세요.");
  process.exit(1);
}

const localHostName = run("scutil", ["--get", "LocalHostName"]);
const sans = ["localhost", "127.0.0.1", "::1"];
if (localHostName) sans.push(localHostName, `${localHostName}.local`);
for (const dev of ["en0", "en1"]) {
  const ip = run("ipconfig", ["getifaddr", dev]);
  if (ip) sans.push(ip);
}

const cert = join(dir, "cert.pem");
const key = join(dir, "key.pem");
const res = spawnSync("mkcert", ["-cert-file", cert, "-key-file", key, ...sans], { stdio: "inherit" });
if (res.status !== 0) process.exit(res.status ?? 1);
console.log(`[gen-cert] ${cert} — SAN: ${sans.join(", ")}`);
if (!existsSync(cert)) process.exit(1);
