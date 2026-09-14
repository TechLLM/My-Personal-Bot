import type { Conversation } from "../api";

export function Sidebar({
  conversations,
  currentId,
  onSelect,
  onNew,
  onDelete,
  onOpenSettings,
  open,
  workspaces,
  workspaceId,
  onWorkspaceChange,
}: {
  conversations: Conversation[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
  open: boolean;
  workspaces: { id: string; name: string }[];
  workspaceId: string;
  onWorkspaceChange: (id: string) => void;
}) {
  if (!open) return null;
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950">
      <div className="flex items-center gap-2 p-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-100 text-sm font-bold text-zinc-900">M</div>
        <span className="font-semibold text-sm">MyBot</span>
        <button
          onClick={onNew}
          className="ml-auto rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
        >+ 새 대화</button>
      </div>
      {workspaces.length > 0 && (
        <div className="px-3 pb-2">
          <select
            className="w-full rounded-lg bg-zinc-900 px-2 py-1.5 text-xs text-zinc-300 outline-none"
            value={workspaceId}
            onChange={(e) => onWorkspaceChange(e.target.value)}
          >
            <option value="">모든 대화</option>
            {workspaces.map((w) => <option key={w.id} value={w.id}>📁 {w.name}</option>)}
          </select>
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {conversations.map((c) => (
          <div
            key={c.id}
            className={`group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm ${
              c.id === currentId ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900"
            }`}
            onClick={() => onSelect(c.id)}
          >
            {c.agent_avatar && <span className="shrink-0 text-xs" title={c.agent_name ?? ""}>{c.agent_avatar}</span>}
            <span className="truncate flex-1">{c.title}</span>
            <button
              className="hidden shrink-0 text-zinc-600 hover:text-red-400 group-hover:block"
              onClick={(e) => { e.stopPropagation(); onDelete(c.id); }}
            >✕</button>
          </div>
        ))}
        {!conversations.length && <div className="px-2.5 py-4 text-xs text-zinc-600">대화가 없습니다</div>}
      </div>
      <div className="border-t border-zinc-800 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <button
          onClick={onOpenSettings}
          className="w-full rounded-lg px-2.5 py-2 text-left text-xs text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
        >⚙ 설정 · 엔드포인트 · 검색</button>
      </div>
    </aside>
  );
}
