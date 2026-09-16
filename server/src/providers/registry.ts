// 프로바이더 레지스트리 — 프록시 없이 각 AI 서비스에 직접 연결
// 자격증명은 로컬 저장소에서 자동 해석: 설정값 → opencode auth.json → codex/gemini OAuth 파일 → airoute 키체인 → 환경변수
import { getSetting, setSetting } from "../db";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
    id: "zai", name: "Z.AI GLM", kind: "openai", baseUrl: "https://api.z.ai/api/paas/v4",
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
        const exp = Number(c.tokens?.expires_at ?? c.last_refresh ?? 0) || undefined;
        return { accessToken: c.tokens.access_token, accountId: c.tokens.account_id, source: "codex", expired: !!(exp && exp < Date.now()) };
      }
      const oc = readJson(OPENCODE_AUTH)?.openai;
      if (oc?.access) return { accessToken: oc.access, accountId: oc.accountId, source: "opencode", expired: !!(oc.expires && oc.expires < Date.now()) };
      return {};
    }
    if (def.id === "gemini") {
      const g = readJson(GEMINI_AUTH);
      if (g?.access_token) return { accessToken: g.access_token, source: "gemini", expired: !!(g.expiry_date && g.expiry_date < Date.now()) };
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
