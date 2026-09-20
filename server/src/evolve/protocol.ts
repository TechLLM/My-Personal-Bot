export interface SeedAgent {
  id: string;
  name: string;
  role_prompt?: string;
  model?: string;
}

export interface CandidateSpec {
  surface: string;
  target: string;
  filePath?: string;
  newContent?: string;
  column?: string;
  newValue?: string;
  summary?: string;
}

export interface SyntheticSeed {
  agents?: SeedAgent[];
  workspaceFiles?: Record<string, string>;
}

export const PROTOCOL_VERSION = 1;
export type WorkerArm = "baseline" | "candidate";

export const WORKER_FAILURE_REASONS = new Set([
  "request_too_large", "request_invalid", "worker_environment_invalid", "seed_invalid",
  "candidate_apply_failed", "fixture_export_missing", "result_too_large", "fixture_failed",
]);

export interface WorkerRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  runId: string;
  arm: WorkerArm;
  armRoot: string;
  fixtureModule: string;
  exportName: string;
  input: unknown;
  seed: SyntheticSeed;
  candidate?: CandidateSpec;
}

export interface WorkerResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  runId: string;
  arm: WorkerArm;
  ok: boolean;
  value?: unknown;
  reasonCode?: string;
}

export interface ArmReceipt {
  arm: "baseline" | "candidate";
  pid: number;
  sourceHash: string;
  dependencyHash: string;
  initialStateHash: string;
  initialStateKind: "synthetic-seed-and-schema";
  harnessHash: string;
  policyHash: string;
  runtime: { path: string; version: string };
  startedAt: number;
  endedAt: number;
  runtimeExecutableHash: string;
  model: { requested: null; resolved: null; executed: false };
  exitCode: number | null;
  signal: string | null;
  value?: unknown;
  reasonCode?: string;
}

export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const visit = (v: unknown, depth = 0): unknown => {
    if (depth > 64) throw new Error("value_too_deep");
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error("non_finite_number");
      return Object.is(v, -0) ? 0 : v;
    }
    if (Array.isArray(v)) {
      if (seen.has(v)) throw new Error("cyclic_value");
      seen.add(v);
      const out = v.map((item) => visit(item, depth + 1));
      seen.delete(v);
      return out;
    }
    if (typeof v === "object") {
      if (seen.has(v as object)) throw new Error("cyclic_value");
      const prototype = Object.getPrototypeOf(v);
      if (prototype !== Object.prototype && prototype !== null) throw new Error("non_plain_object");
      seen.add(v as object);
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        const item = (v as Record<string, unknown>)[key];
        if (item !== undefined) out[key] = visit(item, depth + 1);
      }
      seen.delete(v as object);
      return out;
    }
    throw new Error("non_json_value");
  };
  return JSON.stringify(visit(value));
}

export function isWorkerResponse(value: unknown, request: WorkerRequest): value is WorkerResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.protocolVersion !== PROTOCOL_VERSION || v.runId !== request.runId || v.arm !== request.arm || typeof v.ok !== "boolean") return false;
  const keys = Object.keys(v).sort().join(",");
  if (v.ok) {
    if (keys !== "arm,ok,protocolVersion,runId,value" || !Object.prototype.hasOwnProperty.call(v, "value")) return false;
    try { canonicalJson(v.value); } catch { return false; }
    return true;
  }
  return keys === "arm,ok,protocolVersion,reasonCode,runId"
    && typeof v.reasonCode === "string" && WORKER_FAILURE_REASONS.has(v.reasonCode);
}
