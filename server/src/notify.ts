import { Hono } from "hono";
import nodemailer from "nodemailer";
import { getSetting } from "./db";

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
export function notifyResult(title: string, content: string) {
  if (getSetting("notify_telegram") === "1") {
    sendTelegram(`[MyBot] ${title}\n\n${content}`).then((e) => e && console.error("[notify]", e));
  }
  if (getSetting("notify_email") === "1") {
    sendEmail(`[MyBot] ${title}`, content).then((e) => e && console.error("[notify]", e));
  }
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
