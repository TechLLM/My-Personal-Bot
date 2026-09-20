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

// E2-B production — 격리 worker가 실제 파이프라인으로 수행할 골든 과제.
// 모델 호출은 브로커 경유로만 가능하다 (샌드박스가 그 포트 외 네트워크를 막는다).
export interface GoldenCheckSpec {
  type: string;
  tool?: string; tool_prefix?: string; query?: string; pattern?: string; glob?: string;
  fresh_minutes?: number; score?: number; name?: string; desc?: string;
}

export interface GoldenSpec {
  id: string;
  prompt: string;
  agent?: string;   // 과제를 수행할 시드 봇 이름 (기본 CEO)
  checks?: GoldenCheckSpec[];
  then?: string;    // 2턴 과제의 후속 프롬프트
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
  fixtureModule?: string;
  exportName: string;
  input: unknown;
  seed: SyntheticSeed;
  candidate?: CandidateSpec;
  // E2-B credential broker — 있으면 worker는 이 루프백 주소로만 모델 호출 가능
  // (샌드박스가 그 포트 outbound만 허용). API 키는 부모에만 있고 worker는 토큰만 든다.
  broker?: { url: string; token: string };
  // E2-B production — 골든 과제가 있으면 fixture 대신 실제 파이프라인으로 실행한다
  golden?: GoldenSpec;
  model?: string;      // 측정 대상의 운영 모델 id — worker가 broker/<bare>로 재배선
  evalModel?: string;  // eval_min 체크의 평가 모델 id
}

export interface WorkerResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  runId: string;
  arm: WorkerArm;
  ok: boolean;
  value?: unknown;
  reasonCode?: string;
  modelCalls: number;   // worker가 브로커를 통해 실제로 한 모델 호출 수 (없으면 0)
  models: string[];     // 실제로 호출된 모델 id — receipt.model.resolved로 들어간다
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
  // E2-B — requested: 이 측정이 요구하는 모델(표면의 운영 모델), resolved: 실제 호출된
  // 모델 id 목록, executed: 브로커 호출이 실제로 일어났는지, calls: 호출 횟수
  model: { requested: string | null; resolved: string[]; executed: boolean; calls: number };
  exitCode: number | null;
  signal: string | null;
  value?: unknown;
  reasonCode?: string;
  // 실패 시 worker stderr의 마지막 2KB — 샌드박스 안 진단은 이것이 유일한 통로다
  stderrTail?: string;
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
  if (typeof v.modelCalls !== "number" || !Array.isArray(v.models)) return false;
  if (v.ok) {
    if (keys !== "arm,modelCalls,models,ok,protocolVersion,runId,value" || !Object.prototype.hasOwnProperty.call(v, "value")) return false;
    try { canonicalJson(v.value); } catch { return false; }
    return true;
  }
  return keys === "arm,modelCalls,models,ok,protocolVersion,reasonCode,runId"
    && typeof v.reasonCode === "string" && WORKER_FAILURE_REASONS.has(v.reasonCode);
}
