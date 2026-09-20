// Explicit operator action. Does not import the app/DB or start any integrations.
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function provisionAccessFile(directory: string): "existing" | "created" {
  const path = join(directory, "access.key");
  if (existsSync(path)) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || (stat.mode & 0o077) !== 0) throw new Error("접속 암호 파일의 유형·권한을 확인하세요");
  return "existing";
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(path, randomBytes(32).toString("base64url") + "\n", { flag: "wx", mode: 0o600 });
  return "created";
}
if (import.meta.main) {
  const result = provisionAccessFile(join(import.meta.dir, "../server/data"));
  console.log(result === "created" ? "접속 암호 파일을 생성했습니다 (소유자 전용, 비밀값 출력 안 함)." : "접속 암호 파일이 이미 있습니다. 변경하지 않았습니다.");
  console.log("접속 암호는 이 인스턴스의 server/data/access.key 파일에서 직접 확인하세요.");
}
