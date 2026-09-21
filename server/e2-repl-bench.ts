// 후보 B 측정 — dev 실파이프라인 A/B: 브라우저 조작 방식(eval-우선 vs ref-우선 vs 현행)
// 사용: MYBOT_ENV=dev MYBOT_BROWSER_PROFILE=/tmp/mybot-bench-profile bun server/e2-repl-bench.ts
import { readFileSync } from "node:fs";

const ROOT = `${import.meta.dir}/..`;
const all = JSON.parse(readFileSync(`${ROOT}/evolve/golden-tasks.json`, "utf8")).tasks;
const tasks = all.filter((t: any) => ["G11", "G12", "G13"].includes(t.id));
const { db } = await import("./src/db");
const { getAgent, runAgentDetached } = await import("./src/team");

const row = db.prepare("SELECT * FROM agents WHERE name = ?").get("그룹웨어팀장") as any;
const original = row.role_prompt ?? "";
const variants = [
  { key: "base", prompt: original },
  { key: "eval-first", prompt: original + "\n\n[브라우저 조작] 페이지 탐색·본문 추출·링크 수집은 browser_eval에 JS 한 번으로 우선 처리하고, @번호 지목 도구는 eval로 어려운 클릭에만 쓰세요." },
  { key: "ref-first", prompt: original + "\n\n[브라우저 조작] @번호 지목 도구(browser_read·browser_click)를 우선 사용하고, browser_eval은 목록에 없는 요소나 스냅샷으로 확인 불가한 경우에만 쓰세요." },
];

const agent = getAgent(row.id)!;
for (const v of variants) {
  db.prepare("UPDATE agents SET role_prompt = ? WHERE id = ?").run(v.prompt, row.id);
  for (const task of tasks) {
    const t0 = Date.now();
    const { done } = runAgentDetached(agent, { task: task.prompt, label: `bench-${task.id}`, internal: true });
    const st = await done;
    const ms = Date.now() - t0;
    const content = st.result ?? "";
    const checks = (task.checks ?? []).map((c: any) => {
      if (c.type === "tool_used") return st.toolLog.some((l: any) => (l.tool ?? l.name) === c.tool);
      if (c.type === "content_regex") return new RegExp(c.pattern).test(content);
      return null; // eval_min은 사람이 읽어 판단
    });
    const tools = st.toolLog.map((l: any) => l.tool ?? l.name).join(",");
    console.log(JSON.stringify({ variant: v.key, task: task.id, pass: checks.every((x) => x !== false),
      ms, toolCalls: st.toolLog.length, tools, status: st.status }));
  }
}
db.prepare("UPDATE agents SET role_prompt = ? WHERE id = ?").run(original, row.id);
console.log("restored role_prompt");
process.exit(0);
