import type { Agent } from "../api";
import { Settings, Crown, Plus } from "lucide-react";
import { AgentIcon } from "./icons";

// 사이드바 = 봇 목록. 각 봇이 하나의 세션 — 클릭하면 그 봇과 대화하는 창이 열림
export function Sidebar({
  agents,
  activeAgentId,
  onNew,
  onSelectBot,
  onOpenSettings,
  open,
  onClose,
  workingId,
  workingIds,
}: {
  agents: Agent[];
  activeAgentId: string | null;
  onNew: () => void;
  onSelectBot: (a: Agent) => void;
  onOpenSettings: () => void;
  open: boolean;
  onClose: () => void;
  workingId?: string | null;
  workingIds?: Set<string>;
}) {
  if (!open) return null;
  return (
    <>
      {/* 모바일: 사이드바는 오버레이 — 배경 탭으로 닫힘 */}
      <div className="fixed inset-0 z-30 bg-black/60 md:hidden" onClick={onClose} />
      <aside className="fixed inset-y-0 left-0 z-40 flex h-full w-[80vw] max-w-72 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950 md:static md:z-auto md:w-64">
      <div className="flex items-center gap-2 p-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-100 text-sm font-bold text-zinc-900">M</div>
        <span className="font-semibold text-sm">MyBot</span>
        <button
          onClick={onNew}
          className="ml-auto rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
        >+ 새 봇</button>
      </div>
      <div className="px-3 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">봇</div>
      <div className="flex-1 overflow-y-auto p-2 pt-0 space-y-0.5">
        {agents.map((a) => (
          <div
            key={a.id}
            className={`flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm ${
              a.id === activeAgentId ? "bg-zinc-800 text-zinc-100" : "text-zinc-300 hover:bg-zinc-900"
            }`}
            onClick={() => onSelectBot(a)}
            title={`${a.role_prompt || "범용 봇"} — 클릭하면 이 봇의 세션으로 이동`}
          >
            <AgentIcon name={a.name} seed={a.avatar} size={17} className="shrink-0" working={a.id === workingId || workingIds?.has(a.id)} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1">
                <span className="truncate">{a.name}</span>
                {!!a.is_boss && <Crown size={11} className="shrink-0 text-amber-400" />}
                {!!a.is_lead && !a.is_boss && <span className="shrink-0 rounded bg-zinc-700 px-1 text-[9px] text-zinc-300">팀장</span>}
              </span>
              <span className="block truncate text-[10px] leading-tight text-zinc-500">{(a.role_prompt || "범용 봇").replace(/\s+/g, " ").slice(0, 42)}</span>
            </span>
          </div>
        ))}
        <button
          onClick={onNew}
          className="flex w-full items-center gap-2 rounded-lg border border-dashed border-zinc-800 px-2.5 py-1.5 text-xs text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
        ><Plus size={12} /> 새 봇 만들기</button>
      </div>
      <div className="border-t border-zinc-800 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <button
          onClick={onOpenSettings}
          className="w-full rounded-lg px-2.5 py-2 text-left text-xs text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
        ><span className="flex items-center gap-1.5"><Settings size={13} strokeWidth={1.8} /> 설정 · 엔드포인트 · 검색</span></button>
      </div>
      </aside>
    </>
  );
}
