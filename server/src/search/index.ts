import { getSetting } from "../db";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface SearchProvider {
  name: string;
  search(query: string, limit: number): Promise<SearchResult[]>;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ");
}

const strip = (html: string) => decodeEntities(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// bing.com/ck/a 리다이렉트 → 실제 URL (u= 파라미터, "a1" 접두 + base64url)
function decodeBingUrl(href: string): string {
  href = href.replace(/&amp;/g, "&");
  const u = href.match(/[?&]u=([^&]+)/);
  if (!u) return href;
  try {
    const enc = decodeURIComponent(u[1]);
    const b64 = enc.startsWith("a1") ? enc.slice(2) : enc;
    return Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return href;
  }
}

// Bing HTML — 키 불필요, 기본 폴백
const bing: SearchProvider = {
  name: "bing",
  async search(query, limit) {
    const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${limit * 2}&setlang=ko`, {
      headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8" },
      signal: AbortSignal.timeout(10000),
    });
    const html = await res.text();
    const results: SearchResult[] = [];
    const re = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/g;
    let m;
    while ((m = re.exec(html)) && results.length < limit) {
      const block = m[1];
      const a = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!a) continue;
      const url = decodeBingUrl(a[1]);
      if (!url.startsWith("http")) continue;
      const snip = block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/)
        ?? block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
      results.push({ title: strip(a[2]), url, snippet: snip ? strip(snip[1]) : "" });
    }
    return results;
  },
};

// DuckDuckGo HTML — 봇 차단 잦아 최후 폴백
const ddg: SearchProvider = {
  name: "ddg",
  async search(query, limit) {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(10000),
    });
    const html = await res.text();
    const results: SearchResult[] = [];
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && results.length < limit) {
      let url = m[1];
      const uddg = url.match(/uddg=([^&]+)/);
      if (uddg) url = decodeURIComponent(uddg[1]);
      results.push({ title: strip(m[2]), url, snippet: strip(m[3]) });
    }
    return results;
  },
};

const searxng: SearchProvider = {
  name: "searxng",
  async search(query, limit) {
    const base = getSetting("searxng_url");
    if (!base) return [];
    const res = await fetch(`${base}/search?q=${encodeURIComponent(query)}&format=json`, { signal: AbortSignal.timeout(10000) });
    const data = (await res.json()) as { results?: { title: string; url: string; content?: string }[] };
    return (data.results ?? []).slice(0, limit).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? "" }));
  },
};

const tavily: SearchProvider = {
  name: "tavily",
  async search(query, limit) {
    const key = getSetting("tavily_key");
    if (!key) return [];
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, query, max_results: limit }),
      signal: AbortSignal.timeout(10000),
    });
    const data = (await res.json()) as { results?: { title: string; url: string; content?: string }[] };
    return (data.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? "" }));
  },
};

const brave: SearchProvider = {
  name: "brave",
  async search(query, limit) {
    const key = getSetting("brave_key");
    if (!key) return [];
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`, {
      headers: { "X-Subscription-Token": key, Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    const data = (await res.json()) as { web?: { results?: { title: string; url: string; description?: string }[] } };
    return (data.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.description ?? "" }));
  },
};

// Exa — 에이전트용 뉴럴 검색. 의미 기반 랭킹이라 복합·다단계 질의에 강함 (WebWalker 벤치 최상위)
const exa: SearchProvider = {
  name: "exa",
  async search(query, limit) {
    const key = getSetting("exa_key");
    if (!key) return [];
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key },
      body: JSON.stringify({ query, numResults: limit, type: "auto", contents: { text: { maxCharacters: 300 } } }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { results?: { title?: string; url: string; text?: string }[] };
    return (data.results ?? []).filter((r) => r.url?.startsWith("http")).map((r) => ({
      title: r.title ?? r.url, url: r.url, snippet: (r.text ?? "").slice(0, 300),
    }));
  },
};

// Jina Search (s.jina.ai) — 검색 결과마다 본문까지 읽어서 반환. jina_key 필요.
// no-content 모드로 제목/URL/스니펫만 받고, 본문은 DeepSearch가 r.jina.ai로 읽는다.
const jina: SearchProvider = {
  name: "jina",
  async search(query, limit) {
    const key = getSetting("jina_key");
    if (!key) return [];
    const res = await fetch(`https://s.jina.ai/${encodeURIComponent(query)}`, {
      headers: { Authorization: `Bearer ${key}`, "X-Respond-With": "no-content", Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: { title?: string; url?: string; description?: string; content?: string }[] };
    return (data.data ?? []).filter((r) => r.url?.startsWith("http")).slice(0, limit).map((r) => ({
      title: r.title ?? r.url ?? "", url: r.url ?? "", snippet: r.description ?? (r.content ?? "").slice(0, 300),
    }));
  },
};

// Headless Chromium 검색 — 실제 브라우저라 봇 차단·JS 의존 검색엔진 우회, 키 불필요
const headless: SearchProvider = {
  name: "headless",
  async search(query, limit) {
    const { getBrowser } = await import("../browser");
    const browser = await getBrowser(true);
    const page = await browser.newPage();
    try {
      await page.route(/\.(png|jpe?g|gif|webp|svg|woff2?|mp4|mp3)$/i, (r) => r.abort()).catch(() => {});
      await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${limit * 2}&setlang=ko`, { timeout: 15000, waitUntil: "domcontentloaded" });
      const rows = await page.evaluate((lim) => {
        const out: { title: string; url: string; snippet: string }[] = [];
        for (const li of document.querySelectorAll("li.b_algo")) {
          const a = li.querySelector("h2 a") as HTMLAnchorElement | null;
          const p = li.querySelector(".b_caption p, p");
          if (a?.href?.startsWith("http")) {
            out.push({ title: (a.textContent ?? "").trim(), url: a.href, snippet: (p?.textContent ?? "").trim() });
          }
          if (out.length >= lim) break;
        }
        return out;
      }, limit);
      // bing.com/ck/a 리다이렉트 래퍼 → 실제 URL
      return rows.map((r) => ({ ...r, url: decodeBingUrl(r.url) })).filter((r) => r.url.startsWith("http"));
    } finally {
      await page.close().catch(() => {});
    }
  },
};

// ego lite 검색 — 사용자의 실제 로그인된 브라우저. 별도 Task Space라 사용자 탭을 건드리지 않음
const ego: SearchProvider = {
  name: "ego",
  async search(query, limit) {
    const { egoAvailable, egoRun } = await import("../ego");
    if (!egoAvailable()) return [];
    const out = await egoRun(
      `await openOrReuseTab("https://www.bing.com/search?q=" + encodeURIComponent(${JSON.stringify(query)}), { wait: true, timeout: 20 });
const rows = await js(\`[...document.querySelectorAll("li.b_algo")].slice(0, ${limit}).map(li => ({ title: li.querySelector("h2 a")?.textContent?.trim() ?? "", url: li.querySelector("h2 a")?.href ?? "", snippet: li.querySelector(".b_caption p, p")?.textContent?.trim() ?? "" }))\`);
await closeTab().catch(() => {});
cliLog(JSON.stringify(rows));`,
      "mybot-search",
      45_000,
    );
    try {
      const line = out.trim().split("\n").filter(Boolean).pop() ?? "[]";
      return (JSON.parse(line) as { title: string; url: string; snippet: string }[])
        .map((r) => ({ ...r, url: decodeBingUrl(r.url ?? "") }))
        .filter((r) => r.url?.startsWith("http"));
    } catch {
      return [];
    }
  },
};

const PROVIDERS: Record<string, SearchProvider> = { bing, ddg, searxng, tavily, brave, exa, jina, headless, ego };

export async function webSearch(query: string, limit = 6): Promise<{ provider: string; results: SearchResult[] }> {
  // E2-B 격리 실행 — 샌드박스는 네트워크가 전면 차단이므로 부모의 자격 증명 브로커가
  // 실제 검색을 대행한다. 허용 도구·호출 상한·인자 검증은 브로커가 집행하고,
  // 운영(dev·서비스)에서는 이 분기가 켜지지 않는다(env 미설정).
  if (process.env.MYBOT_ENV === "e2" && process.env.E2_BROKER_URL) {
    const res = await fetch(`${process.env.E2_BROKER_URL}/tool`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.E2_BROKER_TOKEN ?? ""}` },
      body: JSON.stringify({ tool: "web_search", args: { query, limit } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`broker_tool_${res.status}`);
    return (await res.json()).result;
  }
  const pref = getSetting("search_provider") ?? "auto";
  const order = pref === "auto" ? ["searxng", "tavily", "brave", "exa", "jina", "bing", "headless", "ego", "ddg"] : [pref, "bing", "headless", "ego", "ddg"];
  for (const name of order) {
    const p = PROVIDERS[name];
    try {
      const results = await p.search(query, limit);
      if (results.length) return { provider: name, results };
    } catch {}
  }
  return { provider: "none", results: [] };
}
