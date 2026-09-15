import { useEffect, useState } from "react";
import { AgentIcon } from "./icons";
import type { SearchEvent } from "./SearchTrace";

// 순환 상태어 — 도구 이벤트가 없을 때 순서대로 돎
const WORDS = ["Thinking", "Pondering", "Working", "Navigating", "Reading", "Writing", "Synthesizing"];

// 마지막 도구 이벤트로 현재 상태어 추론 — 실제 무슨 일을 하는지 반영
function toolWord(title?: string): string | null {
  const t = title ?? "";
  if (!t || t.includes("라운드")) return null;
  if (/web_search|DeepSearch/i.test(t)) return "Searching";
  if (/browser_|ego_run/i.test(t)) return "Navigating";
  if (/agent_(direct|create|update|delete)/.test(t)) return "Delegating";
  if (/request_credentials/.test(t)) return "Requesting";
  if (/write_file/.test(t)) return "Writing";
  if (/read_file|list_files/.test(t)) return "Reading";
  if (/routine_/.test(t)) return "Scheduling";
  if (/memory_save/.test(t)) return "Memorizing";
  return "Working";
}

// 봇 작업 중 표시 — 픽셀 반짝임 + 쉬머 상태어 + 움직이는 봇 얼굴
export function WorkingStatus({ events = [], agent, compact = false }: {
  events?: SearchEvent[];
  agent?: { name: string; avatar: string | null } | null;
  compact?: boolean;
}) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((v) => v + 1), 1700);
    return () => clearInterval(t);
  }, []);
  const tw = toolWord([...events].reverse().find((e) => e.title)?.title);
  const word = tw ?? WORDS[i % WORDS.length];
  return (
    <div className={`flex items-center gap-2 ${compact ? "text-xs" : "text-sm"} text-zinc-400`}>
      {agent && !compact && <AgentIcon name={agent.name} seed={agent.avatar} size={17} working />}
      <span className="mb-spark text-sky-300/70"><i /><i /><i /><i /></span>
      <span key={word} className="mb-shimmer mb-word font-semibold tracking-wide">{word}…</span>
      {agent && !compact && <span className="text-[10px] text-zinc-600">{agent.name}</span>}
    </div>
  );
}
