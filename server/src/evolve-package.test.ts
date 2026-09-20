import { describe, expect, test } from "bun:test";
import { db, uid } from "./db";
if (db.filename !== ":memory:") throw new Error(`테스트가 운영 DB를 열었습니다: ${db.filename}`);
import { opsKey, verifyUpdatePackage, candidateToOps, evolveRoute, type UpdatePackage, type BenchResult } from "./evolve";
import { createHash } from "node:crypto";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

const bench = (over: Partial<BenchResult> = {}): BenchResult => ({
  passRate: 1, avgLatencyMs: 120,
  samples: [{ taskId: "G1", pass: true, latencyMs: 120, checks: [{ pass: true, detail: "ok" }] }],
  byTask: { G1: { n: 1, pass: 1 } }, evaluationStatus: "complete", ...over,
});

const arm = (name: string, over: object = {}) => ({
  arm: name, pid: 1, sourceHash: hash(`src-${name}`), dependencyHash: hash(`dep-${name}`),
  initialStateHash: hash(`state-${name}`), harnessHash: hash(`harness-${name}`), policyHash: hash(`policy-${name}`),
  runtime: { path: "/usr/bin/bun", version: "1.x" }, runtimeExecutableHash: hash("rt"),
  startedAt: 1, endedAt: 2, model: { requested: "m/1", resolved: ["m/1"], executed: true, calls: 2 },
  exitCode: 0, ...over,
});

// 검증 통과하는 패키지의 완전한 형태 — 각 테스트는 여기서 한 요소만 망가뜨린다
const goodPkg = (): UpdatePackage => {
  const ops = [{ kind: "db" as const, surface: "agents", target: "봇", column: "role_prompt", newValue: "새 역할" }];
  return {
    summary: "역할 개선", ops, source: "exp-1",
    measurement: { baseline: bench(), candidate: bench(), verdict: "keep", reason: "후보 우세" },
    evidence: {
      experimentId: "exp-1", candidateKey: opsKey(ops), at: Date.now(),
      arms: [arm("baseline"), arm("candidate")],
      brokerUsage: { byTag: {} },
      holdout: { baseline: bench(), candidate: bench() },
    },
  };
};

describe("E7 서비스 영수증 검증 — verifyUpdatePackage", () => {
  test("형식이 완전한 패키지는 통과한다", () => {
    expect(verifyUpdatePackage(goodPkg()).ok).toBe(true);
  });

  test("keep이 아닌 판정은 수령하지 않는다", () => {
    const p = goodPkg(); (p.measurement as any).verdict = "discard";
    const r = verifyUpdatePackage(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("keep");
  });

  test("측정 근거가 없거나 평가 불완전이면 거부", () => {
    expect(verifyUpdatePackage({ ...goodPkg(), measurement: undefined as any }).ok).toBe(false);
    const p = goodPkg(); (p.measurement.baseline as any).evaluationStatus = "inconclusive";
    expect(verifyUpdatePackage(p).ok).toBe(false);
    const q = goodPkg(); (q.measurement.candidate as any).samples = [];
    expect(verifyUpdatePackage(q).ok).toBe(false);
  });

  test("증거·실험 id·팔 영수증이 없으면 거부", () => {
    expect(verifyUpdatePackage({ ...goodPkg(), evidence: undefined }).ok).toBe(false);
    const p = goodPkg(); p.evidence!.experimentId = "다른-실험";
    expect(verifyUpdatePackage(p).ok).toBe(false);
    const q = goodPkg(); q.evidence!.arms = [arm("baseline")];
    expect(verifyUpdatePackage(q).ok).toBe(false);
    const s = goodPkg(); s.source = "";
    expect(verifyUpdatePackage(s).ok).toBe(false);
  });

  test("영수증 해시·런타임·실모델 호출이 없으면 거부 — 격리 실측 없는 패키지 차단", () => {
    const badHash = goodPkg(); (badHash.evidence!.arms as any)[0].sourceHash = "짧은해시";
    expect(verifyUpdatePackage(badHash).ok).toBe(false);
    const noRt = goodPkg(); (noRt.evidence!.arms as any)[0].runtime = {};
    expect(verifyUpdatePackage(noRt).ok).toBe(false);
    const noCall = goodPkg(); (noCall.evidence!.arms as any)[1].model = { executed: false, calls: 0 };
    expect(verifyUpdatePackage(noCall).ok).toBe(false);
  });

  test("ops가 측정된 후보와 다르면 거부 — 측정 A·발송 B 차단", () => {
    const p = goodPkg(); p.ops[0].newValue = "몰래 바꾼 내용";
    const r = verifyUpdatePackage(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("측정된 후보");
  });

  test("holdout 근거가 없거나 불완전하면 거부", () => {
    const p = goodPkg(); p.evidence!.holdout = undefined;
    expect(verifyUpdatePackage(p).ok).toBe(false);
    const q = goodPkg(); (q.evidence!.holdout as any).candidate = { passRate: 1, samples: [] };
    expect(verifyUpdatePackage(q).ok).toBe(false);
  });
});

describe("opsKey·candidateToOps", () => {
  test("opsKey는 op 순서와 무관하게 같다", () => {
    const a = { kind: "db" as const, surface: "s", target: "t1", column: "c", newValue: "1" };
    const b = { kind: "code" as const, surface: "s", target: "t2", newContent: "x" };
    expect(opsKey([a, b])).toBe(opsKey([b, a]));
    expect(opsKey([a])).not.toBe(opsKey([{ ...a, newValue: "2" }]));
  });

  test("candidateToOps — db 표면은 컬럼 값 op, src 표면은 파일 내용 op", () => {
    const dbOps = candidateToOps({ surface: "agent.role", target: "봇", column: "role_prompt", newValue: "v", summary: "s" });
    expect(dbOps).toEqual([{ kind: "db", surface: "agent.role", target: "봇", column: "role_prompt", newValue: "v" }]);
    const codeOps = candidateToOps({ surface: "src", target: "t", filePath: "server/src/x.ts", newContent: "c", summary: "s" });
    expect(codeOps).toEqual([{ kind: "code", surface: "src", target: "server/src/x.ts", newContent: "c" }]);
  });
});

describe("E7 수신 라우트 — /updates", () => {
  const post = (pkg: object) => evolveRoute.request("/updates", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(pkg),
  });
  const cleanup = (...ids: string[]) => ids.forEach((id) => db.prepare("DELETE FROM evolve_updates WHERE id = ?").run(id));

  test("증거 없는 구형 패키지는 400 + rejected로 기록된다 — pending이 되지 않는다", async () => {
    const res = await post({ summary: "구형", ops: [{ kind: "db", surface: "agent.role", target: "봇", column: "role_prompt", newValue: "v" }], source: "old-1" });
    expect(res.status).toBe(400);
    const row = db.prepare("SELECT id, status, payload FROM evolve_updates WHERE source = 'old-1'").get() as any;
    try {
      expect(row?.status).toBe("rejected");
      expect(JSON.parse(row.payload).rejectedReason).toContain("측정");
    } finally { cleanup(row?.id); }
  });

  test("완전한 패키지는 pending으로 수령된다", async () => {
    const res = await post(goodPkg());
    expect(res.status).toBe(200);
    const { id } = await res.json() as any;
    const row = db.prepare("SELECT status FROM evolve_updates WHERE id = ?").get(id) as any;
    try { expect(row?.status).toBe("pending"); } finally { cleanup(id); }
  });

  test("구형 pending 패키지는 적용 시 재검증에 걸려 rejected로 마감된다", async () => {
    const id = uid();
    db.prepare("INSERT INTO evolve_updates (id, payload, status, source, created_at) VALUES (?, ?, 'pending', 'legacy', ?)")
      .run(id, JSON.stringify({ summary: "구형", ops: [{ kind: "db", surface: "agent.role", target: "봇", column: "role_prompt", newValue: "v" }] }), Date.now());
    try {
      const res = await evolveRoute.request(`/updates/${id}/apply`, { method: "POST" });
      expect(res.status).toBe(400);
      expect((db.prepare("SELECT status FROM evolve_updates WHERE id = ?").get(id) as any)?.status).toBe("rejected");
    } finally { cleanup(id); }
  });
});
