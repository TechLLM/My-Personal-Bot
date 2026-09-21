import { test, expect, spyOn } from "bun:test";
import { db, getSetting, now, setSetting } from "./db";
import { callBuiltin, getAgent, runAgentDetached, runTeamTasks, stopAllRuns } from "./team";
import { completeCommand, createCommandJob } from "./command-delivery";
import * as providerModule from "./providers";

if (db.filename !== ":memory:") throw new Error(`테스트가 운영 DB를 열었습니다: ${db.filename}`);

const prefix = `command-edge-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function addAgent(suffix: string, model = "missing-provider/model") {
  const id = `${prefix}-agent-${suffix}`;
  const name = `${prefix}-${suffix}`;
  db.prepare("INSERT INTO agents (id, name, role_prompt, model, created_at) VALUES (?, ?, '테스트 역할', ?, ?)")
    .run(id, name, model, now());
  return { id, name };
}

function addCommandFixture(suffix: string) {
  const convId = `${prefix}-conv-${suffix}`;
  const msgId = `${prefix}-msg-${suffix}`;
  db.prepare("INSERT INTO conversations (id, title, mode, created_at, updated_at) VALUES (?, '명령 경계 테스트', 'auto', ?, ?)")
    .run(convId, now(), now());
  db.prepare("INSERT INTO messages (id, conversation_id, parent_id, active, role, content, created_at) VALUES (?, ?, NULL, 1, 'assistant', '', ?)")
    .run(msgId, convId, now());
  const rootJobId = createCommandJob({ source: "web", conversationId: convId, assistantMessageId: msgId, request: `테스트 ${suffix}` });
  return { convId, msgId, rootJobId };
}

async function isolated(fn: () => Promise<void>) {
  const savedFetch = globalThis.fetch;
  const savedEnv = process.env.MYBOT_ENV;
  const savedTelegram = getSetting("notify_telegram");
  const savedEmail = getSetting("notify_email");
  const savedProviders = getSetting("custom_providers");
  const savedDefault = getSetting("default_model");
  process.env.MYBOT_ENV = "dev";
  setSetting("notify_telegram", "0");
  setSetting("notify_email", "0");
  globalThis.fetch = (async () => { throw new Error("초기화 실패 경로에서 네트워크를 호출하면 안 됩니다"); }) as unknown as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = savedFetch;
    if (savedEnv === undefined) delete process.env.MYBOT_ENV;
    else process.env.MYBOT_ENV = savedEnv;
    setSetting("notify_telegram", savedTelegram ?? "0");
    setSetting("notify_email", savedEmail ?? "0");
    setSetting("custom_providers", savedProviders ?? "[]");
    setSetting("default_model", savedDefault ?? "");
  }
}

async function bounded<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("이미 중단된 direct 위임은 running 이력을 만들지 않고 루트 명령을 취소 결과로 끝낸다", async () => {
  await isolated(async () => {
    const target = addAgent("preaborted", "missing-provider/model");
    const fixture = addCommandFixture("preaborted");
    const ctl = new AbortController();
    ctl.abort(new DOMException("사용자 중지", "AbortError"));

    const out = await callBuiltin("agent_direct", { name: target.name, instruction: "자료를 조사하세요" }, null, ctl.signal, 0, undefined, undefined, undefined, [], fixture.rootJobId);
    expect(out).toContain("취소");
    expect(out).toContain("완료되지 않은");
    expect((db.prepare("SELECT COUNT(*) n FROM agent_runs WHERE root_job_id = ?").get(fixture.rootJobId) as { n: number }).n).toBe(0);

    await completeCommand(fixture.rootJobId, out, `msg:${fixture.msgId}`);
    const job = db.prepare("SELECT status, full_result FROM command_jobs WHERE id = ?").get(fixture.rootJobId) as { status: string; full_result: string };
    expect(job.status).toBe("completed");
    expect(job.full_result).toContain("취소");
    expect((db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id = ?").get(fixture.convId) as { n: number }).n).toBe(1);
    const message = db.prepare("SELECT content, command_status FROM messages WHERE id = ?").get(fixture.msgId) as { content: string; command_status: string };
    expect(message.command_status).toBe("completed");
    expect(message.content).toContain("완료되지 않은");
  });
});

test("동시에 끝난 형제 detached run의 결과를 모두 기록한 뒤 루트를 한 번만 전달한다", async () => {
  await isolated(async () => {
    const savedProviders = getSetting("custom_providers");
    const savedDefault = getSetting("default_model");
    setSetting("custom_providers", JSON.stringify([{ id: "edge-race", baseUrl: "http://edge-race.test/v1", apiKey: "test-key", models: ["model"] }]));
    setSetting("default_model", "edge-race/model");
    setSetting("notify_telegram", "1");
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      const content = body.includes("의도를 분류하세요")
        ? '{"verb":null,"object":null,"all":false}'
        : body.includes("RACE_A") ? "결과-A" : body.includes("RACE_B") ? "결과-B" : "테스트 결과";
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      const a = addAgent("race-a", "edge-race/model");
      const b = addAgent("race-b", "edge-race/model");
      const fixture = addCommandFixture("detached-race");
      let arrived = 0;
      let release!: () => void;
      let markBothArrived!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const bothArrived = new Promise<void>((resolve) => { markBothArrived = resolve; });
      const onDone = async () => {
        arrived++;
        if (arrived === 2) markBothArrived();
        await barrier;
      };

      const first = runAgentDetached(getAgent(a.id)!, {
        label: "경합 A",
        task: "RACE_A 결과를 작성하세요",
        rootJobId: fixture.rootJobId,
        verifyIntent: false,
        onDone,
      });
      const second = runAgentDetached(getAgent(b.id)!, {
        label: "경합 B",
        task: "RACE_B 결과를 작성하세요",
        rootJobId: fixture.rootJobId,
        verifyIntent: false,
        onDone,
      });

      let siblingsDone = false;
      try {
        await completeCommand(fixture.rootJobId, "형제 작업을 기다립니다", `msg:${fixture.msgId}`);
        expect((db.prepare("SELECT status FROM command_jobs WHERE id = ?").get(fixture.rootJobId) as { status: string }).status).toBe("waiting_children");
        await bounded(bothArrived, 2000, "두 형제 실행이 onDone 장벽에 도달하지 못했습니다");
        expect(arrived).toBe(2);
        release();
        await bounded(Promise.all([first.done, second.done]), 2000, "형제 실행이 장벽 해제 후 종료되지 않았습니다");
        siblingsDone = true;
      } finally {
        release();
        if (!siblingsDone) {
          stopAllRuns();
          await bounded(Promise.allSettled([first.done, second.done]), 1000, "형제 실행 중단 정리 시간 초과").catch(() => {});
        }
      }

      const rows = db.prepare("SELECT content FROM command_job_results WHERE root_job_id = ? AND result_key LIKE 'run:%'").all(fixture.rootJobId) as { content: string }[];
      expect(rows).toHaveLength(2);
      expect(rows.some((r) => r.content.includes("결과-A"))).toBe(true);
      expect(rows.some((r) => r.content.includes("결과-B"))).toBe(true);
      const job = db.prepare("SELECT status, full_result FROM command_jobs WHERE id = ?").get(fixture.rootJobId) as { status: string; full_result: string };
      expect(job.status).toBe("completed");
      expect(job.full_result).toContain("결과-A");
      expect(job.full_result).toContain("결과-B");
      expect((db.prepare("SELECT COUNT(*) n FROM command_deliveries WHERE root_job_id = ?").get(fixture.rootJobId) as { n: number }).n).toBe(1);
      expect((db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id = ?").get(fixture.convId) as { n: number }).n).toBe(1);
    } finally {
      setSetting("custom_providers", savedProviders ?? "[]");
      setSetting("default_model", savedDefault ?? "");
    }
  });
});

test("direct 실행의 모델 초기화 예외도 run을 terminal error로 만들고 루트를 부분 실패로 완료한다", async () => {
  await isolated(async () => {
    const target = addAgent("invalid-direct");
    const fixture = addCommandFixture("invalid-direct");
    const realResolveModel = providerModule.resolveModel;
    const resolverSpy = spyOn(providerModule, "resolveModel").mockImplementation((modelId: string) => {
      if (modelId === "missing-provider/model") throw new Error("합성 모델 초기화 실패: direct fixture");
      return realResolveModel(modelId);
    });
    try {
      const out = await callBuiltin("agent_direct", { name: target.name, instruction: "보고서를 작성하세요" }, null, undefined, 0, undefined, undefined, undefined, [], fixture.rootJobId);

      expect(out).toContain("실행 결과 — 실패");
      const run = db.prepare("SELECT status, result, finished_at FROM agent_runs WHERE root_job_id = ?").get(fixture.rootJobId) as { status: string; result: string; finished_at: number | null };
      expect(run.status).toBe("error");
      expect(run.finished_at).not.toBeNull();
      expect(run.result).toContain("에이전트 오류");
      expect(run.result).toContain("합성 모델 초기화 실패");

      await completeCommand(fixture.rootJobId, out, `msg:${fixture.msgId}`);
      const job = db.prepare("SELECT status, full_result FROM command_jobs WHERE id = ?").get(fixture.rootJobId) as { status: string; full_result: string };
      expect(job.status).toBe("completed");
      expect(job.full_result).toContain("부분 완료");
      expect(job.full_result).toContain("하위 작업 실패");
    } finally {
      resolverSpy.mockRestore();
    }
  });
});

test("팀 실행의 모델 초기화 예외도 모든 run을 error로 기록하고 루트 blocker를 해제한다", async () => {
  await isolated(async () => {
    const target = addAgent("invalid-team");
    const fixture = addCommandFixture("invalid-team");
    const realResolveModel = providerModule.resolveModel;
    const resolverSpy = spyOn(providerModule, "resolveModel").mockImplementation((modelId: string) => {
      if (modelId === "missing-provider/model") throw new Error("합성 모델 초기화 실패: team fixture");
      return realResolveModel(modelId);
    });
    try {
      const states = await runTeamTasks(fixture.convId, [{ agent: target.name, task: "팀 보고서를 작성하세요" }], () => {}, undefined, fixture.rootJobId);

      expect(states).toHaveLength(1);
      expect(states[0].status).toBe("error");
      const run = db.prepare("SELECT status, result, finished_at FROM agent_runs WHERE id = ?").get(states[0].runId) as { status: string; result: string; finished_at: number | null };
      expect(run.status).toBe("error");
      expect(run.finished_at).not.toBeNull();
      expect(run.result).toContain("에이전트 오류");
      expect(run.result).toContain("합성 모델 초기화 실패");

      await completeCommand(fixture.rootJobId, "팀 실행 종료", `msg:${fixture.msgId}`);
      const job = db.prepare("SELECT status, full_result FROM command_jobs WHERE id = ?").get(fixture.rootJobId) as { status: string; full_result: string };
      expect(job.status).toBe("completed");
      expect(job.full_result).toContain("부분 완료");
      expect((db.prepare("SELECT COUNT(*) n FROM agent_runs WHERE root_job_id = ? AND status IN ('running','resumable')").get(fixture.rootJobId) as { n: number }).n).toBe(0);
    } finally {
      resolverSpy.mockRestore();
    }
  });
});
