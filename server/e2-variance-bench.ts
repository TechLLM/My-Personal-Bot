// 반복 표본 분산 실측 — 같은 과제를 팔당 N회 격리 실행해 단일 표본 판정의 안정성을 잰다.
// 후보는 기준선과 동일한 값(현재 CEO 역할문)이므로 차이는 전부 측정 노이즈다.
// 사용: MYBOT_ENV=dev bun server/e2-variance-bench.ts [과제id,과제id,...] [반복수]
import { db } from "./src/db";
import * as isolation from "./src/evolve/isolation";
import { startBroker } from "./src/evolve/broker";
import { loadGoldenTasks, sandboxToolOk, type GoldenTask } from "./src/evolve";
import { resolveModel, defaultModelId } from "./src/providers";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const REPS = Math.max(1, Number(process.argv[3]) || 4);
const ids = (process.argv[2] ?? "G1,G6,G7").split(",");
const tasks = (loadGoldenTasks() as GoldenTask[]).filter((t) => ids.includes(t.id));
if (!tasks.length) { console.error("과제 없음:", ids); process.exit(1); }

const seedAgents = db.prepare(
  "SELECT id, name, role_prompt, model, tools, persistent, is_boss, is_lead, parent_id, pinned, hidden, max_children, sort_order, workspace_id, special_role FROM agents",
).all() as any[];
const ceo = seedAgents.find((a) => a.is_boss)!;
const evalModel = defaultModelId();
const models = [...new Set([ceo.model, evalModel, ...seedAgents.map((a) => a.model).filter(Boolean)])] as string[];
for (const m of models) resolveModel(m);
const tools = [...new Set(["web_search", ...tasks.flatMap((t) => (t.tools ?? []).filter(sandboxToolOk))])];

const broker = await startBroker({
  models, tools,
  maxCalls: tasks.length * REPS * 60, maxCallsPerTag: 30,
  maxToolCallsPerTag: 10, maxEstTokens: 2_000_000,
});

const candidate = {
  surface: "agent.role", target: "CEO", column: "role_prompt",
  newValue: ceo.role_prompt, summary: "동일 역할문(분산 측정용)",
};

const out: Record<string, { baseline: boolean[]; candidate: boolean[]; ms: number[] }> = {};
for (const task of tasks) {
  out[task.id] = { baseline: [], candidate: [], ms: [] };
  for (let rep = 0; rep < REPS; rep++) {
    const cmp = await isolation.runIsolatedComparison({
      sourceRoot: ROOT, mode: "production", candidate: candidate as any, golden: task as any,
      broker: { port: broker.port, token: broker.token },
      model: ceo.model ?? evalModel, evalModel, seed: { agents: seedAgents },
      deadlineMs: 180_000, tagSuffix: `-${task.id}-r${rep}`,
    });
    for (const [arm, receipt] of [["baseline", cmp.baseline], ["candidate", cmp.candidate]] as const) {
      const v = receipt?.value as any;
      out[task.id][arm].push(!!v?.pass);
      if (receipt) out[task.id].ms.push(receipt.endedAt - receipt.startedAt);
      console.log(JSON.stringify({
        task: task.id, rep, arm, pass: !!v?.pass,
        ms: receipt ? receipt.endedAt - receipt.startedAt : 0,
        err: receipt?.reasonCode ?? null,
        checks: (v?.checks ?? []).map((c: any) => `${c.type}:${c.pass ? "P" : "F"}`).join(" "),
      }));
    }
  }
}

console.log("\n=== 분산 요약 ===");
for (const [id, r] of Object.entries(out)) {
  const pct = (a: boolean[]) => `${a.filter(Boolean).length}/${a.length}`;
  const ms = r.ms.sort((a, b) => a - b);
  console.log(`${id}: baseline ${pct(r.baseline)} · candidate ${pct(r.candidate)} · 지연 ${ms[0] ?? "-"}~${ms[ms.length - 1] ?? "-"}ms`);
}
await broker.close();
process.exit(0);
