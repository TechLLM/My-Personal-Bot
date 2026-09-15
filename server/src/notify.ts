import { Hono } from "hono";
import nodemailer from "nodemailer";
import { db, uid, now, getSetting, setSetting } from "./db";

// 텔레그램 봇 API로 결과 전송. 실패 시 오류 문자열, 성공 시 null
export async function sendTelegram(text: string): Promise<string | null> {
  const token = getSetting("telegram_bot_token");
  const chatId = getSetting("telegram_chat_id");
  if (!token || !chatId) return "봇 토큰/채팅 ID 미설정";
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3900) + (text.length > 3900 ? "\n…(전체는 앱에서 확인)" : "") }),
    });
    if (!res.ok) return `텔레그램 ${res.status}: ${(await res.text()).slice(0, 200)}`;
    return null;
  } catch (e) {
    return `텔레그램 오류: ${(e as Error).message}`;
  }
}

// 마크다운 보고서를 텔레그램 HTML 메시지로 정돈해 전송 — 메시지 자체가 HTML 포맷
// 별도 문서 파일을 만들지 않음. 길면 메시지를 나눠서 보내고, HTML 파싱 실패 시 평문 폴백
export async function sendTelegramReport(title: string, mdReport: string): Promise<string | null> {
  const token = getSetting("telegram_bot_token");
  const chatId = getSetting("telegram_chat_id");
  if (!token || !chatId) return "봇 토큰/채팅 ID 미설정";
  try {
    const { mdToTelegramHtml, cleanOutput } = await import("./report");
    const clean = cleanOutput(mdReport);
    const html = `<b>■ ${title.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</b>\n\n` + mdToTelegramHtml(clean);
    // 텔레그램 메시지 한도 4096자 — 줄 단위로 나눠 여러 메시지로 전송
    const chunks: string[] = [];
    let buf = "";
    for (const line of html.split("\n")) {
      if (buf.length + line.length + 1 > 3900) { chunks.push(buf); buf = ""; }
      buf += (buf ? "\n" : "") + line;
    }
    if (buf) chunks.push(buf);
    for (let ci = 0; ci < chunks.length; ci++) {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunks[ci], parse_mode: "HTML", disable_web_page_preview: true }),
      });
      if (!res.ok) {
        // HTML 파싱 실패 시 실패한 청크부터 평문으로 폴백 — 보고서 후반부가 유실되지 않게 청크 단위로 전송
        const plain = clean.split("\n");
        let buf2 = ci === 0 ? `[MyBot] ${title}\n\n` : "";
        for (const line of plain) {
          if (buf2.length + line.length + 1 > 3900) { await sendTelegram(buf2); buf2 = ""; }
          buf2 += (buf2 ? "\n" : "") + line;
        }
        if (buf2) await sendTelegram(buf2);
        return null;
      }
    }
    return null;
  } catch (e) {
    return `텔레그램 오류: ${(e as Error).message}`;
  }
}

// SMTP로 결과 메일 전송
export async function sendEmail(subject: string, text: string): Promise<string | null> {
  const host = getSetting("smtp_host");
  const to = getSetting("email_to");
  if (!host || !to) return "SMTP 호스트/받는 주소 미설정";
  const port = Number(getSetting("smtp_port") || "587");
  const user = getSetting("smtp_user");
  const pass = getSetting("smtp_pass");
  try {
    const transport = nodemailer.createTransport({
      host, port, secure: port === 465,
      auth: user ? { user, pass: pass ?? undefined } : undefined,
    });
    await transport.sendMail({ from: getSetting("smtp_from") || user || "mybot@local", to, subject, text });
    return null;
  } catch (e) {
    return `메일 오류: ${(e as Error).message}`;
  }
}

// 답변 완성 후 설정된 채널로 발송 (기본은 채팅창만 — 설정 켠 채널에 추가 발송)
// 텔레그램은 정규화된 보고서 형식으로 발송 — 모델과 무관하게 정돈된 포맷 보장
export function notifyResult(title: string, content: string, agentName = "MyBot") {
  if (getSetting("notify_telegram") === "1") {
    void (async () => {
      const { normalizeReport } = await import("./report");
      const report = await normalizeReport(agentName, title, content);
      const e = await sendTelegramReport(title, report);
      if (e) console.error("[notify]", e);
    })();
  }
  if (getSetting("notify_email") === "1") {
    sendEmail(`[MyBot] ${title}`, content).then((e) => e && console.error("[notify]", e));
  }
}

// --- 텔레그램 수신 → 대장 봇 처리 → 대장 세션 기록 + 텔레그램 회신 ---
// 설정 telegram_listen=1 일 때만 동작. 대장 봇이 도구·봇 생성·위임을 전부 사용 가능
async function handleTelegramText(text: string): Promise<string> {
  const { ensureBossAgent, runAgent, bossSessionConvId, defaultModel } = await import("./team");
  type TeamAgentState = import("./team").TeamAgentState;
  const { appendToAgentSession } = await import("./routes/chat");
  const boss = ensureBossAgent();
  const convId = bossSessionConvId(boss.id);

  // 이전 텔레그램 교환을 맥락으로 — "이어서 해줘" 같은 지시가 동작하게
  const msgs = (db.prepare("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 24").all(convId) as any[]).reverse();
  const ctx: string[] = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === "user" && msgs[i].content.startsWith("[텔레그램]")) {
      ctx.push(`사용자: ${msgs[i].content.slice(7)}`);
      if (msgs[i + 1]?.role === "assistant") ctx.push(`대장: ${msgs[i + 1].content.slice(0, 500)}`);
    }
  }
  const ctxBlock = ctx.length ? `\n\n[이전 텔레그램 대화]\n${ctx.slice(-6).join("\n")}` : "";

  const runId = uid();
  db.prepare("INSERT INTO agent_runs (id, agent_id, conversation_id, task, status, created_at) VALUES (?, ?, ?, ?, 'running', ?)")
    .run(runId, boss.id, convId, `[텔레그램] ${text.slice(0, 200)}`, now());
  const state = {
    id: boss.id, runId, name: boss.name, avatar: boss.avatar ?? "🤖",
    role: boss.role_prompt,
    task: `사용자가 텔레그램으로 보낸 업무 지시입니다. 수행하고 결과를 보고하세요. 필요하면 봇을 만들거나 기존 봇에게 위임하세요.${ctxBlock}\n\n지시: ${text}`,
    model: boss.model ?? defaultModel(), status: "running", steps: 0, toolLog: [], depth: 0,
  } as TeamAgentState;
  await runAgent(state, boss, () => {}, AbortSignal.timeout(240_000));
  db.prepare("UPDATE agent_runs SET status = ?, result = ?, steps = ?, tool_log = ?, finished_at = ? WHERE id = ?")
    .run(state.status, state.result ?? null, state.steps, JSON.stringify(state.toolLog), now(), runId);
  const out = state.result ?? "(결과 없음)";
  // 세션 기록과 텔레그램 회신 모두 정규화된 보고서 형식으로 — 이모지 제거·고정 섹션
  const { normalizeReport } = await import("./report");
  const report = await normalizeReport(boss.name, text, out);
  appendToAgentSession(convId, `[텔레그램] ${text}`, report, boss.model);
  const err = await sendTelegramReport(boss.name, report);
  if (err) console.error("[telegram]", err);
  return report;
}

let tgStarted = false;
export function startTelegramBot() {
  if (tgStarted) return;
  tgStarted = true;
  let offset = Number(getSetting("telegram_update_offset") || 0);
  let webhookCleared = false;
  (async () => {
    for (;;) {
      const token = getSetting("telegram_bot_token");
      const chatId = getSetting("telegram_chat_id");
      if (getSetting("telegram_listen") !== "1" || !token || !chatId) {
        await Bun.sleep(5_000);
        continue;
      }
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=25`, { signal: AbortSignal.timeout(35_000) });
        if (res.status === 409 && !webhookCleared) {
          // 다른 곳에서 webhook이 설정돼 있으면 getUpdates가 막힘 — 해제 후 폴링
          webhookCleared = true;
          await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, { method: "POST" }).catch(() => {});
          continue;
        }
        if (!res.ok) { await Bun.sleep(10_000); continue; }
        const data = (await res.json()) as any;
        for (const u of data.result ?? []) {
          offset = Math.max(offset, u.update_id + 1);
          setSetting("telegram_update_offset", String(offset));
          const text = u.message?.text;
          if (!text || String(u.message.chat?.id) !== String(chatId)) continue; // 등록된 채팅만 허용
          try {
            await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, action: "typing" }),
            }).catch(() => {});
            await handleTelegramText(text); // 정규화된 보고서 형식으로 텔레그램 회신까지 내부에서 처리
          } catch (e) {
            console.error("[telegram]", (e as Error).message);
            sendTelegram(`지시 처리 중 오류: ${(e as Error).message}`).catch(() => {});
          }
        }
      } catch {
        await Bun.sleep(5_000);
      }
    }
  })();
  console.log("[mybot] telegram inbound listener started (telegram_listen 설정에 따라 활성)");
}

export const notifyRoute = new Hono()
  .post("/test", async (c) => {
    const { channel } = await c.req.json().catch(() => ({}));
    const err = channel === "telegram"
      ? await sendTelegram("[MyBot] 테스트 메시지입니다 ✅")
      : channel === "email"
        ? await sendEmail("[MyBot] 테스트 메일", "MyBot 메일 설정이 정상 동작합니다.")
        : "channel: telegram|email";
    return err ? c.json({ ok: false, error: err }, 400) : c.json({ ok: true });
  });
