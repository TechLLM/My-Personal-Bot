import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { db, getSetting, now, uid } from "./db";
import { compactResult } from "../../shared/user-facing";

export type CommandSource = "web" | "telegram" | "routine" | "notification";

export interface CreateCommandJob {
  source: CommandSource;
  conversationId?: string | null;
  assistantMessageId?: string | null;
  request: string;
  ownerAgentId?: string | null;
  dedupeKey?: string | null;
  taskMode?: string | null;        // 작업별 권한 모드 — 'readonly'|'guard'|null(기본). 위임된 하위 봇에게도 상속된다
}

const jobs = new AsyncLocalStorage<string>();

export const currentRootJobId = () => jobs.getStore() ?? null;
export const withRootJob = <T>(id: string, fn: () => T): T => jobs.run(id, fn);

const fingerprint = (value: string | null) => value
  ? createHash("sha256").update(value).digest("hex").slice(0, 24)
  : null;

const emailFingerprint = () => fingerprint([
  getSetting("smtp_host") ?? "", getSetting("smtp_port") ?? "",
  getSetting("smtp_user") ?? "", getSetting("smtp_from") ?? "",
].join("\n"));

export function createCommandJob(o: CreateCommandJob): string {
  if (o.dedupeKey) {
    const found = db.prepare("SELECT id FROM command_jobs WHERE source = ? AND dedupe_key = ?").get(o.source, o.dedupeKey) as { id: string } | null;
    if (found) return found.id;
  }
  const id = uid();
  try {
    db.prepare(`INSERT INTO command_jobs
      (id, source, conversation_id, assistant_message_id, request, owner_agent_id, dedupe_key,
       target_snapshot, credential_fingerprint, email_target_snapshot, email_credential_fingerprint, task_mode, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, o.source, o.conversationId ?? null, o.assistantMessageId ?? null,
        o.request, o.ownerAgentId ?? null, o.dedupeKey ?? null,
        getSetting("telegram_chat_id"), fingerprint(getSetting("telegram_bot_token")),
        getSetting("email_to"), emailFingerprint(),
        ["readonly", "guard"].includes(String(o.taskMode)) ? String(o.taskMode) : null, now(),
      );
  } catch (e) {
    if (!o.dedupeKey) throw e;
    const raced = db.prepare("SELECT id FROM command_jobs WHERE source = ? AND dedupe_key = ?").get(o.source, o.dedupeKey) as { id: string } | null;
    if (!raced) throw e;
    return raced.id;
  }
  if (o.assistantMessageId) db.prepare("UPDATE messages SET root_job_id = ?, command_status = 'running' WHERE id = ?").run(id, o.assistantMessageId);
  return id;
}

export function bindCommandMessage(rootJobId: string, assistantMessageId: string) {
  db.prepare("UPDATE command_jobs SET assistant_message_id = ? WHERE id = ?").run(assistantMessageId, rootJobId);
  db.prepare("UPDATE messages SET root_job_id = ? WHERE id = ?").run(rootJobId, assistantMessageId);
}

export function recordCommandResult(rootJobId: string | null | undefined, key: string, content: string, agentId?: string | null) {
  if (!rootJobId || !content.trim()) return;
  db.prepare(`INSERT INTO command_job_results (root_job_id, result_key, agent_id, content, created_at)
    SELECT ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM command_jobs WHERE id = ? AND status != 'completed')
    ON CONFLICT(root_job_id, result_key) DO UPDATE SET content = excluded.content, agent_id = excluded.agent_id`)
    .run(rootJobId, key, agentId ?? null, content, now(), rootJobId);
}

function blockers(rootJobId: string) {
  const approvals = (db.prepare("SELECT COUNT(*) n FROM approval_requests WHERE root_job_id = ? AND (status = 'pending' OR status = 'executing' OR (status = 'approved' AND result IS NULL))").get(rootJobId) as any).n as number;
  const messages = (db.prepare("SELECT COUNT(*) n FROM agent_messages WHERE root_job_id = ? AND status IN ('pending','processing')").get(rootJobId) as any).n as number;
  const runs = (db.prepare("SELECT COUNT(*) n FROM agent_runs WHERE root_job_id = ? AND status IN ('running','resumable')").get(rootJobId) as any).n as number;
  const credentials = (db.prepare("SELECT COUNT(*) n FROM credential_requests WHERE root_job_id = ? AND status = 'pending'").get(rootJobId) as any).n as number;
  return { approvals, messages, runs, credentials };
}

function combinedResult(rootJobId: string, fallback: string | null, aggregate: boolean, rootResultKey: string | null, ownerAgentId: string | null): string {
  const outcomes: string[] = [];
  const runErrors = db.prepare("SELECT result FROM agent_runs WHERE root_job_id = ? AND status IN ('error','interrupted') ORDER BY created_at, rowid").all(rootJobId) as { result: string | null }[];
  for (const row of runErrors) outcomes.push(`- 하위 작업 실패${row.result?.trim() ? `: ${row.result.trim()}` : ""}`);
  const approvals = db.prepare("SELECT status, result FROM approval_requests WHERE root_job_id = ? AND status IN ('denied','expired','failed') ORDER BY created_at, rowid").all(rootJobId) as { status: string; result: string | null }[];
  for (const row of approvals) outcomes.push(`- 승인 ${row.status === "denied" ? "거부" : row.status === "expired" ? "만료" : "처리 실패"}${row.result?.trim() ? `: ${row.result.trim()}` : ""}`);
  const failedMessages = db.prepare("SELECT reply FROM agent_messages WHERE root_job_id = ? AND status = 'failed' ORDER BY created_at, rowid").all(rootJobId) as { reply: string | null }[];
  for (const row of failedMessages) outcomes.push(`- 위임 작업 실패${row.reply?.trim() ? `: ${row.reply.trim()}` : ""}`);
  const credentials = db.prepare("SELECT status, reason FROM credential_requests WHERE root_job_id = ? AND status IN ('denied','dismissed','expired','failed','cancelled') ORDER BY created_at, rowid").all(rootJobId) as { status: string; reason: string | null }[];
  for (const row of credentials) outcomes.push(`- 계정 정보 요청 ${row.status === "expired" ? "만료" : row.status === "failed" ? "실패" : "취소·거절"}${row.reason?.trim() ? `: ${row.reason.trim()}` : ""}`);

  // 후속 작업이 root보다 먼저 끝난 경우에도 실패·거절 결과는 반드시 최종 결과에 포함한다.
  // 아무 실패도 없고 집계가 필요하지 않으면 원본 결과를 바이트 단위로 그대로 보존한다.
  if (!aggregate && !outcomes.length) return fallback ?? "(결과 없음)";

  const rows = db.prepare(`SELECT r.result_key, r.agent_id, r.content, COALESCE(a.name, '작업 결과') label, r.created_at
    FROM command_job_results r LEFT JOIN agents a ON a.id = r.agent_id
    WHERE r.root_job_id = ? AND (? IS NULL OR r.result_key != ?)
    ORDER BY r.created_at DESC, r.rowid DESC`).all(rootJobId, rootResultKey, rootResultKey) as { result_key: string; agent_id: string | null; label: string; content: string; created_at: number }[];

  const usable = rows.filter((r) => r.content.trim());
  const owner = ownerAgentId ? usable.find((r) => r.agent_id === ownerAgentId) : undefined;
  const selected = owner ? [owner] : usable.filter((r, i) => {
    // agent_id가 없는 승인·자격 증명 등의 결과는 서로 다른 결과 키를 별개로 유지한다.
    const identity = r.agent_id || r.result_key;
    return usable.findIndex((x) => (x.agent_id || x.result_key) === identity) === i;
  });
  const sections: string[] = [];
  const seen = new Set<string>();
  for (const row of selected) {
    const content = row.content.trim();
    if (seen.has(content)) continue;
    seen.add(content);
    sections.push(`## ${row.label}\n${content}`);
  }

  if (!sections.length && fallback !== null) sections.push(fallback);
  if (outcomes.length) sections.push(`## 부분 완료 — 완료하지 못한 항목\n${outcomes.join("\n")}`);
  return sections.length ? sections.join("\n\n---\n\n") : (fallback ?? "완료된 결과를 확인할 수 없습니다.");
}

export async function completeCommand(rootJobId: string, fullResult: string, resultKey = "root") {
  const claimed = db.prepare(`UPDATE command_jobs SET execution_done = 1, full_result = ?, root_result_key = ?
    WHERE id = ? AND execution_done = 0 AND status != 'completed'`).run(fullResult, resultKey, rootJobId);
  if (!claimed.changes) {
    await finalizeCommandIfReady(rootJobId);
    return;
  }
  recordCommandResult(rootJobId, resultKey, fullResult);
  const b = blockers(rootJobId);
  db.prepare("UPDATE command_jobs SET needs_final_aggregation = ? WHERE id = ?")
    .run(b.approvals || b.messages || b.runs || b.credentials ? 1 : 0, rootJobId);
  await finalizeCommandIfReady(rootJobId);
}

export async function childCommandFinished(rootJobId: string | null | undefined, key: string, content: string, agentId?: string | null) {
  if (!rootJobId) return;
  recordCommandResult(rootJobId, key, content, agentId);
  await finalizeCommandIfReady(rootJobId);
}

export async function finalizeCommandIfReady(rootJobId: string) {
  const job = db.prepare("SELECT * FROM command_jobs WHERE id = ?").get(rootJobId) as any;
  if (!job || !job.execution_done || job.status === "completed") return false;
  const b = blockers(rootJobId);
  if (b.approvals || b.credentials) {
    db.prepare("UPDATE command_jobs SET status = 'waiting_approval' WHERE id = ?").run(rootJobId);
    setMessageStatus(job.assistant_message_id, "waiting_approval");
    await deliverTelegramActionNeeded(rootJobId);
    return false;
  }
  if (b.messages || b.runs) {
    db.prepare("UPDATE command_jobs SET status = 'waiting_children' WHERE id = ?").run(rootJobId);
    setMessageStatus(job.assistant_message_id, "waiting_children");
    return false;
  }

  const full = combinedResult(rootJobId, job.full_result, !!job.needs_final_aggregation, job.root_result_key, job.owner_agent_id);
  const content = compactResult(full);

  // 완료 소유권 CAS와 최종 원문·표시 메시지 저장을 한 트랜잭션으로 확정한다.
  // 메시지 저장이 실패하면 completed 전환도 롤백되므로 후속 호출이 다시 마무리할 수 있다.
  const persistFinal = db.transaction(() => {
    const claimed = db.prepare(`UPDATE command_jobs SET status = 'completed', full_result = ?, finished_at = ?
      WHERE id = ? AND execution_done = 1 AND status != 'completed'`).run(full, now(), rootJobId);
    if (!claimed.changes) return false;
    if (job.assistant_message_id) {
      db.prepare("UPDATE messages SET content = ?, full_content = ?, command_status = 'completed' WHERE id = ?")
        .run(content, full, job.assistant_message_id);
    }
    return true;
  });
  if (!persistFinal()) return false;

  const forceTelegram = job.source === "telegram";
  if (forceTelegram || getSetting("notify_telegram") === "1") await deliverTelegramOnce(rootJobId, content);
  if (getSetting("notify_email") === "1") await deliverEmailOnce(rootJobId, full);
  return true;
}

function setMessageStatus(messageId: string | null, status: string) {
  if (messageId) db.prepare("UPDATE messages SET command_status = ? WHERE id = ?").run(status, messageId);
}

function reserveDelivery(rootJobId: string, channel: string, target: string | null, status = "sending", credential = fingerprint(getSetting("telegram_bot_token"))): boolean {
  try {
    db.prepare("INSERT INTO command_deliveries (root_job_id, channel, target, target_fingerprint, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(rootJobId, channel, target, credential, status, now(), now());
    return true;
  } catch {
    return false;
  }
}

function finishDelivery(rootJobId: string, channel: string, status: string, error?: string | null) {
  db.prepare("UPDATE command_deliveries SET status = ?, error = ?, updated_at = ? WHERE root_job_id = ? AND channel = ?")
    .run(status, error ?? null, now(), rootJobId, channel);
}

async function deliverTelegramOnce(rootJobId: string, content: string) {
  await serializeTelegram(rootJobId, async () => {
  const job = db.prepare("SELECT target_snapshot, credential_fingerprint FROM command_jobs WHERE id = ?").get(rootJobId) as any;
  if (!job) return;
  const target = job.target_snapshot;
  let delivery = db.prepare("SELECT * FROM command_deliveries WHERE root_job_id = ? AND channel = 'telegram'").get(rootJobId) as any;
  if (process.env.MYBOT_ENV === "dev") {
    if (!delivery) reserveDelivery(rootJobId, "telegram", target, "suppressed_dev", job.credential_fingerprint);
    return;
  }
  let newlyReserved = false;
  if (!delivery) {
    newlyReserved = reserveDelivery(rootJobId, "telegram", target, "sending_final", job.credential_fingerprint);
    if (!newlyReserved) return;
    delivery = db.prepare("SELECT * FROM command_deliveries WHERE root_job_id = ? AND channel = 'telegram'").get(rootJobId) as any;
  }
  if (delivery.status === "waiting_action" && delivery.external_message_id) {
    const claimed = db.prepare("UPDATE command_deliveries SET status = 'editing_final', updated_at = ? WHERE root_job_id = ? AND channel = 'telegram' AND status = 'waiting_action' AND external_message_id IS NOT NULL").run(now(), rootJobId);
    if (!claimed.changes) return;
  } else if (!newlyReserved) {
    // 재기동 전 호출자가 남긴 sending_final을 포함해 기존 영수증의 소유권을 추측하지 않는다.
    return;
  }
  if (String(target ?? "") !== String(getSetting("telegram_chat_id") ?? "") || job.credential_fingerprint !== fingerprint(getSetting("telegram_bot_token"))) {
    finishDelivery(rootJobId, "telegram", "failed", "등록된 텔레그램 대상 또는 계정이 작업 도중 변경됨");
    return;
  }
  const { sendTelegramDetailed } = await import("./notify");
  const sent = await sendTelegramDetailed(`작업 결과\n\n${content}`, delivery.external_message_id ? { messageId: delivery.external_message_id, chatId: target } : { chatId: target });
  db.prepare("UPDATE command_deliveries SET status = ?, external_message_id = COALESCE(?, external_message_id), error = ?, updated_at = ? WHERE root_job_id = ? AND channel = 'telegram'")
    .run(sent.error ? (sent.unknown ? "delivery_unknown" : "failed") : "sent", sent.messageId ?? null, sent.error, now(), rootJobId);
  });
}

async function deliverEmailOnce(rootJobId: string, full: string) {
  const job = db.prepare("SELECT email_target_snapshot, email_credential_fingerprint FROM command_jobs WHERE id = ?").get(rootJobId) as any;
  if (!job || db.prepare("SELECT 1 FROM command_deliveries WHERE root_job_id = ? AND channel = 'email'").get(rootJobId)) return;
  if (process.env.MYBOT_ENV === "dev") {
    reserveDelivery(rootJobId, "email", job.email_target_snapshot, "suppressed_dev", job.email_credential_fingerprint);
    return;
  }
  if (!reserveDelivery(rootJobId, "email", job.email_target_snapshot, "sending_final", job.email_credential_fingerprint)) return;
  if (String(job.email_target_snapshot ?? "") !== String(getSetting("email_to") ?? "") || job.email_credential_fingerprint !== emailFingerprint()) {
    finishDelivery(rootJobId, "email", "failed", "등록된 메일 대상 또는 계정이 작업 도중 변경됨");
    return;
  }
  const { sendEmail } = await import("./notify");
  const err = await sendEmail("[MyBot] 작업 결과", full);
  finishDelivery(rootJobId, "email", err ? (err === "suppressed_dev" ? "suppressed_dev" : err.startsWith("메일 오류:") ? "delivery_unknown" : "failed") : "sent", err);
}

const telegramTails = new Map<string, Promise<void>>();
async function serializeTelegram(rootJobId: string, fn: () => Promise<void>) {
  const prev = telegramTails.get(rootJobId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  telegramTails.set(rootJobId, next);
  try { await next; } finally { if (telegramTails.get(rootJobId) === next) telegramTails.delete(rootJobId); }
}

export async function deliverTelegramActionNeeded(rootJobId: string) {
  await serializeTelegram(rootJobId, async () => {
    const job = db.prepare("SELECT source, status, target_snapshot, credential_fingerprint FROM command_jobs WHERE id = ?").get(rootJobId) as any;
    if (job?.source !== "telegram" || job.status !== "waiting_approval") return;
    const b = blockers(rootJobId);
    if (!b.approvals && !b.credentials) return;
    if (db.prepare("SELECT 1 FROM command_deliveries WHERE root_job_id = ? AND channel = 'telegram'").get(rootJobId)) return;
    const target = job.target_snapshot;
    if (process.env.MYBOT_ENV === "dev") {
      reserveDelivery(rootJobId, "telegram", target, "suppressed_dev", job.credential_fingerprint);
      return;
    }
    if (!reserveDelivery(rootJobId, "telegram", target, "sending_action", job.credential_fingerprint)) return;
    if (String(target ?? "") !== String(getSetting("telegram_chat_id") ?? "") || job.credential_fingerprint !== fingerprint(getSetting("telegram_bot_token"))) {
      finishDelivery(rootJobId, "telegram", "failed", "등록된 텔레그램 대상 또는 계정이 변경됨"); return;
    }
    const { sendTelegramDetailed } = await import("./notify");
    const sent = await sendTelegramDetailed("사용자 확인이 필요한 작업이 있습니다. MyBot 화면에서 확인해 주세요.", { chatId: target });
    db.prepare("UPDATE command_deliveries SET status = ?, external_message_id = ?, error = ?, updated_at = ? WHERE root_job_id = ? AND channel = 'telegram'")
      .run(sent.error ? (sent.unknown ? "delivery_unknown" : "failed") : "waiting_action", sent.messageId ?? null, sent.error ?? null, now(), rootJobId);
  });
}

// 재기동 시 sending을 재전송하지 않는다. 전달 여부가 불명확하다는 기록만 확정한다.
export function markInterruptedDeliveriesUnknown() {
  db.prepare("UPDATE command_deliveries SET status = 'delivery_unknown', error = COALESCE(error, '서버 재시작 중 전달 결과 미확인'), updated_at = ? WHERE status IN ('sending','sending_final','editing_final','sending_action')")
    .run(now());
}

/** 재기동 뒤 실행 주체가 사라진 미완료 명령을 외부 재전송 없이 영구 중단 처리하고 처리 건수를 반환한다. */
export function recoverInterruptedCommands(): number {
  const recover = db.transaction(() => {
    markInterruptedDeliveriesUnknown();
    const rows = db.prepare(`SELECT id, assistant_message_id FROM command_jobs
      WHERE status != 'completed' AND status != 'awaiting_confirmation'`).all() as { id: string; assistant_message_id: string | null }[];
    const message = "서버가 재시작되어 진행 중이던 작업을 안전하게 중단했습니다. 이전 승인과 계정 정보 요청은 더 이상 실행할 수 없으므로 필요하면 새로 요청해 주세요. 결과 전달 여부가 불명확한 외부 전송은 자동 재시도하지 않습니다.";
    let recovered = 0;
    for (const row of rows) {
      db.prepare(`UPDATE approval_requests SET status = 'expired', result = COALESCE(result, ?), resolved_at = ?
        WHERE root_job_id = ? AND (status IN ('pending','executing') OR (status = 'approved' AND result IS NULL))`).run(message, now(), row.id);
      db.prepare("UPDATE credential_requests SET status = 'expired' WHERE root_job_id = ? AND status = 'pending'").run(row.id);
      db.prepare("UPDATE agent_messages SET status = 'failed', reply = COALESCE(reply, ?), done_at = ? WHERE root_job_id = ? AND status IN ('pending','processing')").run(message, now(), row.id);
      db.prepare("UPDATE agent_runs SET status = 'interrupted', result = COALESCE(result, ?), finished_at = ? WHERE root_job_id = ? AND status IN ('running','resumable')").run(message, now(), row.id);
      recordCommandResult(row.id, "recovery:interrupted", message);
      const claimed = db.prepare("UPDATE command_jobs SET execution_done = 1, status = 'completed', full_result = ?, finished_at = ? WHERE id = ? AND status != 'completed' AND status != 'awaiting_confirmation'").run(message, now(), row.id);
      if (!claimed.changes) continue;
      recovered++;
      if (row.assistant_message_id) db.prepare("UPDATE messages SET content = ?, full_content = ?, command_status = 'interrupted' WHERE id = ?").run(compactResult(message), message, row.assistant_message_id);
    }
    return recovered;
  });
  return recover();
}
