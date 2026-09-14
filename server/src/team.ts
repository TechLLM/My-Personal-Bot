import { Hono } from "hono";
import { db, uid, now } from "./db";
import type { Endpoint } from "./providers";
import { resolveModel, modelLabel } from "./providers";
import { chatOnce, streamChat, type ChatMessage } from "./providers/openaiCompat";
import { systemPrompt } from "./routes/chat";
import { notifyResult } from "./notify";
import { webSearch } from "./search";
import { mcpConfigured, mcpTools, mcpCall } from "./mcp";
import { BROWSER_TOOLS, browserTool, closeAgentPage } from "./browser";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

// 에이전트 공용 작업 디렉터리 — 파일 도구는 여기로 샌드박스
const WORK_DIR = join(import.meta.dir, "..", "data", "workspace");
mkdirSync(WORK_DIR, { recursive: true });

export interface Agent {
  id: string;
  name: string;
  role_prompt: string;
  model: string | null;
  avatar: string | null;
  tools: string | null;
  persistent: number;
  is_boss: number;
  created_at: number;
}

// 대장 봇 — 모든 사용자 대화의 기본 접점. 없으면 시드
export const BOSS_NAME = "대장";

const BOSS_ROLE = "당신은 MyBot의 CEO(총괄 관리자) 봇입니다. 사용자의 모든 업무 지시를 받는 총괄 책임자이며, 새로 생성되는 모든 봇의 관리자입니다. 스스로 도구(웹검색·파일·브라우저·MCP)를 사용해 직접 수행하거나, 필요하면 전문 역할 봇들에게 분배하고 결과를 종합해 보고합니다. 봇 관리: agent_list로 전체 봇 현황 확인, agent_direct로 임의 봇에게 즉시 업무 지시(결과를 받아 종합), agent_update로 봇의 역할·모델 수정, agent_delete로 불필요한 봇 정리. 사용자가 반복적·정기적 작업을 요청하면 routine_add 도구로 예약 작업으로 등록하세요 — 일회성 실행으로 처리하지 마세요. 이전 대화와 기억한 맥락을 바탕으로 업무의 연속성을 유지하세요.";

// 사용자가 지정한 CEO 봇 반환 — 없으면 대장 시드
export function ensureBossAgent(): Agent {
  let a = db.prepare("SELECT * FROM agents WHERE is_boss = 1 LIMIT 1").get() as Agent | null;
  if (!a) {
    const id = uid();
    db.prepare("INSERT INTO agents (id, name, role_prompt, model, avatar, tools, persistent, is_boss, created_at) VALUES (?, ?, ?, ?, ?, NULL, 1, 1, ?)")
      .run(id, BOSS_NAME, BOSS_ROLE, "main", "🧭", now());
    a = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Agent;
  } else if (!a.role_prompt.includes("agent_direct")) {
    // CEO 관리 지침이 없으면 기본 역할문에 추가 (사용자가 직접 쓴 역할문이면 뒤에 덧붙임)
    const role = a.role_prompt.includes("MyBot의 CEO") ? BOSS_ROLE : `${a.role_prompt}\n\n[CEO 권한] 당신은 모든 봇의 관리자입니다. agent_list(봇 현황), agent_direct(봇에게 즉시 지시), agent_update(역할·모델 수정), agent_delete(봇 정리), routine_add(예약 등록) 도구를 사용할 수 있습니다.`;
    db.prepare("UPDATE agents SET role_prompt = ? WHERE id = ?").run(role, a.id);
    a.role_prompt = role;
  }
  return a;
}

export function getAgent(id: string | null | undefined): Agent | null {
  if (!id) return null;
  return (db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Agent | null) ?? null;
}

export interface TeamAgentState {
  id: string;
  runId: string;
  name: string;
  avatar: string;
  role: string;
  task: string;
  model: string;
  status: "running" | "done" | "error";
  result?: string;
  steps: number;
}

type Emit = (ev: object) => void;

function safePath(p: string): string {
  const clean = p.replace(/^\/+/, "").split("/").filter((s) => s !== "..").join("/");
  return join(WORK_DIR, clean);
}

export const BUILTIN_TOOLS = [
  { type: "function", function: { name: "web_search", description: "웹에서 정보를 검색합니다", parameters: { type: "object", properties: { query: { type: "string", description: "검색어" } }, required: ["query"] } } },
  { type: "function", function: { name: "read_file", description: "팀 작업 디렉터리의 파일을 읽습니다", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "팀 작업 디렉터리에 파일을 저장합니다", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "list_files", description: "팀 작업 디렉터리의 파일 목록", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "routine_add", description: "예약 작업(루틴)을 등록합니다. 사용자가 반복·정기 작업을 요청할 때 사용하세요. 이 봇의 담당 업무로 등록됩니다", parameters: { type: "object", properties: { name: { type: "string", description: "루틴 이름" }, prompt: { type: "string", description: "매번 실행할 작업 지시" }, schedule: { type: "string", description: "every:30m | every:Nh | daily:HH:MM" } }, required: ["name", "prompt", "schedule"] } } },
  { type: "function", function: { name: "routine_list", description: "등록된 예약 작업 목록", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "routine_delete", description: "예약 작업 삭제 (id는 routine_list로 확인)", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } } },
];

// CEO 봇 전용 — 다른 모든 봇을 관리하는 도구
export const BOSS_TOOLS = [
  { type: "function", function: { name: "agent_list", description: "전체 봇 목록과 각 봇의 역할·모델·상태를 확인합니다", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "agent_direct", description: "특정 봇에게 즉시 업무를 지시하고 결과를 받습니다. 팀 모드 없이도 봇을 활용할 때 사용", parameters: { type: "object", properties: { name: { type: "string", description: "지시할 봇 이름" }, instruction: { type: "string", description: "구체적 업무 지시" } }, required: ["name", "instruction"] } } },
  { type: "function", function: { name: "agent_update", description: "봇의 역할 지침이나 모델을 수정합니다", parameters: { type: "object", properties: { name: { type: "string" }, role: { type: "string" }, model: { type: "string" } }, required: ["name"] } } },
  { type: "function", function: { name: "agent_delete", description: "불필요한 봇을 삭제합니다 (CEO 봇은 삭제 불가)", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } },
];

export async function callBuiltin(name: string, args: Record<string, unknown>, agentId?: string | null): Promise<string> {
  // --- CEO 봇 관리 도구 ---
  if (name === "agent_list") {
    const rows = db.prepare("SELECT a.*, (SELECT COUNT(*) FROM agent_runs r WHERE r.agent_id = a.id) run_count FROM agents a ORDER BY a.is_boss DESC, a.created_at").all() as any[];
    const busyIds = new Set((db.prepare("SELECT DISTINCT agent_id FROM routines WHERE enabled = 1 AND agent_id IS NOT NULL").all() as any[]).map((r) => r.agent_id));
    return rows.length
      ? rows.map((a) => `- ${a.name}${a.is_boss ? " [CEO]" : ""} | 역할: ${(a.role_prompt || "").slice(0, 80)} | 모델: ${modelLabel(a.model ?? "subagent")} | 실행 ${a.run_count}회${busyIds.has(a.id) ? " | 예약 루틴 담당 중" : ""}`).join("\n")
      : "등록된 봇 없음";
  }
  if (name === "agent_direct") {
    const target = db.prepare("SELECT * FROM agents WHERE name = ?").get(String(args.name ?? "")) as Agent | null;
    if (!target) return `봇 없음: ${args.name} — agent_list로 이름을 확인하세요`;
    if (target.is_boss) return "자기 자신(CEO)에게는 지시할 수 없습니다";
    const runId = uid();
    db.prepare("INSERT INTO agent_runs (id, agent_id, conversation_id, task, status, created_at) VALUES (?, ?, NULL, ?, 'running', ?)").run(runId, target.id, `[CEO 지시] ${String(args.instruction ?? "").slice(0, 200)}`, now());
    const state: TeamAgentState = {
      id: target.id, runId, name: target.name, avatar: target.avatar ?? "🤖",
      role: target.role_prompt, task: `CEO 봇이 지시한 업무입니다. 수행하고 결과를 보고하세요.\n\n${args.instruction}`,
      model: target.model ?? "subagent", status: "running", steps: 0,
    };
    await runAgent(state, target, () => {}, AbortSignal.timeout(240_000));
    db.prepare("UPDATE agent_runs SET status = ?, result = ?, steps = ?, finished_at = ? WHERE id = ?").run(state.status, state.result ?? null, state.steps, now(), runId);
    return `[${target.name} 실행 결과 — ${state.status === "done" ? "완료" : "실패"}]\n${state.result ?? "(결과 없음)"}`;
  }
  if (name === "agent_update") {
    const target = db.prepare("SELECT * FROM agents WHERE name = ?").get(String(args.name ?? "")) as Agent | null;
    if (!target) return `봇 없음: ${args.name}`;
    db.prepare("UPDATE agents SET role_prompt = ?, model = ? WHERE id = ?")
      .run(args.role ? String(args.role) : target.role_prompt, args.model ? String(args.model) : target.model, target.id);
    return `봇 수정됨: ${target.name}`;
  }
  if (name === "agent_delete") {
    const target = db.prepare("SELECT * FROM agents WHERE name = ?").get(String(args.name ?? "")) as Agent | null;
    if (!target) return `봇 없음: ${args.name}`;
    if (target.is_boss) return "CEO 봇은 삭제할 수 없습니다";
    db.prepare("DELETE FROM agents WHERE id = ?").run(target.id);
    return `봇 삭제됨: ${target.name}`;
  }
  if (name === "routine_add") {
    const { nextRunAt } = await import("./routines");
    const schedule = String(args.schedule ?? "");
    if (!nextRunAt(schedule)) return `schedule 형식 오류 — every:30m, every:2h, daily:08:30 같은 형식으로 입력하세요 (받은 값: ${schedule})`;
    const id = uid();
    db.prepare("INSERT INTO routines (id, name, prompt, schedule, model, agent_id, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)")
      .run(id, String(args.name ?? "루틴").slice(0, 50), String(args.prompt ?? ""), schedule, null, agentId ?? null, now());
    return `루틴 등록됨: ${args.name} (${schedule}) — 담당 봇: ${agentId ? "이 봇" : "대장"}`;
  }
  if (name === "routine_list") {
    const rows = db.prepare("SELECT r.id, r.name, r.schedule, r.enabled, a.name agent_name FROM routines r LEFT JOIN agents a ON a.id = r.agent_id ORDER BY r.created_at").all() as any[];
    return rows.length ? rows.map((r) => `- [${r.id}] ${r.name} · ${r.schedule} · ${r.enabled ? "활성" : "비활성"} · 담당: ${r.agent_name ?? "대장"}`).join("\n") : "등록된 루틴 없음";
  }
  if (name === "routine_delete") {
    db.prepare("DELETE FROM routines WHERE id = ?").run(String(args.id ?? ""));
    return `루틴 삭제됨: ${args.id}`;
  }
  if (name === "web_search") {
    const r = await webSearch(String(args.query ?? ""), 6);
    return r.results.length
      ? r.results.map((x, i) => `[${i + 1}] ${x.title}\n${x.url}\n${x.snippet}`).join("\n\n")
      : "검색 결과 없음";
  }
  if (name === "read_file") {
    const p = safePath(String(args.path ?? ""));
    if (!existsSync(p)) return "파일 없음";
    return readFileSync(p, "utf8").slice(0, 20000);
  }
  if (name === "write_file") {
    writeFileSync(safePath(String(args.path ?? "")), String(args.content ?? ""));
    return `저장됨: ${args.path}`;
  }
  if (name === "list_files") return readdirSync(WORK_DIR).join("\n") || "(비어 있음)";
  return `알 수 없는 도구: ${name}`;
}

// 이름 충돌 시 " #2" 식으로 유일 이름 생성
function uniqueName(base: string): string {
  const trimmed = base.slice(0, 30).trim() || "작업봇";
  let name = trimmed;
  let i = 2;
  while (db.prepare("SELECT 1 FROM agents WHERE name = ?").get(name)) {
    name = `${trimmed.slice(0, 26)} #${i++}`;
  }
  return name;
}

// 대장이 새 페르소나를 부여해 생성하는 봇 (항상 신규 생성 — 이름 같아도 페르소나 다르면 별개 봇)
function createAgent(t: { name?: string; role?: string; model?: string; avatar?: string }): Agent {
  const id = uid();
  db.prepare("INSERT INTO agents (id, name, role_prompt, model, avatar, tools, persistent, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)")
    .run(id, uniqueName(String(t.name ?? "작업봇")), String(t.role ?? ""), t.model ?? "subagent", t.avatar ?? "🤖", null, now());
  return db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Agent;
}

export async function runAgent(state: TeamAgentState, agent: Agent, emit: Emit, signal?: AbortSignal): Promise<void> {
  const { endpoint, model } = resolveModel(agent.model ?? "subagent");
  state.model = model;
  const isBoss = !!agent.is_boss;
  const tools: any[] = [...BUILTIN_TOOLS, ...(isBoss ? BOSS_TOOLS : []), ...BROWSER_TOOLS];
  if (mcpConfigured()) {
    try {
      for (const t of await mcpTools()) {
        tools.push({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } });
      }
    } catch {}
  }
  const builtinNames = new Set([...BUILTIN_TOOLS, ...BOSS_TOOLS].map((t) => t.function.name));
  const messages: any[] = [
    {
      role: "system",
      content: `당신은 팀의 전문 에이전트 "${agent.name}"입니다.\n역할: ${agent.role_prompt}\n\n지시받은 작업을 수행하세요. 필요하면 도구(web_search, 브라우저, 파일, MCP)를 사용하세요. 브라우저 도구는 사용자의 로그인 세션을 공유하므로 로그인이 필요한 사이트도 열 수 있습니다. 다른 에이전트와 파일로 협업할 수 있습니다(공유 작업 디렉터리). 최종 답변은 팀 리더에게 보고하는 결과 보고서로 작성하세요 — 핵심 결과와 근거를 간결하게.`,
    },
    { role: "user", content: state.task },
  ];
  // 봇당 최대 작업 시간 — 초과 시 수집된 결과로 즉시 보고 마무리
  const deadline = Date.now() + 4 * 60_000;
  try {
    for (let round = 0; round < 8; round++) {
      if (Date.now() > deadline) {
        emit({ type: "agent_step", agentId: state.id, tool: "시간 제한 — 결과 정리" });
        messages.push({ role: "user", content: "작업 시간 제한에 도달했습니다. 도구를 더 사용하지 말고, 지금까지 얻은 결과로 최종 보고서를 즉시 작성하세요." });
        const res = await chatOnce(endpoint, model, messages, { signal });
        state.status = "done";
        state.result = res.content || "(시간 제한 — 결과 없음)";
        return;
      }
      const res = await chatOnce(endpoint, model, messages, { signal, tools });
      state.steps = round + 1;
      if (!res.toolCalls?.length) {
        state.status = "done";
        state.result = res.content;
        return;
      }
      messages.push({ role: "assistant", content: res.content || "", tool_calls: res.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } })) });
      for (const tc of res.toolCalls) {
        emit({ type: "agent_step", agentId: state.id, tool: tc.name });
        let out: string;
        try {
          const args = JSON.parse(tc.arguments || "{}");
          out = builtinNames.has(tc.name)
            ? await callBuiltin(tc.name, args, agent.id)
            : tc.name.startsWith("browser_")
              ? await browserTool(state.runId, tc.name, args)
              : await mcpCall(tc.name, args);
        } catch (e) {
          out = `도구 오류: ${(e as Error).message}`;
        }
        messages.push({ role: "tool", tool_call_id: tc.id, content: String(out).slice(0, 8000) });
      }
    }
    state.status = "done";
    state.result = "(도구 단계 상한에 도달해 작업을 마무리합니다)";
  } catch (e) {
    state.status = "error";
    state.result = `에이전트 오류: ${(e as Error).message}`;
  } finally {
    closeAgentPage(state.runId).catch(() => {});
  }
}

// 대장 봇 계획: 작업을 하위 작업으로 분해만 함 (봇 생성·실행 전 — 사용자 승인 대기용)
// null 반환 시 팀 불필요(일반 답변으로 진행)
export interface PlanTask {
  agent?: string;   // 재사용할 기존 봇 이름
  name?: string;
  avatar?: string;
  role?: string;
  task: string;
  model?: string;
  model_label?: string; // 별칭이 아닌 실제 라우팅 모델 (예: openai/gpt-6-astra@high)
  existing?: boolean; // 기존 봇 재사용 여부 (정규화 후 채움)
}

function rosterInfo() {
  const existing = db.prepare("SELECT * FROM agents ORDER BY created_at").all() as Agent[];
  const busyIds = new Set(
    (db.prepare("SELECT DISTINCT agent_id FROM routines WHERE enabled = 1 AND agent_id IS NOT NULL").all() as { agent_id: string }[]).map((r) => r.agent_id),
  );
  return { existing, busyIds };
}

export async function planTeam(
  endpoint: Endpoint,
  bossModel: string,
  task: string,
  emit: Emit,
  signal?: AbortSignal,
): Promise<PlanTask[] | null> {
  emit({ type: "team_planning" });

  const { existing, busyIds } = rosterInfo();
  const boss = ensureBossAgent();
  const roster = existing.length
    ? "\n\n현재 상주 에이전트 목록 (CEO 본인은 재사용 대상 아님):\n" + existing.map((a) =>
        `- ${a.name}${a.is_boss ? " [CEO]" : ""} | 역할: ${a.role_prompt || "없음"} | 모델: ${modelLabel(a.model ?? "subagent")}${busyIds.has(a.id) ? " | [바쁨: 예약 루틴 담당 중]" : ""}`,
      ).join("\n")
    : "";

  const planRes = await chatOnce(endpoint, bossModel, [
    {
      role: "system",
      content: `당신은 "${boss.name}" — 이 조직의 CEO입니다. 사용자의 작업을 분석해 전문 에이전트들에게 분배할 하위 작업으로 분해하세요.
JSON 배열만 출력하세요. 각 항목은 둘 중 하나:
- 기존 에이전트 재사용: {"agent":"기존 에이전트 이름","task":"구체적 작업 지시"}
- 새 에이전트 생성: {"name":"에이전트 이름","avatar":"이모지","role":"역할 설명 한 줄","task":"구체적 작업 지시","model":"subagent|fast|code|main 중 하나"}

규칙:
- 기존 에이전트의 역할이 하위 작업에 맞을 때만 재사용하세요. 역할이 맞지 않으면 새 페르소나로 새 에이전트를 만드세요 (이름이 같아도 새로 생성).
- [CEO] 표시된 봇은 관리자 본인이므로 작업에 배정하지 마세요.
- [바쁨] 표시된 에이전트는 예약 루틴이 우선이므로 재사용하지 말고 새 에이전트를 만드세요.
- 최대 4개. 코드 작업은 code, 빠른 단순 작업은 fast, 나머지는 subagent.
- 단순 질문·잡담·한 번에 답할 수 있는 것은 분해하지 말고 빈 배열 []만 출력.${roster}`,
    },
    { role: "user", content: task },
  ], { signal });

  const m = planRes.content.match(/\[[\s\S]*\]/);
  let tasks: PlanTask[] = [];
  try { tasks = m ? JSON.parse(m[0]) : []; } catch { tasks = []; }
  if (!Array.isArray(tasks) || !tasks.length) return null;
  tasks = tasks.slice(0, 4);

  // 재사용 가능 여부 정규화: 존재하고 바쁘지 않고 CEO가 아닌 봇만 existing=true
  for (const t of tasks) {
    t.task = String(t.task ?? task);
    if (t.agent) {
      const found = existing.find((a) => a.name === t.agent && !busyIds.has(a.id) && !a.is_boss);
      if (found) {
        t.existing = true;
        t.name = found.name;
        t.avatar = found.avatar ?? "🤖";
        t.role = found.role_prompt;
        t.model = found.model ?? "subagent";
      } else {
        // 지정한 봇이 없거나 바쁨/CEO → 새 봇으로 전환
        t.existing = false;
        t.name = t.name ?? t.agent;
        t.agent = undefined;
      }
    } else {
      t.existing = false;
      t.name = t.name ?? "작업봇";
      t.avatar = t.avatar ?? "🤖";
      t.model = t.model ?? "subagent";
    }
    t.model_label = modelLabel(t.model ?? "subagent");
  }
  return tasks;
}

// 승인된 계획 실행: 봇 생성/재사용 → 병렬 실행 → 상태 배열 반환
export async function runTeamTasks(
  convId: string,
  tasks: PlanTask[],
  emit: Emit,
  signal?: AbortSignal,
): Promise<TeamAgentState[]> {
  const { existing, busyIds } = rosterInfo();
  const states: TeamAgentState[] = tasks.map((t) => {
    const reuse = t.agent ? existing.find((a) => a.name === t.agent && !busyIds.has(a.id) && !a.is_boss) : undefined;
    const agent = reuse ?? createAgent(t);
    const runId = uid();
    db.prepare("INSERT INTO agent_runs (id, agent_id, conversation_id, task, status, created_at) VALUES (?, ?, ?, ?, 'running', ?)")
      .run(runId, agent.id, convId, t.task, now());
    return {
      id: agent.id, runId,
      name: agent.name, avatar: agent.avatar ?? "🤖",
      role: agent.role_prompt, task: t.task,
      model: agent.model ?? "subagent", status: "running", steps: 0,
    };
  });
  emit({ type: "team_plan", agents: states.map((s) => ({ id: s.id, name: s.name, avatar: s.avatar, role: s.role, task: s.task, model: s.model, model_label: modelLabel(s.model) })) });

  await Promise.all(states.map(async (s) => {
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(s.id) as Agent;
    emit({ type: "agent_start", agentId: s.id });
    await runAgent(s, agent, emit, signal);
    db.prepare("UPDATE agent_runs SET status = ?, result = ?, steps = ?, finished_at = ? WHERE id = ?")
      .run(s.status, s.result ?? null, s.steps, now(), s.runId);
    emit({ type: "agent_done", agentId: s.id, status: s.status, result: (s.result ?? "").slice(0, 4000) });
  }));

  return states;
}

// 승인된 팀 계획 실행 SSE: 봇 실행 → 대장 종합 답변을 기존 assistant 메시지에 스트리밍
export const teamRoute = new Hono()
  .post("/run", async (c) => {
    const body = await c.req.json();
    const convId = String(body.conversationId ?? "");
    const msgId = String(body.messageId ?? "");
    const tasks = (body.tasks ?? []) as PlanTask[];
    const conv = db.prepare("SELECT * FROM conversations WHERE id = ?").get(convId) as any;
    const msg = db.prepare("SELECT * FROM messages WHERE id = ?").get(msgId) as any;
    if (!conv || !msg || !Array.isArray(tasks) || !tasks.length) return c.json({ error: "conversationId/messageId/tasks 필요" }, 400);
    const signal = c.req.raw.signal;
    const { endpoint, model: realModel } = resolveModel(body.model ?? conv.model ?? "main");

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch {}
        };
        try {
          const states = await runTeamTasks(convId, tasks, (ev) => send("team", ev), signal);

          // 대장이 봇 결과들을 취합해 최종 답변 작성
          const history: ChatMessage[] = [
            { role: "system", content: systemPrompt("team", conv.persona_id, conv.workspace_id, conv.agent_id) },
            ...(db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at").all(convId) as any[])
              .filter((m) => (m.role === "user" || m.role === "assistant") && m.active && m.id !== msgId)
              .map((m) => ({ role: m.role, content: m.content })),
          ];
          const report = states.map((a) => `## ${a.avatar} ${a.name} — ${a.status === "done" ? "완료" : "실패"}\n작업: ${a.task}\n\n${a.result ?? "(결과 없음)"}`).join("\n\n");
          for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].role === "user") {
              history[i] = {
                role: "user",
                content: `${history[i].content}\n\n[팀 에이전트 실행 결과 — 각 전문 봇이 완료한 보고서]\n\n${report}\n\n---\n위 결과를 종합해 사용자에게 최종 답변을 작성하세요. 어떤 봇이 무엇을 담당했는지 간략히 언급하고, 실패한 봇이 있으면 그 한계도 솔직히 밝히세요.`,
              };
              break;
            }
          }

          let content = "";
          let usage: any = null;
          let usedModel = realModel;
          for await (const ev of streamChat(endpoint, realModel, history, { signal })) {
            if (ev.type === "content" && ev.text) { content += ev.text; send("delta", { id: msgId, text: ev.text }); }
            else if (ev.type === "usage") { usage = ev.usage; if (ev.model) usedModel = ev.model; }
            else if (ev.type === "error") send("error", { message: ev.error });
            else if (ev.type === "done" && ev.model) usedModel = ev.model;
          }

          const meta = {
            type: "team", status: "done",
            agents: states.map((a) => ({ name: a.name, avatar: a.avatar, role: a.role, task: a.task, model: a.model, model_label: modelLabel(a.model), status: a.status, result: (a.result ?? "").slice(0, 4000) })),
          };
          db.prepare("UPDATE messages SET content = ?, model = ?, search_meta = ?, tokens_in = ?, tokens_out = ? WHERE id = ?")
            .run(content, usedModel, JSON.stringify(meta), usage?.prompt_tokens ?? null, usage?.completion_tokens ?? null, msgId);
          const sibs = db.prepare("SELECT * FROM messages WHERE parent_id IS ?").all(msg.parent_id) as any[];
          const idx = sibs.findIndex((s) => s.id === msgId);
          send("done", { message: { ...(db.prepare("SELECT * FROM messages WHERE id = ?").get(msgId) as any), sibling_count: sibs.length, sibling_index: idx } });
          if (content) notifyResult(conv.title, content);
        } catch (e: any) {
          if (e?.name !== "AbortError") send("error", { message: String(e?.message ?? e) });
        } finally {
          try { controller.close(); } catch {}
        }
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  });

const withAgentMeta = (a: any) => ({ ...a, model_label: modelLabel(a.model ?? "subagent") });

export const agentsRoute = new Hono()
  .get("/", (c) => c.json({ agents: (db.prepare("SELECT * FROM agents ORDER BY is_boss DESC, created_at").all() as any[]).map(withAgentMeta) }))
  .post("/", async (c) => {
    const b = await c.req.json();
    if (!b.name) return c.json({ error: "name 필요" }, 400);
    const id = uid();
    db.prepare("INSERT INTO agents (id, name, role_prompt, model, avatar, tools, persistent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, String(b.name).slice(0, 30), b.role_prompt ?? "", b.model ?? "subagent", b.avatar ?? "🤖", b.tools ? JSON.stringify(b.tools) : null, b.persistent === false ? 0 : 1, now());
    return c.json({ agent: withAgentMeta(db.prepare("SELECT * FROM agents WHERE id = ?").get(id)) });
  })
  .patch("/:id", async (c) => {
    const b = await c.req.json();
    const a = db.prepare("SELECT * FROM agents WHERE id = ?").get(c.req.param("id")) as Agent | null;
    if (!a) return c.json({ error: "not found" }, 404);
    db.prepare("UPDATE agents SET name = ?, role_prompt = ?, model = ?, avatar = ? WHERE id = ?")
      .run(b.name ?? a.name, b.role_prompt ?? a.role_prompt, b.model ?? a.model, b.avatar ?? a.avatar, a.id);
    return c.json({ agent: withAgentMeta(db.prepare("SELECT * FROM agents WHERE id = ?").get(a.id)) });
  })
  // CEO 지정: 이 봇이 모든 봇의 관리자가 됨 (기존 CEO는 해제)
  .post("/:id/boss", (c) => {
    const a = db.prepare("SELECT * FROM agents WHERE id = ?").get(c.req.param("id")) as Agent | null;
    if (!a) return c.json({ error: "not found" }, 404);
    db.prepare("UPDATE agents SET is_boss = 0").run();
    db.prepare("UPDATE agents SET is_boss = 1 WHERE id = ?").run(a.id);
    return c.json({ ok: true, agent: withAgentMeta(db.prepare("SELECT * FROM agents WHERE id = ?").get(a.id)) });
  })
  .delete("/:id", (c) => {
    const a = db.prepare("SELECT * FROM agents WHERE id = ?").get(c.req.param("id")) as Agent | null;
    if (a?.is_boss) return c.json({ error: "CEO 봇은 삭제할 수 없습니다 — 다른 봇을 먼저 CEO로 지정하세요" }, 400);
    db.prepare("DELETE FROM agents WHERE id = ?").run(c.req.param("id"));
    return c.json({ ok: true });
  })
  .get("/runs", (c) => c.json({ runs: db.prepare("SELECT r.*, a.name as agent_name, a.avatar FROM agent_runs r LEFT JOIN agents a ON a.id = r.agent_id ORDER BY r.created_at DESC LIMIT 50").all() }));
