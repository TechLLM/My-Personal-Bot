import { describe, expect, spyOn, test } from "bun:test";
import { db, uid, getSetting, setSetting } from "./db";
if (db.filename !== ":memory:") throw new Error(`테스트가 운영 DB를 열었습니다: ${db.filename}`);
import { opsKey, verifyUpdatePackage, candidateToOps, evolveRoute, applyUpdateOps, materializeCandidate, resolveCodeTarget, type UpdatePackage, type UpdateOp, type BenchResult } from "./evolve";
import * as openaiCompat from "./providers/openaiCompat";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
const goodPkg = (ops?: UpdateOp[]): UpdatePackage => {
  const o = ops ?? [{ kind: "db" as const, surface: "agents", target: "봇", column: "role_prompt", newValue: "새 역할" }];
  return {
    summary: "역할 개선", ops: o, source: "exp-1",
    measurement: { baseline: bench(), candidate: bench(), verdict: "keep", reason: "후보 우세" },
    evidence: {
      experimentId: "exp-1", candidateKey: opsKey(o), at: Date.now(),
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

// 2026-09-22 회귀: 수령·적용이 원시 op.target에만 보호 검사를 걸어
// `server/src/./access.ts`·`server/src/x/../access.ts` 별칭이 resolve 후 보호 파일에
// 도달했다. resolveCodeTarget이 정규 경로로 검사해 수령·적용·되돌리기가 같은 결과를 낸다.
// 아래 테스트는 실제 보호 소스를 절대 쓰지 않는다 — 읽기 전용 확인 또는 .tmp fixture만.
const SRC_GLOB = "server/src/**";

// payload를 싣는 테스트가 실제 보호 파일(access.ts 등)을 가리키지 못하게 하는 격리 fixture.
// 보호 디렉터리(server/src/evolve/**) 안에 버릴 파일을 만들어 별칭의 해석 대상으로 쓴다 —
// 파일이 실재하므로 보호 판정만이 쓰기를 막는 최악 경로를 검증하면서, 방어가 회귀해 쓰기가
// 뚫려도 닳는 것은 추적되지 않는 이 fixture뿐이다.
const protectedFixture = () => {
  const name = `.tmp-evolve-protected-${uid()}.ts`;
  const abs = join(import.meta.dir, "evolve", name);
  const content = `// ${name} — 보호 판정 검증용 버릴 파일\n`;
  writeFileSync(abs, content);
  return { name, abs, content, cleanup: () => rmSync(abs, { force: true }) };
};

describe("resolveCodeTarget — 코드 대상 공유 검증기", () => {
  test("별칭이 정규 경로로 해석돼 보호 판정을 우회하지 못한다", () => {
    for (const target of [
      "server/src/./access.ts",
      "./server/src/access.ts",
      "server/src/x/../access.ts",
      "server/src/evolve/../access.ts",
      "server//src///access.ts",
      "server\\src\\access.ts",
      "server\\src\\.\\access.ts",
    ]) {
      const r = resolveCodeTarget(target, SRC_GLOB);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("보호 경로");
    }
  });

  test("보호 디렉터리 안 파일·디렉터리 자체도 별칭으로 못 들어온다", () => {
    for (const target of ["server/src/./evolve/worker.ts", "server/src/x/../evolve/worker.ts", "server/src/./evolve"]) {
      const r = resolveCodeTarget(target, SRC_GLOB);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("보호 경로");
    }
  });

  test("등록 표면 밖·루트 밖·비정상 입력은 거부한다", () => {
    for (const target of ["server/data/x.db", "server/src/../../package.json", "web/src/main.tsx"]) {
      const r = resolveCodeTarget(target, SRC_GLOB);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("등록 표면 밖");
    }
    for (const target of [
      "/etc/passwd",
      "../outside.ts",
      "server/src/../../../outside.ts",
      "server/src/a\0b.ts",
      "\\\\server\\share\\x",
      "",
    ]) expect(resolveCodeTarget(target, SRC_GLOB).ok).toBe(false);
  });

  test("허용되는 일반 소스는 통과하고 정규 경로를 돌려준다", () => {
    const r = resolveCodeTarget("server/src/./report.ts", SRC_GLOB);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rel).toBe("server/src/report.ts");
      expect(r.abs.endsWith(join("server", "src", "report.ts"))).toBe(true);
    }
  });

  test("심볼릭 링크는 대상 불가 — 최종 요소와 조상 디렉터리 탈출 모두", () => {
    // 안전 fixture — 루트 밖 임시 디렉터리와 server/src 안의 링크만 만들고 반드시 정리한다
    const outside = mkdtempSync(join(tmpdir(), "evolve-outside-"));
    writeFileSync(join(outside, "inner.ts"), "export {};\n");
    const dirLink = `.tmp-evolve-dirlink-${uid()}`;
    const fileLink = `.tmp-evolve-filelink-${uid()}`;
    try {
      symlinkSync(outside, join(import.meta.dir, dirLink), "dir");
      symlinkSync(join(import.meta.dir, "report.ts"), join(import.meta.dir, fileLink));
      // 조상 디렉터리가 링크 — 파일은 일반 파일이지만 realpath가 루트 밖으로 빠진다
      const ancestor = resolveCodeTarget(`server/src/${dirLink}/inner.ts`, SRC_GLOB);
      expect(ancestor.ok).toBe(false);
      if (!ancestor.ok) expect(ancestor.error).toContain("심볼릭 링크");
      // 최종 요소가 링크 — 일반 파일 검사에서 걸린다
      expect(resolveCodeTarget(`server/src/${fileLink}`, SRC_GLOB).ok).toBe(false);
    } finally {
      rmSync(join(import.meta.dir, dirLink), { force: true });
      rmSync(join(import.meta.dir, fileLink), { force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("별칭 우회 차단 — 수령·적용·되돌리기가 같은 검증기를 쓴다", () => {
  const post = (pkg: object) => evolveRoute.request("/updates", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(pkg),
  });
  const countForSource = (source: string) =>
    (db.prepare("SELECT COUNT(*) c FROM evolve_updates WHERE source = ?").get(source) as any).c as number;

  test("보호 경로 별칭 op는 유효한 증거가 있어도 수령에서 거부된다", async () => {
    const fx = protectedFixture(); // 별칭이 실재하는 보호 파일로 해석된다 — 수령이 뚫려도 남는 payload는 fixture만 가리킨다
    try {
      for (const target of [
        `server/src/./evolve/${fx.name}`,
        `server/src/x/../evolve/${fx.name}`,
        `server\\src\\evolve\\${fx.name}`,
        `server//src//evolve//${fx.name}`,
      ]) {
        const pkg = goodPkg([{ kind: "code", surface: "src", target, newContent: "export {};" }]);
        pkg.source = `alias-intake-${uid()}`;
        pkg.evidence!.experimentId = pkg.source; // 증거는 별칭 op에 온전히 결속 — 경로 검증만 걸리게 한다
        const res = await post(pkg);
        expect(res.status).toBe(400);
        expect(countForSource(pkg.source)).toBe(0); // 거부된 패키지는 pending으로 남지 않는다
      }
    } finally { fx.cleanup(); }
  });

  test("미등록·비코드 표면과 표면 밖·없는 대상도 수령에서 거부된다", async () => {
    for (const op of [
      { kind: "code" as const, surface: "없는표면", target: "server/src/report.ts", newContent: "x" },
      { kind: "code" as const, surface: "agent.role", target: "server/src/report.ts", newContent: "x" },
      { kind: "code" as const, surface: "src", target: "web/src/main.tsx", newContent: "x" },
      { kind: "code" as const, surface: "src", target: "../outside.ts", newContent: "x" },
      { kind: "code" as const, surface: "src", target: "server/src/없는파일.ts", newContent: "x" },
    ]) {
      const pkg = goodPkg([op]);
      pkg.source = `bad-intake-${uid()}`;
      pkg.evidence!.experimentId = pkg.source;
      expect((await post(pkg)).status).toBe(400);
    }
  });

  test("applyUpdateOps가 같은 검증기를 쓴다 — 별칭 보호 대상은 쓰기 전에 거부된다", () => {
    const fx = protectedFixture(); // 파일이 실재해 보호 판정만이 쓰기를 막는다 — 회귀 시 닳는 것도 이 fixture뿐
    try {
      for (const target of [
        `server/src/./evolve/${fx.name}`,
        `server/src/x/../evolve/${fx.name}`,
        `server\\src\\evolve\\${fx.name}`,
      ])
        expect(() => applyUpdateOps([{ kind: "code", surface: "src", target, newContent: "export {};" }])).toThrow("보호 경로");
      expect(readFileSync(fx.abs, "utf8")).toBe(fx.content); // 계획 단계에서 걸려 쓰기에 도달하지 않는다
    } finally { fx.cleanup(); }
  });

  test("계획 전체가 검증되기 전에는 DB도 파일도 바꾸지 않는다 (all-or-nothing)", () => {
    // 유효 DB op → 허용 파일 op → 보호 별칭 op 순 — 마지막 op가 계획 단계에서 실패해
    // 앞의 유효 op들도 하나도 반영되지 않는다
    const name = `.tmp-evolve-atomic-${uid()}`;
    const abs = join(import.meta.dir, name);
    const fx = protectedFixture();
    const agentId = uid();
    writeFileSync(abs, "원본\n");
    db.prepare("INSERT INTO agents (id, name, role_prompt, created_at) VALUES (?, ?, ?, ?)")
      .run(agentId, `atomic-${agentId}`, "원래 역할", Date.now());
    try {
      expect(() => applyUpdateOps([
        { kind: "db", surface: "agent.role", target: `atomic-${agentId}`, column: "role_prompt", newValue: "바꾼 역할" },
        { kind: "code", surface: "src", target: `server/src/${name}`, newContent: "변경\n" },
        { kind: "code", surface: "src", target: `server/src/./evolve/${fx.name}`, newContent: "export {};" },
      ])).toThrow("보호 경로");
      expect((db.prepare("SELECT role_prompt FROM agents WHERE id = ?").get(agentId) as any)?.role_prompt).toBe("원래 역할");
      expect(readFileSync(abs, "utf8")).toBe("원본\n");
      expect(readFileSync(fx.abs, "utf8")).toBe(fx.content);
    } finally {
      rmSync(abs, { force: true });
      db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
      fx.cleanup();
    }
  });

  test("구형 pending의 별칭 대상은 적용 재검증을 통과해도 쓰기 전에 막힌다", async () => {
    // 수정 이전에 수령된 구형 pending도 applyUpdateOps의 공유 검증기가 막는다
    const fx = protectedFixture();
    const ops: UpdateOp[] = [{ kind: "code", surface: "src", target: `server/src/./evolve/${fx.name}`, newContent: "export {};" }];
    const pkg = goodPkg(ops);
    pkg.source = "legacy-alias";
    pkg.evidence!.experimentId = "legacy-alias";
    const id = uid();
    db.prepare("INSERT INTO evolve_updates (id, payload, status, source, created_at) VALUES (?, ?, 'pending', 'legacy-alias', ?)")
      .run(id, JSON.stringify(pkg), Date.now());
    try {
      const res = await evolveRoute.request(`/updates/${id}/apply`, { method: "POST" });
      expect(res.status).toBe(400);
      // 증거 재검증은 통과했지만 공유 검증기가 거부 — 파일 무결, 상태는 pending 유지
      expect(readFileSync(fx.abs, "utf8")).toBe(fx.content);
      expect((db.prepare("SELECT status FROM evolve_updates WHERE id = ?").get(id) as any)?.status).toBe("pending");
    } finally {
      db.prepare("DELETE FROM evolve_updates WHERE id = ?").run(id);
      fx.cleanup();
    }
  });

  test("구형 applied의 별칭 되돌리기 op는 revert 라우트에서도 막힌다 — 상태 applied 유지", async () => {
    // 되돌리기는 저장된 revert ops를 그대로 applyUpdateOps에 태운다 — 수정 이전에 기록된
    // 구형 applied 레코드의 revert가 별칭 보호 대상을 가리켜도 같은 검증기가 건다
    const fx = protectedFixture();
    const revertOps: UpdateOp[] = [{ kind: "code", surface: "src", target: `server/src/x/../evolve/${fx.name}`, newContent: "export {};" }];
    const id = uid();
    db.prepare("INSERT INTO evolve_updates (id, version, payload, status, revert, source, created_at, applied_at) VALUES (?, 1, ?, 'applied', ?, 'legacy-revert', ?, ?)")
      .run(id, JSON.stringify({ summary: "구형", ops: [] }), JSON.stringify(revertOps), Date.now(), Date.now());
    try {
      const res = await evolveRoute.request(`/updates/${id}/revert`, { method: "POST" });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error).toContain("보호 경로");
      expect(readFileSync(fx.abs, "utf8")).toBe(fx.content); // 되돌리기 실패 — 파일 무결
      expect((db.prepare("SELECT status FROM evolve_updates WHERE id = ?").get(id) as any)?.status).toBe("applied");
    } finally {
      db.prepare("DELETE FROM evolve_updates WHERE id = ?").run(id);
      fx.cleanup();
    }
  });

  test("허용된 일반 소스는 수령→적용→되돌리기가 같은 해석으로 간다 — op 필드는 재작성되지 않는다", async () => {
    const name = `.tmp-evolve-roundtrip-${uid()}`;
    const abs = join(import.meta.dir, name);
    writeFileSync(abs, "원본 내용\n");
    const aliasTarget = `server/src/./${name}`;
    const ops: UpdateOp[] = [{ kind: "code", surface: "src", target: aliasTarget, newContent: "변경된 내용\n" }];
    const pkg = goodPkg(ops);
    pkg.source = "roundtrip";
    pkg.evidence!.experimentId = "roundtrip";
    const prevVersion = getSetting("app_version"); // 적용이 app_version을 올린다 — 테스트 간 격리를 위해 복원한다
    let upId = "";
    try {
      const res = await post(pkg);
      expect(res.status).toBe(200);
      upId = ((await res.json()) as any).id;
      // 저장된 payload는 원본 op를 그대로 담는다 — 서명 결속(opsKey) 필드를 고치지 않는다
      const stored = JSON.parse((db.prepare("SELECT payload FROM evolve_updates WHERE id = ?").get(upId) as any).payload) as UpdatePackage;
      expect(stored.ops).toEqual(ops);
      expect(stored.evidence!.candidateKey).toBe(opsKey(ops));
      const apply = await evolveRoute.request(`/updates/${upId}/apply`, { method: "POST" });
      expect(apply.status).toBe(200);
      expect(readFileSync(abs, "utf8")).toBe("변경된 내용\n");
      // 적용 시 저장된 되돌리기 op도 원본 target을 유지한다 — 같은 별칭 해석으로 원래 자리에 복원된다
      const revertOps = JSON.parse((db.prepare("SELECT revert FROM evolve_updates WHERE id = ?").get(upId) as any).revert) as UpdateOp[];
      expect(revertOps.map((o) => o.target)).toEqual(ops.map((o) => o.target));
      expect(revertOps[0].newContent).toBe("원본 내용\n");
      const revert = await evolveRoute.request(`/updates/${upId}/revert`, { method: "POST" });
      expect(revert.status).toBe(200);
      expect(readFileSync(abs, "utf8")).toBe("원본 내용\n");
    } finally {
      if (upId) db.prepare("DELETE FROM evolve_updates WHERE id = ?").run(upId);
      if (prevVersion === null) db.prepare("DELETE FROM settings WHERE key = 'app_version'").run();
      else setSetting("app_version", prevVersion);
      rmSync(abs, { force: true });
    }
  });
});

describe("materializeCandidate — 코드 표면 구체화도 같은 검증기를 쓴다", () => {
  const codegenSpy = () =>
    spyOn(openaiCompat, "chatOnce").mockImplementation(() => { throw new Error("거부 대상은 모델을 부르면 안 됨"); });

  test("보호·표면 밖 별칭·traversal·심볼릭 링크는 모델 호출 없이 null이다", async () => {
    const spy = codegenSpy();
    // 안전 fixture — 조상 링크 탈출용 루트 밖 임시 디렉터리와 server/src 안의 링크만 만들고 반드시 정리한다
    const outside = mkdtempSync(join(tmpdir(), "evolve-outside-"));
    writeFileSync(join(outside, "inner.ts"), "export {};\n");
    const dirLink = `.tmp-evolve-dirlink-${uid()}`;
    const fileLink = `.tmp-evolve-filelink-${uid()}.ts`;
    const notTs = `.tmp-evolve-notts-${uid()}.txt`;
    writeFileSync(join(import.meta.dir, notTs), "텍스트\n");
    try {
      symlinkSync(outside, join(import.meta.dir, dirLink), "dir");
      symlinkSync(join(import.meta.dir, "report.ts"), join(import.meta.dir, fileLink));
      for (const target of [
        "server/src/ACCESS.ts",            // 대소문자 보호 별칭 — 실제 보호 파일로 해석된다
        "server/src/EVOLVE/worker.ts",     // 보호 디렉터리의 대소문자 별칭
        "server/src/evolve/../access.ts",  // 점 세그먼트 traversal → 보호 파일
        "server/src/../src/access.ts",     // traversal → 보호 파일
        "server/src/../../package.json",   // 루트 밖
        "../outside.ts",                   // 루트 밖
        `server/src/${fileLink}`,          // 최종 요소 심볼릭 링크
        `server/src/${dirLink}/inner.ts`,  // 조상 디렉터리 심볼릭 링크 탈출
        `server/src/${notTs}`,             // 정상 경로지만 .ts가 아님 — 구체화 대상 밖
      ]) {
        expect(await materializeCandidate({ surface: "src", target, intent: "i", summary: "s" })).toBeNull();
      }
      expect(spy).toHaveBeenCalledTimes(0); // 거부는 모델 호출 전에 일어난다 — 실제 네트워크도 나가지 않는다
    } finally {
      spy.mockRestore();
      rmSync(join(import.meta.dir, dirLink), { force: true });
      rmSync(join(import.meta.dir, fileLink), { force: true });
      rmSync(join(import.meta.dir, notTs), { force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("허용된 일반 소스의 별칭은 구체화된다 — Candidate는 원본 path를 유지한다", async () => {
    const name = `.tmp-evolve-mat-${uid()}.ts`;
    const abs = join(import.meta.dir, name);
    writeFileSync(abs, "export const a = 1;\n");
    const aliasTarget = `server/src/./${name}`;
    const agentId = uid(); // codegen 모델 해석용 Eggbot — evolveModel은 로컬 해석만 한다
    db.prepare("INSERT INTO agents (id, name, role_prompt, model, created_at) VALUES (?, 'Eggbot', ?, 'minimax/MiniMax-M3', ?)")
      .run(agentId, "역할", Date.now());
    const spy = spyOn(openaiCompat, "chatOnce").mockResolvedValue({ content: "export const a = 2;\n" } as any);
    try {
      const c = await materializeCandidate({ surface: "src", target: aliasTarget, intent: "상수 증가", summary: "s" });
      expect(spy).toHaveBeenCalledTimes(1);
      // payload·opsKey 결속은 원본 op에 달린다 — target/filePath는 별칭 원문을 유지한다
      expect(c?.target).toBe(aliasTarget);
      expect(c?.filePath).toBe(aliasTarget);
      expect(c?.newContent).toBe("export const a = 2;");
    } finally {
      spy.mockRestore();
      db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
      rmSync(abs, { force: true });
    }
  });
});
