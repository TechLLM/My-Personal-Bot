import { Hono } from "hono";
import { getEndpoints, listRemoteModels, guessCapabilities, endpointFor } from "../providers";
import {
  allProviders, findProvider, resolveAuth, providerEnabled, setProviderEnabled,
  setManualKey, clearAuthCache, customProviders, refreshCodexAuth, refreshGeminiAuth, startProviderLogin, type ProviderDef,
} from "../providers/registry";
import { getSetting, setSetting } from "../db";

// 프로바이더 카드용 상태 — 키 원문은 절대 반환하지 않음
function providerCard(def: ProviderDef) {
  const auth = resolveAuth(def);
  const authed = !!(auth.apiKey || auth.accessToken || auth.source === "cli" || auth.source === "로컬");
  return {
    id: def.id,
    name: def.name,
    kind: def.kind,
    authType: def.authType,
    authLabel: def.authLabel,
    doc: def.doc,
    custom: !!def.custom,
    enabled: providerEnabled(def.id),
    authed,
    source: auth.source ?? null,
    expired: !!auth.expired,
    hasManualKey: !!def.apiKey || undefined,
    baseUrl: def.custom ? def.baseUrl : undefined,
    staticModels: def.models ?? [],
  };
}

export const modelsRoute = new Hono()
  // 프로바이더 카드 목록 (설정 화면)
  .get("/providers", (c) => c.json({ providers: allProviders().map(providerCard) }))

  // 모델 목록 (선택기용) — 활성+인증된 프로바이더만 (미인증은 선택해도 호출이 실패하므로 제외)
  .get("/", async (c) => {
    const all: any[] = [];
    const authedEps = getEndpoints().filter((ep) => {
      const def = findProvider(ep.id);
      const auth = def ? resolveAuth(def) : {};
      return !!(auth.apiKey || auth.accessToken || auth.source === "cli" || auth.source === "로컬");
    });
    await Promise.all(
      authedEps.map(async (ep) => {
        const models = await listRemoteModels(ep);
        for (const m of models) {
          const caps = guessCapabilities(m.id);
          all.push({
            id: `${ep.id}/${m.id}`,
            label: m.label,
            provider: ep.id,
            providerName: ep.name,
            tools: ep.caps?.tools !== false,
            ...caps,
          });
        }
      }),
    );
    all.sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label));
    return c.json({ models: all });
  })

  // 연결 테스트 — 실제 호출로 확인
  .post("/providers/:id/test", async (c) => {
    const def = findProvider(c.req.param("id"));
    if (!def) return c.json({ ok: false, error: "알 수 없는 프로바이더" }, 404);
    const ep = endpointFor(def);
    const t0 = Date.now();
    try {
      if (ep.kind === "cli") {
        const auth = resolveAuth(def);
        if (auth.source !== "cli") return c.json({ ok: false, error: `${def.cmd} CLI가 설치돼 있지 않습니다` });
        return c.json({ ok: true, ms: Date.now() - t0, detail: `${def.cmd} 실행 파일 확인됨 — 로그인은 CLI 자체 세션 사용` });
      }
      const { chatOnce } = await import("../providers/openaiCompat");
      const res = await chatOnce(ep, def.models?.[0] ?? "gpt-5", [{ role: "user", content: "hi" }], { signal: AbortSignal.timeout(30_000), reasoningEffort: "low" });
      return c.json({ ok: true, ms: Date.now() - t0, detail: `응답 수신 (${(res.content ?? "").length}자)` });
    } catch (e) {
      return c.json({ ok: false, ms: Date.now() - t0, error: (e as Error).message.slice(0, 300) });
    }
  })

  // API 키 수동 등록/삭제
  .post("/providers/:id/key", async (c) => {
    const { key } = (await c.req.json()) as { key?: string };
    const id = c.req.param("id");
    if (!findProvider(id)) return c.json({ error: "알 수 없는 프로바이더" }, 404);
    setManualKey(id, key?.trim() || null);
    clearAuthCache();
    return c.json({ ok: true });
  })

  // 재인증 — OAuth는 토큰 갱신을 먼저 시도(사용자 작업 없이 복구), 실패 시 해당 CLI의 로그인 프로세스를 연다
  .post("/providers/:id/reauth", async (c) => {
    const id = c.req.param("id");
    const def = findProvider(id);
    if (!def) return c.json({ ok: false, error: "알 수 없는 프로바이더" }, 404);
    if (def.authType === "oauth") {
      const fresh = def.id === "openai" ? await refreshCodexAuth()
        : def.id === "gemini" ? await refreshGeminiAuth()
        : null;
      if (fresh) return c.json({ ok: true, method: "refresh", detail: "토큰을 자동으로 갱신했습니다" });
      if (def.id === "openai") {
        const r = startProviderLogin("openai");
        return r.ok
          ? c.json({ ok: true, method: "login", detail: "codex 로그인이 시작됐습니다 — 열린 브라우저에서 로그인을 완료하세요. 완료되면 자동으로 연결됩니다." })
          : c.json({ ok: false, error: r.error });
      }
      return c.json({ ok: false, error: "자동 갱신에 실패했습니다 — 터미널에서 gemini를 실행해 /auth로 다시 로그인하세요" });
    }
    if (def.authType === "cli") {
      const r = startProviderLogin(def.id);
      return r.ok
        ? c.json({ ok: true, method: "login", detail: `${def.cmd} 로그인이 시작됐습니다 — 열린 창에서 로그인을 완료하세요.` })
        : c.json({ ok: false, error: r.error });
    }
    if (def.authType === "apikey") return c.json({ ok: false, error: "API 키 프로바이더입니다 — 키 입력으로 갱신하세요", needsKey: true });
    return c.json({ ok: false, error: "인증이 필요 없는 프로바이더입니다" });
  })

  // 활성/비활성
  .post("/providers/:id/toggle", (c) => {
    const id = c.req.param("id");
    if (!findProvider(id)) return c.json({ error: "알 수 없는 프로바이더" }, 404);
    setProviderEnabled(id, !providerEnabled(id));
    return c.json({ ok: true, enabled: providerEnabled(id) });
  })

  // 커스텀 프로바이더 등록 (OpenAI 호환 엔드포인트)
  .post("/providers/custom", async (c) => {
    const body = (await c.req.json()) as { id?: string; name?: string; baseUrl?: string; apiKey?: string; models?: string[] };
    const id = (body.id ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    if (!id || !body.baseUrl?.trim()) return c.json({ error: "id와 baseUrl이 필요합니다" }, 400);
    if (findProvider(id) && !customProviders().some((p) => p.id === id)) return c.json({ error: "이미 있는 프로바이더 id입니다" }, 409);
    let list: any[] = [];
    try { list = JSON.parse(getSetting("custom_providers") ?? "[]"); } catch {}
    const models = Array.isArray(body.models) ? body.models.map((m) => String(m).trim()).filter(Boolean) : undefined;
    const ent = { id, name: body.name?.trim() || id, baseUrl: body.baseUrl.trim().replace(/\/$/, ""), apiKey: body.apiKey?.trim() || undefined, models };
    const i = list.findIndex((p) => p.id === id);
    if (i >= 0) list[i] = { ...list[i], ...ent, apiKey: body.apiKey === undefined ? list[i].apiKey : ent.apiKey };
    else list.push(ent);
    setSetting("custom_providers", JSON.stringify(list));
    clearAuthCache();
    return c.json({ ok: true });
  })

  .delete("/providers/custom/:id", (c) => {
    const id = c.req.param("id");
    let list: any[] = [];
    try { list = JSON.parse(getSetting("custom_providers") ?? "[]"); } catch {}
    setSetting("custom_providers", JSON.stringify(list.filter((p) => p.id !== id)));
    clearAuthCache();
    return c.json({ ok: true });
  });
