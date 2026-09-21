import { Hono } from "hono";
import { db, getSetting, setSetting } from "../db";

const KNOWN = ["system_prompt", "search_provider", "searxng_url", "tavily_key", "brave_key", "exa_key", "jina_key", "image_endpoint", "image_key", "image_model", "vision_model", "memory_enabled", "access_code", "default_model",
  "fallback_chain", "run_deadline_sec", "tool_rounds", "delegate_cap_sec", "run_total_cap_sec", "agent_cap_total",
  "notify_telegram", "telegram_bot_token", "telegram_chat_id", "telegram_listen",
  "notify_email", "smtp_host", "smtp_port", "smtp_user", "smtp_pass", "smtp_from", "email_to",
  "imap_host", "imap_port", "imap_user", "imap_pass", "imap_tls", "mcp_servers", "memory_archive_days",
  "evolve_auto", "evolve_hour"];

// 비밀값 키 — GET에서는 마스킹해 반환 (UI는 "설정됨" 상태만 알면 되고 원문은 볼 필요 없음)
const SECRET = (k: string) => /(_key|_pass)$/.test(k) || k === "access_code" || k === "telegram_bot_token";
const mask = (v: string) => (v.length <= 4 ? "••••" : `••••${v.slice(-4)}`);

export const settingsRoute = new Hono()
  .get("/", (c) => {
    const out: Record<string, string> = {};
    for (const k of KNOWN) {
      const v = getSetting(k) ?? "";
      out[k] = SECRET(k) && v ? mask(v) : v;
    }
    const memories = db.prepare("SELECT * FROM memories ORDER BY created_at DESC").all();
    const personas = db.prepare("SELECT * FROM personas ORDER BY created_at").all();
    return c.json({ settings: out, memories, personas });
  })
  .post("/", async (c) => {
    const body = await c.req.json();
    for (const [k, v] of Object.entries(body)) {
      if (!KNOWN.includes(k) || typeof v !== "string") continue;
      // 마스킹된 값이 그대로 돌아오면 "변경 없음" — 덮어쓰지 않음
      if (SECRET(k)) { const cur = getSetting(k) ?? ""; if (cur && v === mask(cur)) continue; }
      setSetting(k, v);
    }
    // 비전 모델 선택 캐시 무효화 — 설정을 바꾸면 즉시 반영되게
    if ("vision_model" in body || "default_model" in body) {
      const { clearVisionPick } = await import("../browser");
      clearVisionPick();
    }
    return c.json({ ok: true });
  })
  .delete("/memories/:id", (c) => {
    db.prepare("DELETE FROM memories WHERE id = ?").run(c.req.param("id"));
    return c.json({ ok: true });
  });
