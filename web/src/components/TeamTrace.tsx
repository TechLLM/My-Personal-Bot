import { useState } from "react";
import { Bot } from "lucide-react";
import { AgentIcon } from "./icons";

export interface TeamAgentInfo {
  id: string;
  name: string;
  avatar: string;
  role: string;
  task: string;
  model: string;
  model_label?: string;
  status?: string;
  result?: string;
  steps?: number;
}

export interface TeamEvent {
  type: "team_planning" | "team_plan" | "agent_start" | "agent_step" | "agent_phase" | "agent_done";
  agents?: TeamAgentInfo[];
  pending?: boolean;
  agentId?: string;
  tool?: string;
  phase?: string;
  label?: string;
  status?: string;
  result?: string;
}

// 대장 봇 팀 실행 패널: 역할 봇별 상태 카드
export function TeamTrace({ events, done }: { events: TeamEvent[]; done: boolean }) {
  const [openResult, setOpenResult] = useState<Record<string, boolean>>({});

  // 승인 대기 계획(id 없음)과 실행 계획(id 있음) 중 마지막 것을 사용
  const plans = events.filter((e) => e.type === "team_plan");
  const plan = plans[plans.length - 1];
  const pending = plan?.pending === true;
  const agents = new Map<string, TeamAgentInfo & { toolLog: string[]; phase?: string }>();
  for (const [i, a] of (plan?.agents ?? []).entries()) agents.set(a.id ?? `plan-${i}`, { ...a, status: "waiting", toolLog: [] });
  for (const e of events) {
    if (e.type === "agent_start" && e.agentId) {
      const a = agents.get(e.agentId);
      if (a) a.status = "running";
    } else if (e.type === "agent_phase" && e.agentId) {
      const a = agents.get(e.agentId);
      if (a) a.phase = e.label ?? e.phase;
    } else if (e.type === "agent_step" && e.agentId) {
      const a = agents.get(e.agentId);
      // 연속 동일 도구는 중복 표기하지 않음 — 같은 행이 반복 출력되는 것 방지
      if (a) { a.status = "running"; if (e.tool && a.toolLog[a.toolLog.length - 1] !== e.tool) a.toolLog.push(e.tool); }
    } else if (e.type === "agent_done" && e.agentId) {
      const a = agents.get(e.agentId);
      if (a) { a.status = e.status ?? "done"; a.result = e.result; a.phase = undefined; }
    }
  }

  const list = [...agents.values()];
  const running = list.some((a) => a.status === "running" || a.status === "waiting");

  return (
    <div className="rounded-xl border border-amber-900/40 bg-amber-950/20 px-4 py-3 text-sm">
      <div className="flex items-center gap-2 font-medium text-amber-300">
        <span className={!done || running ? "thinking-dot" : ""}><Bot size={14} /></span>
        {list.length
          ? pending
            ? `대장 봇이 계획을 세웠습니다 — 봇 ${list.length}개 (승인 대기)`
            : done && !running ? `팀 작업 완료 — 봇 ${list.length}개` : `팀 작업 중 — 봇 ${list.length}개`
          : "대장 봇이 작업을 분해하는 중…"}
      </div>
      <div className="mt-2 space-y-2">
        {list.map((a) => (
          <div key={a.id} className="rounded-lg border border-stone-200 bg-white/60 px-3 py-2">
            <div className="flex items-center gap-2 text-xs">
              <AgentIcon name={a.name} seed={a.avatar} size={14} className="shrink-0" working={a.status === "running"} />
              <span className="shrink-0 font-medium text-stone-800 whitespace-nowrap">{a.name}</span>
              <span className="min-w-0 flex-1 truncate text-stone-500">{a.role}</span>
              <span className="ml-auto shrink-0 font-mono text-[10px] text-stone-400">{a.model_label ?? a.model}</span>
              <span className={`shrink-0 ${a.status === "done" ? "text-emerald-400" : a.status === "error" ? "text-red-400" : "text-amber-400"}`}>
                {a.status === "done" ? "● 완료" : a.status === "error" ? "● 오류" : a.status === "running" ? `◐ ${a.phase ?? "실행 중"}` : "○ 대기"}
              </span>
            </div>
            <div className="mt-1 text-[11px] text-stone-500">작업: {a.task}</div>
            {a.toolLog.length > 0 && (
              <div className="mt-1 text-[10px] italic text-stone-400">도구: {a.toolLog.join(" → ")}</div>
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
              <div className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded bg-white/60 p-2 text-[11px] text-stone-600">{a.result}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
