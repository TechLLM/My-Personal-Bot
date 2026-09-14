import { Hono } from "hono";
import { chromium, type BrowserContext, type Frame, type Page } from "playwright";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { db } from "./db";

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
  launching = chromium
    .launchPersistentContext(PROFILE_DIR, {
      headless,
      channel: "chromium",
      args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
      ignoreDefaultArgs: ["--enable-automation"],
      viewport: { width: 1440, height: 900 },
      locale: "ko-KR",
      timezoneId: "Asia/Seoul",
      acceptDownloads: true,
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
        const site = db.prepare("SELECT * FROM site_logins WHERE name LIKE ?").get(`%${siteName}%`) as any;
        if (!site) return `등록된 사이트 계정 없음: "${siteName}". 설정 → 사이트 계정에서 먼저 등록하세요.`;
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
        await pass.fill(site.password, { timeout: 5000 });
        const btn = scope.locator('button[type="submit"], input[type="submit"], button:has-text("로그인"), a:has-text("로그인"), button:has-text("Sign in"), button:has-text("Log in")').first();
        if (await btn.count().catch(() => 0)) await btn.click().catch(() => {});
        else await pass.press("Enter").catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(1500);
        const stillForm = await page.locator('input[type="password"]').count().catch(() => 0);
        return `${stillForm ? "로그인 폼이 아직 남아 있습니다 — 실패했거나 추가 인증이 필요할 수 있습니다." : "로그인 완료."}\n\n${await snapshot(page)}`;
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
];

// 등록된 사이트 계정 CRUD — 비밀번호는 목록/조회에서 절대 반환하지 않음 (write-only)
export const sitesRoute = new Hono()
  .get("/", (c) => c.json({ sites: db.prepare("SELECT id, name, url, username, created_at FROM site_logins ORDER BY created_at").all() }))
  .post("/", async (c) => {
    const b = await c.req.json();
    if (!b.name || !b.url || !b.username || !b.password) return c.json({ error: "name/url/username/password 필요" }, 400);
    const { uid, now } = await import("./db");
    const id = uid();
    db.prepare("INSERT INTO site_logins (id, name, url, username, password, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, String(b.name).slice(0, 50), String(b.url), String(b.username), String(b.password), now());
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
