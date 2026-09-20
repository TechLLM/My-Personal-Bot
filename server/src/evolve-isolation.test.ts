import { afterAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runIsolatedComparison } from "./evolve/isolation";

const isDarwin = process.platform === "darwin";
const ownedTemps = new Set<string>();

type Fixture = {
  outer: string;
  root: string;
  sentinel: string;
  sentinelValue: string;
};

const baselineProbe = `
export async function probe() {
  return { value: "baseline-literal" };
}
`;

const candidateProbe = `
export async function probe() {
  return { value: "candidate-literal" };
}
`;

function makeFixture(probe = baselineProbe, extraFiles: Record<string, string> = {}): Fixture {
  const outer = mkdtempSync(join(tmpdir(), "evolve-e2a-"));
  ownedTemps.add(outer);
  const root = join(outer, "source root with spaces");
  mkdirSync(join(root, "server", "src"), { recursive: true });
  copyFileSync(join(import.meta.dir, "db.ts"), join(root, "server", "src", "db.ts"));
  writeFileSync(join(root, "server", "src", "probe.ts"), probe);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "isolation-fixture", private: true, type: "module" }));
  writeFileSync(join(root, "bun.lock"), "");
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      noEmit: true,
      lib: ["ESNext"],
      types: [],
    },
    // Compiler preflight deliberately checks only the candidate probe. Pulling the
    // fixture DB/worker into this project would require Bun ambient types and could
    // turn an unrelated harness typing issue into a false candidate rejection.
    include: ["server/src/probe.ts"],
  }));
  for (const [relative, content] of Object.entries(extraFiles)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  const sentinel = join(outer, "outside-arm-sentinel.txt");
  const sentinelValue = `raw-sentinel-${crypto.randomUUID()}`;
  writeFileSync(sentinel, sentinelValue);
  return { outer, root, sentinel, sentinelValue };
}

function cleanupFixture(fixture: Fixture) {
  const outer = resolve(fixture.outer);
  if (
    ownedTemps.has(fixture.outer)
    && dirname(outer) === resolve(tmpdir())
    && basename(outer).startsWith("evolve-e2a-")
    && lstatSync(outer).isDirectory()
  ) {
    ownedTemps.delete(fixture.outer);
    rmSync(outer, { recursive: true, force: true });
  }
}

afterAll(() => {
  for (const outer of [...ownedTemps]) {
    const fixture = { outer, root: "", sentinel: "", sentinelValue: "" };
    cleanupFixture(fixture);
  }
});

function options(fixture: Fixture, newContent = candidateProbe, overrides: Record<string, unknown> = {}) {
  return {
    sourceRoot: fixture.root,
    candidate: {
      surface: "src",
      target: "server/src/probe.ts",
      filePath: "server/src/probe.ts",
      newContent,
      summary: "independent E2-A fixture candidate",
    },
    mode: "fixture" as const,
    fixture: { modulePath: "server/src/probe.ts" },
    seed: {
      agents: [{ id: "agent-fixed-1", name: "Fixture Agent", role_prompt: "fixed", model: "fixture-model" }],
      workspaceFiles: { "seed.txt": "seed-data" },
    },
    deadlineMs: 1_500,
    maxOutputBytes: 16_384,
    ...overrides,
  };
}

function expectFailClosed(result: any) {
  expect(["inconclusive", "crash"]).toContain(result.status);
  expect(result.promotionEligible).toBe(false);
}

function expectDead(pid: number | undefined) {
  if (pid === undefined) return;
  expect(pid).toBeGreaterThan(0);
  let code: unknown;
  try {
    process.kill(pid, 0);
  } catch (error: any) {
    code = error?.code;
  }
  expect(code).toBe("ESRCH");
}

function expectReceiptInvariant(receipt: any, arm: "baseline" | "candidate") {
  expect(receipt.arm).toBe(arm);
  expect(receipt.pid).toBeGreaterThan(0);
  expect(receipt.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt.dependencyHash).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt.initialStateHash).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt.initialStateKind).toBe("synthetic-seed-and-schema");
  expect(receipt.harnessHash).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt.policyHash).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt.runtime.path.length).toBeGreaterThan(0);
  expect(receipt.runtime.version.length).toBeGreaterThan(0);
  expect(receipt.model).toEqual({ requested: null, resolved: [], executed: false, calls: 0 });
}

function resolveTypeScriptCompiler(command: string): string | undefined {
  if (!existsSync(command)) return undefined;
  const discovered = realpathSync(command);
  const candidates = basename(discovered) === "tsc"
    ? [resolve(dirname(discovered), "..", "lib", "tsc.js")]
    : [discovered];
  for (const candidate of candidates) {
    if (!candidate.endsWith(".js") || !existsSync(candidate)) continue;
    const resolved = realpathSync(candidate);
    if (!resolved.endsWith(".js") || !lstatSync(resolved).isFile()) continue;
    // Bun's native TypeScript launcher delegates through #getExePath and needs
    // process creation, which the strict preflight sandbox intentionally denies.
    // This fixture verifies only a provided, pure-JavaScript compiler entrypoint.
    if (readFileSync(resolved, "utf8").includes("#getExePath")) continue;
    return resolved;
  }
  return undefined;
}

const childTest = isDarwin ? test : test.skip;

describe("runIsolatedComparison E2-A OS boundary", () => {
  childTest("measures independent baseline and changed candidate receipts", async () => {
    const fixture = makeFixture();
    const originalProbe = readFileSync(join(fixture.root, "server/src/probe.ts"), "utf8");
    const originalDb = readFileSync(join(fixture.root, "server/src/db.ts"), "utf8");
    try {
      const result = await runIsolatedComparison(options(fixture));
      expect(result.status).toBe("complete");
      expect(result.promotionEligible).toBe(false);
      expectReceiptInvariant(result.baseline, "baseline");
      expectReceiptInvariant(result.candidate, "candidate");
      expect(result.baseline!.value).toEqual({ value: "baseline-literal" });
      expect(result.candidate!.value).toEqual({ value: "candidate-literal" });
      expect(result.baseline!.pid).not.toBe(result.candidate!.pid);
      expect(result.baseline!.sourceHash).not.toBe(result.candidate!.sourceHash);
      expect(result.baseline!.dependencyHash).toBe(result.candidate!.dependencyHash);
      expect(result.baseline!.initialStateHash).toBe(result.candidate!.initialStateHash);
      expect(result.baseline!.harnessHash).toBe(result.candidate!.harnessHash);
      // The permissions are equivalent, but the policy embeds each arm's
      // absolute directory and therefore the serialized policy hashes differ.
      expect(result.baseline!.policyHash).not.toBe(result.candidate!.policyHash);
      expect(readFileSync(join(fixture.root, "server/src/probe.ts"), "utf8")).toBe(originalProbe);
      expect(readFileSync(join(fixture.root, "server/src/db.ts"), "utf8")).toBe(originalDb);
      expectDead(result.baseline!.pid);
      expectDead(result.candidate!.pid);
    } finally {
      cleanupFixture(fixture);
    }
  }, 10_000);

  childTest("starts both arms from identical DB and workspace seeds", async () => {
    const baseline = `
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
export async function probe(ctx) {
  const countBefore = ctx.db.query("SELECT COUNT(*) count FROM agents").get().count;
  const seed = readFileSync(join(ctx.workspaceDir, "seed.txt"), "utf8");
  ctx.db.exec("INSERT INTO agents (id,name,created_at) VALUES ('baseline-added','Baseline Added',1)");
  writeFileSync(join(ctx.workspaceDir, "baseline-only.txt"), "must-not-cross-arms");
  return { countBefore, seed };
}`;
    const candidate = `
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
export async function probe(ctx) {
  return {
    count: ctx.db.query("SELECT COUNT(*) count FROM agents").get().count,
    seed: readFileSync(join(ctx.workspaceDir, "seed.txt"), "utf8"),
    leakedRow: !!ctx.db.query("SELECT id FROM agents WHERE id='baseline-added'").get(),
    leakedFile: existsSync(join(ctx.workspaceDir, "baseline-only.txt")),
  };
}`;
    const fixture = makeFixture(baseline);
    try {
      const result = await runIsolatedComparison(options(fixture, candidate));
      expect(result.status).toBe("complete");
      expect(result.baseline!.value).toEqual({ countBefore: 1, seed: "seed-data" });
      expect(result.candidate!.value).toEqual({ count: 1, seed: "seed-data", leakedRow: false, leakedFile: false });
      expect(result.baseline!.initialStateHash).toBe(result.candidate!.initialStateHash);
      expectDead(result.baseline!.pid);
      expectDead(result.candidate!.pid);
    } finally {
      cleanupFixture(fixture);
    }
  }, 10_000);

  childTest("denies external reads/writes, source writes, loopback network, and subprocess execution", async () => {
    const fixture = makeFixture();
    const rootMarker = join(fixture.root, "forbidden-original-write.txt");
    const source = `
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
export async function probe() {
  let externalRead = false, originalWrite = false, sourceWrite = false, network = false, spawn = false;
  try { readFileSync(${JSON.stringify(fixture.sentinel)}, "utf8"); externalRead = true; } catch {}
  try { writeFileSync(${JSON.stringify(rootMarker)}, "bad"); originalWrite = true; } catch {}
  try { writeFileSync(fileURLToPath(import.meta.url), "bad"); sourceWrite = true; } catch {}
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 200);
    await fetch("http://127.0.0.1:9/e2-a", { signal: controller.signal });
    clearTimeout(timer);
    network = true;
  } catch {}
  try {
    const child = Bun.spawnSync([process.execPath, "-e", "process.exit(0)"]);
    spawn = child.exitCode === 0;
  } catch {}
  return { externalRead, originalWrite, sourceWrite, network, spawn };
}`;
    try {
      const result = await runIsolatedComparison(options(fixture, source));
      expect(result.status).toBe("complete");
      expect(result.candidate!.value).toEqual({
        externalRead: false,
        originalWrite: false,
        sourceWrite: false,
        network: false,
        spawn: false,
      });
      expect(existsSync(rootMarker)).toBe(false);
      expect(readFileSync(fixture.sentinel, "utf8")).toBe(fixture.sentinelValue);
      expect(JSON.stringify(result)).not.toContain(fixture.sentinelValue);
      expectDead(result.baseline!.pid);
      expectDead(result.candidate!.pid);
    } finally {
      cleanupFixture(fixture);
    }
  }, 10_000);

  childTest("rejects absolute candidate paths before either arm executes", async () => {
    const fixture = makeFixture(`import { writeFileSync } from "node:fs"; export async function probe(){ writeFileSync(${JSON.stringify(join(fixturePathPlaceholder(), "never"))}, "x"); return 1 }`);
    const marker = join(fixture.outer, "validation-marker");
    writeFileSync(join(fixture.root, "server/src/probe.ts"), `import { writeFileSync } from "node:fs"; export async function probe(){ writeFileSync(${JSON.stringify(marker)}, "x"); return 1 }`);
    try {
      const result = await runIsolatedComparison(options(fixture, candidateProbe, {
        candidate: { surface: "src", target: join(fixture.outer, "escape.ts"), filePath: join(fixture.outer, "escape.ts"), newContent: candidateProbe },
      }));
      expectFailClosed(result);
      expect(existsSync(marker)).toBe(false);
      expect(JSON.stringify(result)).not.toContain(fixture.sentinelValue);
    } finally {
      cleanupFixture(fixture);
    }
  }, 10_000);

  childTest("rejects traversal, backslash traversal, and NUL candidate paths", async () => {
    for (const invalid of ["../escape.ts", "server\\src\\..\\..\\escape.ts", "server/src/probe.ts\0tail"]) {
      const fixture = makeFixture();
      try {
        const result = await runIsolatedComparison(options(fixture, candidateProbe, {
          candidate: { surface: "src", target: invalid, filePath: invalid, newContent: candidateProbe },
        }));
        expectFailClosed(result);
        expect(JSON.stringify(result)).not.toContain(fixture.sentinelValue);
      } finally {
        cleanupFixture(fixture);
      }
    }
  }, 10_000);

  childTest("rejects an unregistered candidate surface independently of path validation", async () => {
    const fixture = makeFixture();
    const marker = join(fixture.outer, "unknown-surface-executed");
    writeFileSync(join(fixture.root, "server/src/probe.ts"), `import { writeFileSync } from "node:fs"; export async function probe(){ writeFileSync(${JSON.stringify(marker)}, "bad"); return 1 }`);
    try {
      const result = await runIsolatedComparison(options(fixture, candidateProbe, {
        candidate: {
          surface: "not-registered",
          target: "server/src/probe.ts",
          filePath: "server/src/probe.ts",
          newContent: candidateProbe,
          summary: "unknown surface fixture",
        },
      }));
      expectFailClosed(result);
      expect(existsSync(marker)).toBe(false);
    } finally {
      cleanupFixture(fixture);
    }
  }, 10_000);

  childTest("rejects source file and directory symlinks that escape the source root", async () => {
    for (const kind of ["file", "directory"] as const) {
      const fixture = makeFixture();
      try {
        if (kind === "file") {
          symlinkSync(fixture.sentinel, join(fixture.root, "server", "src", "escaped-link.ts"));
        } else {
          const outsideDir = join(fixture.outer, "outside-dir");
          mkdirSync(outsideDir);
          writeFileSync(join(outsideDir, "value.ts"), "export const value = 1");
          symlinkSync(outsideDir, join(fixture.root, "server", "src", "escaped-dir"), "dir");
        }
        const result = await runIsolatedComparison(options(fixture));
        expectFailClosed(result);
        expect(JSON.stringify(result)).not.toContain(fixture.sentinelValue);
      } finally {
        cleanupFixture(fixture);
      }
    }
  }, 10_000);

  childTest("rejects an untrusted symlinked dependency root before spawning either arm", async () => {
    const fixture = makeFixture();
    const privateDir = join(fixture.outer, "private-dir");
    const secretValue = `fake-secret-${crypto.randomUUID()}`;
    mkdirSync(privateDir);
    writeFileSync(join(privateDir, "fake-secret.txt"), secretValue);
    symlinkSync(privateDir, join(fixture.root, "node_modules"), "dir");
    try {
      const result = await runIsolatedComparison(options(fixture));
      expectFailClosed(result);
      expect(result.promotionEligible).toBe(false);
      expect(result.reasonCode).toBe("dependency_root_untrusted");
      expect(result.baseline).toBeUndefined();
      expect(result.candidate).toBeUndefined();
      expect(readFileSync(fixture.sentinel, "utf8")).toBe(fixture.sentinelValue);
      expect(JSON.stringify(result)).not.toContain(secretValue);
      expect(JSON.stringify(result)).not.toContain(fixture.sentinelValue);
    } finally {
      cleanupFixture(fixture);
    }
  }, 10_000);

  childTest("copies the trusted installed dependency root into each read-only arm", async () => {
    const fixture = makeFixture();
    const projectRoot = resolve(import.meta.dir, "..", "..");
    const installedDependencies = realpathSync(join(projectRoot, "node_modules"));
    const installedHonoFile = realpathSync(Bun.resolveSync("hono", import.meta.dir));
    const originalDependencyBytes = readFileSync(installedHonoFile);
    const dependencyProbe = `
import { appendFileSync } from "node:fs";
import { dirname, sep } from "node:path";
import { Hono } from "hono";
export async function probe(ctx) {
  const resolvedLibrary = Bun.resolveSync("hono", import.meta.dir);
  const armRoot = dirname(dirname(import.meta.dir));
  const libraryResolvedInsideArm = resolvedLibrary === armRoot || resolvedLibrary.startsWith(armRoot + sep);
  let dependencyWriteDenied = false;
  try { appendFileSync(resolvedLibrary, "\\n// forbidden dependency mutation"); }
  catch { dependencyWriteDenied = true; }
  const app = new Hono();
  return { libraryResolvedInsideArm, dependencyWriteDenied, honoConstructed: !!app };
}`;
    writeFileSync(join(fixture.root, "server", "src", "probe.ts"), dependencyProbe);
    symlinkSync(installedDependencies, join(fixture.root, "node_modules"), "dir");
    try {
      const result = await runIsolatedComparison(options(fixture, dependencyProbe, { deadlineMs: 7_500 }));
      expect(result.status).toBe("complete");
      expect(result.baseline?.value).toEqual({
        libraryResolvedInsideArm: true,
        dependencyWriteDenied: true,
        honoConstructed: true,
      });
      expect(result.candidate?.value).toEqual(result.baseline?.value);
      expect(result.baseline?.dependencyHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.candidate?.dependencyHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.baseline?.dependencyHash).toBe(result.candidate?.dependencyHash);
      expect(readFileSync(installedHonoFile)).toEqual(originalDependencyBytes);
      expectDead(result.baseline?.pid);
      expectDead(result.candidate?.pid);
    } finally {
      cleanupFixture(fixture);
    }
  }, 15_000);

  childTest("rejects a symlinked evolve metadata ancestor before either arm executes", async () => {
    const fixture = makeFixture();
    const marker = join(fixture.outer, "metadata-symlink-executed");
    writeFileSync(join(fixture.outer, "surfaces.json"), JSON.stringify({ surfaces: { fake: true } }));
    symlinkSync(fixture.outer, join(fixture.root, "evolve"), "dir");
    writeFileSync(
      join(fixture.root, "server/src/probe.ts"),
      `import { writeFileSync } from "node:fs"; export async function probe(){ writeFileSync(${JSON.stringify(marker)}, "bad"); return 1 }`,
    );
    try {
      const result = await runIsolatedComparison(options(fixture));
      expectFailClosed(result);
      expect(result.baseline).toBeUndefined();
      expect(result.candidate).toBeUndefined();
      expect(existsSync(marker)).toBe(false);
      expect(JSON.stringify(result)).not.toContain(fixture.sentinelValue);
    } finally {
      cleanupFixture(fixture);
    }
  }, 10_000);

  childTest("rejects protected database, entrypoint, tests, and evolve targets", async () => {
    const targets = [
      "server/src/db.ts",
      "server/src/index.ts",
      "server/src/protected.test.ts",
      "server/src/evolve/worker.ts",
    ];
    for (const target of targets) {
      const fixture = makeFixture();
      try {
        const result = await runIsolatedComparison(options(fixture, candidateProbe, {
          candidate: { surface: "src", target, filePath: target, newContent: candidateProbe },
        }));
        expectFailClosed(result);
      } finally {
        cleanupFixture(fixture);
      }
    }
  }, 10_000);

  childTest("fails closed when the candidate throws", async () => {
    const fixture = makeFixture();
    try {
      const result = await runIsolatedComparison(options(fixture, `export async function probe(){ throw new Error("fixture boom") }`));
      expectFailClosed(result);
      expect(result.reasonCode).toBe("candidate_failed");
      expect(result.candidate?.reasonCode).toBeTruthy();
      expectDead(result.baseline?.pid);
      expectDead(result.candidate?.pid);
    } finally {
      cleanupFixture(fixture);
    }
  }, 10_000);

  childTest("fails closed when the candidate exits nonzero", async () => {
    const fixture = makeFixture();
    try {
      const result = await runIsolatedComparison(options(fixture, `export async function probe(){ process.exit(23) }`));
      expectFailClosed(result);
      expect(result.reasonCode).toBe("candidate_failed");
      expect(result.candidate?.reasonCode).toBe("worker_nonzero_exit");
      expect(result.candidate?.exitCode).toBe(23);
      expectDead(result.baseline?.pid);
      expectDead(result.candidate?.pid);
    } finally {
      cleanupFixture(fixture);
    }
  }, 10_000);

  childTest("records the underlying signal when the candidate terminates itself", async () => {
    const fixture = makeFixture();
    try {
      const result = await runIsolatedComparison(options(fixture, `export async function probe(){ process.kill(process.pid, "SIGTERM"); await new Promise(() => {}); }`));
      expectFailClosed(result);
      expect(result.reasonCode).toBe("candidate_failed");
      expect(result.candidate?.reasonCode).toBe("worker_signaled");
      expect(result.candidate?.signal).toBeTruthy();
      expectDead(result.baseline?.pid);
      expectDead(result.candidate?.pid);
    } finally {
      cleanupFixture(fixture);
    }
  }, 10_000);

  childTest("fails closed on untrusted stdout protocol junk", async () => {
    const fixture = makeFixture();
    try {
      const result = await runIsolatedComparison(options(fixture, `export async function probe(){ process.stdout.write("untrusted-junk\\n"); return 7 }`));
      expectFailClosed(result);
      expect(result.reasonCode).toBe("candidate_failed");
      expect(result.candidate?.reasonCode).toBe("worker_invalid_output");
      expectDead(result.baseline?.pid);
      expectDead(result.candidate?.pid);
    } finally {
      cleanupFixture(fixture);
    }
  }, 10_000);

  childTest("rejects forged protocol-shaped stdout even when its version matches", async () => {
    const fixture = makeFixture();
    const forged = JSON.stringify({
      protocolVersion: 1,
      runId: "opaque-forged-run",
      arm: "candidate",
      ok: true,
      value: "forged",
    });
    try {
      const result = await runIsolatedComparison(options(
        fixture,
        `export async function probe(){ process.stdout.write(${JSON.stringify(`${forged}\n`)}); return 7 }`,
      ));
      expectFailClosed(result);
      expect(result.reasonCode).toBe("candidate_failed");
      expect(result.candidate?.reasonCode).toBe("worker_invalid_output");
      expectDead(result.baseline?.pid);
      expectDead(result.candidate?.pid);
    } finally {
      cleanupFixture(fixture);
    }
  }, 10_000);

  childTest("applies agent role candidates only to the seeded isolated database", async () => {
    const probe = `
export async function probe(ctx) {
  const row = ctx.db.query("SELECT id, role_prompt FROM agents WHERE id = ?").get("agent-fixed-1");
  return row ? { id: row.id, role: row.role_prompt } : null;
}`;
    const fixture = makeFixture(probe);
    const missingFixture = makeFixture(probe);
    const roleCandidate = {
      surface: "agent.role",
      target: "agent-fixed-1",
      column: "role_prompt",
      newValue: "candidate-new-role",
      summary: "isolated DB role fixture",
    };
    try {
      const result = await runIsolatedComparison(options(fixture, candidateProbe, {
        candidate: roleCandidate,
      }));
      expect(result.status).toBe("complete");
      expect(result.baseline?.value).toEqual({ id: "agent-fixed-1", role: "fixed" });
      expect(result.candidate?.value).toEqual({ id: "agent-fixed-1", role: "candidate-new-role" });
      expect(result.baseline?.sourceHash).toBe(result.candidate?.sourceHash);
      expect(result.baseline?.initialStateHash).toBe(result.candidate?.initialStateHash);
      expectDead(result.baseline?.pid);
      expectDead(result.candidate?.pid);

      const missing = await runIsolatedComparison(options(missingFixture, candidateProbe, {
        candidate: roleCandidate,
        seed: {
          agents: [{ id: "different-seed-agent", name: "Different Agent", role_prompt: "unchanged" }],
          workspaceFiles: { "seed.txt": "seed-data" },
        },
      }));
      expect(missing.status).toBe("inconclusive");
      expect(missing.promotionEligible).toBe(false);
      expect(missing.reasonCode).toBe("candidate_target_missing");
      expect(missing.baseline).toBeUndefined();
      expect(missing.candidate).toBeUndefined();
    } finally {
      cleanupFixture(fixture);
      cleanupFixture(missingFixture);
    }
  }, 10_000);

  childTest("caps excessive child output and fails closed", async () => {
    const fixture = makeFixture();
    try {
      const result = await runIsolatedComparison(options(fixture, `export async function probe(){ process.stdout.write("x".repeat(262144)); return 7 }`, { maxOutputBytes: 4_096 }));
      expectFailClosed(result);
      expect(result.reasonCode).toBe("candidate_failed");
      expect(result.candidate?.reasonCode).toBe("output_limit");
      expect(result.candidate?.pid).toBeGreaterThan(0);
      expect(JSON.stringify(result).length).toBeLessThan(32_768);
      expectDead(result.baseline?.pid);
      expectDead(result.candidate?.pid);
    } finally {
      cleanupFixture(fixture);
    }
  }, 10_000);

  childTest("terminates an infinite candidate promise within the bounded deadline", async () => {
    const fixture = makeFixture();
    try {
      const started = Date.now();
      const result = await runIsolatedComparison(options(fixture, `export async function probe(){ await new Promise(() => {}); return 1 }`, { deadlineMs: 350 }));
      expect(Date.now() - started).toBeLessThan(2_000);
      expectFailClosed(result);
      expect(result.reasonCode).toBe("candidate_failed");
      expect(result.candidate?.pid).toBeGreaterThan(0);
      expect(result.candidate?.reasonCode).toBe("timeout");
      expectDead(result.baseline?.pid);
      expectDead(result.candidate?.pid);
    } finally {
      cleanupFixture(fixture);
    }
  }, 10_000);

  childTest("accepts a valid typed candidate before rejecting an invalid typed candidate", async () => {
    const fixture = makeFixture();
    let compiler: string | undefined;
    try {
      const projectRoot = resolve(import.meta.dir, "..", "..");
      const preferredCompilers = [
        join(projectRoot, "web", "node_modules", "typescript", "lib", "tsc.js"),
        join(projectRoot, "node_modules", "typescript", "lib", "tsc.js"),
      ];
      for (const candidate of preferredCompilers) {
        compiler = resolveTypeScriptCompiler(candidate);
        if (compiler) break;
      }
      if (!compiler) {
        try {
          const found = execFileSync("which", ["tsc"], { encoding: "utf8" }).trim();
          if (found) compiler = resolveTypeScriptCompiler(found);
        } catch {}
      }
      expect(compiler).toBeDefined();
      const selected = compiler!;
      expect(selected.endsWith(".js")).toBe(true);
      expect(lstatSync(selected).isFile()).toBe(true);
      const valid = `export function probe(): { value: string } { return { value: "typed-valid" }; }`;
      const validResult = await runIsolatedComparison(options(fixture, valid, {
        preflight: { typeScriptCompiler: selected },
      }));
      expect(validResult.status).toBe("complete");
      expect(validResult.candidate?.value).toEqual({ value: "typed-valid" });

      const typedError = `export function probe(): number { let n: number = "bad"; return n; }`;
      const invalidResult = await runIsolatedComparison(options(fixture, typedError, {
        preflight: { typeScriptCompiler: selected },
      }));
      expectFailClosed(invalidResult);
      expect(invalidResult.reasonCode).toBe("typecheck_failed");
      expect(invalidResult.baseline?.pid).toBeGreaterThan(0);
      expect(invalidResult.candidate).toBeUndefined();
    } finally {
      cleanupFixture(fixture);
    }
  }, 10_000);

  childTest("runs a passing fixed Bun preflight before failing closed on a failing one", async () => {
    const fixture = makeFixture(baselineProbe, {
      "server/src/passing-preflight.test.ts": `import { expect, test } from "bun:test"; test("fixed pass", () => expect(1).toBe(1));`,
      "server/src/fixed-preflight.test.ts": `import { expect, test } from "bun:test"; test("fixed failure", () => expect(1).toBe(2));`,
    });
    try {
      const passing = await runIsolatedComparison(options(fixture, candidateProbe, {
        preflight: { testFiles: ["server/src/passing-preflight.test.ts"] },
      }));
      expect(passing.status).toBe("complete");
      expect(passing.candidate?.value).toEqual({ value: "candidate-literal" });

      const failing = await runIsolatedComparison(options(fixture, candidateProbe, {
        preflight: { testFiles: ["server/src/fixed-preflight.test.ts"] },
      }));
      expectFailClosed(failing);
      expect(failing.reasonCode).toBe("tests_failed");
      expect(failing.baseline?.pid).toBeGreaterThan(0);
      expect(failing.candidate).toBeUndefined();
    } finally {
      cleanupFixture(fixture);
    }
  }, 10_000);

  childTest("routes model calls through the credential broker on its loopback port only", async () => {
    const { startBroker } = await import("./evolve/broker");
    const { createServer } = await import("node:http");
    const broker = await startBroker({
      models: ["test/bench-model"],
      upstream: async (_model, messages) => ({ content: `ok:${(messages as any[])[0]?.content}` }),
    });
    // 브로커 외 포트도 열려 있는 제어 서버 — 샌드박스가 브로커 포트만 열었는지 증명한다
    const dummy = createServer((_, res) => res.end("x"));
    await new Promise<void>((r) => dummy.listen(0, "127.0.0.1", r));
    const dummyPort = (dummy.address() as { port: number }).port;
    const brokerProbe = `
export async function probe(ctx) {
  const content = await ctx.chat("test/bench-model", [{ role: "user", content: "ping" }]);
  let deniedModel = false, deniedPort = false;
  try { await ctx.chat("not/allowed", []); } catch { deniedModel = true; }
  try { await fetch("http://127.0.0.1:${dummyPort}/"); } catch { deniedPort = true; }
  return { content, deniedModel, deniedPort };
}`;
    const fixture = makeFixture(brokerProbe);
    try {
      const result = await runIsolatedComparison(options(fixture, brokerProbe, {
        broker: { port: broker.port, token: broker.token },
        model: "test/bench-model",
      }));
      expect(result.status).toBe("complete");
      for (const arm of [result.baseline!, result.candidate!]) {
        expect(arm.value).toEqual({ content: "ok:ping", deniedModel: true, deniedPort: true });
        expect(arm.model).toEqual({ requested: "test/bench-model", resolved: ["test/bench-model"], executed: true, calls: 2 });
      }
      // 브로커는 승인된 호출만 비용으로 집계한다 — 팔당 허용 1건 + 거부 1건(403에서 차단)
      expect(broker.usage().calls).toBe(2);
    } finally {
      cleanupFixture(fixture);
      await broker.close();
      dummy.close();
    }
  }, 15_000);

  childTest("production mode runs a golden task through the real pipeline via broker", async () => {
    const { startBroker } = await import("./evolve/broker");
    // production은 실제 파이프라인을 도니 sourceRoot가 실제 저장소여야 한다 —
    // 스냅샷에 server/src 전체와 node_modules가 들어가야 team.ts가 샌드박스 안에서 임포트된다.
    const repoRoot = resolve(import.meta.dir, "../..");
    // 스텁: 첫 호출은 agent_list 도구 호출을, 도구 결과가 messages에 들어오면 최종 답을 반환.
    // 모델→도구→모델 왕복이 샌드박스 안에서 실제로 도는지 검증한다.
    const broker = await startBroker({
      models: ["zai/glm-5.3-flash"],
      upstream: async (_m, messages) => {
        const hasToolResult = (messages as any[]).some((m) => m?.role === "tool");
        if (!hasToolResult) return { content: "", toolCalls: [{ name: "agent_list", arguments: "{}" }] };
        return { content: "확인 완료 — 등록 봇 수 보고" };
      },
    });
    try {
      const result = await runIsolatedComparison({
        sourceRoot: repoRoot,
        candidate: { surface: "agent.role", target: "bench-bot", newValue: "개선된 역할", summary: "DB 표면 후보" },
        mode: "production",
        seed: {
          agents: [{ id: "bench-bot", name: "Bench Bot", role_prompt: "원래 역할", model: "zai/glm-5.3-flash" }],
          workspaceFiles: { "seed.txt": "seed-data" },
        },
        golden: {
          id: "GT", prompt: "봇 수를 확인해줘", agent: "Bench Bot",
          checks: [{ type: "tool_used", tool: "agent_list" }, { type: "content_regex", pattern: "봇 수" }],
        },
        model: "zai/glm-5.3-flash",
        broker: { port: broker.port, token: broker.token },
        deadlineMs: 120_000,
      });
      expect(result.status).toBe("complete");
      for (const arm of [result.baseline!, result.candidate!]) {
        const v = arm.value as any;
        expect(v.pass).toBe(true);
        expect(v.checks.every((c: any) => c.pass === true)).toBe(true);
        expect(arm.model.executed).toBe(true);
        expect(arm.model.calls).toBeGreaterThanOrEqual(2); // 도구 왕복 = 호출 2회
        expect(arm.model.resolved).toContain("zai/glm-5.3-flash");
      }
      expect(broker.usage().calls).toBeGreaterThanOrEqual(4);
      expect(broker.usage().byTag.baseline?.calls).toBeGreaterThanOrEqual(2);
      expect(broker.usage().byTag.candidate?.calls).toBeGreaterThanOrEqual(2);
      expectDead(result.baseline!.pid);
      expectDead(result.candidate!.pid);
    } finally {
      await broker.close();
    }
  }, 180_000);

  childTest("fails closed when a probe calls ctx.chat without a broker", async () => {
    const fixture = makeFixture(`
export async function probe(ctx) {
  try { await ctx.chat("any/model", []); return { leaked: true }; }
  catch { return { leaked: false }; }
}`);
    try {
      const result = await runIsolatedComparison(options(fixture, baselineProbe));
      expect(result.status).toBe("complete");
      expect(result.baseline!.value).toEqual({ leaked: false });
      expect(result.baseline!.model.executed).toBe(false);
    } finally {
      cleanupFixture(fixture);
    }
  }, 10_000);
});

test("production mode refuses to run without broker, golden task, and model", async () => {
  const fixture = makeFixture();
  const marker = join(fixture.outer, "production-executed");
  writeFileSync(join(fixture.root, "server/src/probe.ts"), `import { writeFileSync } from "node:fs"; export async function probe(){ writeFileSync(${JSON.stringify(marker)}, "bad"); return 1 }`);
  try {
    const result = await runIsolatedComparison({ ...options(fixture), mode: "production" });
    expect(result).toMatchObject({
      status: "inconclusive",
      promotionEligible: false,
      reasonCode: "production_requirements_missing",
    });
    expect(existsSync(marker)).toBe(false);
  } finally {
    cleanupFixture(fixture);
  }
}, 10_000);

test("fixture mode is refused outside NODE_ENV=test and restores the caller environment", async () => {
  const fixture = makeFixture();
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    const result = await runIsolatedComparison(options(fixture));
    expectFailClosed(result);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
    cleanupFixture(fixture);
  }
  expect(process.env.NODE_ENV).toBe(previous);
}, 10_000);

if (!isDarwin) {
  test("returns a structured fail-closed result on unsupported operating systems", async () => {
    const fixture = makeFixture();
    try {
      const result = await runIsolatedComparison(options(fixture));
      expectFailClosed(result);
      expect(typeof result.reasonCode).toBe("string");
      expect(result.reasonCode!.length).toBeGreaterThan(0);
    } finally {
      cleanupFixture(fixture);
    }
  }, 10_000);
}

function fixturePathPlaceholder() {
  return tmpdir();
}
