import { Hono } from "hono";
import { db, uid, now } from "./db";
import type { Endpoint } from "./providers";
import { resolveModel } from "./providers";
import { chatOnce } from "./providers/openaiCompat";
import { webSearch } from "./search";
import { mcpConfigured, mcpTools, mcpCall } from "./mcp";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

// 에이전트 공용 작업 디렉터리 — 파일 도구는 여기로 샌드박스
const WORK_DIR = join(import.meta.dir, "..", "..", "data", "workspace");
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

const BUILTIN_TOOLS = [
  { type: "function", function: { name: "web_search", description: "웹에서 정보를 검색합니다", parameters: { type: "object", properties: { query: { type: "string", description: "검색어" } }, required: ["query"] } } },
  { type: "function", function: { name: "read_file", description: "팀 작업 디렉터리의 파일을 읽습니다", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "팀 작업 디렉터리에 파일을 저장합니다", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "list_files", description: "팀 작업 디렉터리의 파일 목록", parameters: { type: "object", properties: {} } } },
];

async function callBuiltin(name: string, args: Record<string, unknown>): Promise<string> {
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

// 이름으로 기존 상주 봇 재사용, 없으면 생성 (둘 다 지원: 계획이 임시 봇을 요구해도 저장됨)
function findOrCreateAgent(t: { name?: string; role?: string; model?: string; avatar?: string }): Agent {
  const name = String(t.name ?? "작업봇").slice(0, 30);
  const existing = db.prepare("SELECT * FROM agents WHERE name = ?").get(name) as Agent | null;
  if (existing) return existing;
  const id = uid();
  db.prepare("INSERT INTO agents (id, name, role_prompt, model, avatar, tools, persistent, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)")
    .run(id, name, String(t.role ?? ""), t.model ?? "subagent", t.avatar ?? "🤖", null, now());
  return db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Agent;
}

async function runAgent(state: TeamAgentState, agent: Agent, emit: Emit, signal?: AbortSignal): Promise<void> {
  const { endpoint, model } = resolveModel(agent.model ?? "subagent");
  state.model = model;
  const tools: any[] = [...BUILTIN_TOOLS];
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
      content: `당신은 팀의 전문 에이전트 "${agent.name}"입니다.\n역할: ${agent.role_prompt}\n\n지시받은 작업을 수행하세요. 필요하면 도구(web_search, 파일, MCP)를 사용하세요. 다른 에이전트와 파일로 협업할 수 있습니다(공유 작업 디렉터리). 최종 답변은 팀 리더에게 보고하는 결과 보고서로 작성하세요 — 핵심 결과와 근거를 간결하게.`,
    },
    { role: "user", content: state.task },
  ];
  try {
    for (let round = 0; round < 8; round++) {
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
          out = builtinNames.has(tc.name) ? await callBuiltin(tc.name, args) : await mcpCall(tc.name, args);
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
  }
}

// 대장 봇 오케스트레이션: 계획 → 역할 봇 병렬 실행 → 결과 반환
// null 반환 시 팀 불필요(일반 답변으로 진행)
export async function orchestrateTeam(
  endpoint: Endpoint,
  bossModel: string,
  task: string,
  convId: string,
  emit: Emit,
  signal?: AbortSignal,
): Promise<TeamAgentState[] | null> {
  emit({ type: "team_planning" });
  const planRes = await chatOnce(endpoint, bossModel, [
    {
      role: "system",
      content: `당신은 팀 리더입니다. 사용자의 작업을 분석해 전문 에이전트들에게 분배할 하위 작업으로 분해하세요.
JSON 배열만 출력하세요: [{"name":"에이전트 이름","avatar":"이모지","role":"역할 설명 한 줄","task":"구체적 작업 지시","model":"subagent|fast|code|main 중 하나"}]
- 최대 4개. 코드 작업은 code, 빠른 단순 작업은 fast, 나머지는 subagent.
- 단순 질문·잡담·한 번에 답할 수 있는 것은 분해하지 말고 빈 배열 []만 출력.`,
    },
    { role: "user", content: task },
  ], { signal });

  const m = planRes.content.match(/\[[\s\S]*\]/);
  let tasks: { name?: string; role?: string; task?: string; model?: string; avatar?: string }[] = [];
  try { tasks = m ? JSON.parse(m[0]) : []; } catch { tasks = []; }
  if (!Array.isArray(tasks) || !tasks.length) return null;
  tasks = tasks.slice(0, 4);

  const states: TeamAgentState[] = tasks.map((t) => {
    const agent = findOrCreateAgent(t);
    const runId = uid();
    db.prepare("INSERT INTO agent_runs (id, agent_id, conversation_id, task, status, created_at) VALUES (?, ?, ?, ?, 'running', ?)")
      .run(runId, agent.id, convId, String(t.task ?? task), now());
    return {
      id: agent.id, runId,
      name: agent.name, avatar: agent.avatar ?? "🤖",
      role: agent.role_prompt, task: String(t.task ?? task),
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
