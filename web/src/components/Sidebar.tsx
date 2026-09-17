import { useState } from "react";
import type { Agent, Group } from "../api";
import { Settings, Crown, Plus, Pin, Users, EyeOff } from "lucide-react";
import { AgentIcon, BrandMark } from "./icons";
import { roleSummary } from "./BotLobby";
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

  const row = (active: boolean) =>
    `flex min-h-14 cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 transition-colors md:min-h-[52px] ${
      active ? "bg-white text-stone-900 shadow-[0_1px_3px_rgba(28,25,23,0.08)] ring-1 ring-stone-900/5" : "text-stone-700 hover:bg-white/60"
    }`;
  const quiet = "flex h-11 w-full items-center gap-2.5 rounded-xl px-3 text-sm text-stone-500 hover:bg-white/60 hover:text-stone-800 md:h-10";

  if (!open) return null;
  return (
    <>
      {/* 모바일: 사이드바는 오버레이 — 배경 탭으로 닫힘 */}
      <div className="mb-fade fixed inset-0 z-30 bg-stone-950/25 backdrop-blur-[2px] md:hidden" onClick={onClose} />
      <aside className="mb-drawer fixed inset-y-0 left-0 z-40 flex h-full w-[86vw] max-w-80 shrink-0 flex-col bg-[var(--panel)] shadow-[8px_0_32px_-12px_rgba(28,25,23,0.3)] md:static md:z-auto md:w-72 md:border-r md:border-stone-200/70 md:shadow-none">
      <div className="flex items-center gap-2.5 px-4 pb-2 pt-[max(0.875rem,env(safe-area-inset-top))]">
        <BrandMark size={32} className="shrink-0" />
        <span className="font-display text-[17px] font-bold text-stone-900">MyBot</span>
        <button
          onClick={onNew}
          className="ml-auto flex h-9 items-center gap-1 rounded-xl bg-stone-900 px-3 text-xs font-semibold text-white hover:bg-stone-700 md:h-8"
        ><Plus size={14} strokeWidth={2.4} /> 새 봇</button>
      </div>
      <div className="px-4 pb-1 pt-3 text-2xs font-semibold uppercase tracking-wider text-stone-400">봇</div>
      <div className="flex-1 space-y-0.5 overflow-y-auto overscroll-contain px-2 pb-2">
        {visible.map((a) => {
          const tool = working?.[a.id];
          const isWorking = a.id === workingId || tool !== undefined;
          return (
          <div
            key={a.id}
            className={`${row(a.id === activeAgentId)} ${a.hidden ? "opacity-45" : ""}`}
            onClick={() => onSelectBot(a)}
            title={`${a.role_prompt || "범용 봇"} — 클릭하면 이 봇의 세션으로 이동`}
          >
            <AgentIcon name={a.name} seed={a.avatar} size={32} className="shrink-0" working={isWorking} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1">
                <span className="truncate text-sm font-semibold">{a.name}</span>
                {!!a.pinned && <Pin size={12} className="shrink-0 text-stone-400" />}
                {!!a.is_boss && <Crown size={13} className="shrink-0 text-amber-600" />}
                {!!a.is_lead && !a.is_boss && <span className="shrink-0 rounded-full bg-stone-900/[0.07] px-1.5 py-px text-micro font-semibold text-stone-600">팀장</span>}
                {!!a.hidden && <EyeOff size={12} className="shrink-0 text-stone-400" />}
              </span>
              {isWorking ? (
                <span className="mt-0.5 flex items-center gap-1 truncate text-2xs">
                  <span className="mb-spark text-sky-600/80"><i /><i /></span>
                  <span className="mb-shimmer font-semibold text-sky-600">{toolWord(tool ?? "") ?? "Working"}…</span>
                  <span className="truncate text-stone-500">{toolLabel(tool)}</span>
                </span>
              ) : (
                <span className="mt-0.5 block truncate text-2xs text-stone-500">{roleSummary(a.role_prompt, a.name)}</span>
              )}
            </span>
          </div>
          );
        })}
        <button onClick={onNew} className={quiet}>
          <span className="grid size-7 place-items-center rounded-full border border-dashed border-stone-300"><Plus size={14} /></span> 새 봇 만들기
        </button>
        {hiddenCount > 0 && (
          <button onClick={() => setShowHidden(!showHidden)} className={`${quiet} text-caption text-stone-400`}>
            <span className="grid size-7 place-items-center"><EyeOff size={14} /></span> {showHidden ? "숨긴 봇 감추기" : `숨긴 봇 ${hiddenCount}개 보기`}
          </button>
        )}

        {/* 그룹채팅 — 여러 봇이 하나의 대화에 참여 */}
        <div className="px-2 pb-1 pt-4 text-2xs font-semibold uppercase tracking-wider text-stone-400">그룹</div>
        {groups.map((g) => (
          <div
            key={g.id}
            className={row(g.id === activeGroupId)}
            onClick={() => onSelectGroup(g)}
            title={`${g.members.map((m) => m.name).join(", ")} — 클릭하면 그룹 대화로 이동`}
          >
            <span className="flex shrink-0 -space-x-2">
              {g.members.slice(0, 3).map((m) => (
                <AgentIcon key={m.id} name={m.name} seed={m.avatar} size={26} working={working?.[m.id] !== undefined} />
              ))}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{g.name}</span>
              <span className="mt-0.5 block truncate text-2xs text-stone-500">{g.members.map((m) => m.name).join(" · ")}</span>
            </span>
          </div>
        ))}
        {groupForm ? (
          <div className="space-y-2.5 rounded-xl bg-white p-3 ring-1 ring-stone-200">
            <input
              className="h-10 w-full rounded-lg bg-stone-100 px-3 text-sm outline-none ring-1 ring-transparent focus:bg-white focus:ring-stone-300"
              placeholder="그룹 이름 (예: 뉴스 분석팀)"
              value={groupName} onChange={(e) => setGroupName(e.target.value)} autoFocus
            />
            <div className="max-h-48 space-y-0.5 overflow-y-auto">
              {agents.filter((a) => !a.hidden).map((a) => (
                <label key={a.id} className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg px-1.5 text-sm text-stone-700 hover:bg-stone-50">
                  <input
                    type="checkbox"
                    className="size-4 accent-stone-900"
                    checked={picked.has(a.id)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(a.id); else next.delete(a.id);
                      setPicked(next);
                    }}
                  />
                  <AgentIcon name={a.name} seed={a.avatar} size={20} />
                  <span className="truncate">{a.name}</span>
                </label>
              ))}
            </div>
            <div className="flex gap-2">
              <button onClick={() => setGroupForm(false)} className="h-10 flex-1 rounded-lg bg-stone-100 text-xs font-medium text-stone-600 hover:bg-stone-200">취소</button>
              <button
                onClick={createGroup}
                disabled={!groupName.trim() || picked.size < 2}
                className="h-10 flex-1 rounded-lg bg-stone-900 text-xs font-semibold text-white disabled:opacity-40"
              >만들기 ({picked.size})</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setGroupForm(true)} className={quiet}>
            <span className="grid size-7 place-items-center rounded-full border border-dashed border-stone-300"><Users size={14} /></span> 그룹 만들기
          </button>
        )}
      </div>
      <div className="border-t border-stone-900/[0.06] p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <button
          onClick={onOpenSettings}
          className="flex h-11 w-full items-center gap-2.5 rounded-xl px-3 text-left text-sm text-stone-600 hover:bg-white/60 hover:text-stone-900 md:h-10"
        ><Settings size={17} strokeWidth={1.8} /> 설정 · 엔드포인트 · 검색</button>
      </div>
      </aside>
    </>
  );
}
