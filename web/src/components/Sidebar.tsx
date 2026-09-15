import type { Agent, Conversation } from "../api";
import { X, Settings, Crown, Plus } from "lucide-react";
import { AgentIcon } from "./icons";

export function Sidebar({
  conversations,
  agents,
  currentId,
  onSelect,
  onNew,
  onSelectBot,
  onDelete,
  onOpenSettings,
  open,
  onClose,
  workspaces,
  workspaceId,
  onWorkspaceChange,
}: {
  conversations: Conversation[];
  agents: Agent[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onSelectBot: (a: Agent) => void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
  open: boolean;
  onClose: () => void;
  workspaces: { id: string; name: string }[];
  workspaceId: string;
  onWorkspaceChange: (id: string) => void;
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
      {workspaces.length > 0 && (
        <div className="px-3 pb-2">
          <select
            className="w-full rounded-lg bg-zinc-900 px-2 py-1.5 text-xs text-zinc-300 outline-none"
            value={workspaceId}
            onChange={(e) => onWorkspaceChange(e.target.value)}
          >
            <option value="">모든 대화</option>
            {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </div>
      )}
      {/* 봇 목록 — 각 봇이 하나의 세션. 클릭하면 그 봇의 최근 대화로 진입 */}
      <div className="border-b border-zinc-800/60">
        <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">봇</div>
        <div className="max-h-44 overflow-y-auto px-2 pb-2 space-y-0.5">
          {agents.map((a) => (
            <div
              key={a.id}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-zinc-300 hover:bg-zinc-900"
              onClick={() => onSelectBot(a)}
              title={`${a.role_prompt || "범용 봇"} — 클릭하면 이 봇의 세션으로 이동`}
            >
              <AgentIcon name={a.name} seed={a.avatar} size={17} className="shrink-0" />
              <span className="truncate flex-1">{a.name}</span>
              {!!a.is_boss && <Crown size={11} className="shrink-0 text-amber-400" />}
            </div>
          ))}
          <button
            onClick={onNew}
            className="flex w-full items-center gap-2 rounded-lg border border-dashed border-zinc-800 px-2.5 py-1.5 text-xs text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
          ><Plus size={12} /> 새 봇 만들기</button>
        </div>
      </div>
      <div className="px-3 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">대화</div>
      <div className="flex-1 overflow-y-auto p-2 pt-1 space-y-0.5">
        {conversations.map((c) => (
          <div
            key={c.id}
            className={`group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm ${
              c.id === currentId ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900"
            }`}
            onClick={() => onSelect(c.id)}
          >
            {c.agent_name && <AgentIcon name={c.agent_name} seed={c.agent_avatar} size={15} className="shrink-0" />}
            <span className="truncate flex-1">{c.title}</span>
            <button
              className="hidden shrink-0 text-zinc-600 hover:text-red-400 group-hover:block"
              onClick={(e) => { e.stopPropagation(); onDelete(c.id); }}
            ><X size={12} strokeWidth={2} /></button>
          </div>
        ))}
        {!conversations.length && <div className="px-2.5 py-4 text-xs text-zinc-600">대화가 없습니다</div>}
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
