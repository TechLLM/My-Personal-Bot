import { Hono } from "hono";
import nodemailer from "nodemailer";
import { db, uid, now, getSetting, setSetting } from "./db";
import { compactResult } from "../../shared/user-facing";
import { completeCommand, createCommandJob, withRootJob } from "./command-delivery";

const devSuppressed = () => process.env.MYBOT_ENV === "dev";
const safeTelegramError = (status?: number) => status ? `텔레그램 API 오류 (${status})` : "텔레그램 전달 오류";

export async function sendTelegramDetailed(text: string, o: { chatId?: string | null; messageId?: string | null } = {}): Promise<{ error: string | null; messageId?: string; unknown?: boolean }> {
  if (devSuppressed()) return { error: "suppressed_dev" };
  const token = getSetting("telegram_bot_token");
  const chatId = o.chatId ?? getSetting("telegram_chat_id");
  if (!token || !chatId) return { error: "봇 토큰/채팅 ID 미설정" };
  const method = o.messageId ? "editMessageText" : "sendMessage";
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ chat_id: chatId, ...(o.messageId ? { message_id: Number(o.messageId) } : {}), text: text.slice(0, 3900) + (text.length > 3900 ? "\n…(전체는 앱에서 확인)" : "") }),
    });
    const data = await res.json().catch(() => null) as any;
    if (!res.ok) return { error: safeTelegramError(res.status) };
    if (!data || typeof data.ok !== "boolean") return { error: "텔레그램 전달 결과 미확인", unknown: true };
    if (!data.ok) return { error: safeTelegramError(res.status) };
    const messageId = String(data.result?.message_id ?? o.messageId ?? "") || undefined;
    if (!messageId) return { error: "텔레그램 전달 결과 미확인", unknown: true };
    return { error: null, messageId };
  } catch {
    return { error: "텔레그램 전달 결과 미확인", unknown: true };
  }
}

// 텔레그램 봇 API로 결과 전송. 실패 시 오류 문자열, 성공 시 null
export async function sendTelegram(text: string): Promise<string | null> {
  return (await sendTelegramDetailed(text)).error;
}

// 마크다운 보고서를 텔레그램 HTML 메시지로 정돈해 전송 — 메시지 자체가 HTML 포맷
// 별도 문서 파일을 만들지 않음. 길면 메시지를 나눠서 보내고, HTML 파싱 실패 시 평문 폴백
// meta가 있으면 제목 아래 "관련 봇/요청" 헤더를 붙여 제목·관련봇·요청·결과 포맷을 완성한다
export async function sendTelegramReport(title: string, mdReport: string, _meta?: { agents?: string[]; request?: string }): Promise<string | null> {
  // 저수준 전송은 안전한 평문 한 건만 보낸다. 원 요청 재인용·청크 분할·HTML 폴백 재전송 금지.
  return sendTelegram(`${title}\n\n${compactResult(mdReport, 3700)}`);
}

// SMTP로 결과 메일 전송
export async function sendEmail(subject: string, text: string): Promise<string | null> {
  if (devSuppressed()) return "suppressed_dev";
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
// 포맷: ■ 제목 / 관련 봇 / 요청 / ──── / 결과. dedupeKey로 같은 결과의 중복 발송 차단
// (위임 중간 응답 + 최종 보고, 루틴 발송 + 대화 완료 발송 등 같은 결과가 2경로로 오는 경우)
export interface NotifyResultOpts {
  title: string;                    // 제목 — 대화 제목 / 루틴 라벨 등
  content: string;                  // 결과 내용
  agents?: string[];                // 관련 봇 이름들
  request?: string;                 // 요청 내용 (원본 지시)
  dedupeKey?: string;               // 중복 방지 키 — msgId/runId. 없으면 내용 해시
}

export function notifyResult(o: NotifyResultOpts) {
  const root = createCommandJob({ source: "notification", request: o.request ?? o.title, dedupeKey: o.dedupeKey ?? null });
  void completeCommand(root, o.content, o.dedupeKey ?? "notification");
}

// --- 텔레그램 수신 → 대장 봇 처리 → 대장 세션 기록 + 텔레그램 회신 ---
// 설정 telegram_listen=1 일 때만 동작. 대장 봇이 도구·봇 생성·위임을 전부 사용 가능
export async function handleTelegramText(text: string, updateId?: number): Promise<string> {
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

  const placeholder = appendToAgentSession(convId, `[텔레그램] ${text}`, "", boss.model);
  const rootJobId = createCommandJob({ source: "telegram", conversationId: convId, assistantMessageId: placeholder.assistant.id, request: text, ownerAgentId: boss.id, dedupeKey: updateId === undefined ? null : `update:${updateId}` });
  const existing = db.prepare("SELECT execution_done, full_result FROM command_jobs WHERE id = ?").get(rootJobId) as { execution_done: number; full_result: string | null };
  if (existing.execution_done) return existing.full_result ?? "(결과 없음)";
  const runId = uid();
  db.prepare("INSERT INTO agent_runs (id, agent_id, conversation_id, task, status, root_job_id, created_at) VALUES (?, ?, ?, ?, 'running', ?, ?)")
    .run(runId, boss.id, convId, `[텔레그램] ${text.slice(0, 200)}`, rootJobId, now());
  const state = {
    id: boss.id, runId, name: boss.name, avatar: boss.avatar ?? "🤖",
    role: boss.role_prompt,
    task: `사용자가 텔레그램으로 보낸 업무 지시입니다. 수행하고 결과를 보고하세요. 필요하면 봇을 만들거나 기존 봇에게 위임하세요.${ctxBlock}\n\n지시: ${text}`,
    model: boss.model ?? defaultModel(), status: "running", steps: 0, toolLog: [], depth: 0,
  } as TeamAgentState;
  state.rootJobId = rootJobId;
  try {
    await withRootJob(rootJobId, () => runAgent(state, boss, () => {}, AbortSignal.timeout(240_000)));
    db.prepare("UPDATE agent_runs SET status = ?, result = ?, steps = ?, tool_log = ?, finished_at = ? WHERE id = ?")
      .run(state.status, state.result ?? null, state.steps, JSON.stringify(state.toolLog), now(), runId);
    const out = state.result ?? "(결과 없음)";
    const { normalizeReport } = await import("./report");
    const report = await normalizeReport(boss.name, text, out);
    await completeCommand(rootJobId, report, `run:${runId}`);
    return report;
  } catch (e) {
    const report = `작업 실행 중 오류가 발생했습니다: ${(e as Error).message || "원인을 확인할 수 없습니다."}`;
    db.prepare("UPDATE agent_runs SET status = 'error', result = ?, steps = ?, tool_log = ?, finished_at = ? WHERE id = ?")
      .run(report, state.steps, JSON.stringify(state.toolLog), now(), runId);
    await completeCommand(rootJobId, report, `run:${runId}`);
    throw e;
  }
}

let tgStarted = false;
export function startTelegramBot() {
  if (devSuppressed()) { console.log("[mybot] dev 환경 — 텔레그램 수신·발신 억제"); return; }
  if (tgStarted) return;
  tgStarted = true;
  let offset = Number(getSetting("telegram_update_offset") || 0);
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
        if (res.status === 409) { await Bun.sleep(10_000); continue; }
        if (!res.ok) { await Bun.sleep(10_000); continue; }
        const data = (await res.json()) as any;
        for (const u of data.result ?? []) {
          offset = Math.max(offset, u.update_id + 1);
          setSetting("telegram_update_offset", String(offset));
          const text = u.message?.text;
          if (!text || String(u.message.chat?.id) !== String(chatId)) continue; // 등록된 채팅만 허용
          try { db.prepare("INSERT INTO telegram_updates (update_id, created_at) VALUES (?, ?)").run(Number(u.update_id), now()); }
          catch { continue; }
          try {
            if (!devSuppressed()) await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, action: "typing" }), signal: AbortSignal.timeout(10_000),
            }).catch(() => {});
            await handleTelegramText(text, Number(u.update_id));
          } catch (e) {
            console.error("[telegram]", (e as Error).message);
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
        : channel === "imap"
          ? await (await import("./mail")).testImap() // 수신(IMAP) — 사서함 접속까지 확인
          : "channel: telegram|email|imap";
    return err ? c.json({ ok: false, error: err }, 400) : c.json({ ok: true });
  });
