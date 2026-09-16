import { Hono } from "hono";
import { chromium, type BrowserContext, type Frame, type Page } from "playwright";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { db } from "./db";
import type { TeamAgentState } from "./team";

// ego(lite) 방식 증류: 별도 브라우저가 아니라 MyBot이 직접 구동하는 영속 Chromium.
// - headed(실제 창)로 실행해 headless 탐지 신호 제거
// - 프로필 디렉터리 영속 → 사용자가 한 번 로그인하면 봇이 세션 재사용
// - 봇별 탭(page) 격리 = ego의 "Space"에 해당

const PROFILE_DIR = join(import.meta.dir, "..", "data", "browser-profile");
mkdirSync(PROFILE_DIR, { recursive: true });

// 자동화 탐지 신호 제거 스크립트
const STEALTH_INIT = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
window.chrome = window.chrome || { runtime: {} };
const origQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
if (origQuery) {
  window.navigator.permissions.query = (p) =>
    p.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : origQuery(p);
}
`;

let ctx: BrowserContext | null = null;
let ctxHeadless = true;
let launching: Promise<BrowserContext> | null = null;

// 이전 서버 프로세스가 죽으며 남긴 Chromium이 프로필을 잡고 있으면 ProcessSingleton 오류 발생 —
// 해당 프로필을 쓰는 좀비 프로세스를 정리하고 Singleton 잠금 파일을 지운 뒤 재시도
async function cleanupProfileLock() {
  try { (await import("node:child_process")).execSync(`pkill -f "${PROFILE_DIR}" 2>/dev/null || true`); } catch {}
  const { unlinkSync } = await import("node:fs");
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"])
    try { unlinkSync(join(PROFILE_DIR, f)); } catch {}
  await new Promise((r) => setTimeout(r, 800));
}

function launchContext(headless: boolean): Promise<BrowserContext> {
  return chromium
    .launchPersistentContext(PROFILE_DIR, {
      headless,
      channel: "chromium",
      args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
      ignoreDefaultArgs: ["--enable-automation"],
      viewport: { width: 1440, height: 900 },
      locale: "ko-KR",
      timezoneId: "Asia/Seoul",
      acceptDownloads: true,
    });
}

// 봇 작업은 headless(창 없음, Chrome for Testing의 new headless = 실제 Chrome 지문에 근접),
// 수동 로그인만 headed로 잠시 전환. 프로필 잠금 때문에 동시 실행은 불가 — 모드 전환 시 재기동.
export async function getBrowser(headless = true): Promise<BrowserContext> {
  if (ctx && ctxHeadless === headless) return ctx;
  if (ctx) {
    try { await ctx.close(); } catch {}
    ctx = null;
    pages.clear();
  }
  if (launching) return launching;
  launching = launchContext(headless)
    .catch(async (e) => {
      if (!/ProcessSingleton|profile directory|SingletonLock/i.test((e as Error).message)) throw e;
      console.warn("[mybot] 브라우저 프로필 잠금 감지 — 좀비 프로세스 정리 후 재시도");
      await cleanupProfileLock();
      return launchContext(headless);
    })
    .then(async (c) => {
      await c.addInitScript(STEALTH_INIT);
      c.on("close", () => { ctx = null; pages.clear(); });
      ctx = c;
      ctxHeadless = headless;
      return c;
    })
    .finally(() => { launching = null; });
  return launching;
}

// 봇별 탭 (Space) 관리
const pages = new Map<string, Page>();

async function pageFor(key: string): Promise<Page> {
  const browser = await getBrowser(true);
  const existing = pages.get(key);
  if (existing && !existing.isClosed()) return existing;
  const page = await browser.newPage();
  pages.set(key, page);
  return page;
}

export async function closeAgentPage(key: string) {
  const p = pages.get(key);
  pages.delete(key);
  try { await p?.close(); } catch {}
}

// 이 프로세스가 ego lite에 연 Task Space (key = browserTool의 agentKey) — 종료 시 정리 대상
const egoSpaces = new Set<string>();

// 작업 종료 시 ego Task Space 정리 — 공간+탭을 닫아 사용자 브라우저에 mybot-* 공간이 남지 않게 함
export async function closeAgentEgoSpace(key: string) {
  if (!egoSpaces.delete(key)) return;
  const { egoCloseSpace } = await import("./ego");
  await egoCloseSpace(`mybot-${key}`).catch(() => {});
}

// 페이지를 텍스트로 요약 (LLM이 읽기 좋은 형태)
async function snapshot(page: Page): Promise<string> {
  const title = await page.title().catch(() => "");
  const url = page.url();
  const text = await page.evaluate(() => {
    const body = document.body;
    if (!body) return "";
    return body.innerText.replace(/\n{3,}/g, "\n\n");
  }).catch(() => "(읽기 실패)");
  const links = await page.evaluate(() =>
    [...document.querySelectorAll("a[href]")]
      .slice(0, 30)
      .map((a) => `[${(a.textContent ?? "").trim().slice(0, 60)}](${(a as HTMLAnchorElement).href})`)
      .filter((s) => !s.startsWith("[]("))
      .join("\n"),
  ).catch(() => "");
  return `URL: ${url}\n제목: ${title}\n\n${String(text).slice(0, 8000)}\n\n[링크]\n${links}`.trim();
}

// 봇이 쓰는 브라우저 도구
export async function browserTool(agentKey: string, name: string, args: Record<string, unknown>): Promise<string> {
  try {
    // ego lite 경유 — 사용자의 실제 로그인된 브라우저, 내장 브라우저를 띄우지 않음
    if (name === "ego_run") {
      const { egoAvailable, egoRun } = await import("./ego");
      if (!egoAvailable()) return "브라우저 오류: ego lite가 설치돼 있지 않습니다 — 내장 browser_* 도구를 사용하세요";
      const script = String(args.script ?? "");
      if (!script.trim()) return "오류: script 필요";
      egoSpaces.add(agentKey); // run 종료 시 closeAgentEgoSpace가 이 공간을 닫음
      return await egoRun(script, `mybot-${agentKey}`);
    }
    const page = await pageFor(agentKey);
    switch (name) {
      case "browser_open": {
        const url = String(args.url ?? "");
        if (!/^https?:\/\//.test(url)) return "오류: http(s) URL만 가능";
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(1500);
        return await snapshot(page);
      }
      case "browser_read":
        return await snapshot(page);
      case "browser_click": {
        const sel = String(args.selector ?? "");
        if (!sel) return "오류: selector 필요";
        await page.click(sel, { timeout: 8000 });
        await page.waitForTimeout(1200);
        return await snapshot(page);
      }
      case "browser_type": {
        const sel = String(args.selector ?? "");
        const text = String(args.text ?? "");
        if (!sel) return "오류: selector 필요";
        await page.fill(sel, text, { timeout: 8000 });
        if (args.enter) await page.press(sel, "Enter").catch(() => {});
        await page.waitForTimeout(800);
        return `입력 완료: ${sel}`;
      }
      case "browser_scroll": {
        const dy = args.direction === "up" ? -800 : 800;
        await page.mouse.wheel(0, dy);
        await page.waitForTimeout(800);
        return await snapshot(page);
      }
      case "browser_login": {
        // 설정에 등록된 계정으로 자동 로그인 — 비밀번호는 서버에만 있고 모델 컨텍스트로 안 나감
        const siteName = String(args.site ?? "");
        const site = db.prepare("SELECT * FROM site_logins WHERE name LIKE ? ESCAPE '\\'").get(`%${siteName.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) as any;
        if (!site) return `등록된 사이트 계정 없음: "${siteName}". request_credentials 도구로 사용자에게 계정 입력을 요청하거나, 설정 → 사이트 계정에서 먼저 등록하세요.`;
        await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(1500);
        // 로그인 폼 탐색 — iframe 안 폼도 지원 (그룹웨어 다수)
        let scope: Page | Frame = page;
        if (!(await page.locator('input[type="password"]').count().catch(() => 0))) {
          for (const f of page.frames()) {
            if (await f.locator('input[type="password"]').count().catch(() => 0)) { scope = f; break; }
          }
        }
        const pass = scope.locator('input[type="password"]').first();
        if (!(await pass.count().catch(() => 0))) {
          return `로그인 폼을 찾지 못했습니다 — 이미 로그인된 상태일 수 있습니다.\n\n${await snapshot(page)}`;
        }
        const userSels = ['input[type="email"]', 'input[name*="user" i]', 'input[name*="login" i]', 'input[name*="mail" i]', 'input[id*="user" i]', 'input[name*="id" i]', 'input[id*="id" i]', 'input[type="text"]'];
        for (const sel of userSels) {
          const f = scope.locator(sel).first();
          if (await f.count().catch(() => 0)) { await f.fill(site.username, { timeout: 5000 }).catch(() => {}); break; }
        }
        const { decryptSecret } = await import("./crypto");
        const password = decryptSecret(site.password);
        if (!password) return "브라우저 오류: 저장된 비밀번호를 복호화할 수 없습니다 — 계정을 다시 등록하세요";
        await pass.fill(password, { timeout: 5000 });
        const btn = scope.locator('button[type="submit"], input[type="submit"], button:has-text("로그인"), a:has-text("로그인"), button:has-text("Sign in"), button:has-text("Log in")').first();
        if (await btn.count().catch(() => 0)) await btn.click().catch(() => {});
        else await pass.press("Enter").catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(1500);
        const stillForm = await page.locator('input[type="password"]').count().catch(() => 0);
        return `${stillForm ? "로그인 폼이 아직 남아 있습니다 — 실패했거나 추가 인증이 필요할 수 있습니다." : "로그인 완료."}\n\n${await snapshot(page)}`;
      }
      case "browser_eval": {
        // 셀렉터 기반 도구로 안 되는 작업용 — 페이지 컨텍스트에서 임의 JS 실행
        const script = String(args.script ?? "");
        if (!script.trim()) return "오류: script 필요";
        const result = await page.evaluate(async (code) => {
          try { return { ok: true, value: await new Function(`return (async () => { ${code} })()`)() }; }
          catch (e) { return { ok: false, error: String(e) }; }
        }, script);
        if (!result.ok) return `실행 오류: ${result.error}`;
        const text = typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 1);
        return (text ?? "undefined").slice(0, 6000);
      }
      case "browser_look": {
        // 텍스트로 안 읽히는 화면(차트·캔버스·이미지 UI) — 스크린샷을 비전 모델이 설명
        const png = await page.screenshot({ type: "png" });
        const { resolveModel, defaultModelId } = await import("./providers");
        const { chatOnce } = await import("./providers/openaiCompat");
        const { endpoint, model } = resolveModel(defaultModelId());
        const q = String(args.question ?? "이 화면에 보이는 내용을 자세히 설명해줘. 텍스트로 읽히지 않는 요소(차트·캔버스·이미지·아이콘)도 포함하고, 읽기 좋게 정리해줘");
        const res = await chatOnce(endpoint, model, [
          { role: "user", content: [{ type: "text", text: q }, { type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } }] },
        ]);
        return `[화면 분석 — ${await page.title().catch(() => "")}]\n${res.content || "(설명 없음)"}`;
      }
      default:
        return `알 수 없는 도구: ${name}`;
    }
  } catch (e) {
    return `브라우저 오류: ${(e as Error).message}`;
  }
}

export const BROWSER_TOOLS = [
  { type: "function", function: { name: "browser_open", description: "브라우저로 URL을 열고 페이지 내용을 읽습니다. 로그인 필요 사이트도 저장된 세션으로 접근합니다.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
  { type: "function", function: { name: "browser_read", description: "현재 브라우저 페이지의 내용을 다시 읽습니다", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "browser_click", description: "CSS 선택자 또는 text=텍스트 로 요소를 클릭합니다", parameters: { type: "object", properties: { selector: { type: "string", description: "CSS 선택자 또는 'text=링크텍스트'" } }, required: ["selector"] } } },
  { type: "function", function: { name: "browser_type", description: "입력 필드에 텍스트를 입력합니다", parameters: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" }, enter: { type: "boolean", description: "입력 후 Enter" } }, required: ["selector", "text"] } } },
  { type: "function", function: { name: "browser_scroll", description: "페이지를 스크롤합니다", parameters: { type: "object", properties: { direction: { type: "string", enum: ["down", "up"] } } } } },
  { type: "function", function: { name: "browser_login", description: "설정에 등록된 사이트 계정으로 자동 로그인합니다 (회사 그룹웨어·사내 시스템 등). 로그인 후 browser_read/browser_click으로 정보를 가져오세요.", parameters: { type: "object", properties: { site: { type: "string", description: "설정에 등록한 사이트 이름" } }, required: ["site"] } } },
  { type: "function", function: { name: "browser_eval", description: "현재 페이지에서 임의 JavaScript를 실행하고 결과를 반환합니다 — 셀렉터 기반 도구로 안 되는 복잡한 조작·데이터 추출에 사용 (예: document.querySelectorAll('a').map(a=>a.href))", parameters: { type: "object", properties: { script: { type: "string", description: "페이지에서 실행할 JS 본문 (반환값이 결과로 옴)" } }, required: ["script"] } } },
  { type: "function", function: { name: "browser_look", description: "현재 페이지를 스크린샷하고 비전 모델이 화면을 설명합니다 — 텍스트로 안 읽히는 차트·캔버스·이미지 기반 UI를 읽을 때 사용", parameters: { type: "object", properties: { question: { type: "string", description: "화면에서 알고 싶은 것 (예: '결재 대기 문서 제목들을 알려줘')" } } } } },
  { type: "function", function: { name: "ego_run", description: "ego lite — 사용자의 실제 로그인된 브라우저에서 JavaScript를 실행합니다 (컴퓨트 유즈). 로그인 필요 사이트·복잡한 상호작용은 이 도구가 가장 강력합니다. script 안에서 쓸 수 있는 헬퍼: openOrReuseTab(url,{wait:true}), snapshotText()(요소를 [ref=N]으로 표시), click('@N' 또는 CSS), typeText(sel,text), fillInput(sel,text), pressKey('Enter'), scrollBy(픽셀), js('JS표현식'), captureScreenshot(), listTabs(), waitForElement(sel). 결과는 반드시 cliLog(...)로 출력하세요. 작업 공간은 자동으로 'mybot-{작업ID}' Space에서 실행됩니다.", parameters: { type: "object", properties: { script: { type: "string", description: "실행할 JS (top-level await 가능). 예: await openOrReuseTab('https://...', {wait:true}); cliLog(await snapshotText());" } }, required: ["script"] } } },
];

// 등록된 사이트 계정 CRUD — 비밀번호는 암호화 저장, 목록/조회에서 절대 반환하지 않음 (write-only)
export const sitesRoute = new Hono()
  .get("/", (c) => c.json({ sites: db.prepare("SELECT id, name, url, username, created_at FROM site_logins ORDER BY created_at").all() }))
  // 봇이 요청한 계정 입력 (팝업 대기 목록)
  .get("/requests", (c) => c.json({ requests: db.prepare("SELECT id, name, url, reason, created_at FROM credential_requests WHERE status = 'pending' ORDER BY created_at").all() }))
  .post("/requests/:id/dismiss", (c) => {
    db.prepare("UPDATE credential_requests SET status = 'dismissed' WHERE id = ?").run(c.req.param("id"));
    return c.json({ ok: true });
  })
  .post("/", async (c) => {
    const b = await c.req.json();
    if (!b.name || !b.url || !b.username || !b.password) return c.json({ error: "name/url/username/password 필요" }, 400);
    const { uid, now } = await import("./db");
    const { encryptSecret } = await import("./crypto");
    // 같은 이름의 계정이 있으면 갱신 — 재입력 시 중복 행이 쌓이지 않음
    const siteName = String(b.name).slice(0, 50);
    const existing = db.prepare("SELECT id FROM site_logins WHERE name = ?").get(siteName) as any;
    const id = existing?.id ?? uid();
    if (existing)
      db.prepare("UPDATE site_logins SET url = ?, username = ?, password = ? WHERE id = ?")
        .run(String(b.url), String(b.username), encryptSecret(String(b.password)), id);
    else
      db.prepare("INSERT INTO site_logins (id, name, url, username, password, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, siteName, String(b.url), String(b.username), encryptSecret(String(b.password)), now());
    // 봇 요청으로 온 입력이면 요청을 완료 처리하고 요청한 봇의 작업을 자동 재개
    // status='pending' 조건으로 원자 전이 — 이미 처리된 요청의 중복 제출이 재개를 다시 발화하지 않게
    if (b.request_id) {
      const flipped = db.prepare("UPDATE credential_requests SET status = 'done' WHERE id = ? AND status = 'pending'").run(String(b.request_id));
      const req = flipped.changes > 0 ? db.prepare("SELECT * FROM credential_requests WHERE id = ?").get(String(b.request_id)) as any : null;
      if (req?.agent_id) {
        const { getAgent, runAgent, agentSessionConvId, defaultModel } = await import("./team");
        const agent = getAgent(req.agent_id);
        if (agent) {
          const runId = uid();
          db.prepare("INSERT INTO agent_runs (id, agent_id, conversation_id, task, status, created_at) VALUES (?, ?, NULL, ?, 'running', ?)")
            .run(runId, agent.id, `[계정 입력됨] ${req.name} — 작업 자동 재개`, now());
          const state: TeamAgentState = {
            id: agent.id, runId, name: agent.name, avatar: agent.avatar ?? "🤖", role: agent.role_prompt,
            task: `사용자가 "${req.name}" 계정을 보안 팝업에 입력했습니다. 계정은 암호화되어 저장됐고 browser_login(site: "${req.name}")으로 로그인할 수 있습니다. 이어서 원래 업무를 진행하고 결과를 보고하세요.\n\n원래 작업: ${req.resume || req.reason || "(없음)"}`,
            model: agent.model ?? defaultModel(), status: "running", steps: 0, toolLog: [] as any[], depth: 0,
          };
          (async () => {
            await runAgent(state as any, agent, () => {}, AbortSignal.timeout(540_000));
            db.prepare("UPDATE agent_runs SET status = ?, result = ?, steps = ?, tool_log = ?, finished_at = ? WHERE id = ?")
              .run(state.status, state.result ?? null, state.steps, JSON.stringify(state.toolLog), now(), runId);
            const { appendToAgentSession } = await import("./routes/chat");
            const meta = JSON.stringify({ type: "tools", events: state.toolLog.map((l) => ({ type: "read", title: l.tool, url: "" })) });
            const { normalizeReport } = await import("./report");
            appendToAgentSession(agentSessionConvId(agent.id), `[계정 입력 완료 — 작업 자동 재개] ${req.name}`, await normalizeReport(agent.name, req.resume || req.name, state.result ?? "(결과 없음)"), agent.model, meta);
            const { notifyResult } = await import("./notify");
            notifyResult(`계정 입력됨 — ${agent.name} 작업 재개`, state.result ?? "(결과 없음)");
          })().catch((e) => console.error("[mybot] 계정 입력 후 재개 실패:", (e as Error).message));
        }
      }
    }
    return c.json({ site: db.prepare("SELECT id, name, url, username, created_at FROM site_logins WHERE id = ?").get(id) });
  })
  .delete("/:id", (c) => {
    db.prepare("DELETE FROM site_logins WHERE id = ?").run(c.req.param("id"));
    return c.json({ ok: true });
  });

export function browserRunning(): boolean {
  return ctx !== null;
}

// 수동 로그인용: 브라우저 창을 열어 사용자가 직접 로그인 (세션이 프로필에 저장됨)
export const browserRoute = new Hono()
  .get("/status", (c) => c.json({ running: browserRunning() }))
  .post("/open", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    try {
      const browser = await getBrowser(false); // 수동 로그인은 창이 보여야 하므로 headed
      const page = await browser.newPage();
      await page.goto(String(b.url ?? "about:blank"), { waitUntil: "domcontentloaded" }).catch(() => {});
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  })
  .post("/close", async (c) => {
    try { await ctx?.close(); } catch {}
    return c.json({ ok: true });
  });
