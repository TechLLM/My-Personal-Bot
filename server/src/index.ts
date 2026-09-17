import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { join } from "node:path";
import { db, getSetting, now } from "./db";
import { modelsRoute } from "./routes/models";
import { chatRoute } from "./routes/chat";
import { settingsRoute } from "./routes/settings";
import { filesRoute } from "./routes/files";
import { personasRoute, seedPersonas } from "./routes/personas";
import { workspacesRoute, skillsRoute } from "./routes/workspaces";
import { routinesRoute, startScheduler } from "./routines";
import { agentsRoute, teamRoute, ensureBossAgent } from "./team";
import { browserRoute, sitesRoute } from "./browser";
import { notifyRoute, startTelegramBot } from "./notify";
import { approvalsRoute } from "./approvals";
import { groupsRoute } from "./routes/groups";
import { startMaintenance } from "./maintenance";

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
api.route("/sites", sitesRoute);
api.route("/team", teamRoute);
api.route("/notify", notifyRoute);
api.route("/approvals", approvalsRoute);
api.route("/groups", groupsRoute);
seedPersonas();
// 구형 평문 비밀번호를 AES-256-GCM으로 일괄 암호화 (1회성 마이그레이션)
{
  const { encryptSecret } = await import("./crypto");
  const legacy = db.prepare("SELECT id, password FROM site_logins WHERE password NOT LIKE 'enc:v1:%'").all() as { id: string; password: string }[];
  for (const row of legacy) db.prepare("UPDATE site_logins SET password = ? WHERE id = ?").run(encryptSecret(row.password), row.id);
  if (legacy.length) console.log(`[mybot] 사이트 계정 비밀번호 ${legacy.length}건 암호화 완료`);
}
// 대장 봇 시드 + 기존 대화를 대장에게 귀속 (봇 중심 모델)
const boss = ensureBossAgent();
// 그룹 대화는 agent_id가 원래 NULL — 대장 귀속에서 제외해야 그룹 대화가 대장 대화로 겹쳐 보이지 않음
db.prepare("UPDATE conversations SET agent_id = ? WHERE agent_id IS NULL AND group_id IS NULL").run(boss.id);
// 서버 재시작으로 끊긴 실행 — A5: error로 죽이지 말고 재개한다. 같은 run id에 이어 기록되고
// 재개 횟수(resume_count)가 3회를 넘으면 그때만 error로 확정한다.
const orphanRuns = db.prepare("SELECT * FROM agent_runs WHERE status = 'running'").all() as any[];
for (const r of orphanRuns) {
  if ((r.resume_count ?? 0) < 3) {
    db.prepare("UPDATE agent_runs SET status = 'resumable' WHERE id = ?").run(r.id); // 상태 전이로 중복 재개 방지
    import("./team").then(({ resumeAgentRun }) => resumeAgentRun(r)).catch((e) => console.error(`[mybot] 실행 재개 실패 (${r.id}):`, (e as Error).message));
  } else {
    db.prepare("UPDATE agent_runs SET status = 'error', result = COALESCE(result, '서버 재시작으로 작업이 중단됨 — 재개 3회 초과'), finished_at = ? WHERE id = ?").run(now(), r.id);
  }
}
// 재시작으로 끊긴 대화 스트림의 빈 assistant 자리표시 — 빈 말풍선으로 남지 않게
db.prepare("UPDATE messages SET content = '⚠️ 서버 재시작으로 중단된 작업입니다.' WHERE role = 'assistant' AND trim(content) = ''").run();
// 같은 이유로 처리 중이던 봇 간 메시지도 정리 — 'processing' 상태로 영원히 멈추지 않게
db.prepare("UPDATE agent_messages SET status = 'failed', reply = '서버 재시작으로 처리 중단', done_at = ? WHERE status = 'processing'").run(now());
// 인계 대기 중이던 테이크오버도 재시작으로 headed 창이 닫혔으므로 정리 — 프론트에 영원히 뜨지 않게
db.prepare("UPDATE handoff_requests SET status = 'timeout', resolved_at = ? WHERE status = 'pending'").run(now());
// 재시작 사이에 디스패치가 끊긴 pending 메시지 재배달 — pending은 아직 시작 안 한 큐이므로 전달해야 함
for (const m of db.prepare("SELECT id FROM agent_messages WHERE status = 'pending'").all() as { id: string }[]) {
  import("./approvals").then(({ dispatchAgentMessage }) => dispatchAgentMessage(m.id)).catch(() => {});
}
startScheduler();
startTelegramBot();
startMaintenance(); // 보존 정리 — 실행이력·승인·브라우저 캐시 (업무지침서 C16)

app.route("/api", api);

const dist = join(import.meta.dir, "..", "..", "web", "dist");
// html 응답은 항상 재검증 — 해시된 번들은 변경 시 새 파일명이라 캐시돼도 안전
const noCacheHtml = (path: string, c: any) => {
  if (path.endsWith(".html")) c.header("Cache-Control", "no-cache");
};
app.use("/*", serveStatic({ root: dist, onFound: noCacheHtml }));
app.get("/*", async (c) => {
  const html = await Bun.file(join(dist, "index.html")).text();
  return c.html(html, 200, { "Cache-Control": "no-cache" });
});

console.log(`[mybot] 시작 중 — http://127.0.0.1:${PORT}`); // 실제 바인딩은 아래 default export 이후

// HTTPS 리스너 — server/.certs에 mkcert 인증서가 있으면 함께 연다 (HTTP도 그대로 유지)
// 인증서 생성: bun scripts/gen-cert.ts / 브라우저 신뢰: 각 기기에 mkcert 루트 CA 설치
const certDir = join(import.meta.dir, "..", ".certs");
const [certFile, keyFile] = [join(certDir, "cert.pem"), join(certDir, "key.pem")];
if (await Bun.file(certFile).exists() && await Bun.file(keyFile).exists()) {
  const httpsPort = Number(process.env.MYBOT_HTTPS_PORT ?? 5443);
  // HTTPS는 부가 기능이다 — 포트 충돌로 본체 HTTP 서버까지 죽으면 안 된다.
  // 실측 사고(2026-09-16): 이미 다른 인스턴스가 5443을 잡고 있어 EADDRINUSE가 나자
  // 프로세스 전체가 exit 1로 종료됐고, 재시작이 조용히 실패해 구버전이 계속 떠 있었다.
  try {
    Bun.serve({
      port: httpsPort,
      fetch: app.fetch,
      idleTimeout: 255,
      tls: { cert: Bun.file(certFile), key: Bun.file(keyFile) },
    });
    console.log(`[mybot] listening on https://0.0.0.0:${httpsPort}`);
  } catch (e) {
    console.error(`[mybot] HTTPS(${httpsPort}) 시작 실패 — HTTP만 계속합니다. 이미 다른 MyBot 인스턴스가 떠 있는지 확인하세요: ${(e as Error).message}`);
  }
} else {
  console.log("[mybot] HTTPS 비활성 — 인증서가 없습니다 (생성: bun scripts/gen-cert.ts)");
}

export default { port: PORT, fetch: app.fetch, idleTimeout: 255 };
