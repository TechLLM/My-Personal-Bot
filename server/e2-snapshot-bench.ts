// 스냅샷 크기 벤치 — 실제 페이지들에서 browser_open이 돌려주는 스냅샷의 크기를 잰다.
// 별도 프로필로 띄워 dev 서버의 브라우저 프로필과 충돌하지 않는다.
// 사용: MYBOT_BROWSER_PROFILE=/tmp/mybot-bench-profile bun server/e2-snapshot-bench.ts
import { browserTool, closeAgentPage } from "./src/browser";

const urls = process.argv.slice(2).length ? process.argv.slice(2) : [
  "https://example.com",
  "https://en.wikipedia.org/wiki/Web_browser",
  "https://github.com/trending",
  "https://www.iana.org/domains/reserved",
];

for (const url of urls) {
  try {
    const out = await browserTool("bench", "browser_open", { url });
    const refLines = (out.match(/^·?\s*@\d+/gm) ?? []).length;
    console.log(JSON.stringify({ url, chars: out.length, approxTokens: Math.ceil(out.length / 3), refs: refLines }));
  } catch (e) {
    console.log(JSON.stringify({ url, error: String((e as Error).message).slice(0, 120) }));
  }
}
await closeAgentPage("bench");
process.exit(0);
