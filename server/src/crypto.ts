import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// 로컬 전용 암호화 키 — server/data/secret.key (gitignore 대상, 소유자만 읽기).
// 이 키가 유출되지 않는 한 DB의 비밀번호는 복호화 불가.
const DATA_DIR = join(import.meta.dir, "..", "data");
const KEY_PATH = join(DATA_DIR, "secret.key");

let cachedKey: Buffer | null = null;
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  if (existsSync(KEY_PATH)) {
    cachedKey = readFileSync(KEY_PATH);
    return cachedKey;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  cachedKey = randomBytes(32);
  writeFileSync(KEY_PATH, cachedKey, { mode: 0o600 });
  return cachedKey;
}

const PREFIX = "enc:v1:";

// AES-256-GCM — 저장 형식: enc:v1:<iv>:<tag>:<data> (모두 base64)
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${PREFIX}${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored; // 구형 평문 레코드 호환
  try {
    const parts = stored.slice(PREFIX.length).split(":"); // PREFIX 뒤: iv:tag:data
    const [iv, tag, data] = parts;
    const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return ""; // 키 분실·데이터 손상 — 평문을 절대 반환하지 않음
  }
}
