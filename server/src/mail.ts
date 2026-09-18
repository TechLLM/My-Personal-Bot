// ─── IMAP 메일 조회 ───
// 그룹웨어 화면을 브라우저로 긁는 대신 메일 서버에서 직접 읽는다.
// 실측 2026-09-18: 브라우저 경로는 로그인·진입에 10라운드, 본문 1건당 클릭 1라운드가 들어
// "오늘 메일 상세 보고"가 8건 중 2건만 열고 단계 상한으로 끝났다. IMAP은 목록 1회·본문 1회면 된다.
import { getSetting } from "./db";

export interface MailCfg { host: string; port: number; user: string; pass: string; secure: boolean }

export function mailConfig(): MailCfg | null {
  const host = getSetting("imap_host"), user = getSetting("imap_user"), pass = getSetting("imap_pass");
  if (!host || !user || !pass) return null;
  return { host, port: Number(getSetting("imap_port")) || 993, user, pass, secure: getSetting("imap_tls") !== "0" };
}

// IMAP 검색 조건 — SINCE는 날짜 단위라 시각은 무시된다(당일 메일을 받으려면 오늘 0시)
export function searchCriteria(args: { since?: unknown; unseen?: unknown; from?: unknown; subject?: unknown }): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  const since = String(args.since ?? "").trim();
  if (since) {
    const d = since === "today" ? new Date() : new Date(since);
    if (!isNaN(d.getTime())) { d.setHours(0, 0, 0, 0); c.since = d; }
  }
  if (args.unseen === true || args.unseen === "true") c.seen = false;
  if (args.from) c.from = String(args.from);
  if (args.subject) c.subject = String(args.subject);
  return Object.keys(c).length ? c : { all: true };
}

// 본문으로 읽을 파트 — text/plain 우선, 없으면 text/html
export function pickTextPart(node: any): { part: string; type: string; charset?: string } | null {
  if (!node) return null;
  const type = String(node.type ?? "").toLowerCase();
  if (type === "text/plain" || type === "text/html") {
    return { part: String(node.part || "1"), type, charset: node.parameters?.charset };
  }
  let html: { part: string; type: string; charset?: string } | null = null;
  for (const kid of node.childNodes ?? []) {
    const r = pickTextPart(kid);
    if (r?.type === "text/plain") return r;
    if (r && !html) html = r;
  }
  return html;
}

// 첨부 파일명 — 업무 메일은 첨부가 핵심인 경우가 많다
export function attachmentNames(node: any, out: string[] = []): string[] {
  if (!node) return out;
  const name = node.dispositionParameters?.filename || node.parameters?.name;
  if (name && String(node.disposition ?? "").toLowerCase() === "attachment") out.push(String(name));
  for (const kid of node.childNodes ?? []) attachmentNames(kid, out);
  return out;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const fmtDate = (d: unknown) => {
  const t = d instanceof Date ? d : new Date(String(d ?? ""));
  return isNaN(t.getTime()) ? "?" : t.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
};

const NO_CONFIG = "메일 설정이 없습니다 — 설정 > 알림·연동에서 IMAP 호스트·계정·비밀번호를 입력하세요";

async function withMailbox<T>(mailbox: string, fn: (client: any) => Promise<T>): Promise<T | string> {
  const cfg = mailConfig();
  if (!cfg) return NO_CONFIG;
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: { user: cfg.user, pass: cfg.pass }, logger: false });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(mailbox);
    try { return await fn(client); } finally { lock.release(); }
  } catch (e) {
    return `메일 서버 오류: ${(e as Error).message}`;
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function mailList(args: Record<string, unknown>): Promise<string> {
  const mailbox = String(args.mailbox || "INBOX");
  const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
  return (await withMailbox(mailbox, async (client) => {
    const uids = (await client.search(searchCriteria(args), { uid: true })) as number[] | false;
    if (!uids || !uids.length) return `${mailbox}: 조건에 맞는 메일이 없습니다`;
    const rows: string[] = [];
    for await (const m of client.fetch(uids.slice(-limit), { envelope: true, flags: true }, { uid: true })) {
      const e = m.envelope ?? {};
      const f = e.from?.[0];
      const seen = m.flags?.has?.("\\Seen");
      rows.push(`- uid ${m.uid} | ${fmtDate(e.date)} | ${f?.name || f?.address || "?"}${f?.address ? ` <${f.address}>` : ""} | ${e.subject || "(제목 없음)"}${seen ? "" : " | 안읽음"}`);
    }
    return `${mailbox} — 조건 일치 ${uids.length}건 중 최근 ${rows.length}건 (제목만으로 요약하지 말 것 — 본문이 필요하면 uid들을 쉼표로 묶어 mail_read를 한 번 호출하세요)\n${rows.join("\n")}`;
  })) as string;
}

// uid는 쉼표·공백으로 여러 개를 받는다 — 연결 한 번에 여러 통을 읽기 위해서다
export function parseUids(args: Record<string, unknown>): string[] {
  const raw = args.uid ?? args.uids ?? args.id ?? args.ids;
  const list = Array.isArray(raw) ? raw.map(String) : String(raw ?? "").split(/[,\s]+/);
  return [...new Set(list.map((x) => x.trim()).filter((x) => /^\d+$/.test(x)))];
}

export async function mailRead(args: Record<string, unknown>): Promise<string> {
  const uids = parseUids(args);
  if (!uids.length) return "오류: 읽을 메일의 uid가 없습니다 — mail_list가 알려준 uid를 넣으세요 (여러 통은 \"101,102,103\"처럼 한 번에)";
  const mailbox = String(args.mailbox || "INBOX");
  const pick10 = uids.slice(0, 20);
  // 여러 통이면 본문을 짧게 — 한 응답에 20통이 들어가도 맥락이 넘치지 않게 한다
  const cap = pick10.length > 1 ? 2000 : 8000;
  return (await withMailbox(mailbox, async (client) => {
    const out: string[] = [];
    for (const uid of pick10) {
      const msg = await client.fetchOne(uid, { envelope: true, bodyStructure: true }, { uid: true });
      if (!msg) { out.push(`[uid ${uid}] 찾지 못했습니다 — mail_list로 uid를 다시 확인하세요`); continue; }
      const e = msg.envelope ?? {};
      const f = e.from?.[0];
      const pick = pickTextPart(msg.bodyStructure);
      let body = "";
      if (pick) {
        try {
          const { content } = await client.download(uid, pick.part, { uid: true });
          const chunks: Buffer[] = [];
          for await (const ch of content) chunks.push(ch as Buffer);
          const raw = Buffer.concat(chunks);
          // 사내 메일은 euc-kr인 경우가 있어 파트가 알려준 charset을 따른다
          try { body = new TextDecoder(pick.charset || "utf-8").decode(raw); } catch { body = raw.toString("utf8"); }
          if (pick.type === "text/html") body = htmlToText(body);
        } catch (err) {
          body = `(본문을 내려받지 못했습니다: ${(err as Error).message})`;
        }
      }
      const files = attachmentNames(msg.bodyStructure);
      const head = [
        `[uid ${uid}]`,
        `발신: ${f?.name || ""} <${f?.address ?? ""}>`,
        `수신시각: ${fmtDate(e.date)}`,
        `제목: ${e.subject || "(제목 없음)"}`,
        files.length ? `첨부: ${files.join(", ")}` : "첨부: 없음",
      ].join("\n");
      out.push(`${head}\n\n${body.slice(0, cap) || "(본문 없음)"}${body.length > cap ? `\n…(잘림 — 전체 ${body.length}자)` : ""}`);
    }
    const more = uids.length > pick10.length ? `\n\n(요청 ${uids.length}통 중 ${pick10.length}통만 읽었습니다 — 나머지는 다시 호출하세요)` : "";
    return out.join("\n\n———\n\n") + more;
  })) as string;
}

// 설정 화면의 연결 테스트 — 사서함에 접속해 최근 메일 수를 돌려준다
export async function testImap(): Promise<string | null> {
  const cfg = mailConfig();
  if (!cfg) return "IMAP 호스트·계정·비밀번호를 먼저 입력하세요";
  const r = await withMailbox("INBOX", async (client) => {
    const uids = (await client.search({ all: true }, { uid: true })) as number[] | false;
    return `ok:${uids ? uids.length : 0}`;
  });
  if (typeof r === "string" && r.startsWith("ok:")) return null;
  return String(r);
}
