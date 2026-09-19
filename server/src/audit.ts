// ─── 조직 설계 점검 ───
// 점검을 모델 판단에 맡기면 모델마다 놓치는 항목이 달라진다. 규칙을 코드로 고정해
// 어떤 모델이 실행하든 같은 결과가 나오게 한다. 봇은 이 결과를 읽고 보고서로 정리만 한다.
import { db } from "./db";
import { findProvider } from "./providers/registry";

export type Severity = "위험" | "주의" | "참고";

export interface Finding {
  id: string;          // 규칙 id — 보고서에서 추적용
  severity: Severity;
  title: string;
  detail: string;      // 발견된 대상과 수치
  fix: string;         // 수정 방법
}

interface AgentRow {
  id: string; name: string; role_prompt: string; model: string | null;
  is_boss: number; is_lead: number; parent_id: string | null; special_role: string | null; max_children: number | null;
}

const MIN_ROLE_LEN = 100;      // 역할문이 이보다 짧으면 봇이 자기 일을 스스로 판단하지 못한다
const MIN_ROUTINE_LEN = 60;    // routine_add 가드와 같은 기준
const AGENT_CAP = 20;          // 전체 봇 정원
const PENDING_STALE_H = 24;    // 이 시간을 넘긴 승인 대기는 사실상 방치된 것

// 같은 문단이 되풀이되는지 — 프롬프트를 덧붙이는 코드가 멱등하지 않으면 이렇게 쌓인다
export function repeatedParagraph(text: string): { text: string; count: number } | null {
  const seen = new Map<string, number>();
  for (const raw of (text || "").split(/\n\n+/)) {
    const t = raw.trim();
    if (t.length < 30) continue;
    seen.set(t, (seen.get(t) ?? 0) + 1);
  }
  let worst: { text: string; count: number } | null = null;
  for (const [t, n] of seen) if (n > 1 && (!worst || n > worst.count)) worst = { text: t, count: n };
  return worst;
}

// 모델 id가 쓸 수 있는 형태인지 — 네트워크 없이 형식과 프로바이더 등록 여부만 본다
export function modelProblem(model: string | null): string | null {
  const m = (model ?? "").trim();
  if (!m) return "모델 미지정";
  const sep = m.indexOf("/");
  if (sep <= 0) return `형식 오류(provider/model 이어야 함): ${m}`;
  const pid = m.slice(0, sep);
  return findProvider(pid) ? null : `등록되지 않은 프로바이더: ${pid}`;
}

export function auditOrg(): Finding[] {
  const f: Finding[] = [];
  const agents = db.prepare("SELECT * FROM agents").all() as AgentRow[];
  const byId = new Map(agents.map((a) => [a.id, a]));
  const add = (id: string, severity: Severity, title: string, detail: string, fix: string) => f.push({ id, severity, title, detail, fix });

  // ── 봇 트리 ──
  const bosses = agents.filter((a) => a.is_boss);
  if (bosses.length === 0) add("tree.no_boss", "위험", "CEO 봇이 없습니다", "is_boss=1인 봇 0개", "봇 하나를 CEO로 지정하세요(설정 > 에이전트 봇).");
  if (bosses.length > 1) add("tree.multi_boss", "위험", "CEO 봇이 둘 이상입니다", bosses.map((b) => b.name).join(", "), "하나만 남기고 나머지는 CEO 지정을 해제하세요.");

  for (const a of agents) {
    if (!a.parent_id) continue;
    const p = byId.get(a.parent_id);
    if (!p) { add("tree.orphan", "위험", "삭제된 봇을 상위로 참조", `${a.name} → 없는 봇(${a.parent_id})`, "상위를 비우거나 실제 팀장으로 다시 지정하세요."); continue; }
    if (!p.is_lead && !p.is_boss) add("tree.parent_not_lead", "주의", "팀장이 아닌 봇이 상위로 지정됨", `${a.name} → ${p.name}`, "상위를 팀장 또는 CEO로 바꾸세요.");
    if (p.parent_id) add("tree.depth", "주의", "업무 트리가 2단계를 넘습니다", `${a.name} → ${p.name} → ${byId.get(p.parent_id)?.name ?? "?"}`, "CEO → 팀장 → 봇 2단계로 맞추세요.");
    if (a.special_role) add("tree.special_parent", "주의", "특수 역할 봇에 상위가 설정됨", `${a.name}(${a.special_role})`, "특수 역할 봇은 CEO 직속이어야 합니다.");
  }

  for (const lead of agents.filter((a) => a.is_lead && !a.is_boss)) {
    const kids = agents.filter((a) => a.parent_id === lead.id).length;
    const cap = lead.max_children ?? 4;
    if (kids > cap) add("tree.over_children", "주의", "팀장의 하위 봇이 한도를 넘었습니다", `${lead.name}: ${kids}개 / 한도 ${cap}`, "한도를 올리거나 일부 봇을 재배치하세요.");
  }
  if (agents.length > AGENT_CAP) add("tree.over_cap", "주의", "전체 봇이 정원을 넘었습니다", `${agents.length}개 / 정원 ${AGENT_CAP}`, "쓰지 않는 봇을 정리하세요.");

  // ── 역할문 ──
  for (const a of agents) {
    const role = a.role_prompt ?? "";
    if (!role.trim()) add("role.empty", "위험", "역할문이 비어 있습니다", a.name, "그 봇이 무엇을 어떤 기준으로 하는지 역할문에 적으세요.");
    else if (role.length < MIN_ROLE_LEN) add("role.short", "주의", "역할문이 너무 짧습니다", `${a.name}: ${role.length}자`, "담당 범위·완료 기준·금지사항을 포함해 보강하세요.");
    const dup = repeatedParagraph(role);
    if (dup) add("role.repeat", "위험", "역할문에 같은 문단이 반복됩니다", `${a.name}: ${dup.count}회 반복 — "${dup.text.slice(0, 40)}…"`, "중복 문단을 1개만 남기세요(프롬프트를 덧붙이는 코드가 멱등한지도 확인).");
    const mp = modelProblem(a.model);
    if (mp) add("model.invalid", "위험", "봇 모델을 쓸 수 없습니다", `${a.name}: ${mp}`, "설정에서 사용 가능한 모델로 바꾸세요.");
  }

  // ── 루틴 ──
  const routines = db.prepare("SELECT * FROM routines").all() as any[];
  const slots = new Map<string, string[]>();
  for (const r of routines) {
    if (!r.prompt || String(r.prompt).length < MIN_ROUTINE_LEN)
      add("routine.weak", "위험", "루틴 지시문이 부실합니다", `${r.name}: ${String(r.prompt ?? "").length}자`, "실행 시점에는 대화 맥락이 없습니다 — 범위·형식·완료 기준을 담아 다시 쓰세요.");
    if (r.agent_id && !byId.get(r.agent_id))
      add("routine.orphan", "위험", "루틴 담당 봇이 없습니다", `${r.name} → 삭제된 봇`, "담당 봇을 다시 지정하거나 루틴을 삭제하세요.");
    if (!r.enabled) add("routine.disabled", "참고", "꺼져 있는 루틴", r.name, "쓰지 않으면 삭제하고, 쓸 것이면 켜세요.");
    if (r.trigger_type !== "email" && r.schedule) {
      const list = slots.get(r.schedule) ?? [];
      list.push(r.name); slots.set(r.schedule, list);
    }
  }
  for (const [sched, names] of slots)
    if (names.length > 1) add("routine.collision", "참고", "같은 시각에 여러 루틴이 실행됩니다", `${sched}: ${names.join(", ")}`, "시간을 나누면 모델 호출이 몰리지 않습니다.");

  // ── 스킬 ──
  for (const s of db.prepare("SELECT * FROM skills").all() as any[]) {
    if (s.disabled) add("skill.disabled", "주의", "꺼진 스킬", s.name, "성공률 미달로 자동 비활성됐을 수 있습니다 — 절차를 고쳐 다시 켜거나 삭제하세요.");
    // 짧은 프롬프트는 "요약·번역" 같은 기본 템플릿이라 적용 조건이 필요 없다 — 학습된 절차 스킬만 본다
    if (String(s.prompt ?? "").length >= 200 && !String(s.prompt ?? "").includes("[적용 조건]"))
      add("skill.no_condition", "참고", "적용 조건이 없는 스킬", s.name, "[적용 조건]을 적어야 봇이 언제 쓸지 판단합니다.");
  }
  for (const r of db.prepare("SELECT s.name, COUNT(*) n, COALESCE(SUM(r.ok),0) ok FROM skill_runs r JOIN skills s ON s.id = r.skill_id WHERE r.ok IS NOT NULL GROUP BY s.name HAVING n >= 3").all() as any[])
    if (r.ok / r.n < 0.5) add("skill.low_success", "주의", "스킬 성공률이 낮습니다", `${r.name}: ${r.ok}/${r.n}`, "실패 사례를 절차에 반영하세요.");

  // ── 운영 지표(최근 7일) ──
  const since = Date.now() - 7 * 86_400_000;
  const runs = db.prepare("SELECT status, steps FROM agent_runs WHERE created_at > ?").all(since) as { status: string; steps: number | null }[];
  if (runs.length >= 10) {
    const err = runs.filter((r) => r.status === "error").length;
    if (err / runs.length > 0.1) add("ops.fail_rate", "위험", "최근 7일 실패율이 높습니다", `${err}/${runs.length} (${Math.round((err / runs.length) * 100)}%)`, "실패 결과의 사유를 확인하세요 — 프로바이더 인증·한도 문제가 흔합니다.");
    const capped = runs.filter((r) => (r.steps ?? 0) >= 12).length;
    if (capped / runs.length > 0.2) add("ops.step_cap", "주의", "단계 상한에 걸리는 실행이 많습니다", `${capped}/${runs.length}`, "반복 조회를 줄이거나 tool_rounds·tool_rounds_browser를 조정하세요.");
  }
  const stale = db.prepare("SELECT COUNT(*) c FROM approval_requests WHERE status = 'pending' AND created_at < ?").get(Date.now() - PENDING_STALE_H * 3_600_000) as { c: number };
  if (stale.c > 0) add("ops.stale_approval", "위험", "오래 방치된 승인 대기가 있습니다", `${stale.c}건 (${PENDING_STALE_H}시간 초과)`, "화면에서 승인하거나 거부하세요 — 그동안 해당 업무는 멈춰 있습니다.");
  const exp = db.prepare("SELECT COUNT(*) c FROM approval_requests WHERE status = 'expired'").get() as { c: number };
  const apr = db.prepare("SELECT COUNT(*) c FROM approval_requests").get() as { c: number };
  if (apr.c >= 20 && exp.c / apr.c > 0.2) add("ops.expired_rate", "주의", "만료된 승인이 많습니다", `${exp.c}/${apr.c}`, "승인 대상이 과한지 검토하세요 — 조회성 도구까지 막고 있을 수 있습니다.");

  const order: Severity[] = ["위험", "주의", "참고"];
  return f.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
}

// 도구 결과로 돌려줄 텍스트 — 봇은 이 내용을 옮겨 적기만 하면 된다
export function formatAudit(findings: Finding[]): string {
  const counts = { 위험: 0, 주의: 0, 참고: 0 } as Record<Severity, number>;
  for (const x of findings) counts[x.severity]++;
  const head = `조직 설계 점검 — 위험 ${counts.위험} / 주의 ${counts.주의} / 참고 ${counts.참고} (규칙 기반 점검이라 실행 모델과 무관하게 같은 결과가 나옵니다)`;
  if (!findings.length) return `${head}\n\n발견된 문제 없음.`;
  const lines = findings.map((x) => `[${x.severity}] ${x.title} (${x.id})\n  - 대상: ${x.detail}\n  - 조치: ${x.fix}`);
  return `${head}\n\n${lines.join("\n\n")}`;
}
