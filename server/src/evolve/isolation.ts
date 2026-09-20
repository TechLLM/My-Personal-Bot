import { spawn } from "node:child_process";
import { constants, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, accessSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  isWorkerResponse,
  PROTOCOL_VERSION,
  type ArmReceipt,
  type CandidateSpec,
  type GoldenSpec,
  type SyntheticSeed,
  type WorkerRequest,
} from "./protocol";
import {
  applySourceCandidate,
  captureSource,
  hashBytes,
  hashFrozenDeps,
  hashSnapshot,
  materializeSnapshot,
  safeRelativePath,
} from "./snapshot";

export type { ArmReceipt } from "./protocol";

export interface IsolationOptions {
  sourceRoot: string;
  candidate: CandidateSpec;
  mode: "production" | "fixture";
  fixture?: { modulePath: string; exportName?: string; input?: unknown };
  seed?: SyntheticSeed;
  deadlineMs?: number;
  maxOutputBytes?: number;
  preflight?: { typeScriptCompiler?: string; testFiles?: string[]; preload?: string };
  // E2-B — credential broker. 지정하면 샌드박스가 이 루프백 포트로의 outbound만 허용하고
  // worker는 토큰으로 브로커를 통해 모델을 호출한다. API 키는 부모 프로세스에만 있다.
  broker?: { port: number; token: string };
  // 다중 후보 토너먼트에서 팔별 계측을 후보별로 분리하기 위한 태그 접미사.
  // 브로커 토큰이 `token:baseline-1`·`token:candidate-1`처럼 붙어 byTag가 후보별로 갈린다.
  tagSuffix?: string;
  // 이 측정이 요구하는 모델 id — 영수증의 model.requested로 기록된다
  model?: string;
  evalModel?: string;    // eval_min 체크의 평가 모델 id
  golden?: GoldenSpec;   // production 모드: worker가 실제 파이프라인으로 실행할 골든 과제
}

export interface IsolationResult {
  status: "complete" | "inconclusive" | "crash";
  promotionEligible: false;
  reasonCode?: string;
  baseline?: ArmReceipt;
  candidate?: ArmReceipt;
}

const PROTECTED = [
  "server/src/db.ts", "server/src/index.ts", "server/src/approvals.ts", "server/src/evaluate.ts",
  "server/src/evaluation-evidence.ts", "server/src/evolve.ts", "evolve/surfaces.json",
];
const DB_SURFACES = new Set(["agent.role", "agent.model", "agent.tools", "skill.prompt", "routine.config"]);

function bounded(value: number | undefined, fallback: number, min: number, max: number) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value!))) : fallback;
}

function pathInside(child: string, parent: string) {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep));
}

function globMatches(path: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*").replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`).test(path);
}

function safeProtectedPattern(value: string): string {
  if (!value || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value))
    throw new Error("unsafe_path");
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("unsafe_path");
  return parts.join("/");
}

function protectedPatterns(files: Map<string, Buffer>): string[] {
  const patterns = [...PROTECTED, "server/src/evolve/**"];
  const bytes = files.get("evolve/surfaces.json");
  if (!bytes) return patterns;
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("surfaces_invalid"); }
  const visit = (node: unknown, protectedContext = false, depth = 0) => {
    if (depth > 64) throw new Error("surfaces_invalid");
    if (Array.isArray(node)) return node.forEach((item) => visit(item, protectedContext, depth + 1));
    if (!node || typeof node !== "object") {
      if (protectedContext && typeof node === "string") patterns.push(node);
      return;
    }
    const record = node as Record<string, unknown>;
    if (record.protected === true) {
      for (const key of ["path", "file", "target", "pattern"]) if (typeof record[key] === "string") patterns.push(record[key] as string);
    }
    for (const key of Object.keys(record).sort()) visit(record[key], protectedContext || /protect/i.test(key), depth + 1);
  };
  visit(value);
  return patterns.map(safeProtectedPattern);
}

function validateCodeTarget(candidate: CandidateSpec, files: Map<string, Buffer>): string | undefined {
  if (candidate.newContent === undefined && candidate.filePath === undefined) return undefined;
  if (candidate.surface !== "src") throw new Error("candidate_surface_invalid");
  const path = safeRelativePath(candidate.filePath ?? candidate.target);
  const lower = path.toLowerCase();
  if (!path.startsWith("server/src/") || !path.endsWith(".ts") || !files.has(path)) throw new Error("candidate_target_invalid");
  if (lower.endsWith(".test.ts") || lower.includes("/__tests__/") || lower.includes("/test/")) throw new Error("candidate_target_protected");
  if (protectedPatterns(files).some((pattern) => globMatches(path, pattern)) || /\/(crypto|access|notify|command-delivery)\.ts$/.test(path))
    throw new Error("candidate_target_protected");
  return path;
}

function quotePolicy(path: string) {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function sandboxPolicy(armRoot: string, runtime: string, extraRead: string[] = [], brokerPort?: number) {
  const subpaths = [armRoot, "/System/Library", "/usr/lib", "/usr/share", ...extraRead];
  const literals = ["/", runtime, "/dev/null", "/dev/random", "/dev/urandom"];
  const filters = `${literals.map((p) => `(literal ${quotePolicy(p)})`).join(" ")} ${subpaths.map((p) => `(subpath ${quotePolicy(p)})`).join(" ")}`;
  // 브로커가 있으면 그 루프백 포트로만 outbound를 연다 — 나머지 네트워크는 전면 차단 유지.
  // SBPL의 remote tcp 필터는 숫자 IP를 받지 않고 호스트명만 받는다 — localhost를 쓴다.
  const network = brokerPort
    ? `(allow network-outbound (remote tcp "localhost:${brokerPort}"))`
    : `(deny network*)`;
  return `(version 1)\n(deny default)\n(allow signal (target self))\n(allow sysctl-read)\n(allow file-read-metadata ${filters})\n(allow file-read* ${filters})\n(allow process-exec (literal ${quotePolicy(runtime)}))\n(deny process-fork)\n${network}\n(allow file-write* (literal ${quotePolicy("/dev/null")}))\n(allow file-write* (subpath ${quotePolicy(join(armRoot, "server", "data"))}))\n(allow file-write* (subpath ${quotePolicy(join(armRoot, "tmp"))}))\n`;
}

interface ChildResult { pid: number; exitCode: number | null; signal: string | null; stdout: Buffer; stderr: Buffer; reasonCode?: string }

function executeSandboxed(args: string[], cwd: string, policy: string, deadlineMs: number, maxOutput: number, input = "", nodeEnv: "production" | "test" = "production", extraEnv: Record<string, string> = {}): Promise<ChildResult> {
  return new Promise((done) => {
    const child = spawn("/usr/bin/sandbox-exec", ["-p", policy, realpathSync(process.execPath), ...args], {
      cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        HOME: join(cwd, "tmp"), TMPDIR: join(cwd, "tmp"), NODE_ENV: nodeEnv, MYBOT_ENV: "e2",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        ...extraEnv,
      },
    });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let size = 0;
    let reasonCode: string | undefined;
    let settled = false;
    let killed = false;
    const kill = (reason: string) => {
      if (!reasonCode) reasonCode = reason;
      if (killed) return;
      killed = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
    };
    const timer = setTimeout(() => kill("timeout"), deadlineMs);
    const collect = (chunk: Buffer) => {
      if (killed) return;
      size += chunk.length;
      if (size > maxOutput) kill("output_limit");
      else chunks.push(Buffer.from(chunk));
    };
    child.stdout.on("data", collect);
    // stderr는 영수증 진단용으로만 보관한다 — stdout과 같은 크기 예산을 공유한다
    child.stderr.on("data", (chunk: Buffer) => {
      if (killed) return;
      size += chunk.length;
      if (size > maxOutput) kill("output_limit");
      else errChunks.push(Buffer.from(chunk.subarray(0, Math.min(chunk.length, 8 * 1024))));
    });
    child.stdin.on("error", () => { reasonCode ||= "stdin_failed"; });
    child.on("error", () => { reasonCode ||= "spawn_failed"; kill(reasonCode); });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ pid: child.pid ?? 0, exitCode: code, signal, stdout: Buffer.concat(chunks), stderr: Buffer.concat(errChunks), reasonCode });
    });
    child.stdin.end(input);
  });
}

function validateFrozenFile(root: string, value: string, suffix?: string): string {
  const rel = safeRelativePath(value);
  if (suffix && !rel.endsWith(suffix)) throw new Error("preflight_path_invalid");
  const path = join(root, rel);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("preflight_path_invalid");
  return rel;
}

async function candidatePreflight(options: IsolationOptions, root: string, dependencyRoot: string | undefined, deadline: number, output: number): Promise<string | undefined> {
  const preflight = options.preflight;
  if (!preflight) return undefined;
  if (preflight.typeScriptCompiler) {
    const supplied = resolve(options.sourceRoot, preflight.typeScriptCompiler);
    if (!existsSync(supplied)) return "typescript_compiler_missing";
    const compiler = realpathSync(supplied);
    if (!compiler.endsWith(".js") || !lstatSync(compiler).isFile() || lstatSync(compiler).isSymbolicLink()) return "typescript_compiler_invalid";
    const source = realpathSync(options.sourceRoot);
    const executableCompiler = dependencyRoot && pathInside(compiler, dependencyRoot)
      ? join(root, "node_modules", relative(dependencyRoot, compiler))
      : pathInside(compiler, source) ? join(root, relative(source, compiler)) : compiler;
    if (!existsSync(executableCompiler) || !lstatSync(executableCompiler).isFile()) return "typescript_compiler_invalid";
    const config = join(root, "tmp", "e2-tsconfig.json");
    writeFileSync(config, JSON.stringify({ extends: join(root, "tsconfig.json"), files: [join(root, safeRelativePath(options.candidate.filePath ?? options.candidate.target))], include: [] }));
    const policy = sandboxPolicy(root, realpathSync(process.execPath), pathInside(executableCompiler, root) ? [] : [dirname(executableCompiler)]);
    const result = await executeSandboxed([executableCompiler, "--noEmit", "-p", config], root, policy, deadline, output);
    if (result.reasonCode || result.signal || result.exitCode !== 0) return "typecheck_failed";
  }
  const tests = preflight.testFiles?.map((file) => validateFrozenFile(root, file, ".test.ts")) ?? [];
  if (tests.length) {
    const preload = preflight.preload ? validateFrozenFile(root, preflight.preload) : undefined;
    const args = ["test", ...(preload ? ["--preload", preload] : []), ...tests];
    const policy = sandboxPolicy(root, realpathSync(process.execPath));
    const result = await executeSandboxed(args, root, policy, deadline, output, "", "test");
    if (result.reasonCode || result.signal || result.exitCode !== 0) return "tests_failed";
  }
  return undefined;
}

export async function runIsolatedComparison(options: IsolationOptions): Promise<IsolationResult> {
  if (!options || typeof options !== "object") return { status: "inconclusive", promotionEligible: false, reasonCode: "mode_invalid" };
  if (options.mode === "production") {
    // E2-B — 실제 골든 업무를 브로커 경유 실모델로 격리 실행한다.
    // broker·golden·model 없이는 측정할 수 없으므로 명시적으로 불능 처리한다.
    if (!options.broker || !options.golden?.prompt || !options.model)
      return { status: "inconclusive", promotionEligible: false, reasonCode: "production_requirements_missing" };
  } else if (options.mode !== "fixture") {
    return { status: "inconclusive", promotionEligible: false, reasonCode: "mode_invalid" };
  } else {
    if (process.env.NODE_ENV !== "test") return { status: "inconclusive", promotionEligible: false, reasonCode: "fixture_mode_disabled" };
    if (!options.fixture?.modulePath) return { status: "inconclusive", promotionEligible: false, reasonCode: "fixture_required" };
  }
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))
    return { status: "inconclusive", promotionEligible: false, reasonCode: "sandbox_unavailable" };
  // 태그는 브로커 토큰의 ":" 뒤에 실린다 — ":"·공백이 섞이면 태그 파싱이 깨져 계측이 엉킨다
  const tagSuffix = options.tagSuffix ?? "";
  if (!/^[\w-]{0,16}$/.test(tagSuffix))
    return { status: "inconclusive", promotionEligible: false, reasonCode: "tag_suffix_invalid" };

  // production은 실모델 호출이 들어가 기본 3분·최대 10분까지, fixture는 30초 상한.
  // 기한은 정지 감지용이라 판정과 무관하다 — 5초는 외장 디스크 I/O 경합에서
  // 느려진 정상 자식까지 잘라, 검증된 업데이트의 적용을 실패시킨 적이 있다(2026-09-20).
  const production = options.mode === "production";
  const deadline = bounded(options.deadlineMs, production ? 180_000 : 30_000, 100, production ? 600_000 : 60_000);
  const outputLimit = bounded(options.maxOutputBytes, 64 * 1024, 1_024, 1024 * 1024);
  let comparisonRoot: string | undefined;
  try {
    accessSync("/usr/bin/sandbox-exec", constants.X_OK);
    const frozen = captureSource(options.sourceRoot);
    const codeTarget = validateCodeTarget(options.candidate, frozen.files);
    if (!codeTarget) {
      if (!DB_SURFACES.has(options.candidate.surface)) return { status: "inconclusive", promotionEligible: false, reasonCode: "candidate_surface_invalid" };
      const seeded = options.seed?.agents?.some((agent) => agent.id === options.candidate.target || agent.name === options.candidate.target) ?? false;
      if (!options.candidate.surface.startsWith("agent.") || !seeded)
        return { status: "inconclusive", promotionEligible: false, reasonCode: "candidate_target_missing" };
    }
    const fixturePath = production ? undefined : safeRelativePath(options.fixture!.modulePath);
    if (fixturePath && !frozen.files.has(fixturePath)) throw new Error("fixture_not_frozen");
    const seed = options.seed ?? {};
    const schemaHash = hashBytes([frozen.files.get("server/src/db.ts")!]);
    const initialStateHash = hashBytes([canonicalJson({ seed, schemaHash })]);
    comparisonRoot = mkdtempSync(join(realpathSync(tmpdir()), "mybot-e2a-"));
    const baselineRoot = join(comparisonRoot, "baseline");
    const candidateRoot = join(comparisonRoot, "candidate");
    materializeSnapshot(frozen, baselineRoot);
    materializeSnapshot(frozen, candidateRoot);
    if (hashFrozenDeps(baselineRoot, frozen.dependencies) !== frozen.dependencyHash
      || hashFrozenDeps(candidateRoot, frozen.dependencies) !== frozen.dependencyHash)
      throw new Error("dependency_mutated");
    const manifest = [...frozen.files.keys()];
    if (codeTarget) applySourceCandidate(candidateRoot, codeTarget, options.candidate.newContent ?? "");
    const candidatePreparedHash = hashSnapshot(candidateRoot, manifest);
    const workerRel = "server/src/evolve/worker.ts";
    const protocolRel = "server/src/evolve/protocol.ts";
    const snapshotRel = "server/src/evolve/snapshot.ts";
    const isolationRel = "server/src/evolve/isolation.ts";
    const harnessHash = hashBytes([
      frozen.files.get(workerRel)!, frozen.files.get(protocolRel)!, frozen.files.get(snapshotRel)!, frozen.files.get(isolationRel)!,
    ]);
    const runtime = { path: realpathSync(process.execPath), version: process.versions.bun ?? "unknown" };
    const runtimeExecutableHash = hashBytes([readFileSync(runtime.path)]);

    const runArm = async (arm: "baseline" | "candidate", root: string): Promise<ArmReceipt> => {
      const sourceHash = hashSnapshot(root, manifest);
      if (hashFrozenDeps(root, frozen.dependencies) !== frozen.dependencyHash) throw new Error("dependency_mutated");
      const policy = sandboxPolicy(root, runtime.path, [], options.broker?.port);
      const policyHash = hashBytes([policy]);
      const request: WorkerRequest = {
        protocolVersion: PROTOCOL_VERSION, runId: randomUUID(), arm,
        armRoot: root, fixtureModule: fixturePath, exportName: options.fixture?.exportName ?? "probe",
        input: options.fixture?.input, seed,
        candidate: arm === "candidate" && !codeTarget ? options.candidate : undefined,
        // 토큰에 팔 태그를 붙인다 — 브로커가 같은 인증으로 팔별 비용을 분리 집계한다
        broker: options.broker ? { url: `http://127.0.0.1:${options.broker.port}`, token: `${options.broker.token}:${arm}${tagSuffix}` } : undefined,
        golden: production ? options.golden : undefined,
        model: production ? options.model : undefined,
        evalModel: production ? options.evalModel : undefined,
      };
      const startedAt = Date.now();
      // 파이프라인 깊은 곳(검색 등)은 요청 객체에 닿지 못하므로 브로커 주소·팔 태그 토큰을
      // env로 넘긴다 — search.ts의 e2 분기가 이걸 읽어 브로커의 /tool을 호출한다.
      const child = await executeSandboxed([join(root, workerRel)], root, policy, deadline, outputLimit, canonicalJson(request), "production",
        options.broker ? { E2_BROKER_URL: `http://127.0.0.1:${options.broker.port}`, E2_BROKER_TOKEN: `${options.broker.token}:${arm}${tagSuffix}` } : {});
      const endedAt = Date.now();
      const stderrTail = child.stderr.length ? child.stderr.toString("utf8").slice(-2048) : undefined;
      const receipt: ArmReceipt = {
        arm, pid: child.pid, sourceHash, dependencyHash: frozen.dependencyHash,
        initialStateHash, initialStateKind: "synthetic-seed-and-schema", harnessHash, policyHash, runtime,
        startedAt, endedAt, runtimeExecutableHash,
        model: { requested: options.model ?? null, resolved: [], executed: false, calls: 0 }, exitCode: child.exitCode, signal: child.signal,
      };
      const failReceipt = (reasonCode: string): ArmReceipt => ({ ...receipt, reasonCode, stderrTail });
      if (hashSnapshot(root, manifest) !== sourceHash) return failReceipt("source_mutated");
      try {
        if (hashFrozenDeps(root, frozen.dependencies) !== frozen.dependencyHash)
          return failReceipt("dependency_mutated");
      } catch { return failReceipt("dependency_mutated"); }
      if (child.reasonCode) return failReceipt(child.reasonCode);
      if (child.signal) return failReceipt("worker_signaled");
      if (child.exitCode !== 0) return failReceipt("worker_nonzero_exit");
      let response: unknown;
      try { response = JSON.parse(child.stdout.toString("utf8")); } catch { return failReceipt("worker_invalid_output"); }
      if (!isWorkerResponse(response, request)) return failReceipt("worker_invalid_output");
      if (!response.ok) return failReceipt(response.reasonCode ?? "worker_failed");
      receipt.value = response.value;
      // 영수증의 진실 원천은 브로커 — 파이프라인 호출은 worker가 못 보지만 브로커는 다 본다.
      // worker 보고(ctx.chat 경유)와 병합한다.
      let brokerCalls = 0; let brokerModels: string[] = [];
      if (options.broker) {
        try {
          const u = await (await fetch(`http://127.0.0.1:${options.broker.port}/usage`, { headers: { authorization: `Bearer ${options.broker.token}` } })).json() as any;
          const per = u?.byTag?.[`${arm}${tagSuffix}`];
          brokerCalls = per?.calls ?? 0;
          brokerModels = per?.models ?? [];
        } catch {}
      }
      receipt.model = {
        requested: options.model ?? null,
        resolved: [...new Set([...response.models, ...brokerModels])],
        executed: response.modelCalls > 0 || brokerCalls > 0,
        calls: Math.max(response.modelCalls, brokerCalls),
      };
      return receipt;
    };

    const baseline = await runArm("baseline", baselineRoot);
    if (baseline.reasonCode) return { status: "crash", promotionEligible: false, reasonCode: "baseline_failed", baseline };
    let preflightFailure: string | undefined;
    try {
      if (hashFrozenDeps(candidateRoot, frozen.dependencies) !== frozen.dependencyHash)
        return { status: "inconclusive", promotionEligible: false, reasonCode: "dependency_mutated", baseline };
      preflightFailure = await candidatePreflight(options, candidateRoot, frozen.dependencyRoot, deadline, outputLimit);
    } catch (error) {
      if (hashSnapshot(candidateRoot, manifest) !== candidatePreparedHash)
        return { status: "inconclusive", promotionEligible: false, reasonCode: "source_mutated", baseline };
      try {
        if (hashFrozenDeps(candidateRoot, frozen.dependencies) !== frozen.dependencyHash)
          return { status: "inconclusive", promotionEligible: false, reasonCode: "dependency_mutated", baseline };
      } catch { return { status: "inconclusive", promotionEligible: false, reasonCode: "dependency_mutated", baseline }; }
      throw error;
    }
    if (hashSnapshot(candidateRoot, manifest) !== candidatePreparedHash)
      return { status: "inconclusive", promotionEligible: false, reasonCode: "source_mutated", baseline };
    try {
      if (hashFrozenDeps(candidateRoot, frozen.dependencies) !== frozen.dependencyHash)
        return { status: "inconclusive", promotionEligible: false, reasonCode: "dependency_mutated", baseline };
    } catch { return { status: "inconclusive", promotionEligible: false, reasonCode: "dependency_mutated", baseline }; }
    if (preflightFailure) return { status: "inconclusive", promotionEligible: false, reasonCode: preflightFailure, baseline };
    rmSync(join(candidateRoot, "server", "data"), { recursive: true, force: true });
    rmSync(join(candidateRoot, "tmp"), { recursive: true, force: true });
    mkdirSync(join(candidateRoot, "server", "data"), { recursive: true, mode: 0o700 });
    mkdirSync(join(candidateRoot, "tmp"), { recursive: true, mode: 0o700 });
    const candidate = await runArm("candidate", candidateRoot);
    if (candidate.reasonCode === "candidate_apply_failed") return { status: "inconclusive", promotionEligible: false, reasonCode: "candidate_apply_failed", baseline, candidate };
    if (candidate.reasonCode) return { status: "crash", promotionEligible: false, reasonCode: "candidate_failed", baseline, candidate };
    return { status: "complete", promotionEligible: false, baseline, candidate };
  } catch (error) {
    const code = (error as Error).message;
    if (process.env.E2_DEBUG) console.error("E2 parent failure:", error);
    return { status: "crash", promotionEligible: false, reasonCode: /^[a-z0-9_]+$/.test(code) ? code : "parent_failure" };
  } finally {
    if (comparisonRoot) {
      try { rmSync(comparisonRoot, { recursive: true, force: true }); } catch {}
    }
  }
}
