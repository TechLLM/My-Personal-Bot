// 모델 해석 — "<providerId>/<model>" 형식으로 등록된 프로바이더에 직접 연결 (프록시 없음)
import { getSetting } from "../db";
import { allProviders, findProvider, resolveAuth, providerEnabled, findCli, dedupeAirouteModels, type ProviderDef, type ResolvedAuth } from "./registry";

export interface Endpoint {
  id: string;
  name: string;
  kind: "openai" | "responses" | "gemini" | "cli";
  baseUrl?: string;
  apiKey?: string;
  accessToken?: string;
  accountId?: string;
  cmd?: string;
  args?: string[];
  builtin?: boolean;
  caps?: { tools: boolean };  // cli 프로바이더는 function calling 미지원
}

// 프로바이더 + 자격증명 → 호출 가능한 엔드포인트
export function endpointFor(def: ProviderDef): Endpoint {
  const auth = resolveAuth(def);
  return {
    id: def.id,
    name: def.name,
    kind: def.kind,
    baseUrl: def.baseUrl,
    apiKey: auth.apiKey,
    accessToken: auth.accessToken,
    accountId: auth.accountId,
    cmd: def.cmd ? (findCli(def.cmd) ?? def.cmd) : undefined, // 절대 경로로 해석 — launchd PATH에 없어도 spawn 가능
    args: def.args,
    builtin: !def.custom,
    caps: { tools: def.kind !== "cli" }, // CLI 브릿지는 텍스트만 — 도구 호출 불가
  };
}

// 활성+인증된 프로바이더의 엔드포인트 목록 (모델 목록 조회용)
export function getEndpoints(): Endpoint[] {
  return allProviders().filter((p) => providerEnabled(p.id)).map(endpointFor);
}

export interface Resolved {
  endpoint: Endpoint;
  model: string;
}

// 과거 airoute 형식의 모델 id → 새 직접 연결 형식
const LEGACY_PROVIDER: Record<string, string> = { zhipu: "zai" };
const LEGACY_VIRTUAL = new Set(["main", "fast", "subagent", "team", "plan", "design", "code", "review", "critique"]);

function migrateId(modelId: string): string {
  let m = modelId.trim();
  if (m.startsWith("ep_")) { // 구 ep_<endpoint>/<model> 형식
    const sep = m.indexOf("/");
    if (sep > 3) m = `${m.slice(3, sep)}/${m.slice(sep + 1)}`;
  }
  const sep = m.indexOf("/");
  if (sep > 0) {
    const prov = m.slice(0, sep);
    if (LEGACY_PROVIDER[prov]) m = `${LEGACY_PROVIDER[prov]}${m.slice(sep)}`;
    else if (prov === "openai") {
      // 구 airoute id 호환: openai 직접 연결이 인증돼 있으면 그대로 사용.
      // 미인증인데 opencode-zen이 인증돼 있으면 같은 이름의 zen 모델로 대체
      const openaiDef = findProvider("openai");
      const zenDef = findProvider("opencode-zen");
      const ok = (d?: ProviderDef) => {
        if (!d || !providerEnabled(d.id)) return false;
        const a: ResolvedAuth = resolveAuth(d);
        return !!(a.apiKey || a.accessToken);
      };
      if (!ok(openaiDef) && ok(zenDef)) m = `opencode-zen${m.slice(sep)}`;
    }
  }
  return m;
}

// modelId 형식: "<providerId>/<model>" — 별칭·구형식은 마이그레이션, provider 없으면 기본 모델로 폴백
export function resolveModel(modelId: string): Resolved {
  let m = migrateId(modelId);
  const sep = m.indexOf("/");
  let providerId = sep > 0 ? m.slice(0, sep) : "";
  let model = sep > 0 ? m.slice(sep + 1) : m;

  if (!providerId || LEGACY_VIRTUAL.has(m) || !findProvider(providerId)) {
    // 별칭/알 수 없는 형식 → 기본 모델로 재해석
    const def = defaultModelId();
    const dsep = def.indexOf("/");
    providerId = def.slice(0, dsep);
    model = def.slice(dsep + 1);
  }

  const def = findProvider(providerId);
  if (!def) throw new Error(`알 수 없는 프로바이더: ${providerId}`);
  // 모델 id 대소문자 교정 — "minimax-m3"처럼 소문자로 써도 등록된 실제 id("MiniMax-M3")로 해석
  const known = def.models ?? [];
  const ci = known.find((k) => k.toLowerCase() === model.toLowerCase());
  if (ci) model = ci;
  return { endpoint: endpointFor(def), model };
}

// 기본 모델 — 설정값, 없으면 인증된 첫 프로바이더의 첫 모델
export function defaultModelId(): string {
  const configured = getSetting("default_model");
  if (configured) {
    const migrated = migrateId(configured);
    const sep = migrated.indexOf("/");
    if (sep > 0 && findProvider(migrated.slice(0, sep))) return migrated;
  }
  for (const p of allProviders()) {
    if (!providerEnabled(p.id)) continue;
    const auth = resolveAuth(p);
    if (auth.apiKey || auth.accessToken || auth.source === "cli" || auth.source === "로컬") {
      if (p.models?.length) return `${p.id}/${p.models[0]}`;
    }
  }
  return "opencode-zen/gpt-6-astra"; // 최종 폴백
}

// airoute 별칭(main/fast/subagent…)과 호환되던 표시 함수 — 이제 id를 그대로 보여줌
export function modelLabel(modelId: string): string {
  return migrateId(modelId || "") || modelId;
}

// A4 — 폴백 체인. 설정 fallback_chain은 "minimax/MiniMax-M3, zai/glm-5.3" 또는
// "minimax → zai" 처럼 쉼표·화살표로 구분된 목록. 프로바이더만 적으면 그 첫 모델을 쓴다.
// 비활성·자격증명 없는 항목은 건너뛴다. curId가 체인에 없으면 첫 항목을 반환한다.
export function nextInChain(curId: string): string | null {
  const chain = (getSetting("fallback_chain") ?? "").split(/[,;>\n→]+/).map((s) => s.trim()).filter(Boolean);
  if (!chain.length) return null;
  const expand = (c: string): string | null => {
    const pid = c.includes("/") ? c.split("/")[0] : c;
    const def = findProvider(pid);
    if (!def || !providerEnabled(def.id)) return null;
    const auth = resolveAuth(def);
    if (!auth.apiKey && !auth.accessToken && auth.source !== "cli" && auth.source !== "로컬") return null;
    if (!c.includes("/") && !def.models?.length) return null; // 모델 없는 프로바이더 항목은 건너뛴다
    return c.includes("/") ? c : `${pid}/${def.models![0]}`;
  };
  const cur = curId.toLowerCase();
  const idx = chain.findIndex((c) => cur === c.toLowerCase() || cur.startsWith(c.toLowerCase() + "/"));
  for (let i = idx === -1 ? 0 : idx + 1; i < chain.length; i++) {
    const e = expand(chain[i]);
    if (e && e.toLowerCase() !== cur) return e;
  }
  return null;
}

export async function listRemoteModels(endpoint: Endpoint): Promise<{ id: string; label: string }[]> {
  const def = findProvider(endpoint.id);
  // cli/oauth 프로바이더는 /models가 없음 — 정적 목록
  if (endpoint.kind === "cli" || endpoint.kind === "responses" || endpoint.kind === "gemini") {
    return (def?.models ?? []).map((id) => ({ id, label: id }));
  }
  try {
    const res = await fetch(`${endpoint.baseUrl}/models`, {
      headers: endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = (await res.json()) as { data?: { id: string }[] };
      const ids = (data.data ?? []).map((m) => ({ id: m.id, label: m.id }));
      if (ids.length) return endpoint.id === "airoute" ? dedupeAirouteModels(ids) : ids;
    }
  } catch {}
  return (def?.models ?? []).map((id) => ({ id, label: id })); // 실패 시 정적 목록
}

// 인증된 프로바이더가 실제로 보고하는 모델 id 전체 — 사용자가 고를 수 있는 유효 범위
export async function listAllModelIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  await Promise.all(
    getEndpoints().map(async (ep) => {
      for (const m of await listRemoteModels(ep)) ids.add(`${ep.id}/${m.id}`);
    }),
  );
  return ids;
}

// 모델 이름 패턴으로 capability 추정
export function guessCapabilities(id: string): { vision: boolean; reasoning: boolean; image: boolean } {
  const s = id.toLowerCase();
  const vision = /(vision|vl|4o|4v|gemini|claude-(3|4|opus|sonnet|fable)|gpt-4|gpt-5|gpt-6|pixtral|qwen.*(vl|vision)|llava|minicpm|internvl|glm-.*v|kimi)/.test(s);
  const reasoning = /(o1|o3|o4|r1|reasoning|think|deepseek.*r|qwq|fable|opus-4|sonnet-4|gpt-5|gpt-6|kimi-k|glm-5|pro$|ultra|max)/.test(s);
  const image = /(dall-e|image|flux|sdxl|stable-diffusion|imagen|banana)/.test(s);
  return { vision, reasoning, image };
}
