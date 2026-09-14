import { Hono } from "hono";
import { getEndpoints, listRemoteModels, guessCapabilities, saveEndpoints, type Endpoint } from "../providers";

const VIRTUAL = new Set(["main", "fast", "subagent", "team", "plan", "design", "code", "review", "critique"]);

export const modelsRoute = new Hono()
  .get("/", async (c) => {
    const endpoints = getEndpoints();
    const all: any[] = [];
    await Promise.all(
      endpoints.map(async (ep) => {
        const models = await listRemoteModels(ep);
        for (const m of models) {
          const caps = guessCapabilities(m.id);
          all.push({
            id: ep.id === "airoute" ? m.id : `ep_${ep.id}/${m.id}`,
            label: m.label,
            provider: ep.id,
            providerName: ep.name,
            virtual: ep.id === "airoute" && VIRTUAL.has(m.id),
            ...caps,
          });
        }
      }),
    );
    all.sort((a, b) => Number(b.virtual) - Number(a.virtual) || a.label.localeCompare(b.label));
    return c.json({ models: all, endpoints: endpoints.map((e) => ({ id: e.id, name: e.name, baseUrl: e.baseUrl, builtin: !!e.builtin, hasKey: !!e.apiKey })) });
  })
  .post("/endpoints", async (c) => {
    const body = (await c.req.json()) as Partial<Endpoint>;
    if (!body.id || !body.baseUrl) return c.json({ error: "id와 baseUrl 필요" }, 400);
    const endpoints = getEndpoints().filter((e) => !e.builtin);
    const i = endpoints.findIndex((e) => e.id === body.id);
    const ep = { id: body.id, name: body.name || body.id, baseUrl: body.baseUrl, apiKey: body.apiKey, builtin: false };
    if (i >= 0) endpoints[i] = ep;
    else endpoints.push(ep);
    saveEndpoints(endpoints);
    return c.json({ ok: true });
  })
  .delete("/endpoints/:id", async (c) => {
    const endpoints = getEndpoints().filter((e) => !e.builtin && e.id !== c.req.param("id"));
    saveEndpoints(endpoints);
    return c.json({ ok: true });
  });
