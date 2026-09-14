import { useState } from "react";

export interface TeamAgentInfo {
  id: string;
  name: string;
  avatar: string;
  role: string;
  task: string;
  model: string;
  status?: string;
  result?: string;
  steps?: number;
}

export interface TeamEvent {
  type: "team_planning" | "team_plan" | "agent_start" | "agent_step" | "agent_done";
  agents?: TeamAgentInfo[];
  agentId?: string;
  tool?: string;
  status?: string;
  result?: string;
}

// 대장 봇 팀 실행 패널: 역할 봇별 상태 카드
export function TeamTrace({ events, done }: { events: TeamEvent[]; done: boolean }) {
  const [openResult, setOpenResult] = useState<Record<string, boolean>>({});

  const plan = events.find((e) => e.type === "team_plan");
  const agents = new Map<string, TeamAgentInfo & { toolLog: string[] }>();
  for (const a of plan?.agents ?? []) agents.set(a.id, { ...a, status: "waiting", toolLog: [] });
  for (const e of events) {
    if (e.type === "agent_start" && e.agentId) {
      const a = agents.get(e.agentId);
      if (a) a.status = "running";
    } else if (e.type === "agent_step" && e.agentId) {
      const a = agents.get(e.agentId);
      if (a) { a.status = "running"; a.toolLog.push(e.tool ?? ""); }
    } else if (e.type === "agent_done" && e.agentId) {
      const a = agents.get(e.agentId);
      if (a) { a.status = e.status ?? "done"; a.result = e.result; }
    }
  }

  const list = [...agents.values()];
  const running = list.some((a) => a.status === "running" || a.status === "waiting");

  return (
    <div className="rounded-xl border border-amber-900/40 bg-amber-950/20 px-4 py-3 text-sm">
      <div className="flex items-center gap-2 font-medium text-amber-300">
        <span className={!done || running ? "thinking-dot" : ""}>🤖</span>
        {list.length
          ? done && !running ? `팀 작업 완료 — 봇 ${list.length}개` : `팀 작업 중 — 봇 ${list.length}개`
          : "대장 봇이 작업을 분해하는 중…"}
      </div>
      <div className="mt-2 space-y-2">
        {list.map((a) => (
          <div key={a.id} className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
            <div className="flex items-center gap-2 text-xs">
              <span>{a.avatar}</span>
              <span className="font-medium text-zinc-200">{a.name}</span>
              <span className="text-zinc-500 truncate">{a.role}</span>
              <span className="ml-auto shrink-0 font-mono text-[10px] text-zinc-600">{a.model}</span>
              <span className={`shrink-0 ${a.status === "done" ? "text-emerald-400" : a.status === "error" ? "text-red-400" : "text-amber-400"}`}>
                {a.status === "done" ? "● 완료" : a.status === "error" ? "● 오류" : a.status === "running" ? "◐ 실행 중" : "○ 대기"}
              </span>
            </div>
            <div className="mt-1 text-[11px] text-zinc-500">작업: {a.task}</div>
            {a.toolLog.length > 0 && (
              <div className="mt-1 text-[10px] text-zinc-600">도구: {a.toolLog.join(" → ")}</div>
            )}
            {a.result && (
              <button
                className="mt-1 text-[11px] text-amber-400/80 hover:text-amber-300"
                onClick={() => setOpenResult((p) => ({ ...p, [a.id]: !p[a.id] }))}
              >
                {openResult[a.id] ? "▾ 결과 접기" : "▸ 결과 보기"}
              </button>
            )}
            {openResult[a.id] && a.result && (
              <div className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded bg-zinc-950/60 p-2 text-[11px] text-zinc-400">{a.result}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
