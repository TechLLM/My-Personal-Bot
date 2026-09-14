import { Hono } from "hono";
import { db, uid, now } from "./db";
import type { Endpoint } from "./providers";
import { resolveModel } from "./providers";
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
  created_at: number;
}

// 대장 봇 — 모든 사용자 대화의 기본 접점. 없으면 시드
export const BOSS_NAME = "대장";

export function ensureBossAgent(): Agent {
  let a = db.prepare("SELECT * FROM agents WHERE name = ?").get(BOSS_NAME) as Agent | null;
  if (!a) {
    const id = uid();
    db.prepare("INSERT INTO agents (id, name, role_prompt, model, avatar, tools, persistent, created_at) VALUES (?, ?, ?, ?, ?, NULL, 1, ?)")
      .run(id, BOSS_NAME,
        "당신은 MyBot의 대장 봇입니다. 사용자의 모든 업무 지시를 받는 총괄 책임자입니다. 스스로 도구(웹검색·파일·브라우저·MCP)를 사용해 직접 수행하거나, 필요하면 전문 역할 봇들에게 분배하고 결과를 종합해 보고합니다. 이전 대화와 기억한 맥락을 바탕으로 업무의 연속성을 유지하세요.",
        "main", "🧭", now());
    a = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Agent;
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
];

export async function callBuiltin(name: string, args: Record<string, unknown>): Promise<string> {
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

async function runAgent(state: TeamAgentState, agent: Agent, emit: Emit, signal?: AbortSignal): Promise<void> {
  const { endpoint, model } = resolveModel(agent.model ?? "subagent");
  state.model = model;
  const tools: any[] = [...BUILTIN_TOOLS, ...BROWSER_TOOLS];
  if (mcpConfigured()) {
    try {
      for (const t of await mcpTools()) {
        tools.push({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } });
      }
    } catch {}
  }
  const builtinNames = new Set(BUILTIN_TOOLS.map((t) => t.function.name));
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
        emit({ type: "agent_step", agentId: state.id, tool: "⏱ 시간 제한 — 결과 정리" });
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
            ? await callBuiltin(tc.name, args)
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
  const roster = existing.length
    ? "\n\n현재 상주 에이전트 목록:\n" + existing.map((a) =>
        `- ${a.name} (${a.avatar ?? "🤖"}) | 역할: ${a.role_prompt || "없음"} | 모델: ${a.model ?? "subagent"}${busyIds.has(a.id) ? " | [바쁨: 예약 루틴 담당 중]" : ""}`,
      ).join("\n")
    : "";

  const planRes = await chatOnce(endpoint, bossModel, [
    {
      role: "system",
      content: `당신은 팀 리더입니다. 사용자의 작업을 분석해 전문 에이전트들에게 분배할 하위 작업으로 분해하세요.
JSON 배열만 출력하세요. 각 항목은 둘 중 하나:
- 기존 에이전트 재사용: {"agent":"기존 에이전트 이름","task":"구체적 작업 지시"}
- 새 에이전트 생성: {"name":"에이전트 이름","avatar":"이모지","role":"역할 설명 한 줄","task":"구체적 작업 지시","model":"subagent|fast|code|main 중 하나"}

규칙:
- 기존 에이전트의 역할이 하위 작업에 맞을 때만 재사용하세요. 역할이 맞지 않으면 새 페르소나로 새 에이전트를 만드세요 (이름이 같아도 새로 생성).
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

  // 재사용 가능 여부 정규화: 존재하고 바쁘지 않은 봇만 existing=true
  for (const t of tasks) {
    t.task = String(t.task ?? task);
    if (t.agent) {
      const found = existing.find((a) => a.name === t.agent && !busyIds.has(a.id));
      if (found) {
        t.existing = true;
        t.name = found.name;
        t.avatar = found.avatar ?? "🤖";
        t.role = found.role_prompt;
        t.model = found.model ?? "subagent";
      } else {
        // 지정한 봇이 없거나 바쁨 → 새 봇으로 전환
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
    const reuse = t.agent ? existing.find((a) => a.name === t.agent && !busyIds.has(a.id)) : undefined;
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
  emit({ type: "team_plan", agents: states.map((s) => ({ id: s.id, name: s.name, avatar: s.avatar, role: s.role, task: s.task, model: s.model })) });

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
            agents: states.map((a) => ({ name: a.name, avatar: a.avatar, role: a.role, task: a.task, model: a.model, status: a.status, result: (a.result ?? "").slice(0, 4000) })),
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

export const agentsRoute = new Hono()
  .get("/", (c) => c.json({ agents: db.prepare("SELECT * FROM agents ORDER BY created_at").all() }))
  .post("/", async (c) => {
    const b = await c.req.json();
    if (!b.name) return c.json({ error: "name 필요" }, 400);
    const id = uid();
    db.prepare("INSERT INTO agents (id, name, role_prompt, model, avatar, tools, persistent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, String(b.name).slice(0, 30), b.role_prompt ?? "", b.model ?? "subagent", b.avatar ?? "🤖", b.tools ? JSON.stringify(b.tools) : null, b.persistent === false ? 0 : 1, now());
    return c.json({ agent: db.prepare("SELECT * FROM agents WHERE id = ?").get(id) });
  })
  .patch("/:id", async (c) => {
    const b = await c.req.json();
    const a = db.prepare("SELECT * FROM agents WHERE id = ?").get(c.req.param("id")) as Agent | null;
    if (!a) return c.json({ error: "not found" }, 404);
    db.prepare("UPDATE agents SET name = ?, role_prompt = ?, model = ?, avatar = ? WHERE id = ?")
      .run(b.name ?? a.name, b.role_prompt ?? a.role_prompt, b.model ?? a.model, b.avatar ?? a.avatar, a.id);
    return c.json({ agent: db.prepare("SELECT * FROM agents WHERE id = ?").get(a.id) });
  })
  .delete("/:id", (c) => {
    db.prepare("DELETE FROM agents WHERE id = ?").run(c.req.param("id"));
    return c.json({ ok: true });
  })
  .get("/runs", (c) => c.json({ runs: db.prepare("SELECT r.*, a.name as agent_name, a.avatar FROM agent_runs r LEFT JOIN agents a ON a.id = r.agent_id ORDER BY r.created_at DESC LIMIT 50").all() }));
