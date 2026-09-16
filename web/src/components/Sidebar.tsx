import { useState } from "react";
import type { Agent, Group } from "../api";
import { Settings, Crown, Plus, Pin, Users, EyeOff } from "lucide-react";
import { AgentIcon } from "./icons";
import { toolWord, toolLabel } from "./WorkingStatus";

// 사이드바 = 봇 목록 + 그룹. 각 봇이 하나의 세션 — 클릭하면 그 봇과 대화하는 창이 열림
// 작업 중인 봇은 얼굴이 움직이고, 역할 설명 자리에 실시간 작업 상태(상태어 + 작업 내용)가 표시됨
export function Sidebar({
  agents,
  groups,
  activeAgentId,
  activeGroupId,
  onNew,
  onSelectBot,
  onSelectGroup,
  onCreateGroup,
  onOpenSettings,
  open,
  onClose,
  workingId,
  working,
}: {
  agents: Agent[];
  groups: Group[];
  activeAgentId: string | null;
  activeGroupId: string | null;
  onNew: () => void;
  onSelectBot: (a: Agent) => void;
  onSelectGroup: (g: Group) => void;
  onCreateGroup: (name: string, agentIds: string[]) => void;
  onOpenSettings: () => void;
  open: boolean;
  onClose: () => void;
  workingId?: string | null;
  // 서버에서 실행 중인 봇: id → 마지막으로 사용한 도구 (실시간 작업 내용 표시용)
  working?: Record<string, string | null>;
}) {
  const [showHidden, setShowHidden] = useState(false);
  const [groupForm, setGroupForm] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const visible = agents.filter((a) => showHidden || !a.hidden);
  const hiddenCount = agents.filter((a) => a.hidden).length;

  const createGroup = () => {
    if (!groupName.trim() || picked.size < 2) return;
    onCreateGroup(groupName.trim(), [...picked]);
    setGroupName(""); setPicked(new Set()); setGroupForm(false);
  };

  if (!open) return null;
  return (
    <>
      {/* 모바일: 사이드바는 오버레이 — 배경 탭으로 닫힘 */}
      <div className="fixed inset-0 z-30 bg-stone-950/30 md:hidden" onClick={onClose} />
      <aside className="fixed inset-y-0 left-0 z-40 flex h-full w-[80vw] max-w-72 shrink-0 flex-col border-r border-stone-200 bg-white md:static md:z-auto md:w-64">
      <div className="flex items-center gap-2 p-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-stone-900 text-sm font-bold text-white">M</div>
        <span className="font-display text-[15px] font-semibold text-stone-900">MyBot</span>
        <button
          onClick={onNew}
          className="ml-auto rounded-lg bg-stone-200 px-2.5 py-1.5 text-xs text-stone-700 hover:bg-stone-300"
        >+ 새 봇</button>
      </div>
      <div className="px-3 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-stone-400">봇</div>
      <div className="flex-1 overflow-y-auto p-2 pt-0 space-y-0.5">
        {visible.map((a) => {
          const tool = working?.[a.id];
          const isWorking = a.id === workingId || tool !== undefined;
          return (
          <div
            key={a.id}
            className={`flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm ${
              a.id === activeAgentId ? "bg-stone-200 text-stone-900" : "text-stone-700 hover:bg-white"
            } ${a.hidden ? "opacity-45" : ""}`}
            onClick={() => onSelectBot(a)}
            title={`${a.role_prompt || "범용 봇"} — 클릭하면 이 봇의 세션으로 이동`}
          >
            <AgentIcon name={a.name} seed={a.avatar} size={17} className="shrink-0" working={isWorking} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1">
                <span className="truncate">{a.name}</span>
                {!!a.pinned && <Pin size={10} className="shrink-0 text-stone-500" />}
                {!!a.is_boss && <Crown size={11} className="shrink-0 text-amber-600" />}
                {!!a.is_lead && !a.is_boss && <span className="shrink-0 rounded bg-stone-300 px-1 text-[9px] text-stone-700">팀장</span>}
                {!!a.hidden && <EyeOff size={10} className="shrink-0 text-stone-400" />}
              </span>
              {isWorking ? (
                <span className="flex items-center gap-1 truncate text-[10px] leading-tight">
                  <span className="mb-spark text-sky-600/80"><i /><i /></span>
                  <span className="mb-shimmer font-medium text-sky-600">{toolWord(tool ?? "") ?? "Working"}…</span>
                  <span className="truncate text-stone-500">{toolLabel(tool)}</span>
                </span>
              ) : (
                <span className="block truncate text-[10px] leading-tight text-stone-500">{(a.role_prompt || "범용 봇").replace(/\s+/g, " ").slice(0, 42)}</span>
              )}
            </span>
          </div>
          );
        })}
        <button
          onClick={onNew}
          className="flex w-full items-center gap-2 rounded-lg border border-dashed border-stone-200 px-2.5 py-1.5 text-xs text-stone-500 hover:bg-white hover:text-stone-700"
        ><Plus size={12} /> 새 봇 만들기</button>
        {hiddenCount > 0 && (
          <button
            onClick={() => setShowHidden(!showHidden)}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[11px] text-stone-400 hover:text-stone-600"
          ><EyeOff size={11} /> {showHidden ? "숨긴 봇 감추기" : `숨긴 봇 ${hiddenCount}개 보기`}</button>
        )}

        {/* 그룹채팅 — 여러 봇이 하나의 대화에 참여 */}
        <div className="px-1 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-stone-400">그룹</div>
        {groups.map((g) => (
          <div
            key={g.id}
            className={`flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm ${
              g.id === activeGroupId ? "bg-stone-200 text-stone-900" : "text-stone-700 hover:bg-white"
            }`}
            onClick={() => onSelectGroup(g)}
            title={`${g.members.map((m) => m.name).join(", ")} — 클릭하면 그룹 대화로 이동`}
          >
            <span className="flex shrink-0 -space-x-1.5">
              {g.members.slice(0, 3).map((m) => (
                <AgentIcon key={m.id} name={m.name} seed={m.avatar} size={17} className="rounded-full ring-1 ring-stone-200" working={working?.[m.id] !== undefined} />
              ))}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{g.name}</span>
              <span className="block truncate text-[10px] leading-tight text-stone-500">{g.members.map((m) => m.name).join(" · ")}</span>
            </span>
          </div>
        ))}
        {groupForm ? (
          <div className="rounded-lg border border-stone-200 p-2.5 space-y-2">
            <input
              className="w-full rounded-lg bg-stone-200 px-2.5 py-1.5 text-xs outline-none"
              placeholder="그룹 이름 (예: 뉴스 분석팀)"
              value={groupName} onChange={(e) => setGroupName(e.target.value)} autoFocus
            />
            <div className="max-h-40 space-y-1 overflow-y-auto">
              {agents.filter((a) => !a.hidden).map((a) => (
                <label key={a.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs text-stone-700 hover:bg-white">
                  <input
                    type="checkbox"
                    checked={picked.has(a.id)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(a.id); else next.delete(a.id);
                      setPicked(next);
                    }}
                  />
                  <AgentIcon name={a.name} seed={a.avatar} size={14} />
                  <span className="truncate">{a.name}</span>
                </label>
              ))}
            </div>
            <div className="flex gap-1.5">
              <button onClick={() => setGroupForm(false)} className="flex-1 rounded-lg bg-stone-200 py-1.5 text-[11px] text-stone-600">취소</button>
              <button
                onClick={createGroup}
                disabled={!groupName.trim() || picked.size < 2}
                className="flex-1 rounded-lg bg-stone-900 py-1.5 text-[11px] font-medium text-white disabled:opacity-40"
              >만들기 ({picked.size})</button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setGroupForm(true)}
            className="flex w-full items-center gap-2 rounded-lg border border-dashed border-stone-200 px-2.5 py-1.5 text-xs text-stone-500 hover:bg-white hover:text-stone-700"
          ><Users size={12} /> 그룹 만들기</button>
        )}
      </div>
      <div className="border-t border-stone-200 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <button
          onClick={onOpenSettings}
          className="w-full rounded-lg px-2.5 py-2 text-left text-xs text-stone-500 hover:bg-white hover:text-stone-700"
        ><span className="flex items-center gap-1.5"><Settings size={13} strokeWidth={1.8} /> 설정 · 엔드포인트 · 검색</span></button>
      </div>
      </aside>
    </>
  );
}
