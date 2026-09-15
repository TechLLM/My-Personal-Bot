import { resolveModel } from "./providers";

// ── 출력 정제: 장식 이모지를 선형 텍스트 마커로 치환하고 나머지 픽토그래픽은 제거 ──
// 어떤 모델이 만들어도 결과물이 정돈된 형식으로 보이게 하는 공통 정제층
const MARKER_MAP: [RegExp, string][] = [
  [/(\d)\uFE0F\u20E3/g, "$1."],                       // 1️⃣ → 1.
  [/✅|✔️|☑️|🟢/gu, "[완료] "],
  [/⚠️|⚠|🚨/gu, "[주의] "],
  [/❌|🔴|⛔/gu, "[없음] "],
  [/📧|📨|✉️|💌/gu, "[메일] "],
  [/💳|🧾|💰/gu, "[결재] "],
  [/🌐|🖥️/gu, "[웹] "],
  [/🔑|🔐|🗝️/gu, "[계정] "],
  [/📅|🗓️/gu, "[일정] "],
  [/🕐|⏰|⌛/gu, "[시간] "],
  [/📌|📍/gu, "▸ "],
  [/📊|📈|📉/gu, "[결과] "],
  [/📋|📝|📄/gu, "▸ "],
  [/💡/gu, "[참고] "],
  [/⏸️?/gu, "[중단] "],
  [/👉|▶️|➡️/gu, "▸ "],
  [/🔗/gu, ""],
  [/🤖|👾|🧠/gu, ""],
  [/⭐|🌟|✨/gu, ""],
  [/⚡/gu, ""],
  [/🔥/gu, ""],
  [/🎯/gu, "[목표] "],
  [/🛠️|🔧|⚙️/gu, "[도구] "],
  [/📦/gu, "[항목] "],
];

export function cleanOutput(text: string): string {
  let out = text;
  for (const [re, rep] of MARKER_MAP) out = out.replace(re, rep);
  out = out.replace(/\p{Extended_Pictographic}\uFE0F?/gu, "");
  out = out.replace(/\u200D/g, "");
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^ +/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── 결과 정규화: 어떤 모델이 쓴 보고든 고정 섹션으로 재구성 (fast 모델) ──
// 모델 품질과 무관하게 최소한의 정보(요약/결과/미확인/다음 단계)가 항상 담기게 함
export async function normalizeReport(agentName: string, task: string, result: string, tools?: string[]): Promise<string> {
  const cleaned = cleanOutput(result);
  try {
    const { endpoint, model } = resolveModel("fast");
    const { chatOnce } = await import("./providers/openaiCompat");
    const res = await chatOnce(endpoint, model, [
      {
        role: "system",
        content: `당신은 업무 보고서 포맷터입니다. 입력된 작업 결과를 아래 고정 형식으로 재구성하세요.
규칙: 이모지 사용 금지. 원문에 있는 사실만 사용(지어내지 않음). 없는 항목은 '없음' 표기. 마크다운 표는 유지하고 정돈. 섹션은 반드시 모두 출력.
정확성: '실행된 도구'가 비어 있거나(도구 호출 없음) 결과의 주장이 실제 확인 없이 쓰인 것처럼 보이면, 그 항목은 '## 결과'가 아니라 '## 미확인'에 넣고 '(미검증)' 표기를 붙이세요. 도구로 실제 확인한 데이터만 결과에 남깁니다.

형식:
## 요약
(1~2문장 — 무엇을 했고 핵심 결과가 무엇인지)
## 결과
(실제 수집된 데이터 — 표·목록·링크)
## 미확인
(확인하지 못한 항목. 모두 확인했으면 '없음')
## 다음 단계
(이어서 할 일 또는 권고. 없으면 '없음')`,
      },
      { role: "user", content: `봇: ${agentName}\n지시: ${task.slice(0, 400)}\n실행된 도구: ${tools?.length ? tools.join(", ") : "(없음 — 도구 미사용)"}\n\n원본 결과:\n${cleaned.slice(0, 6000)}` },
    ], { signal: AbortSignal.timeout(45_000) });
    const out = (res.content ?? "").trim();
    if (out.length > 30) return cleanOutput(out);
  } catch {}
  return `## 요약\n${cleaned.slice(0, 300)}\n\n## 결과\n${cleaned}`; // 포맷터 실패 시 원문 유지
}

// ── 마크다운 → 텔레그램 HTML (b/i/u/s/code/pre/a/blockquote만 지원) ──
const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function mdToTelegramHtml(md: string): string {
  const out: string[] = [];
  let inPre = false;
  let preBuf: string[] = [];
  const flushPre = () => {
    if (preBuf.length) out.push(`<pre>${escHtml(preBuf.join("\n"))}</pre>`);
    preBuf = [];
  };
  for (const raw of md.split("\n")) {
    const line = raw;
    if (/^\s*```/.test(line)) { inPre ? flushPre() : null; inPre = !inPre; continue; }
    if (inPre) { preBuf.push(line); continue; }
    // 마크다운 표 → <pre> 블록으로 정렬 유지 (구분선 행은 ─ 로 치환)
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) { preBuf.push("─".repeat(30)); continue; }
      preBuf.push(line.replace(/^\s*\||\|\s*$/g, "").split("|").map((c) => c.trim()).join("  |  "));
      continue;
    }
    if (preBuf.length) flushPre();
    if (/^\s*$/.test(line)) { out.push(""); continue; }
    let t = escHtml(line);
    const h = t.match(/^(#{1,4})\s+(.*)/);
    if (h) { out.push(`<b>■ ${h[2]}</b>`); continue; }
    if (/^\s*---+\s*$/.test(t)) { out.push("────────────"); continue; }
    t = t
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/\*([^*\n]+)\*/g, "<i>$1</i>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
      .replace(/^\s*[-*•]\s+/g, "▸ ")
      .replace(/^\s*&gt;\s?/g, "▎ ");
    out.push(t);
  }
  flushPre();
  return out.join("\n");
}

// ── 마크다운 → 독립 HTML 문서 (표를 실제 테이블로) — 텔레그램 문서 첨부·기록용 ──
export function mdToHtmlDocument(title: string, md: string): string {
  const inline = (s: string) =>
    escHtml(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  const body: string[] = [];
  const lines = md.split("\n");
  let i = 0;
  let inCode = false;
  let codeBuf: string[] = [];
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {
      if (inCode) { body.push(`<pre><code>${escHtml(codeBuf.join("\n"))}</code></pre>`); codeBuf = []; }
      inCode = !inCode; i++; continue;
    }
    if (inCode) { codeBuf.push(l); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i].replace(/^\s*\||\|\s*$/g, "").split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells);
        i++;
      }
      body.push(
        "<table>" +
          rows.map((r, ri) => `<tr>${r.map((c) => (ri === 0 ? `<th>${inline(c)}</th>` : `<td>${inline(c)}</td>`)).join("")}</tr>`).join("") +
          "</table>",
      );
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)/);
    if (h) { const lv = Math.min(h[1].length + 1, 4); body.push(`<h${lv}>${inline(h[2])}</h${lv}>`); i++; continue; }
    if (/^\s*---+\s*$/.test(l)) { body.push("<hr>"); i++; continue; }
    const li = l.match(/^\s*[-*•]\s+(.*)/);
    if (li) { body.push(`<p class="li">▸ ${inline(li[1])}</p>`); i++; continue; }
    if (l.trim()) body.push(`<p>${inline(l)}</p>`);
    i++;
  }
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)}</title><style>
body{font-family:-apple-system,'Pretendard','Apple SD Gothic Neo',sans-serif;max-width:760px;margin:28px auto;padding:0 18px;color:#18181b;line-height:1.65;font-size:15px}
h1{font-size:20px;border-bottom:2px solid #18181b;padding-bottom:8px}h2,h3,h4{margin-top:22px}
table{border-collapse:collapse;width:100%;margin:14px 0;font-size:14px}
th,td{border:1px solid #d4d4d8;padding:7px 11px;text-align:left;vertical-align:top}th{background:#f4f4f5;font-weight:600}
code{background:#f4f4f5;padding:1px 5px;border-radius:4px;font-size:13px}
pre{background:#f4f4f5;padding:12px;border-radius:8px;overflow-x:auto;font-size:13px}
hr{border:none;border-top:1px solid #e4e4e7;margin:20px 0}.li{margin:3px 0 3px 10px}a{color:#2563eb}
</style></head><body><h1>${escHtml(title)}</h1>${body.join("\n")}</body></html>`;
}
