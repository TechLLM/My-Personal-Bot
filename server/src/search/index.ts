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

const PROVIDERS: Record<string, SearchProvider> = { bing, ddg, searxng, tavily, brave };

export async function webSearch(query: string, limit = 6): Promise<{ provider: string; results: SearchResult[] }> {
  const pref = getSetting("search_provider") ?? "auto";
  const order = pref === "auto" ? ["searxng", "tavily", "brave", "bing", "ddg"] : [pref, "bing", "ddg"];
  for (const name of order) {
    const p = PROVIDERS[name];
    try {
      const results = await p.search(query, limit);
      if (results.length) return { provider: name, results };
    } catch {}
  }
  return { provider: "none", results: [] };
}
