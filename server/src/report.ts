import { resolveModel, defaultModelId } from "./providers";

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

// 언론 관용 한자 약어 → 한글. 모델이 신문 제목 투로 쓰면 읽기 어렵다
// (실측 2026-09-19 뉴스 브리핑: 與·國·靑·李·前·美가 섞여 나왔다. 스킬로 두 번 금지했는데도 남았다).
// 뜻이 갈리는 한자는 손대지 않는다 — 임의 변환은 오역이 되므로, 관용이 굳은 것만 바꾼다.
const HANJA_MAP: [RegExp, string][] = [
  // 두 글자 조합을 먼저 — 韓美를 글자별로 바꾸면 "한국미국"이 된다
  [/(?<![(])韓美/g, "한미"], [/(?<![(])美韓/g, "미한"], [/(?<![(])美中/g, "미중"], [/(?<![(])中美/g, "중미"], [/(?<![(])韓中/g, "한중"], [/(?<![(])韓日/g, "한일"],
  [/(?<![(])日韓/g, "일한"], [/(?<![(])北美/g, "북미"], [/(?<![(])南北/g, "남북"], [/(?<![(])對北/g, "대북"], [/(?<![(])對美/g, "대미"], [/(?<![(])對中/g, "대중"],
  [/(?<![(])與野/g, "여야"], [/靑瓦臺/g, "대통령실"], [/(?<![(])人事/g, "인사"], [/(?<![(])國會/g, "국회"],
  // 한 글자 — 뒤에 공백·한글·문장부호가 오는 제목 투에서만 (美術 같은 한자어는 건드리지 않게)
  [/(?<![(])美(?=[\s,·]|[가-힣])/g, "미국"], [/(?<![(])中(?=[\s,·]|[가-힣])/g, "중국"], [/(?<![(])日(?=[\s,·]|[가-힣])/g, "일본"],
  [/(?<![(])北(?=[\s,·]|[가-힣])/g, "북한"], [/(?<![(])韓(?=[\s,·]|[가-힣])/g, "한국"], [/(?<![(])英(?=[\s,·]|[가-힣])/g, "영국"],
  [/(?<![(])獨(?=[\s,·]|[가-힣])/g, "독일"], [/(?<![(])佛(?=[\s,·]|[가-힣])/g, "프랑스"], [/(?<![(])露(?=[\s,·]|[가-힣])/g, "러시아"],
  [/(?<![(])與(?=[\s,·]|[가-힣])/g, "여당"], [/(?<![(])野(?=[\s,·]|[가-힣])/g, "야당"], [/(?<![(])靑(?=[\s,·]|[가-힣])/g, "대통령실"],
  [/(?<![(])檢(?=[\s,·]|[가-힣])/g, "검찰"], [/(?<![(])警(?=[\s,·]|[가-힣])/g, "경찰"], [/(?<![(])軍(?=[\s,·]|[가-힣])/g, "군"],
  [/(?<![(])前(?=[\s,·]|[가-힣])/g, "전"], [/(?<![(])現(?=[\s,·]|[가-힣])/g, "현"], [/(?<![(])故(?=[\s,·]|[가-힣])/g, "고"],
  [/(?<![(])新(?=[\s,·]|[가-힣])/g, "신"], [/(?<![(])對(?=[\s,·]|[가-힣])/g, "대"],
];

export function hanjaToHangul(text: string): string {
  let out = text;
  for (const [re, rep] of HANJA_MAP) out = out.replace(re, rep);
  return out;
}

// 코드블록·인라인 코드는 원문 그대로 둔다 — HTML 미리보기나 코드 예시가 깨지면 안 된다
function outsideCode(text: string, fn: (s: string) => string): string {
  return text.split(/(```[\s\S]*?```|`[^`\n]+`)/g).map((part, i) => (i % 2 ? part : fn(part))).join("");
}

export function cleanOutput(text: string): string {
  let out = text;
  // MiniMax-M3 등 추론 모델이 content에 새는 think 블록 제거 — 닫는 태그가 없으면 끝까지 제거
  out = out.replace(/<think>[\s\S]*?(<\/think>|$)/g, "");
  out = out.replace(/<\/?tool_call>|<\/?invoke[^>]*>|<\/?parameter[^>]*>/g, ""); // 텍스트로 샌 도구 호출 마크업 제거
  for (const [re, rep] of MARKER_MAP) out = out.replace(re, rep);
  out = outsideCode(out, hanjaToHangul); // 신문 제목 투 한자 약어를 한글로 (코드블록 제외)
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
  if (!cleaned.trim()) return "## 요약\n봇이 결과를 생성하지 못했습니다.\n\n## 결과\n없음\n\n## 미확인\n전체 작업 미수행\n\n## 다음 단계\n같은 지시를 다시 보내 확인"; // 빈 원문이면 섹션만 있는 빈 보고서 대신 명시
  // LLM 재작성 생략 — 완료마다 돌던 포맷터 호출(비용·지연)을 줄인다:
  // ① 이미 고정 섹션으로 작성된 결과(봇이 보고서 형식을 지킨 경우) ② 짧은 결과는 직접 감싸기
  if (["## 요약", "## 결과", "## 미확인", "## 다음 단계"].every((h) => cleaned.includes(h))) return cleaned;
  if (cleaned.length < 200) return `## 요약\n${cleaned.slice(0, 150)}\n\n## 결과\n${cleaned}\n\n## 미확인\n없음\n\n## 다음 단계\n없음`;
  try {
    const { endpoint, model } = resolveModel(defaultModelId());
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
    ], { signal: AbortSignal.timeout(45_000), reasoningEffort: "low" });
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

