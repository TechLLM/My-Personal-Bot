import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { join } from "node:path";
import { getSetting } from "./db";
import { modelsRoute } from "./routes/models";
import { chatRoute } from "./routes/chat";
import { settingsRoute } from "./routes/settings";
import { filesRoute } from "./routes/files";
import { personasRoute, seedPersonas } from "./routes/personas";
import { workspacesRoute, skillsRoute } from "./routes/workspaces";
import { routinesRoute, startScheduler } from "./routines";
import { agentsRoute, teamRoute } from "./team";
import { browserRoute } from "./browser";
import { notifyRoute } from "./notify";

const PORT = Number(process.env.MYBOT_PORT ?? 5274);

const app = new Hono();
app.use("/api/*", cors());

// 접속 암호 설정 시 /api 전체 보호 (health 제외)
app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health") return next();
  const code = getSetting("access_code");
  if (!code) return next();
  const key = c.req.header("x-mybot-key") ?? c.req.query("key");
  if (key !== code) return c.json({ error: "unauthorized" }, 401);
  return next();
});

const api = new Hono();
api.get("/health", (c) => c.json({ ok: true, name: "mybot", ts: Date.now() }));
api.route("/models", modelsRoute);
api.route("/chat", chatRoute);
api.route("/settings", settingsRoute);
api.route("/files", filesRoute);
api.route("/personas", personasRoute);
api.route("/workspaces", workspacesRoute);
api.route("/skills", skillsRoute);
api.route("/routines", routinesRoute);
api.route("/agents", agentsRoute);
api.route("/browser", browserRoute);
api.route("/team", teamRoute);
api.route("/notify", notifyRoute);
seedPersonas();
startScheduler();

app.route("/api", api);

const dist = join(import.meta.dir, "..", "..", "web", "dist");
app.use("/*", serveStatic({ root: dist }));
app.get("/*", serveStatic({ path: join(dist, "index.html") }));

console.log(`[mybot] listening on http://127.0.0.1:${PORT}`);
export default { port: PORT, fetch: app.fetch, idleTimeout: 255 };
