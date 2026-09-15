import { Hono } from "hono";
import { db, getSetting, setSetting } from "../db";

const KNOWN = ["system_prompt", "search_provider", "searxng_url", "tavily_key", "brave_key", "exa_key", "jina_key", "image_endpoint", "image_key", "image_model", "memory_enabled", "access_code", "default_model",
  "notify_telegram", "telegram_bot_token", "telegram_chat_id", "telegram_listen",
  "notify_email", "smtp_host", "smtp_port", "smtp_user", "smtp_pass", "smtp_from", "email_to"];

export const settingsRoute = new Hono()
  .get("/", (c) => {
    const out: Record<string, string> = {};
    for (const k of KNOWN) out[k] = getSetting(k) ?? "";
    const memories = db.prepare("SELECT * FROM memories ORDER BY created_at DESC").all();
    const personas = db.prepare("SELECT * FROM personas ORDER BY created_at").all();
    return c.json({ settings: out, memories, personas });
  })
  .post("/", async (c) => {
    const body = await c.req.json();
    for (const [k, v] of Object.entries(body)) {
      if (KNOWN.includes(k) && typeof v === "string") setSetting(k, v);
    }
    return c.json({ ok: true });
  })
  .delete("/memories/:id", (c) => {
    db.prepare("DELETE FROM memories WHERE id = ?").run(c.req.param("id"));
    return c.json({ ok: true });
  });
