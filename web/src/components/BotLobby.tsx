import { useState } from "react";
import { api, type Agent, type Model } from "../api";
import { Crown, AlarmClock, Plus, MessageSquare, ChevronDown, ChevronUp } from "lucide-react";
import { AgentIcon } from "./icons";

// 첫 화면: 봇 선택/생성이 진입점 — 봇이 곧 워크플로어
export function BotLobby({
  agents,
  models,
  routineAgentIds,
  onSelect,
  onRefresh,
}: {
  agents: Agent[];
  models: Model[];
  routineAgentIds: Set<string>;
  onSelect: (a: Agent) => void;
  onRefresh: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [step, setStep] = useState<1 | 2>(1); // 1: 이름·얼굴 → 2: 페르소나·역할
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [model, setModel] = useState("subagent");
  const [asBoss, setAsBoss] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // 얼굴 시드 — 생성 시 서버에 avatar로 저장돼 영구 얼굴이 됨
  const [faceSeed, setFaceSeed] = useState(() => Math.random().toString(36).slice(2, 10));

  const NAME_A = ["민첩한", "꼼꼼한", "든든한", "영리한", "성실한", "차분한", "날카로운", "따뜻한"];
  const NAME_B = ["비서", "탐정", "사서", "분석가", "파수꾼", "도우미", "기록관", "전령"];
  const suggestName = () =>
    setName(`${NAME_A[Math.floor(Math.random() * NAME_A.length)]} ${NAME_B[Math.floor(Math.random() * NAME_B.length)]}`);

  const create = () => {
    if (!name.trim()) return;
    api.addAgent({ name: name.trim(), role_prompt: role, model, avatar: `face:${faceSeed}` }).then(async (d: any) => {
      const agent = d.agent as Agent;
      if (asBoss) await api.setAgentBoss(agent.id).catch(() => {});
      setName(""); setRole(""); setAsBoss(false); setCreating(false); setStep(1);
      setFaceSeed(Math.random().toString(36).slice(2, 10));
      onRefresh();
      onSelect(agent); // 만든 봇과 바로 대화 시작
    });
  };

  const list = showAll ? agents : agents.slice(0, 6);

  return (
    <div className="mt-[10vh]">
      <div className="text-center mb-6">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-100 text-2xl font-bold text-zinc-900">M</div>
        <h1 className="text-xl font-semibold text-zinc-200">봇을 선택하거나 새로 만드세요</h1>
        <p className="mt-2 text-sm text-zinc-500">모든 대화는 봇이 담당합니다 — 봇을 고르면 그 봇의 기억·역할·도구로 일합니다</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-2xl mx-auto">
        {list.map((a) => (
          <div key={a.id} className="group rounded-xl border border-zinc-800 px-3.5 py-3 hover:bg-zinc-900 hover:border-zinc-700 transition-colors">
            <div className="flex items-center gap-2">
              <AgentIcon name={a.name} seed={a.avatar} size={18} className="shrink-0" />
              <span className="font-medium text-sm text-zinc-200 truncate">{a.name}</span>
              {!!a.is_boss && (
                <span className="flex items-center gap-0.5 rounded bg-amber-900/50 px-1 py-px text-[9px] text-amber-300"><Crown size={9} /> CEO</span>
              )}
              {routineAgentIds.has(a.id) && (
                <AlarmClock size={11} className="shrink-0 text-amber-400/80" />
              )}
              <button
                className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-1 text-[11px] font-medium text-zinc-900 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-white"
                onClick={() => onSelect(a)}
              ><MessageSquare size={11} /> 대화</button>
            </div>
            <div className="mt-1 text-[11px] text-zinc-500 truncate">{a.role_prompt || "범용 봇"}</div>
            <div className="mt-0.5 font-mono text-[10px] text-zinc-600">{a.model_label ?? a.model ?? "subagent"}</div>
          </div>
        ))}

        {/* 새 봇 만들기 카드 */}
        <button
          onClick={() => setCreating(!creating)}
          className={`rounded-xl border border-dashed px-3.5 py-3 text-left transition-colors ${creating ? "border-zinc-600 bg-zinc-900" : "border-zinc-800 hover:bg-zinc-900 hover:border-zinc-700"}`}
        >
          <div className="flex items-center gap-2 text-sm text-zinc-400">
            <Plus size={15} /> 새 봇 만들기
            {agents.length > 6 && (
              <span className="ml-auto text-[11px] text-zinc-600" onClick={(e) => { e.stopPropagation(); setShowAll(!showAll); }}>
                {showAll ? <ChevronUp size={12} className="inline" /> : <ChevronDown size={12} className="inline" />} {agents.length - 6}개 더
              </span>
            )}
          </div>
          <div className="mt-1 text-[11px] text-zinc-600">이름·역할을 정하고 바로 대화를 시작합니다</div>
        </button>
      </div>

      {creating && (
        <div className="mx-auto mt-3 max-w-2xl rounded-xl border border-zinc-700 bg-zinc-900 p-4">
          <div className="mb-3 flex items-center gap-1.5 text-[10px] font-medium text-zinc-500">
            <span className={step === 1 ? "text-zinc-200" : ""}>1. 이름·얼굴</span>
            <span>→</span>
            <span className={step === 2 ? "text-zinc-200" : ""}>2. 페르소나·역할</span>
          </div>

          {step === 1 && (
            <div className="space-y-2.5">
              <div className="flex items-center gap-3">
                <button
                  className="shrink-0 rounded-xl bg-zinc-800 p-2 hover:bg-zinc-700 transition-colors"
                  onClick={() => setFaceSeed(Math.random().toString(36).slice(2, 10))}
                  title="다른 얼굴"
                >
                  <AgentIcon seed={`face:${faceSeed}`} size={38} />
                </button>
                <div className="flex-1">
                  <div className="flex gap-2">
                    <input
                      className="flex-1 rounded-lg bg-zinc-800 px-2.5 py-1.5 text-sm outline-none"
                      placeholder="봇 이름 (예: 회의록 정리봇)"
                      value={name} onChange={(e) => setName(e.target.value)}
                      autoFocus
                      onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) setStep(2); }}
                    />
                    <button className="shrink-0 rounded-lg bg-zinc-800 px-2.5 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200" onClick={suggestName}>자동 이름</button>
                  </div>
                  <p className="mt-1.5 text-[10px] text-zinc-600">얼굴은 자동으로 만들어집니다 — 아이콘을 눌러 다른 얼굴로 바꿀 수 있어요</p>
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  className="rounded-lg bg-zinc-100 px-3.5 py-1.5 text-xs font-semibold text-zinc-900 hover:bg-white disabled:opacity-40"
                  disabled={!name.trim()}
                  onClick={() => setStep(2)}
                >다음 →</button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-2.5">
              <div className="flex items-center gap-2 text-sm text-zinc-300">
                <AgentIcon seed={`face:${faceSeed}`} size={20} />
                <span className="font-medium">{name}</span>
                <button className="text-[10px] text-zinc-600 hover:text-zinc-400" onClick={() => setStep(1)}>이름 변경</button>
              </div>
              <div className="flex gap-2">
                <textarea
                  className="flex-1 rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs outline-none" rows={2}
                  placeholder="페르소나·역할 지침 (예: 회의록을 요약하고 액션 아이템을 뽑는 비서)"
                  value={role} onChange={(e) => setRole(e.target.value)} autoFocus
                />
                <select className="w-40 self-start rounded-lg bg-zinc-800 px-2 py-1.5 text-xs outline-none" value={model} onChange={(e) => setModel(e.target.value)}>
                  {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  {!models.find((m) => m.id === "subagent") && <option value="subagent">subagent</option>}
                </select>
              </div>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs text-zinc-400">
                  <input type="checkbox" checked={asBoss} onChange={(e) => setAsBoss(e.target.checked)} />
                  <Crown size={12} className="text-amber-400" /> CEO로 지정 — 모든 봇의 관리자가 됩니다
                </label>
                <button
                  className="ml-auto rounded-lg bg-zinc-100 px-3.5 py-1.5 text-xs font-semibold text-zinc-900 hover:bg-white"
                  onClick={create}
                >만들고 대화 시작</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
