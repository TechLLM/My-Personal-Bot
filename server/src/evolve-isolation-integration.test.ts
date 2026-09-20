import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "./db";
import * as isolation from "./evolve/isolation";
import {
  applyCandidate,
  autoResolveApprovals,
  evolveRoute,
  preflightCandidate,
  runBench,
  runCycle,
  runGoldenTask,
  dailyEvolveTick,
  type Candidate,
} from "./evolve";

if (db.filename !== ":memory:") throw new Error("메모리 DB에서만 테스트");

const originalMybotEnv = process.env.MYBOT_ENV;
afterEach(() => {
  if (originalMybotEnv === undefined) delete process.env.MYBOT_ENV;
  else process.env.MYBOT_ENV = originalMybotEnv;
});

test("legacy 벤치·승인·live 후보 적용 우회는 부작용 전에 닫힌다", async () => {
  const before = (db.prepare("SELECT COUNT(*) c FROM approval_requests").get() as any).c;
  expect(() => autoResolveApprovals("fixture", 0)).toThrow("legacy-bench-unavailable");
  expect((db.prepare("SELECT COUNT(*) c FROM approval_requests").get() as any).c).toBe(before);

  const bench = await runBench();
  expect(bench.evaluationStatus).toBe("inconclusive");
  expect(bench.samples).toEqual([]);
  await expect(runGoldenTask({ id: "fixture", holdout: false, prompt: "x", checks: [] }))
    .rejects.toThrow("legacy-bench-unavailable");

  expect(() => applyCandidate({
    surface: "src",
    target: "server/src/report.ts",
    filePath: "server/src/report.ts",
    newContent: "export const changed = true;",
    summary: "fixture",
  })).toThrow("live-candidate-application-disabled");
});

test("정적 preflight는 traversal·보호 대상·미등록 DB 컬럼을 실행 전에 거부한다", async () => {
  const reportPath = join(import.meta.dir, "report.ts");
  const originalReport = readFileSync(reportPath);
  const valid: Candidate = {
    surface: "src", target: "server/src/report.ts", filePath: "server/src/report.ts",
    newContent: `${originalReport.toString("utf8")}\n// static preflight fixture\n`, summary: "fixture",
  };
  const validResult = await preflightCandidate(valid);
  expect(validResult).toEqual([]); // 유효한 후보는 정적 검사를 통과한다 — 격리 실행 자체는 runCycle이 수행
  expect(readFileSync(reportPath)).toEqual(originalReport);

  const traversal: Candidate = {
    surface: "src", target: "../../package.json", filePath: "../../package.json",
    newContent: "{}", summary: "fixture",
  };
  expect((await preflightCandidate(traversal)).join(" ")).toContain("루트 밖");
  expect(readFileSync(reportPath)).toEqual(originalReport);

  const protectedCandidate: Candidate = {
    surface: "src", target: "server/src/db.ts", filePath: "server/src/db.ts",
    newContent: "export {};", summary: "fixture",
  };
  const protectedFailures = await preflightCandidate(protectedCandidate);
  expect(protectedFailures.some((message) => message.includes("DB 하네스") && message.includes("후보 대상 불가"))).toBe(true);
  expect(protectedFailures.every((message) => message.trim().length > 0)).toBe(true);
  expect(readFileSync(reportPath)).toEqual(originalReport);

  const unknown: Candidate = {
    surface: "unknown.surface", target: "server/src/report.ts", filePath: "server/src/report.ts",
    newContent: "export {};", summary: "fixture",
  };
  expect((await preflightCandidate(unknown)).join(" ")).toContain("미등록 표면");
  expect(readFileSync(reportPath)).toEqual(originalReport);

  const badColumn: Candidate = {
    surface: "agent.role", target: "fixture", column: "created_at",
    newValue: "[전문가 수행 기준] fixture", summary: "fixture",
  };
  expect((await preflightCandidate(badColumn)).join(" ")).toContain("등록되지 않은 컬럼");
});

function tableCount(table: string): number | undefined {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!exists) return undefined;
  return Number((db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as any).c);
}

function outboxCounts(): Record<string, number> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%outbox%'").all() as { name: string }[];
  return Object.fromEntries(rows.map(({ name }) => [name, tableCount(name)!]));
}

function parkExistingExperiments() {
  const rows = db.prepare("SELECT id, created_at, finished_at, verdict, reason FROM experiments").all() as any[];
  for (const row of rows) {
    db.prepare("UPDATE experiments SET created_at = 0, finished_at = COALESCE(finished_at, 1) WHERE id = ?").run(row.id);
  }
  return () => {
    for (const row of rows) {
      db.prepare("UPDATE experiments SET created_at = ?, finished_at = ?, verdict = ?, reason = ? WHERE id = ?")
        .run(row.created_at, row.finished_at, row.verdict, row.reason, row.id);
    }
  };
}

test("runCycle은 격리 결과를 승격하지 않고 원장을 마감하며 원본·외부 부작용을 보존한다", async () => {
  const previousEnv = process.env.MYBOT_ENV;
  const restoreExperiments = parkExistingExperiments();
  const reportPath = join(import.meta.dir, "report.ts");
  const originalReport = readFileSync(reportPath);
  const beforeOutbox = outboxCounts();
  let fetchCount = 0;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    (async () => {
      fetchCount++;
      throw new Error("network disabled in evolve integration fixture");
    }) as unknown as typeof globalThis.fetch,
  );
  const isolationSpy = spyOn(isolation, "runIsolatedComparison").mockResolvedValue({
    status: "complete",
    promotionEligible: false,
    baseline: {
      arm: "baseline", pid: 101, sourceHash: "a".repeat(64), initialStateHash: "b".repeat(64),
      harnessHash: "c".repeat(64), policyHash: "d".repeat(64),
      runtime: { path: "/fixture/bun", version: "fixture" },
      model: { requested: null, resolved: null, executed: false }, value: { score: 100 }, exitCode: 0, signal: null,
    },
    candidate: {
      arm: "candidate", pid: 102, sourceHash: "e".repeat(64), initialStateHash: "b".repeat(64),
      harnessHash: "c".repeat(64), policyHash: "f".repeat(64),
      runtime: { path: "/fixture/bun", version: "fixture" },
      model: { requested: null, resolved: null, executed: false }, value: { score: 100 }, exitCode: 0, signal: null,
    },
  } as any);
  let experimentId = "";
  try {
    process.env.MYBOT_ENV = "dev";
    const candidate: Candidate = {
      surface: "src", target: "server/src/report.ts", filePath: "server/src/report.ts",
      newContent: `${originalReport.toString("utf8")}\n// isolated cycle candidate\n`, summary: "격리 사이클 fixture",
    };
    const fakePerfectBaseline = {
      passRate: 1, avgLatencyMs: 1, samples: [], byTask: {}, evaluationStatus: "complete" as const,
    };
    const result = await runCycle(candidate, { baseline: fakePerfectBaseline });
    experimentId = result.experimentId;
    expect(result.experimentId.length).toBeGreaterThan(0);
    expect(result.verdict).toBe("inconclusive");
    expect(result.reason.length).toBeGreaterThan(0);

    const row = db.prepare("SELECT verdict, result, finished_at FROM experiments WHERE id = ?").get(result.experimentId) as any;
    expect(row.verdict).toBe("inconclusive");
    expect(row.finished_at).not.toBeNull();
    expect(JSON.parse(row.result).promotionEligible).toBe(false);
    expect(readFileSync(reportPath)).toEqual(originalReport);
    expect(outboxCounts()).toEqual(beforeOutbox);
    expect(fetchCount).toBe(0);
    expect(isolationSpy).toHaveBeenCalled(); // 골든 과제마다 한 번 — 과제당 baseline/candidate 비교 1회
  } finally {
    isolationSpy.mockRestore();
    fetchSpy.mockRestore();
    if (experimentId) db.prepare("DELETE FROM experiments WHERE id = ?").run(experimentId);
    restoreExperiments();
    if (previousEnv === undefined) delete process.env.MYBOT_ENV;
    else process.env.MYBOT_ENV = previousEnv;
  }
});

test("dailyEvolveTick은 모델·네트워크·상태 생성 없이 자동 사이클 보류를 반환한다", async () => {
  const previousEnv = process.env.MYBOT_ENV;
  const restoreExperiments = parkExistingExperiments();
  const before = {
    agents: tableCount("agents"),
    runs: tableCount("agent_runs"),
    memories: tableCount("memories"),
    outbox: outboxCounts(),
  };
  let fetchCount = 0;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    (async () => {
      fetchCount++;
      throw new Error("network disabled in daily evolve fixture");
    }) as unknown as typeof globalThis.fetch,
  );
  try {
    process.env.MYBOT_ENV = "dev";
    const result = await dailyEvolveTick();
    expect(result).toContain("auto-cycle-paused");
    expect(fetchCount).toBe(0);
    expect({
      agents: tableCount("agents"),
      runs: tableCount("agent_runs"),
      memories: tableCount("memories"),
      outbox: outboxCounts(),
    }).toEqual(before);
  } finally {
    fetchSpy.mockRestore();
    restoreExperiments();
    if (previousEnv === undefined) delete process.env.MYBOT_ENV;
    else process.env.MYBOT_ENV = previousEnv;
  }
});

test("서비스 환경에서는 dry cycle과 tick도 동적 개발 게이트를 통과할 수 없다", async () => {
  process.env.MYBOT_ENV = "service";
  const candidate: Candidate = {
    surface: "src", target: "server/src/report.ts", filePath: "server/src/report.ts",
    newContent: "export const fixture = true;", summary: "fixture",
  };
  const dry = await evolveRoute.request("/cycle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ candidate, dry: true }),
  });
  expect(dry.status).toBe(403);
  expect((await evolveRoute.request("/tick", { method: "POST" })).status).toBe(403);
});
