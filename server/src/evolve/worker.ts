import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalJson,
  PROTOCOL_VERSION,
  WORKER_FAILURE_REASONS,
  type CandidateSpec,
  type WorkerArm,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol";
import { safeRelativePath } from "./snapshot";

const MAX_REQUEST = 512 * 1024;
const MAX_RESULT = 512 * 1024;

function fail(reasonCode: WorkerResponse["reasonCode"], request?: Pick<WorkerRequest, "runId" | "arm">): WorkerResponse {
  return { protocolVersion: PROTOCOL_VERSION, runId: request?.runId ?? "invalid", arm: request?.arm ?? "baseline", ok: false, reasonCode, modelCalls: 0, models: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validRequest(value: unknown): value is WorkerRequest {
  if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION || typeof value.runId !== "string" || !/^[0-9a-f-]{36}$/.test(value.runId)) return false;
  if (value.arm !== "baseline" && value.arm !== "candidate") return false;
  if (typeof value.armRoot !== "string" || typeof value.exportName !== "string" || !isRecord(value.seed)) return false;
  if (value.fixtureModule !== undefined && typeof value.fixtureModule !== "string") return false;
  if (value.fixtureModule === undefined && value.golden === undefined) return false;
  if (!Array.isArray(value.seed.agents ?? []) || !isRecord(value.seed.workspaceFiles ?? {})) return false;
  if (value.candidate !== undefined && !isRecord(value.candidate)) return false;
  if (value.broker !== undefined) {
    const b = value.broker;
    if (!isRecord(b) || typeof b.url !== "string" || typeof b.token !== "string" || !/^https?:\/\/127\.0\.0\.1:\d+$/.test(b.url)) return false;
  }
  if (value.golden !== undefined) {
    const g = value.golden;
    if (!isRecord(g) || typeof g.id !== "string" || typeof g.prompt !== "string" || g.prompt.length > 32_768) return false;
  }
  if ((value.model !== undefined && typeof value.model !== "string") || (value.evalModel !== undefined && typeof value.evalModel !== "string")) return false;
  return Object.keys(value).every((key) => ["protocolVersion", "runId", "arm", "armRoot", "fixtureModule", "exportName", "input", "seed", "candidate", "broker", "golden", "model", "evalModel"].includes(key));
}

function applyDatabaseCandidate(db: any, candidate: CandidateSpec): void {
  const definitions: Record<string, { table: string; columns: Set<string> }> = {
    "agent.role": { table: "agents", columns: new Set(["role_prompt"]) },
    "agent.model": { table: "agents", columns: new Set(["model"]) },
    "agent.tools": { table: "agents", columns: new Set(["tools"]) },
    "skill.prompt": { table: "skills", columns: new Set(["prompt"]) },
    "routine.config": { table: "routines", columns: new Set(["schedule", "prompt", "enabled"]) },
  };
  const definition = definitions[candidate.surface];
  const column = candidate.column ?? (candidate.surface === "agent.role" ? "role_prompt" : candidate.surface.split(".")[1]);
  if (!definition || !column || !definition.columns.has(column)) throw new Error("candidate_surface_invalid");
  const row = db.prepare(`SELECT rowid FROM ${definition.table} WHERE id = ? OR name = ?`).get(candidate.target, candidate.target) as any;
  if (!row) throw new Error("candidate_target_missing");
  db.prepare(`UPDATE ${definition.table} SET ${column} = ? WHERE rowid = ?`).run(candidate.newValue ?? "", row.rowid);
}

async function run(request: WorkerRequest): Promise<WorkerResponse> {
  if (process.env.NODE_ENV !== "production" || process.env.MYBOT_ENV !== "e2") return fail("worker_environment_invalid", request);
  const root = resolve(request.armRoot);
  if (root !== resolve(process.cwd())) return fail("request_invalid", request);
  const workspaceDir = join(root, "server", "data", "workspace");
  mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });

  const dbModule = await import(pathToFileURL(join(root, "server", "src", "db.ts")).href);
  const db = dbModule.db;
  try {
    const agents = request.seed.agents ?? [];
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const agent of agents) {
      if (!agent || typeof agent.id !== "string" || typeof agent.name !== "string" || !agent.id || !agent.name || ids.has(agent.id) || names.has(agent.name))
        return fail("seed_invalid", request);
      ids.add(agent.id); names.add(agent.name);
      db.prepare("INSERT INTO agents (id, name, role_prompt, model, tools, persistent, is_boss, is_lead, parent_id, pinned, hidden, max_children, sort_order, workspace_id, special_role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(agent.id, agent.name, agent.role_prompt ?? "", agent.model ?? null,
          agent.tools ?? null, agent.persistent ?? 1, agent.is_boss ?? 0, agent.is_lead ?? 0,
          agent.parent_id ?? null, agent.pinned ?? 0, agent.hidden ?? 0,
          agent.max_children ?? null, agent.sort_order ?? null, agent.workspace_id ?? null,
          agent.special_role ?? null, 1_700_000_000_000);
    }
    for (const [name, content] of Object.entries(request.seed.workspaceFiles ?? {})) {
      if (typeof content !== "string") return fail("seed_invalid", request);
      const rel = safeRelativePath(name);
      const path = join(workspaceDir, rel);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, content, { mode: 0o600 });
    }
    if (request.candidate) {
      try { applyDatabaseCandidate(db, request.candidate); }
      catch { return fail("candidate_apply_failed", request); }
    }
    // E2-B — 모델 호출은 브로커 경유만. 샌드박스가 그 포트 외 네트워크를 막아서
    // 직접 프로바이더 호출은 물리적으로 불가하고, 토큰 없는 호출은 브로커가 401로 거른다.
    let modelCalls = 0;
    const models = new Set<string>();
    const chat = request.broker
      ? async (model: string, messages: unknown[], opts: Record<string, unknown> = {}) => {
          modelCalls++;
          const res = await fetch(`${request.broker!.url}/chat`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${request.broker!.token}` },
            body: JSON.stringify({ model, messages, opts }),
          });
          if (!res.ok) throw new Error(`broker_${res.status}`);
          const data = await res.json() as { content: string; model?: string };
          models.add(data.model ?? model); // 브로커가 해석한 실제 모델 id를 기록한다
          return data.content;
        }
      : async () => { throw new Error("model_unavailable"); };
    const value = request.golden
      ? await runGolden(request, dbModule, db, workspaceDir, root, chat)
      : await runFixture(request, root, db, workspaceDir, chat);
    const encoded = canonicalJson(value);
    if (Buffer.byteLength(encoded) > MAX_RESULT) return fail("result_too_large", request);
    return { protocolVersion: PROTOCOL_VERSION, runId: request.runId, arm: request.arm, ok: true, value: JSON.parse(encoded), modelCalls, models: [...models] };
  } catch (e) {
    // stderr로 진단을 남긴다 — 부모는 실패 시 영수증의 stderrTail로만 수집한다
    try { console.error("worker_error:", (e as Error)?.stack ?? e); } catch {}
    const code = (e as Error).message;
    return fail(WORKER_FAILURE_REASONS.has(code as any) ? code as WorkerResponse["reasonCode"] : "fixture_failed", request);
  } finally {
    try { db.close(); } catch {}
  }
}

type ChatFn = (model: string, messages: unknown[], opts?: Record<string, unknown>) => Promise<string>;

async function runFixture(request: WorkerRequest, root: string, db: any, workspaceDir: string, chat: ChatFn): Promise<unknown> {
  const fixturePath = join(root, safeRelativePath(request.fixtureModule!));
  const fixture = await import(pathToFileURL(fixturePath).href);
  const probe = fixture[request.exportName];
  if (typeof probe !== "function") throw new Error("fixture_export_missing");
  return await probe({ db, workspaceDir, input: request.input, chat });
}

const bareModel = (id: string) => id.slice(id.lastIndexOf("/") + 1);

// E2-B production — 골든 과제를 실제 파이프라인(runAgentDetached)으로 실행한다.
// 모델 호출은 전부 브로커 경유: 브로커를 OpenAI 호환 프로바이더로 등록해 운영 코드를
// 수정 없이 재사용하고, 시드된 봇의 모델은 broker/<bare>로 재배선한다.
// 운영 API 키·외부 데이터는 들어오지 않는다 — 합성 seed + 부모의 토큰뿐.
async function runGolden(request: WorkerRequest, dbModule: any, db: any, workspaceDir: string, root: string, chat: ChatFn): Promise<unknown> {
  const g = request.golden!;
  if (!request.broker || !request.model) throw new Error("worker_environment_invalid");
  // 브로커 프로바이더 등록 — defaultModelId()가 인증된 유일한 프로바이더로 이것을 고른다
  const modelIds = new Set<string>();
  for (const id of [request.model, request.evalModel, ...(request.seed.agents ?? []).map((a) => a.model)]) {
    if (id) modelIds.add(bareModel(id));
  }
  dbModule.setSetting("custom_providers", JSON.stringify([{
    id: "broker", name: "e2-broker", kind: "openai",
    baseUrl: `${request.broker.url}/v1`, apiKey: request.broker.token,
    models: [...modelIds],
  }]));
  // 시드된 봇의 모델을 브로커 경유로 재배선 — 측정된 실제 모델은 영수증 resolved에 기록된다
  for (const a of request.seed.agents ?? []) {
    db.prepare("UPDATE agents SET model = ? WHERE id = ?").run(`broker/${bareModel(a.model ?? request.model)}`, a.id);
  }
  // approvals:"auto" — 샌드박스 합성 DB 안에서만 유효한 자동 승인 규칙.
  // 서비스의 사람 승인 정책과 무관하게, 여기서는 "승인이 주어졌을 때 에이전트가
  // 수명주기 절차를 올바르게 수행하는가"를 측정한다. 규칙은 이 팔의 일회용 DB에만 있다.
  if (g.approvals === "auto")
    db.prepare("INSERT INTO approval_rules (id, pattern, action, created_at) VALUES (?, ?, 'allow', ?)")
      .run(`ar-${request.runId}`, "^agent_", dbModule.now());
  const team = await import(pathToFileURL(join(root, "server", "src", "team.ts")).href);
  const agentName = g.agent ?? "CEO";
  const agent = team.findAgentByName(agentName)
    ?? db.prepare("SELECT * FROM agents WHERE name = ? OR id = ?").get(agentName, agentName)
    ?? team.ensureBossAgent();
  const runOnce = async (task: string, label: string) => {
    const { done } = team.runAgentDetached(agent, { label, task, verifyIntent: false, internal: true });
    return await done;
  };
  const s1 = await runOnce(g.prompt, `[골든] ${g.id}`);
  const s2 = g.then ? await runOnce(g.then, `[골든] ${g.id} 후속`) : null;
  const final = s2 ?? s1;
  const out = {
    content: final.result ?? "",
    content2: s2 ? s1.result ?? "" : undefined,
    toolLog: [...(s1.toolLog ?? []), ...(s2?.toolLog ?? [])],
  };
  const checks = await evalGoldenChecks(g.checks ?? [], g.prompt, out, db, workspaceDir, root, chat, request.evalModel ?? request.model);
  return {
    status: final.status, steps: s1.steps + (s2?.steps ?? 0),
    pass: checks.length > 0 && checks.every((c) => c.pass === true), checks,
    result: out.content.slice(0, 4000),
  };
}

// 골든 체크 — worker의 합성 DB·workspace를 대상으로 평가한다 (부모의 실제 DB가 아님).
// eval_min은 evaluate.ts의 독립 평가 프롬프트를 재사용하고 모델 호출은 브로커로 간다.
async function evalGoldenChecks(checks: any[], task: string, out: { content: string; toolLog: any[] }, db: any, workspaceDir: string, root: string, chat: ChatFn, evalModel: string): Promise<any[]> {
  const walk = (d: string): string[] => {
    try { return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])); } catch { return []; }
  };
  const results: any[] = [];
  for (const c of checks) {
    switch (c.type) {
      case "tool_used":
        results.push({ pass: out.toolLog.some((t) => t.tool === c.tool && t.ok), detail: c.tool });
        break;
      case "tool_prefix":
        results.push({ pass: out.toolLog.some((t) => typeof t.tool === "string" && t.tool.startsWith(c.tool_prefix) && t.ok), detail: `${c.tool_prefix}*` });
        break;
      case "db_count": {
        const row = db.prepare(c.query).get() as any;
        const expected = row ? Number(Object.values(row)[0]) : 0;
        const nums = (out.content.match(/\d+/g) ?? []).map(Number);
        results.push({ pass: nums.includes(expected), detail: `기대값 ${expected}` });
        break;
      }
      case "content_regex":
        results.push({ pass: new RegExp(c.pattern).test(out.content), detail: `/${c.pattern}/` });
        break;
      case "file_exists": {
        const exts = String(c.glob ?? "").replace("*", "");
        const cutoff = Date.now() - (c.fresh_minutes ?? 10) * 60_000;
        const hit = walk(workspaceDir).some((f) => f.endsWith(exts) && statSync(f).mtimeMs > cutoff);
        results.push({ pass: hit, detail: c.glob });
        break;
      }
      case "lifecycle": {
        // 생성이 실제로 실행된 증거만 인정한다 — 어느 실행의 tool_log에서 agent_create ok,
        // 또는 승인 경로에서 실행까지 간 agent_create 요청. agent_runs.task LIKE %name%은
        // 부모 실행의 프롬프트가 봇 이름을 포함해 항상 매칭되는 허점이 있어 증거로 쓰지 않는다
        // (생성 시도 없이 보고만 해도 pass가 되던 문제).
        const createdByTool = out.toolLog.some((t) => t.tool === "agent_create" && t.ok)
          || (db.prepare("SELECT tool_log FROM agent_runs").all() as any[])
              .some((r: any) => { try { return JSON.parse(r.tool_log ?? "[]").some((t: any) => t?.tool === "agent_create" && t.ok); } catch { return false; } });
        const createdByApproval = db.prepare("SELECT 1 FROM approval_requests WHERE args LIKE ? AND tool = 'agent_create' AND status = 'approved' LIMIT 1").get(`%${c.name}%`);
        const created = createdByTool || createdByApproval;
        const exists = db.prepare("SELECT 1 FROM agents WHERE name = ?").get(c.name);
        results.push({ pass: !!created && !exists, detail: `생성 실행 증거 ${created ? "있음" : "없음"}, 최종 존재 ${exists ? "함" : "없음"}` });
        break;
      }
      case "eval_min": {
        const { evaluateResult } = await import(pathToFileURL(join(root, "server", "src", "evaluate.ts")).href);
        const { evaluationCheck } = await import(pathToFileURL(join(root, "server", "src", "evaluation-evidence.ts")).href);
        const callModel = async (_ep: any, _m: string, msgs: any[]) => ({ content: await chat(bareModel(evalModel), msgs, {}) });
        // toolLog를 넘겨야 평가자가 "도구를 안 쓰고 지어냈다"고 오판하지 않는다
        let verdict = await evaluateResult({} as any, bareModel(evalModel), task, out.content, { callModel, toolLog: out.toolLog });
        // 평가자의 형식 오류·프로바이더 오류는 일시적 — 한 번만 재시도한다(aborted 제외).
        // 재시도해도 불능이면 그대로 inconclusive — 없는 평가를 지어내지 않는다.
        if (verdict.status === "inconclusive" && verdict.reasonCode !== "aborted")
          verdict = await evaluateResult({} as any, bareModel(evalModel), task, out.content, { callModel });
        results.push(evaluationCheck(verdict, c.score ?? 70));
        break;
      }
      default:
        // 모르는 체크는 평가하지 못한다 — 평가 안 된 항목을 통과로 세지 않도록 실패 처리
        results.push({ pass: false, detail: `미지원 체크 유형: ${String(c?.type)}` });
    }
  }
  return results;
}

async function main() {
  // 응답을 쓰면 작업은 끝이다 — 파이프라인이 남긴 타이머·핸들이 이벤트 루프를 잡아도
  // 부모의 deadline이 이 프로세스를 kill하지 않도록 flush 후 명시적으로 종료한다.
  const reply = (r: WorkerResponse) => process.stdout.write(canonicalJson(r), () => process.exit(0));
  let body = "";
  for await (const chunk of Bun.stdin.stream()) {
    body += Buffer.from(chunk).toString("utf8");
    if (Buffer.byteLength(body) > MAX_REQUEST) {
      reply(fail("request_too_large"));
      return;
    }
  }
  let parsed: unknown;
  try { parsed = JSON.parse(body); }
  catch { reply(fail("request_invalid")); return; }
  if (!validRequest(parsed)) { reply(fail("request_invalid")); return; }
  const request = parsed;
  reply(await run(request));
}

if (import.meta.main) await main();
