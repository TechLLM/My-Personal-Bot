import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalJson,
  PROTOCOL_VERSION,
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
  if (typeof value.armRoot !== "string" || typeof value.fixtureModule !== "string" || typeof value.exportName !== "string" || !isRecord(value.seed)) return false;
  if (!Array.isArray(value.seed.agents ?? []) || !isRecord(value.seed.workspaceFiles ?? {})) return false;
  if (value.candidate !== undefined && !isRecord(value.candidate)) return false;
  if (value.broker !== undefined) {
    const b = value.broker;
    if (!isRecord(b) || typeof b.url !== "string" || typeof b.token !== "string" || !/^https?:\/\/127\.0\.0\.1:\d+$/.test(b.url)) return false;
  }
  return Object.keys(value).every((key) => ["protocolVersion", "runId", "arm", "armRoot", "fixtureModule", "exportName", "input", "seed", "candidate", "broker"].includes(key));
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
      db.prepare("INSERT INTO agents (id, name, role_prompt, model, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(agent.id, agent.name, agent.role_prompt ?? "", agent.model ?? null, 1_700_000_000_000);
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
    const fixturePath = join(root, safeRelativePath(request.fixtureModule));
    const fixture = await import(pathToFileURL(fixturePath).href);
    const probe = fixture[request.exportName];
    if (typeof probe !== "function") return fail("fixture_export_missing", request);
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
          const data = await res.json() as { content: string };
          models.add(model);
          return data.content;
        }
      : async () => { throw new Error("model_unavailable"); };
    const value = await probe({ db, workspaceDir, input: request.input, chat });
    const encoded = canonicalJson(value);
    if (Buffer.byteLength(encoded) > MAX_RESULT) return fail("result_too_large", request);
    return { protocolVersion: PROTOCOL_VERSION, runId: request.runId, arm: request.arm, ok: true, value: JSON.parse(encoded), modelCalls, models: [...models] };
  } catch {
    return fail("fixture_failed", request);
  } finally {
    try { db.close(); } catch {}
  }
}

async function main() {
  let body = "";
  for await (const chunk of Bun.stdin.stream()) {
    body += Buffer.from(chunk).toString("utf8");
    if (Buffer.byteLength(body) > MAX_REQUEST) {
      process.stdout.write(canonicalJson(fail("request_too_large")));
      return;
    }
  }
  let parsed: unknown;
  try { parsed = JSON.parse(body); }
  catch { process.stdout.write(canonicalJson(fail("request_invalid"))); return; }
  if (!validRequest(parsed)) { process.stdout.write(canonicalJson(fail("request_invalid"))); return; }
  const request = parsed;
  process.stdout.write(canonicalJson(await run(request)));
}

if (import.meta.main) await main();
