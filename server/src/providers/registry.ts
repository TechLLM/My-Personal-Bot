// 프로바이더 레지스트리 — 프록시 없이 각 AI 서비스에 직접 연결
// 자격증명은 로컬 저장소에서 자동 해석: 설정값 → opencode auth.json → codex/gemini OAuth 파일 → airoute 키체인 → 환경변수
import { getSetting, setSetting } from "../db";
import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";

export type ProviderKind = "openai" | "responses" | "gemini" | "cli";
export type AuthType = "apikey" | "oauth" | "cli" | "none";

export interface ProviderDef {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl?: string;
  authType: AuthType;
  authLabel: string;          // UI 표시용 인증 방식 설명
  doc?: string;               // 키 발급 안내
  env?: string;
  ocKeys?: string[];          // opencode auth.json 내 키 후보
  keychain?: string;          // airoute 키체인 계정명 (예: "xai/apikey")
  cmd?: string;               // cli kind 실행 파일
  args?: string[];            // cli 인자 템플릿 {model} {prompt}
  models?: string[];          // 정적 모델 목록 (oauth/cli — /models 엔드포인트 없는 제공자)
  custom?: boolean;           // 사용자 등록 프로바이더
  apiKey?: string;            // 커스텀 프로바이더의 저장 키 (서버 내부용 — UI 반환 시 제외)
}

const HOME = process.env.HOME ?? "~";
// launchd 등 최소 PATH 환경에서도 사용자 설치 CLI를 찾을 수 있게 일반 설치 경로를 직접 검색
const CLI_DIRS = [join(HOME, ".local", "bin"), join(HOME, ".npm-global", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
export function findCli(cmd: string): string | undefined {
  for (const d of CLI_DIRS) { const p = join(d, cmd); if (existsSync(p)) return p; }
  try {
    const out = execFileSync("which", [cmd], { stdio: ["pipe", "pipe", "pipe"], timeout: 3000 });
    return String(out).trim() || undefined;
  } catch { return undefined; }
}
// spawn 시 PATH에 사용자 bin 경로를 추가 — CLI가 내부적으로 다른 도구를 호출할 때 대비
export const CLI_PATH_PREFIX = CLI_DIRS.slice(0, 4).join(":");
const OPENCODE_AUTH = join(HOME, ".local", "share", "opencode", "auth.json");
const CODEX_AUTH = join(HOME, ".codex", "auth.json");
const GEMINI_AUTH = join(HOME, ".gemini", "oauth_creds.json");

// ─── 기본 프로바이더 프리셋 ───
export const PROVIDER_PRESETS: ProviderDef[] = [
  {
    id: "openai", name: "OpenAI · ChatGPT 구독", kind: "responses",
    baseUrl: "https://chatgpt.com/backend-api/codex", authType: "oauth",
    authLabel: "OAuth — codex 로그인 재사용", doc: "codex CLI 로그인(`codex login`) 상태를 사용합니다",
    models: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
  },
  {
    id: "gemini", name: "Google Gemini · 구독", kind: "gemini",
    baseUrl: "https://cloudcode-pa.googleapis.com", authType: "oauth",
    authLabel: "OAuth — gemini 로그인 재사용", doc: "gemini CLI 로그인(`gemini` 실행 후 /login) 상태를 사용합니다",
    models: ["gemini-3-pro", "gemini-3-flash", "gemini-3.1-pro", "gemini-3.6-flash", "gemini-2.5-pro", "gemini-2.5-flash"],
  },
  {
    id: "grok", name: "Grok · X 구독", kind: "cli", authType: "cli",
    cmd: "grok", args: ["-p", "{prompt}", "--output-format", "plain", "-m", "{model}"],
    authLabel: "OAuth — grok CLI 로그인", doc: "grok CLI 로그인(`grok login`) 상태를 사용합니다",
    models: ["grok-4.6", "grok-4.5"],
  },
  {
    id: "cursor", name: "Cursor · 구독", kind: "cli", authType: "cli",
    cmd: "cursor-agent", args: ["--print", "--trust", "--model", "{model}", "--output-format", "text", "{prompt}"],
    authLabel: "OAuth — cursor-agent 로그인", doc: "cursor-agent 로그인 상태를 사용합니다",
    models: ["auto", "composer-2.5", "gpt-5.3-codex", "gpt-5.3-codex-high", "gpt-5.3-codex-xhigh", "gpt-5.2",
      "cursor-grok-4.6-high-fast", "cursor-grok-4.6-low", "cursor-grok-4.5-high",
      "claude-opus-5-thinking-high", "claude-sonnet-5-thinking-high", "claude-sonnet-5-thinking-xhigh",
      "claude-fable-5-thinking-high", "claude-fable-5-thinking-xhigh", "gpt-5.6-sol-high", "gpt-5.6-luna-high", "gemini-3.7-flash-high"],
  },
  {
    // 코딩플랜 엔드포인트 — opencode의 zai 키는 코딩플랜이라 /paas/v4에서 1113 잔액 오류가 난다
    id: "zai", name: "Z.AI GLM", kind: "openai", baseUrl: "https://api.z.ai/api/coding/paas/v4",
    authType: "apikey", authLabel: "API 키", env: "ZAI_API_KEY", ocKeys: ["zai", "zai-coding-plan"], keychain: "zhipu/apikey",
    doc: "https://z.ai — 코딩 플랜·API 키",
    models: ["glm-5.3", "glm-5-turbo", "glm-5.3-flash", "glm-5v-turbo", "glm-5", "glm-5.1", "glm-5.2"],
  },
  {
    id: "minimax", name: "MiniMax", kind: "openai", baseUrl: "https://api.minimax.io/v1",
    authType: "apikey", authLabel: "API 키", env: "MINIMAX_API_KEY", ocKeys: ["minimax-coding-plan", "minimax"], keychain: "minimax/apikey",
    doc: "https://platform.minimax.io",
    models: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5", "MiniMax-M2.5-highspeed", "MiniMax-M2.1", "MiniMax-M2.1-highspeed", "MiniMax-M2"],
  },
  {
    id: "opencode-zen", name: "OpenCode Zen", kind: "openai", baseUrl: "https://opencode.ai/zen/v1",
    authType: "apikey", authLabel: "API 키", env: "OPENCODE_API_KEY", ocKeys: ["opencode", "opencode-zen"], keychain: "opencode-zen/apikey",
    doc: "종량제 — https://opencode.ai/auth",
    models: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-pro", "gpt-5.4-mini", "gpt-5.4-nano",
      "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.2", "gpt-5.2-codex", "gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-max", "gpt-5.1-codex-mini",
      "claude-opus-4.6", "claude-sonnet-4.6", "claude-haiku-4.5", "gemini-3-pro", "gemini-3-flash", "grok-4.6",
      "qwen3-coder-480b", "deepseek-v4-pro", "glm-5.3", "kimi-k3", "minimax-m3"],
  },
  {
    id: "opencode-go", name: "OpenCode Go · 구독", kind: "openai", baseUrl: "https://opencode.ai/zen/go/v1",
    authType: "apikey", authLabel: "API 키", env: "OPENCODE_GO_API_KEY", ocKeys: ["opencode-go"],
    doc: "$10/월 구독 — https://opencode.ai/auth",
    models: ["grok-4.6", "gpt-5.6-luna", "glm-5.3-flash", "glm-5.3", "glm-5.2", "glm-5.1", "kimi-k3", "kimi-k2.7-code", "kimi-k2.6",
      "longcat-2.0", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-flash", "mimo-v2.5", "mimo-v2.5-pro", "minimax-m3", "minimax-m2.7", "qwen3.7-plus", "qwen3.8-flash"],
  },
  {
    id: "xai", name: "xAI Grok API", kind: "openai", baseUrl: "https://api.x.ai/v1",
    authType: "apikey", authLabel: "API 키", env: "XAI_API_KEY", ocKeys: ["xai"], keychain: "xai/apikey",
    doc: "https://console.x.ai — API 키 발급",
    models: ["grok-4.6", "grok-4.5", "grok-4.3", "grok-4.20-0309-reasoning"],
  },
  {
    id: "openrouter", name: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1",
    authType: "apikey", authLabel: "API 키", env: "OPENROUTER_API_KEY", ocKeys: ["openrouter"],
    doc: "https://openrouter.ai/keys",
  },
  {
    id: "ollama", name: "Ollama · 로컬", kind: "openai", baseUrl: "http://localhost:11434/v1",
    authType: "none", authLabel: "로컬 — 키 불필요",
  },
];

// ─── 자격증명 해석 ───
function readJson(path: string): any {
  try { if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")); } catch {}
  return null;
}

function keychainGet(account: string): string | undefined {
  try {
    const out = execFileSync("security", ["find-generic-password", "-s", "airoute", "-a", account, "-w"], { stdio: ["pipe", "pipe", "pipe"], timeout: 5000 });
    return String(out).trim() || undefined;
  } catch { return undefined; }
}

export interface ResolvedAuth {
  apiKey?: string;
  accessToken?: string;
  accountId?: string;
  source?: string;   // UI 표시: "설정" | "opencode" | "codex" | "gemini" | "keychain" | "env" | "cli"
  expired?: boolean;
}

const authCache = new Map<string, { v: ResolvedAuth; at: number }>();
export function clearAuthCache() { authCache.clear(); }

// 수동 입력 키 — settings.provider_keys JSON {providerId: key}
export function manualKey(providerId: string): string | undefined {
  try { return JSON.parse(getSetting("provider_keys") ?? "{}")[providerId] || undefined; } catch { return undefined; }
}
export function setManualKey(providerId: string, key: string | null) {
  let m: Record<string, string> = {};
  try { m = JSON.parse(getSetting("provider_keys") ?? "{}"); } catch {}
  if (key) m[providerId] = key; else delete m[providerId];
  setSetting("provider_keys", JSON.stringify(m));
  authCache.delete(providerId);
}

export function resolveAuth(def: ProviderDef): ResolvedAuth {
  const cached = authCache.get(def.id);
  if (cached && Date.now() - cached.at < 30_000) return cached.v;
  const v = resolveAuthUncached(def);
  authCache.set(def.id, { v, at: Date.now() });
  return v;
}

// ─── codex(ChatGPT 구독) OAuth 토큰 갱신 ───
// access_token은 JWT로 만료가 있고 refresh_token으로 갱신해야 한다 — 미갱신 시
// 만료 경계에서 401 token_expired가 나고 실행이 통째로 error로 끝났다.
// codex CLI와 같은 파일을 쓰므로 임시 파일 + rename으로 원자적으로 갱신한다.
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
let codexRefreshInflight: Promise<string | null> | null = null;

// JWT의 exp 클레임(초)을 ms로 — access_token의 실제 만료 시각. 파일의 last_refresh는 발급 시각이라 만료 판정에 못 쓴다
function jwtExp(token: string): number | undefined {
  try {
    const p = token.split(".")[1];
    if (!p) return undefined;
    const exp = JSON.parse(Buffer.from(p, "base64url").toString("utf8"))?.exp;
    return typeof exp === "number" ? exp * 1000 : undefined;
  } catch { return undefined; }
}

export function refreshCodexAuth(): Promise<string | null> {
  codexRefreshInflight ??= (async () => {
    try {
      const c = readJson(CODEX_AUTH);
      const rt = c?.tokens?.refresh_token;
      if (!rt) return null;
      const res = await fetch("https://auth.openai.com/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: "refresh_token", refresh_token: rt }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as any;
      if (!j.access_token) return null;
      c.tokens = { ...c.tokens, access_token: j.access_token, id_token: j.id_token ?? c.tokens.id_token, refresh_token: j.refresh_token ?? rt };
      c.last_refresh = new Date().toISOString();
      const tmp = `${CODEX_AUTH}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(c));
      renameSync(tmp, CODEX_AUTH);
      authCache.delete("openai");
      console.log("[mybot] codex OAuth 토큰 갱신 완료");
      return j.access_token as string;
    } catch (e) {
      console.warn(`[mybot] codex OAuth 토큰 갱신 실패: ${(e as Error).message}`);
      return null;
    } finally {
      codexRefreshInflight = null;
    }
  })();
  return codexRefreshInflight;
}

// ─── Gemini(Code Assist 구독) OAuth 토큰 갱신 ───
// 클라이언트 정보는 설치된 gemini-cli 패키지에서 읽는다 — 저장소에 박지 않는다.
let geminiRefreshInflight: Promise<string | null> | null = null;

function geminiClientCreds(): { clientId: string; clientSecret: string } | null {
  const dirs = [
    join(HOME, ".npm-global", "lib", "node_modules", "@google", "gemini-cli"),
    "/opt/homebrew/lib/node_modules/@google/gemini-cli",
    "/usr/local/lib/node_modules/@google/gemini-cli",
  ];
  for (const dir of dirs) {
    try {
      const bundle = join(dir, "bundle");
      for (const f of readdirSync(bundle).filter((n) => n.endsWith(".js"))) {
        const src = readFileSync(join(bundle, f), "utf8");
        const id = src.match(/OAUTH_CLIENT_ID = "([^"]+)"/)?.[1];
        const sec = src.match(/OAUTH_CLIENT_SECRET = "([^"]+)"/)?.[1];
        if (id && sec) return { clientId: id, clientSecret: sec };
      }
    } catch {}
  }
  return null;
}

export function refreshGeminiAuth(): Promise<string | null> {
  geminiRefreshInflight ??= (async () => {
    try {
      const c = readJson(GEMINI_AUTH);
      const rt = c?.refresh_token;
      const creds = geminiClientCreds();
      if (!rt || !creds) return null;
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, grant_type: "refresh_token", refresh_token: rt }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as any;
      if (!j.access_token) return null;
      Object.assign(c, { access_token: j.access_token, expires_in: j.expires_in, expiry_date: Date.now() + (j.expires_in ?? 3600) * 1000 });
      const tmp = `${GEMINI_AUTH}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(c));
      renameSync(tmp, GEMINI_AUTH);
      authCache.delete("gemini");
      console.log("[mybot] gemini OAuth 토큰 갱신 완료");
      return j.access_token as string;
    } catch (e) {
      console.warn(`[mybot] gemini OAuth 토큰 갱신 실패: ${(e as Error).message}`);
      return null;
    } finally {
      geminiRefreshInflight = null;
    }
  })();
  return geminiRefreshInflight;
}

// ─── 프로바이더 재로그인 — CLI의 브라우저 로그인을 백그라운드로 실행 ───
// 완료되면 각 CLI가 자체 자격증명 파일을 갱신하고, 다음 resolveAuth가 새 토큰을 읽는다.
const loginInFlight = new Map<string, number>();
export function startProviderLogin(providerId: string): { ok: boolean; error?: string } {
  const cmds: Record<string, { cmd: string; args: string[] }> = {
    openai: { cmd: "codex", args: ["login"] },
    grok: { cmd: "grok", args: ["login"] },
    cursor: { cmd: "cursor-agent", args: ["login"] },
  };
  const spec = cmds[providerId];
  if (!spec) return { ok: false, error: "이 프로바이더는 자동 재로그인을 지원하지 않습니다" };
  const bin = findCli(spec.cmd);
  if (!bin) return { ok: false, error: `${spec.cmd} CLI가 설치돼 있지 않습니다` };
  const last = loginInFlight.get(providerId) ?? 0;
  if (Date.now() - last < 60_000) return { ok: true }; // 이미 로그인 창이 열려 있음 — 중복 실행 방지
  loginInFlight.set(providerId, Date.now());
  try {
    const child = spawn(bin, spec.args, { detached: true, stdio: "ignore", env: { ...process.env, PATH: `${CLI_PATH_PREFIX}:${process.env.PATH}` } });
    child.unref();
    console.log(`[mybot] ${providerId} 재로그인 프로세스 시작 (pid ${child.pid})`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function resolveAuthUncached(def: ProviderDef): ResolvedAuth {
  // 0. 커스텀 프로바이더 저장 키
  if (def.apiKey) return { apiKey: def.apiKey, source: "설정" };
  // 1. 수동 입력 키 (최우선 — 사용자가 명시한 값)
  const manual = manualKey(def.id);
  if (manual) return { apiKey: manual, source: "설정" };

  if (def.authType === "cli") {
    // CLI 로그인 — 실행 파일 존재 여부만 확인 (자격증명은 CLI가 자체 관리)
    return findCli(def.cmd!) ? { source: "cli" } : {};
  }

  if (def.authType === "oauth") {
    if (def.id === "openai") {
      const c = readJson(CODEX_AUTH);
      if (c?.tokens?.access_token) {
        const exp = jwtExp(c.tokens.access_token);
        const expired = !!(exp && exp < Date.now());
        if (expired) void refreshCodexAuth(); // 만료 토큰을 미리 갱신해 다음 호출이 401로 죽지 않게 한다
        return { accessToken: c.tokens.access_token, accountId: c.tokens.account_id, source: "codex", expired };
      }
      const oc = readJson(OPENCODE_AUTH)?.openai;
      if (oc?.access) return { accessToken: oc.access, accountId: oc.accountId, source: "opencode", expired: !!(oc.expires && oc.expires < Date.now()) };
      return {};
    }
    if (def.id === "gemini") {
      const g = readJson(GEMINI_AUTH);
      if (g?.access_token) {
        const expired = !!(g.expiry_date && g.expiry_date < Date.now());
        if (expired) void refreshGeminiAuth();
        return { accessToken: g.access_token, source: "gemini", expired };
      }
      const oc = readJson(OPENCODE_AUTH)?.google;
      if (oc?.access) return { accessToken: oc.access, source: "opencode", expired: !!(oc.expires && oc.expires < Date.now()) };
      return {};
    }
    return {};
  }

  if (def.authType === "none") return { source: "로컬" };

  // 2. opencode auth.json — <id> / <id>-coding-plan 항목의 api 키
  const oc = readJson(OPENCODE_AUTH);
  for (const k of def.ocKeys ?? [def.id]) {
    const ent = oc?.[k];
    if (ent?.type === "api" && ent.key) return { apiKey: ent.key, source: "opencode" };
  }
  // 3. airoute 키체인
  if (def.keychain) {
    const k = keychainGet(def.keychain);
    if (k) return { apiKey: k, source: "keychain" };
  }
  // 4. 환경변수
  if (def.env && process.env[def.env]) return { apiKey: process.env[def.env], source: "env" };
  return {};
}

// 사용자 등록 커스텀 프로바이더 (OpenAI 호환 엔드포인트)
export function customProviders(): ProviderDef[] {
  try {
    const list = JSON.parse(getSetting("custom_providers") ?? "[]") as any[];
    return list.map((p) => ({
      id: p.id, name: p.name || p.id, kind: "openai" as const, baseUrl: p.baseUrl,
      authType: p.apiKey ? "apikey" as const : "none" as const, authLabel: p.apiKey ? "API 키" : "키 불필요",
      models: Array.isArray(p.models) ? p.models : undefined, custom: true, apiKey: p.apiKey || undefined,
    }));
  } catch { return []; }
}

export function allProviders(): ProviderDef[] {
  return [...PROVIDER_PRESETS, ...customProviders()];
}

export function findProvider(id: string): ProviderDef | undefined {
  return allProviders().find((p) => p.id === id);
}

export function providerEnabled(id: string): boolean {
  try { return JSON.parse(getSetting("provider_disabled") ?? "[]").includes(id) === false; } catch { return true; }
}
export function setProviderEnabled(id: string, on: boolean) {
  let list: string[] = [];
  try { list = JSON.parse(getSetting("provider_disabled") ?? "[]"); } catch {}
  setSetting("provider_disabled", JSON.stringify(on ? list.filter((x) => x !== id) : [...new Set([...list, id])]));
}
