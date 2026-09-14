import { getSetting, setSetting } from "../db";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface Endpoint {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  builtin?: boolean;
}

const AIRouteConfigPath = join(process.env.HOME ?? "~", ".config", "airoute", "config.json");

function airouteToken(): string | undefined {
  try {
    if (!existsSync(AIRouteConfigPath)) return undefined;
    const cfg = JSON.parse(readFileSync(AIRouteConfigPath, "utf8"));
    return cfg.token;
  } catch {
    return undefined;
  }
}

export function getEndpoints(): Endpoint[] {
  const list: Endpoint[] = [];
  list.push({
    id: "airoute",
    name: "airoute (로컬 프록시)",
    baseUrl: "http://127.0.0.1:11441/v1",
    apiKey: airouteToken(),
    builtin: true,
  });
  const extra = getSetting("endpoints");
  if (extra) {
    try {
      for (const e of JSON.parse(extra)) list.push({ ...e, builtin: false });
    } catch {}
  }
  return list;
}

export function saveEndpoints(endpoints: Endpoint[]) {
  setSetting("endpoints", JSON.stringify(endpoints.filter((e) => !e.builtin)));
}

export interface Resolved {
  endpoint: Endpoint;
  model: string;
}

// modelId 형식: "ep_<endpointId>/<model>" 또는 airoute 기본 "<model>"
export function resolveModel(modelId: string): Resolved {
  const endpoints = getEndpoints();
  if (modelId.startsWith("ep_")) {
    const sep = modelId.indexOf("/");
    const epId = modelId.slice(3, sep);
    const model = modelId.slice(sep + 1);
    const endpoint = endpoints.find((e) => e.id === epId);
    if (!endpoint) throw new Error(`알 수 없는 엔드포인트: ${epId}`);
    return { endpoint, model };
  }
  const endpoint = endpoints.find((e) => e.id === "airoute")!;
  return { endpoint, model: modelId };
}

function globMatch(s: string, pat: string): boolean {
  const re = new RegExp("^" + pat.split("*").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
  return re.test(s);
}

// airoute 별칭(main/fast/subagent…) → 실제 라우팅 대상("openai/gpt-6-astra@high" 등)
export function modelLabel(modelId: string): string {
  if (!modelId || modelId.startsWith("ep_")) return modelId;
  try {
    if (!existsSync(AIRouteConfigPath)) return modelId;
    const cfg = JSON.parse(readFileSync(AIRouteConfigPath, "utf8"));
    const routes = cfg.routes ?? {};
    let m = modelId;
    for (const rule of routes.rules ?? []) {
      const pats = String(rule.match?.model ?? "").split("|").filter(Boolean);
      if (pats.some((p) => globMatch(m, p))) { m = rule.route; break; }
    }
    if (routes[m]) m = routes[m];
    return m;
  } catch {
    return modelId;
  }
}

export async function listRemoteModels(endpoint: Endpoint): Promise<{ id: string; label: string }[]> {
  try {
    const res = await fetch(`${endpoint.baseUrl}/models`, {
      headers: endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: { id: string }[] };
    return (data.data ?? []).map((m) => ({ id: m.id, label: m.id }));
  } catch {
    return [];
  }
}

// 모델 이름 패턴으로 capability 추정 (airoute 카탈로그 메타 없을 때 폴백)
export function guessCapabilities(id: string): { vision: boolean; reasoning: boolean; image: boolean } {
  const s = id.toLowerCase();
  const vision = /(vision|vl|4o|4v|gemini|claude-(3|4|opus|sonnet|fable)|gpt-4|gpt-5|gpt-6|pixtral|qwen.*(vl|vision)|llava|minicpm|internvl|glm-.*v|kimi)/.test(s);
  const reasoning = /(o1|o3|o4|r1|reasoning|think|deepseek.*r|qwq|fable|opus-4|sonnet-4|gpt-5|gpt-6|kimi-k|glm-5|pro$|ultra|max)/.test(s);
  const image = /(dall-e|image|flux|sdxl|stable-diffusion|imagen|banana)/.test(s);
  return { vision, reasoning, image };
}
