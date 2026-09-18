// ─── IMAP 메일 조회 ───
// 그룹웨어 화면을 브라우저로 긁는 대신 메일 서버에서 직접 읽는다.
// 실측 2026-09-18: 브라우저 경로는 로그인·진입에 10라운드, 본문 1건당 클릭 1라운드가 들어
// "오늘 메일 상세 보고"가 8건 중 2건만 열고 단계 상한으로 끝났다. IMAP은 목록 1회·본문 1회면 된다.
import { getSetting } from "./db";

export interface MailCfg { host: string; port: number; user: string; pass: string; secure: boolean }

export function mailConfig(): MailCfg | null {
  const host = getSetting("imap_host"), user = getSetting("imap_user"), pass = getSetting("imap_pass");
  if (!host || !user || !pass) return null;
  const port = Number(getSetting("imap_port")) || 993;
  // 993은 암시적 TLS 전용 포트다 — 체크박스가 꺼져 있어도 TLS로 붙는다.
  // (실측 2026-09-18: 993 + 평문은 "Failed to receive greeting from server. Maybe should use TLS?"로 연결 자체가 실패했다)
  return { host, port, user, pass, secure: port === 993 || getSetting("imap_tls") !== "0" };
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
  return c; // 조건이 없으면 빈 객체 — 호출부가 "최근 N건" 경로로 처리한다
}

// 본문으로 읽을 파트 — text/plain 우선, 없으면 text/html
export interface TextPart { part: string; type: string; charset?: string; encoding?: string }
export function pickTextPart(node: any): TextPart | null {
  if (!node) return null;
  const type = String(node.type ?? "").toLowerCase();
  if (type === "text/plain" || type === "text/html") {
    return { part: String(node.part || "1"), type, charset: node.parameters?.charset, encoding: node.encoding };
  }
  let html: TextPart | null = null;
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

// fetch(bodyParts)로 받은 조각을 디코딩한다 — download와 달리 전송 인코딩이 풀리지 않은 raw다.
// 전송 인코딩(base64·quoted-printable)은 반드시 **바이트 단계에서 먼저** 풀고 그 다음 charset을 적용한다.
// 순서를 바꾸면 =ED=95=9C 같은 한글 바이트가 개별 문자로 해석돼 깨진다
export function decodeBodyChunk(raw: Buffer, part: TextPart): string {
  const enc = String(part.encoding ?? "").toLowerCase();
  let buf = raw;
  if (enc === "base64") {
    try { buf = Buffer.from(raw.toString("ascii").replace(/\s+/g, ""), "base64"); } catch {}
  } else if (enc === "quoted-printable") {
    const ascii = raw.toString("ascii").replace(/=\r?\n/g, ""); // soft line break
    const bytes: number[] = [];
    for (let i = 0; i < ascii.length; i++) {
      const hex = ascii.slice(i + 1, i + 3);
      if (ascii[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) { bytes.push(parseInt(hex, 16)); i += 2; }
      else bytes.push(ascii.charCodeAt(i));
    }
    buf = Buffer.from(bytes);
  }
  let text: string;
  try { text = new TextDecoder(part.charset || "utf-8").decode(buf); } catch { text = buf.toString("utf8"); }
  if (part.type === "text/html") text = htmlToText(text);
  return text.replace(/\s+/g, " ").trim();
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
  const preview = args.preview !== false && args.preview !== "false";
  return (await withMailbox(mailbox, async (client) => {
    const crit = searchCriteria(args);
    let range: string | number[];
    let total: number;
    let byUid = true;
    if (Object.keys(crit).length) {
      const uids = (await client.search(crit, { uid: true })) as number[] | false;
      if (!uids || !uids.length) return `${mailbox}: 조건에 맞는 메일이 없습니다`;
      total = uids.length;
      range = uids.slice(-limit);
    } else {
      // 조건이 없을 때 ALL 검색에 기대지 않는다 — 0건을 돌려주는 서버가 있다(DOPMAIL 실측).
      // 사서함이 알려주는 전체 개수에서 끝의 limit건을 시퀀스로 직접 가져온다
      total = (client.mailbox as { exists?: number })?.exists ?? 0;
      if (!total) return `${mailbox}: 메일이 없습니다`;
      range = `${Math.max(1, total - limit + 1)}:${total}`;
      byUid = false;
    }
    const metas: { uid: number; line: string; part: TextPart | null }[] = [];
    for await (const m of client.fetch(range, { envelope: true, flags: true, bodyStructure: preview }, { uid: byUid })) {
      const e = m.envelope ?? {};
      const f = e.from?.[0];
      const seen = m.flags?.has?.("\\Seen");
      metas.push({
        uid: Number(m.uid),
        line: `- uid ${m.uid} | ${fmtDate(e.date)} | ${f?.name || f?.address || "?"}${f?.address ? ` <${f.address}>` : ""} | ${e.subject || "(제목 없음)"}${seen ? "" : " | 안읽음"}`,
        part: preview ? pickTextPart(m.bodyStructure) : null,
      });
    }
    metas.reverse(); // 최신이 위로

    // 본문 앞부분을 같은 연결에서 함께 받아 각 줄에 붙인다 —
    // 목록에 제목만 있으면 봇이 제목으로만 요약하고 광고·업무 분류도 틀린다 (2026-09-18 실측)
    if (preview && metas.length) {
      const byPart = new Map<string, number[]>();
      for (const m of metas) if (m.part) byPart.set(m.part.part, [...(byPart.get(m.part.part) ?? []), m.uid]);
      const got = new Map<number, string>();
      for (const [part, uids] of byPart) {
        try {
          for await (const r of client.fetch(uids, { bodyParts: [{ key: part, start: 0, maxLength: 700 }] }, { uid: true })) {
            const raw = r.bodyParts?.get?.(part) as Buffer | undefined;
            const meta = metas.find((x) => x.uid === Number(r.uid));
            if (raw?.length && meta?.part) got.set(Number(r.uid), decodeBodyChunk(raw, meta.part));
          }
        } catch {} // 미리보기는 부가 정보 — 실패해도 목록은 돌려준다
      }
      for (const m of metas) {
        const t = got.get(m.uid);
        if (t) m.line += `\n    ↳ ${t.slice(0, 200)}${t.length > 200 ? "…" : ""}`;
      }
    }
    const head = `${mailbox} — ${Object.keys(crit).length ? `조건 일치 ${total}건` : `전체 ${total}건`} 중 최근 ${metas.length}건`;
    const guide = preview
      ? `\n\n[↳ 는 본문 앞부분입니다] 분류·개요는 이것으로 판단하고, 요청사항·기한·첨부처럼 정확한 내용이 필요한 메일만 골라 본문을 읽으세요.\n[본문 읽기] mail_read(uid: "${metas.slice(0, 15).map((m) => m.uid).join(",")}") — 이렇게 여러 통을 한 번에 넣으세요. 한 통씩 나눠 부르지 마세요`
      : `\n\n(제목만으로 요약하지 말 것 — 본문이 필요하면 uid들을 쉼표로 묶어 mail_read를 한 번 호출하세요)`;
    return `${head}${guide}\n${metas.map((m) => m.line).join("\n")}`;
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
  const r = await withMailbox("INBOX", async (client) => `ok:${(client.mailbox as { exists?: number })?.exists ?? 0}`);
  return typeof r === "string" && r.startsWith("ok:") ? null : String(r);
}
