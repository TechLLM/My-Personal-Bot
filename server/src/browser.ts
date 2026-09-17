import { Hono } from "hono";
import { chromium, type BrowserContext, type Frame, type Page } from "playwright";
import type { Endpoint } from "./providers";
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

// 봇별 탭(Space) 관리 — 값은 "탭 스택"이다.
// 그룹웨어는 문서를 target=_blank 새 창으로 여는 경우가 많은데, 예전 구현은 원래 페이지만
// 붙들고 있어 봇이 새 창을 전혀 보지 못했다 — "클릭은 됐는데 화면이 그대로"인 실패의 큰 몫.
// 이제 팝업이 열리면 스택에 쌓아 자동으로 따라가고, browser_back으로 이전 창에 돌아온다.
const pages = new Map<string, Page[]>();

function trackPopups(key: string, page: Page) {
  page.on("popup", (pop) => {
    const stack = pages.get(key);
    if (!stack) return;
    stack.push(pop);
    trackPopups(key, pop); // 팝업이 또 팝업을 열어도 따라간다
  });
  page.on("close", () => {
    const stack = pages.get(key);
    if (stack) pages.set(key, stack.filter((x) => x !== page));
  });
}

async function pageFor(key: string): Promise<Page> {
  const browser = await getBrowser(true);
  const alive = (pages.get(key) ?? []).filter((x) => !x.isClosed());
  if (alive.length) { pages.set(key, alive); return alive[alive.length - 1]; }
  const page = await browser.newPage();
  pages.set(key, [page]);
  trackPopups(key, page);
  return page;
}

export async function closeAgentPage(key: string) {
  const stack = pages.get(key) ?? [];
  pages.delete(key);
  for (const x of stack) { try { await x.close(); } catch {} }
}

// 이 프로세스가 ego lite에 연 Task Space (key = browserTool의 agentKey) — 종료 시 정리 대상
const egoSpaces = new Set<string>();

// 작업 종료 시 ego Task Space 정리 — 공간+탭을 닫아 사용자 브라우저에 mybot-* 공간이 남지 않게 함
export async function closeAgentEgoSpace(key: string) {
  if (!egoSpaces.delete(key)) return;
  const { egoCloseSpace } = await import("./ego");
  await egoCloseSpace(`mybot-${key}`).catch(() => {});
}

// ─── 참조 스냅샷 (업무지침서 A1/C1) ───
// 예전 snapshot()은 innerText와 링크 30개만 돌려줘서, 모델이 클릭할 요소의 CSS 셀렉터를
// "추측"해야 했다. 실측 결과 browser_click은 24회 중 12회(50%)가 셀렉터 불일치로 실패했고
// (전부 `waiting for locator('text=…')` 타임아웃), 모델은 셀렉터 도구를 포기하고
// browser_eval(생 JS)로 112회 우회했다 — 설계한 도구 세트가 실사용에서 버려진 것이다.
// 이제 조작 가능한 요소에 번호를 붙여 돌려주고, 모델은 "@12"처럼 번호로 지목한다.
const REF_ATTR = "data-mybot-ref";

// 페이지가 조용해질 때까지 대기 — 고정 waitForTimeout(1200~1500ms) 대체 (C2).
// 느린 그룹웨어에선 1.5초가 모자라 클릭이 빗나갔고, 빠른 페이지에선 그냥 낭비였다.
async function settle(page: Page, budgetMs = 6000): Promise<void> {
  const t0 = Date.now();
  await page.waitForLoadState("domcontentloaded", { timeout: budgetMs }).catch(() => {});
  // networkidle은 상시 폴링하는 그룹웨어에서 영영 오지 않으므로 짧게만 기다린다
  await page.waitForLoadState("networkidle", { timeout: Math.max(500, 2000 - (Date.now() - t0)) }).catch(() => {});
  // DOM 변화가 멎을 때까지 — SPA 렌더가 끝나기 전에 읽어서 "목록 0건"으로 오판하는 것을 막는다
  await page.evaluate(() => new Promise<void>((resolve) => {
    let quiet: ReturnType<typeof setTimeout> | null = null;
    let hard: ReturnType<typeof setTimeout> | null = null;
    let obs: MutationObserver | null = null;
    const finish = () => {
      if (quiet) clearTimeout(quiet);
      if (hard) clearTimeout(hard);
      obs?.disconnect();
      resolve();
    };
    obs = new MutationObserver(() => { if (quiet) clearTimeout(quiet); quiet = setTimeout(finish, 400); });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    quiet = setTimeout(finish, 400);
    hard = setTimeout(finish, 2500);
  })).catch(() => {});
}

interface FrameSnap { lines: string[]; next: number; modal: boolean; text: string; loading: boolean }

// 한 프레임의 조작 가능 요소를 수집하고 각 요소에 참조 번호를 심는다.
// 번호를 DOM 속성으로 남기므로 다음 호출에서 [data-mybot-ref="12"]로 정확히 다시 잡을 수 있다.
async function collectFrame(frame: Frame, start: number, room: number): Promise<FrameSnap> {
  return await frame.evaluate(({ start, room, attr }) => {
    const SEL = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="option"], [contenteditable="true"], [onclick]';
    const norm = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 70);
    // 가시성은 rect + computed style로 판정한다.
    // offsetParent는 position:fixed 요소에서 항상 null이라, 모달(대개 fixed)을 "숨김"으로 오판했다.
    const visible = (el: Element) => {
      const rr = el.getBoundingClientRect();
      if (rr.width < 3 || rr.height < 3) return false;
      const c = getComputedStyle(el);
      return !(c.visibility === "hidden" || c.display === "none" || Number(c.opacity) < 0.05);
    };
    const lines: string[] = [];
    let n = start;
    const vpH = window.innerHeight || 900;
    const vpW = window.innerWidth || 1440;
    let els: Element[] = [];
    try { els = Array.from(document.querySelectorAll(SEL)); } catch { els = []; }
    for (const el of els) {
      if (n - start >= room) break;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      const tag = el.tagName.toLowerCase();
      const any = el as any;
      const role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "input" ? (any.type || "input") : tag);
      let name = norm(el.getAttribute("aria-label") || any.title || any.alt);
      if (!name) name = norm((el as HTMLElement).innerText);
      if (!name) name = norm(el.getAttribute("placeholder") || el.getAttribute("name") || el.getAttribute("value"));
      if (!name && tag === "a") { try { name = norm(decodeURIComponent(String(any.href || "").split("/").filter(Boolean).pop() || "")); } catch {} }
      const bits: string[] = [];
      if (any.disabled) bits.push("비활성");
      if (any.checked) bits.push("체크됨");
      const val = typeof any.value === "string" ? norm(any.value) : "";
      if (val && (tag === "input" || tag === "textarea" || tag === "select")) bits.push(`값="${val}"`);
      const inView = r.top < vpH && r.bottom > 0 && r.left < vpW && r.right > 0;
      try { el.setAttribute(attr, String(n)); } catch { continue; }
      lines.push(`${inView ? "" : "· "}@${n} ${role} "${name || "(이름없음)"}"${bits.length ? ` [${bits.join(", ")}]` : ""}`);
      n++;
    }
    const dlg = document.querySelector('[role="dialog"], [aria-modal="true"], dialog[open]');
    const modal = !!(dlg && visible(dlg));
    const text = String(document.body ? document.body.innerText : "").replace(/\n{3,}/g, "\n\n").trim();
    // 아직 렌더 중인지 — 이걸 모르면 로딩 중 화면을 읽고 "목록 0건"으로 단정해 버린다.
    // 실측 실패 기록이 정확히 그 모양이었다(메일분석봇 "목록 미확보", IP신청봇 "목록 영역 초기화 안 됨").
    let spinner = false;
    try {
      spinner = Array.from(document.querySelectorAll('[aria-busy="true"], [role="progressbar"], .loading, .spinner, .is-loading'))
        .some((x) => visible(x));
    } catch {}
    const loading = document.readyState !== "complete" || spinner
      || /(?:불러오는|불러오고|로딩\s*중|로드\s*중|잠시만|Loading…|Loading\.\.\.)/i.test(text.slice(0, 1500));
    return { lines, next: n, modal, text, loading };
  }, { start, room, attr: REF_ATTR });
}

// 페이지 전체(메인 + iframe)를 모델이 읽을 형태로 요약.
// 렌더가 끝나기 전에 읽으면 "조작 가능 요소 없음"이 돌아가고, 모델은 그걸 "목록 0건"으로
// 보고해 버린다 — 실측 실패 기록(메일분석봇 "목록 미확보", IP신청봇 "목록 영역 초기화 안 됨")이
// 정확히 이 모양이었다. 그래서 비어 보이면 한 번만 더 기다렸다 다시 읽는다.
async function snapshot(page: Page, opts: { maxRefs?: number; textChars?: number } = {}): Promise<string> {
  const deadline = Date.now() + 6000; // 미완 화면을 기다리는 총예산
  let snap = await snapshotOnce(page, opts);
  let prevSig = "";
  // 고정 시간 대기는 항상 "조금 모자라거나 그냥 낭비"다. 대신 화면이 더 이상 변하지
  // 않을 때까지만 기다린다 — 두 번 연속 같은 결과면 더 기다려도 소용없으니 멈춘다.
  while (snap.incomplete && Date.now() < deadline) {
    const sig = `${snap.refCount}:${snap.textLen}`;
    if (sig === prevSig) break;
    prevSig = sig;
    await settle(page, 3000);
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(600);
    snap = await snapshotOnce(page, opts);
  }
  return snap.text;
}

interface SnapResult { text: string; incomplete: boolean; refCount: number; textLen: number }

async function snapshotOnce(page: Page, opts: { maxRefs?: number; textChars?: number } = {}): Promise<SnapResult> {
  const maxRefs = opts.maxRefs ?? 60;
  const textChars = opts.textChars ?? 4000;
  const url = page.url();
  const title = await page.title().catch(() => "");
  const lines: string[] = [];
  let modal = false;
  let mainText = "";
  let frameText = "";
  let n = 1;
  let pendingFrame = false; // 요소도 내용도 없는 하위 프레임 = 아직 렌더 중일 가능성
  let loading = false;
  for (const f of page.frames()) {
    if (n - 1 >= maxRefs) break;
    let snap: FrameSnap;
    try { snap = await collectFrame(f, n, maxRefs - (n - 1)); } catch { continue; } // 교차 출처 프레임은 건너뜀
    if (f === page.mainFrame()) mainText = snap.text;
    else {
      if (snap.text.length > frameText.length) frameText = snap.text;
      if (snap.lines.length) lines.push(`  ── iframe: ${f.url().slice(0, 70)}`);
      else if (snap.text.length < 200) pendingFrame = true;
    }
    lines.push(...snap.lines);
    modal = modal || snap.modal;
    loading = loading || snap.loading;
    n = snap.next;
  }
  // 그룹웨어처럼 본문이 iframe 안에 있으면 메인 텍스트가 사실상 비어 있다 — 가장 큰 iframe 본문을 덧붙인다
  let text = mainText;
  if (frameText && mainText.length < 400) text = `${mainText}\n\n[iframe 본문]\n${frameText}`.trim();
  const offscreen = lines.filter((l) => l.startsWith("· ")).length;
  const head = [
    `URL: ${url}`,
    `제목: ${title}`,
    modal ? "주의: 모달/팝업이 열려 있습니다 — 뒤쪽 요소를 클릭하려면 먼저 닫으세요" : "",
    loading ? "주의: 화면이 아직 로딩 중입니다 — 목록이 비어 보여도 '0건'으로 단정하지 말고 browser_wait로 기다린 뒤 다시 읽으세요" : "",
  ].filter(Boolean).join("\n");
  const body = text
    ? `\n\n[화면 텍스트]\n${text.slice(0, textChars)}${text.length > textChars ? "\n…(잘림)" : ""}`
    : "";
  const shown = lines.length - lines.filter((l) => l.startsWith("  ── iframe")).length;
  const capped = n - 1 >= maxRefs; // 상한에 걸려 더 못 담은 요소가 있다는 뜻
  const refs = lines.length
    ? `\n\n[조작 가능 요소 ${shown}개] — browser_click/browser_type에 "@번호"로 지목하세요${offscreen ? ` (· 표시 ${offscreen}개는 화면 밖 — browser_scroll 후 다시 읽으세요)` : ""}${capped ? ` (표시 상한 ${maxRefs}개 도달 — 목록에 없는 요소는 browser_scroll로 화면을 옮기거나 browser_eval로 찾으세요)` : ""}\n${lines.join("\n")}`
    : `\n\n[조작 가능 요소] 없음 — 아직 로딩 중이거나(browser_wait) 접근이 막힌 iframe일 수 있습니다`;
  const refCount = shown;
  return { text: `${head}${body}${refs}`, incomplete: refCount === 0 || pendingFrame || loading, refCount, textLen: text.length };
}

// "@12" 참조 또는 CSS/text= 셀렉터를 실제 프레임+셀렉터로 해석 (iframe 안까지 찾는다)
async function locate(page: Page, target: string): Promise<{ frame: Frame; selector: string } | null> {
  const t = String(target ?? "").trim();
  if (!t) return null;
  const m = t.match(/^@?(\d+)$/);
  const sel = m ? `[${REF_ATTR}="${m[1]}"]` : t;
  const frames = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];
  for (const f of frames) {
    try { if (await f.locator(sel).count()) return { frame: f, selector: sel }; } catch {}
  }
  return null;
}

// ─── 비전 모델 해석 (업무지침서 C4) ───
// CLI 어댑터(grok·cursor-agent)는 프롬프트를 텍스트로 직렬화하면서 이미지를 통째로 버린다
// (providers/adapters.ts의 textOf가 image_url 파트를 빈 문자열로 만든다).
// 이 맥의 default_model이 cursor/composer-2.5(CLI)였기 때문에 예전 browser_look은
// "모델이 볼 수 없는 스크린샷"을 보내고 답을 기다리다 죽었다 — 실측 실패 7/10이 이 경로다.
// 그래서 설정에 의존하지 않고, 이미지 입력이 실제로 가능한 모델을 자동으로 고른다.
let visionPick: { endpoint: Endpoint; model: string } | null | undefined;
export function clearVisionPick() { visionPick = undefined; } // 설정 변경 시 재선택

async function resolveVisionModel(): Promise<{ endpoint: Endpoint; model: string } | null> {
  if (visionPick !== undefined) return visionPick;
  const { resolveModel, defaultModelId, getEndpoints, guessCapabilities } = await import("./providers");
  const { findProvider, resolveAuth } = await import("./providers/registry");
  const { getSetting } = await import("./db");

  // 1) 사용자가 지정했으면 그것 — 단 CLI면 이미지를 못 보므로 거부하고 자동 선택으로 넘어간다
  const configured = getSetting("vision_model");
  if (configured) {
    const r = resolveModel(configured);
    if (r.endpoint.kind !== "cli") return (visionPick = r);
    console.warn(`[mybot] vision_model(${configured})은 이미지 입력을 지원하지 않는 CLI 어댑터입니다 — 자동 선택으로 대체합니다`);
  }
  // 2) 기본 모델이 이미지를 볼 수 있으면 그것
  const dflt = resolveModel(defaultModelId());
  if (dflt.endpoint.kind !== "cli" && guessCapabilities(dflt.model).vision) return (visionPick = dflt);
  // 3) 인증된 프로바이더에서 비전 가능한 첫 모델
  for (const ep of getEndpoints()) {
    if (ep.kind === "cli") continue;
    const def = findProvider(ep.id);
    if (!def) continue;
    const auth = resolveAuth(def);
    if (!(auth.apiKey || auth.accessToken || auth.source === "로컬")) continue;
    for (const id of def.models ?? []) {
      if (guessCapabilities(id).vision) return (visionPick = { endpoint: ep, model: id });
    }
  }
  return (visionPick = null);
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
        await settle(page);
        return await snapshot(page);
      }
      case "browser_read":
        return await snapshot(page);
      case "browser_click": {
        // ref(@번호) 우선, CSS/text= 셀렉터도 계속 허용 — 기존 스킬·절차가 깨지지 않게
        const target = String(args.ref ?? args.selector ?? args.target ?? "");
        if (!target) return '오류: ref(@번호) 또는 selector 필요 — browser_read로 요소 번호를 먼저 확인하세요';
        const loc = await locate(page, target);
        if (!loc) return `요소를 찾지 못했습니다: ${target}\n번호는 화면이 바뀌면 무효가 됩니다 — 아래 목록에서 다시 지목하세요.\n\n${await snapshot(page)}`;
        try {
          await loc.frame.locator(loc.selector).first().click({ timeout: 8000 });
        } catch (e) {
          // C3: 실패하면 원문 오류만 던지지 말고 지금 화면에서 고를 수 있는 요소를 함께 준다
          return `클릭 실패(${target}): ${String((e as Error).message).split("\n")[0]}\n아래 목록에서 다시 지목하세요.\n\n${await snapshot(page)}`;
        }
        await settle(page);
        return await snapshot(await pageFor(agentKey)); // 클릭으로 새 창이 열렸으면 그 창을 읽는다
      }
      case "browser_type": {
        const target = String(args.ref ?? args.selector ?? args.target ?? "");
        const text = String(args.text ?? "");
        if (!target) return '오류: ref(@번호) 또는 selector 필요';
        const loc = await locate(page, target);
        if (!loc) return `입력할 요소를 찾지 못했습니다: ${target}\n\n${await snapshot(page)}`;
        const el = loc.frame.locator(loc.selector).first();
        try {
          await el.fill(text, { timeout: 8000 });
        } catch (e) {
          return `입력 실패(${target}): ${String((e as Error).message).split("\n")[0]}\n\n${await snapshot(page)}`;
        }
        if (args.enter) {
          await el.press("Enter").catch(() => {});
          await settle(page);
          return await snapshot(await pageFor(agentKey));
        }
        return `입력 완료: ${target} ← "${text.slice(0, 60)}"`;
      }
      case "browser_scroll": {
        const dy = args.direction === "up" ? -800 : 800;
        await page.mouse.wheel(0, dy);
        await settle(page, 2000);
        return await snapshot(page);
      }
      case "browser_wait": {
        // 로딩이 끝나기를 기다린다 — 예전엔 고정 대기가 모자라 "목록 0건"으로 오판하는 일이 잦았다
        const text = String(args.text ?? "");
        const sel = String(args.selector ?? "");
        const secs = Math.min(Math.max(Number(args.seconds) || 0, 0), 30);
        const ms = (secs || 15) * 1000;
        try {
          if (text) await page.getByText(text, { exact: false }).first().waitFor({ state: "visible", timeout: ms });
          else if (sel) await page.locator(sel).first().waitFor({ state: "visible", timeout: ms });
          else await page.waitForTimeout((secs || 3) * 1000);
        } catch {
          return `대기 시간 초과 — "${text || sel}"이(가) 나타나지 않았습니다.\n\n${await snapshot(page)}`;
        }
        await settle(page);
        return await snapshot(page);
      }
      case "browser_back": {
        const stack = (pages.get(agentKey) ?? []).filter((x) => !x.isClosed());
        if (stack.length > 1 && stack[stack.length - 1] === page) {
          // 새 창에 들어와 있으면 창을 닫고 이전 창으로 — 그룹웨어 "문서 열기 → 목록 복귀" 흐름
          try { await page.close(); } catch {}
          const prev = (pages.get(agentKey) ?? []).filter((x) => !x.isClosed());
          pages.set(agentKey, prev);
          const back = prev[prev.length - 1];
          if (back) {
            await back.bringToFront().catch(() => {});
            await settle(back);
            return `새 창을 닫고 이전 화면으로 돌아왔습니다.\n\n${await snapshot(back)}`;
          }
        }
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
        await settle(page);
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
        await settle(page, 12000);
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
        // 텍스트로 안 읽히는 화면(차트·캔버스·이미지 UI)을 비전 모델이 설명한다.
        // 실측: 예전 구현은 10회 중 7회가 120초 타임아웃으로 죽었다(평균 97초).
        // 원인 — 풀페이지 PNG를 비전 지원 여부도 모르는 기본 모델에 태웠다.
        // 이제 viewport만 JPEG로 찍고, 설정 vision_model을 우선 쓰며, 45초 안에 못 끝내면
        // 텍스트 스냅샷으로 폴백한다 (빈손으로 돌아오지 않게).
        const q = String(args.question ?? "이 화면에 보이는 내용을 설명해줘. 텍스트로 읽히지 않는 요소(차트·캔버스·이미지·아이콘)도 포함해 읽기 좋게 정리해줘");
        let shot: Buffer;
        try {
          shot = await page.screenshot({ type: "jpeg", quality: 60 }); // viewport만 — fullPage 아님
        } catch (e) {
          return `화면 캡처 실패: ${(e as Error).message}\n\n${await snapshot(page)}`;
        }
        const pick = await resolveVisionModel();
        if (!pick) {
          // 볼 수 없는 모델에 스크린샷을 던지고 45초를 버리느니, 즉시 텍스트로 답하는 편이 낫다
          return `[화면 분석 불가 — 이미지 입력을 지원하는 모델이 인증돼 있지 않습니다. 설정에서 비전 모델(예: OpenAI·Gemini·GLM 계열)을 인증하거나 vision_model에 지정하세요. 대신 화면 텍스트로 답합니다]\n\n${await snapshot(page)}`;
        }
        try {
          const { chatOnce } = await import("./providers/openaiCompat");
          const res = await chatOnce(pick.endpoint, pick.model, [
            { role: "user", content: [{ type: "text", text: q }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${shot.toString("base64")}` } }] },
          ], { signal: AbortSignal.timeout(45_000) });
          if (res.content?.trim()) return `[화면 분석 — ${await page.title().catch(() => "")} · ${pick.endpoint.id}/${pick.model}]\n${res.content}`;
        } catch (e) {
          console.error(`[mybot] browser_look 실패 (${pick.endpoint.id}/${pick.model}) — ${(e as Error).message}`);
        }
        return `[화면 분석 실패 — ${pick.endpoint.id}/${pick.model}이 45초 안에 응답하지 않아 텍스트로 대체합니다]\n\n${await snapshot(page)}`;
      }
      default:
        return `알 수 없는 도구: ${name}`;
    }
  } catch (e) {
    return `브라우저 오류: ${(e as Error).message}`;
  }
}

export const BROWSER_TOOLS = [
  { type: "function", function: { name: "browser_open", description: "브라우저로 URL을 열고 화면을 읽습니다. 저장된 로그인 세션을 공유하므로 로그인 필요 사이트도 열립니다. 결과에는 화면 텍스트와 함께 [조작 가능 요소] 목록이 @번호로 딸려 옵니다 — 이후 클릭·입력은 그 번호로 지목하세요.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
  { type: "function", function: { name: "browser_read", description: "현재 화면을 다시 읽습니다 — 화면 텍스트 + 조작 가능 요소 @번호 목록. 클릭·입력 전에 번호를 확인하는 용도로 쓰세요. 화면이 바뀌면 번호도 새로 매겨집니다.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "browser_click", description: "요소를 클릭합니다. ref에 browser_read가 준 @번호(예: \"@12\")를 넣는 것이 가장 정확합니다 — 셀렉터를 추측하지 마세요. CSS 선택자나 'text=텍스트'도 받지만 실패율이 높습니다. 실패하면 현재 화면의 요소 목록이 함께 돌아오니 그 중에서 다시 고르세요. 새 창이 열리면 자동으로 그 창을 따라갑니다.", parameters: { type: "object", properties: { ref: { type: "string", description: "browser_read가 부여한 요소 번호 (예: \"@12\")" }, selector: { type: "string", description: "대안 — CSS 선택자 또는 'text=링크텍스트'" } } } } },
  { type: "function", function: { name: "browser_type", description: "입력 필드에 텍스트를 입력합니다. ref에 @번호를 쓰세요. enter를 true로 주면 입력 후 Enter까지 누르고 바뀐 화면을 읽어 돌려줍니다.", parameters: { type: "object", properties: { ref: { type: "string", description: "요소 번호 (예: \"@4\")" }, selector: { type: "string", description: "대안 — CSS 선택자" }, text: { type: "string" }, enter: { type: "boolean", description: "입력 후 Enter" } }, required: ["text"] } } },
  { type: "function", function: { name: "browser_scroll", description: "페이지를 스크롤하고 화면을 다시 읽습니다. 요소 목록에서 · 표시가 붙은 항목은 화면 밖이므로, 클릭하려면 먼저 스크롤하세요.", parameters: { type: "object", properties: { direction: { type: "string", enum: ["down", "up"] } } } } },
  { type: "function", function: { name: "browser_wait", description: "화면에 특정 텍스트나 요소가 나타날 때까지 기다린 뒤 화면을 읽습니다. 목록이 비어 보이거나 '로딩 중'일 때 바로 실패로 판단하지 말고 이 도구로 한 번 기다리세요.", parameters: { type: "object", properties: { text: { type: "string", description: "나타나기를 기다릴 화면 텍스트" }, selector: { type: "string", description: "나타나기를 기다릴 CSS 선택자" }, seconds: { type: "number", description: "최대 대기 초 (기본 15, 최대 30)" } } } } },
  { type: "function", function: { name: "browser_back", description: "이전 화면으로 돌아갑니다. 링크가 새 창으로 열렸던 경우에는 그 창을 닫고 원래 목록 화면으로 복귀합니다 (문서 열람 후 목록으로 돌아오는 흐름).", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "browser_login", description: "설정에 등록된 사이트 계정으로 자동 로그인합니다 (회사 그룹웨어·사내 시스템 등). 로그인 후 browser_read로 화면과 요소 번호를 확인하세요.", parameters: { type: "object", properties: { site: { type: "string", description: "설정에 등록한 사이트 이름" } }, required: ["site"] } } },
  { type: "function", function: { name: "browser_eval", description: "현재 페이지에서 임의 JavaScript를 실행합니다. @번호 기반 클릭·입력으로 안 되는 경우에만 쓰세요 — 먼저 browser_read로 요소 번호를 확인하고 browser_click을 시도하는 것이 원칙입니다. 대량 데이터 추출처럼 클릭으로 불가능한 작업에 적합합니다.", parameters: { type: "object", properties: { script: { type: "string", description: "페이지에서 실행할 JS 본문 (반환값이 결과로 옴)" } }, required: ["script"] } } },
  { type: "function", function: { name: "browser_look", description: "현재 화면을 캡처해 비전 모델이 설명합니다 — 차트·캔버스·이미지 기반 UI처럼 텍스트로 안 읽히는 화면에만 쓰세요. 텍스트가 읽히는 화면은 browser_read가 훨씬 빠르고 정확합니다.", parameters: { type: "object", properties: { question: { type: "string", description: "화면에서 알고 싶은 것" } } } } },
  { type: "function", function: { name: "ego_run", description: "ego lite — 사용자의 실제 로그인된 브라우저에서 JavaScript를 실행합니다 (컴퓨트 유즈). 내장 browser_* 도구로 접근이 안 되는 사이트에 쓰세요. script 안에서 쓸 수 있는 헬퍼: openOrReuseTab(url,{wait:true}), snapshotText()(요소를 [ref=N]으로 표시), click('@N' 또는 CSS), typeText(sel,text), fillInput(sel,text), pressKey('Enter'), scrollBy(픽셀), js('JS표현식'), captureScreenshot(), listTabs(), waitForElement(sel). 결과는 반드시 cliLog(...)로 출력하세요. 작업 공간은 자동으로 'mybot-{작업ID}' Space에서 실행됩니다.", parameters: { type: "object", properties: { script: { type: "string", description: "실행할 JS (top-level await 가능). 예: await openOrReuseTab('https://...', {wait:true}); cliLog(await snapshotText());" } }, required: ["script"] } } },
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
