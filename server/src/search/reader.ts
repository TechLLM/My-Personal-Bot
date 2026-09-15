// fetch로 못 읽는 페이지용 — headless Chromium으로 실제 렌더링 후 본문 추출
async function readPageHeadless(url: string, maxChars: number): Promise<{ title: string; text: string } | null> {
  try {
    const { getBrowser } = await import("../browser");
    const browser = await getBrowser(true);
    const page = await browser.newPage();
    try {
      await page.route(/\.(png|jpe?g|gif|webp|svg|woff2?|mp4|mp3)$/i, (r) => r.abort()).catch(() => {});
      await page.goto(url, { timeout: 15000, waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200); // JS 렌더 대기
      const title = await page.title().catch(() => "");
      const raw = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      const text = String(raw).replace(/\n{3,}/g, "\n\n").trim();
      if (text.length < 100) return null;
      return { title, text: text.slice(0, maxChars) };
    } finally {
      await page.close().catch(() => {});
    }
  } catch {
    return null;
  }
}

// URL → 본문 텍스트 정제. fetch가 실패하거나 내용이 얇으면(JS 렌더링 필요·봇 차단) 실제 브라우저로 재시도 — ego lite 우선, 없으면 내장 headless
export async function readPage(url: string, maxChars = 6000): Promise<{ title: string; text: string } | null> {
  const viaFetch = await readPageFetch(url, maxChars);
  if (viaFetch) return viaFetch;
  const { egoReadPage } = await import("../ego");
  const viaEgo = await egoReadPage(url, maxChars);
  if (viaEgo) return viaEgo;
  return readPageHeadless(url, maxChars);
}

async function readPageFetch(url: string, maxChars = 6000): Promise<{ title: string; text: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36", Accept: "text/html,*/*" },
      signal: AbortSignal.timeout(12000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    let html = await res.text();
    if (!ct.includes("html") && !ct.includes("text")) return null;

    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "")
      .replace(/<[^>]+>/g, "").trim();

    // 노이즈 제거
    html = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
      .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
      .replace(/<header[\s\S]*?<\/header>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ");

    // main/article 우선
    const mainMatch = html.match(/<(?:article|main)[^>]*>([\s\S]*?)<\/(?:article|main)>/i);
    const body = mainMatch ? mainMatch[1] : (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html);

    const text = body
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n+/g, "\n\n")
      .trim();

    if (text.length < 100) return null;
    return { title, text: text.slice(0, maxChars) };
  } catch {
    return null;
  }
}
