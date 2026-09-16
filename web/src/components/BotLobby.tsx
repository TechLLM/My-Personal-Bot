import { useEffect, useState } from "react";
import { api, type Agent, type Model } from "../api";
import { Crown, AlarmClock, Plus, MessageSquare, ChevronDown, ChevronUp, Copy, Pin, EyeOff, Eye } from "lucide-react";
import { AgentIcon } from "./icons";

// 첫 화면: 봇 선택/생성이 진입점 — 봇이 곧 워크플로어
export function BotLobby({
  agents,
  agentsLoaded,
  models,
  defaultModel,
  routineAgentIds,
  createSignal,
  onSelect,
  onRefresh,
}: {
  agents: Agent[];
  agentsLoaded: boolean;
  models: Model[];
  defaultModel: string; // 설정의 기본 AI 모델 — 새 봇의 기본값
  routineAgentIds: Set<string>;
  createSignal: number; // 증가할 때마다 생성 마법사를 엶
  onSelect: (a: Agent) => void;
  onRefresh: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [step, setStep] = useState<1 | 2>(1); // 1: 이름·얼굴 → 2: 페르소나·역할
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [model, setModel] = useState(defaultModel || "subagent");
  const [modelTouched, setModelTouched] = useState(false); // 사용자가 직접 고르기 전까진 기본값 추적
  const [asBoss, setAsBoss] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // 얼굴 시드 — 생성 시 서버에 avatar로 저장돼 영구 얼굴이 됨
  const [faceSeed, setFaceSeed] = useState(() => Math.random().toString(36).slice(2, 10));

  // 기본 모델 설정이 늦게 로드돼도 사용자가 직접 고르기 전이면 따라감
  useEffect(() => {
    if (defaultModel && !modelTouched) setModel(defaultModel);
  }, [defaultModel, modelTouched]);

  // 봇이 하나도 없으면 최초 워크플로 = 봇 생성 — 마법사를 자동으로 엶
  useEffect(() => {
    if (agentsLoaded && agents.length === 0) setCreating(true);
  }, [agentsLoaded, agents.length]);

  // 사이드바 "+ 새 봇" → 생성 마법사 열기
  useEffect(() => {
    if (createSignal > 0) setCreating(true);
  }, [createSignal]);

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
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-stone-900 font-display text-2xl font-semibold text-white">M</div>
        <h1 className="font-display text-2xl font-semibold text-stone-900">{agentsLoaded && agents.length === 0 ? "첫 봇을 만드세요" : "봇을 선택하거나 새로 만드세요"}</h1>
        <p className="mt-2 text-sm text-stone-500">
          {agentsLoaded && agents.length === 0
            ? "모든 대화는 봇이 담당합니다 — 먼저 봇을 만들어야 대화할 수 있습니다. CEO로 지정하면 다른 봇들을 관리합니다"
            : "모든 대화는 봇이 담당합니다 — 봇을 고르면 그 봇의 기억·역할·도구로 일합니다"}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-2xl mx-auto">
        {list.map((a) => (
          <div key={a.id} onClick={() => onSelect(a)} className="group cursor-pointer rounded-xl border border-stone-200 px-3.5 py-3 hover:bg-white hover:border-stone-300 transition-colors" title={`${a.role_prompt || "범용 봇"} — 클릭하면 이 봇과 대화`}>
            <div className="flex items-center gap-2">
              <AgentIcon name={a.name} seed={a.avatar} size={18} className="shrink-0" />
              <span className="font-medium text-sm text-stone-800 truncate">{a.name}</span>
              {!!a.is_boss && (
                <span className="flex items-center gap-0.5 rounded bg-amber-100 px-1 py-px text-[9px] text-amber-700"><Crown size={9} /> CEO</span>
              )}
              {routineAgentIds.has(a.id) && (
                <AlarmClock size={11} className="shrink-0 text-amber-600" />
              )}
              <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
                <button
                  className="rounded p-1 text-stone-500 hover:bg-stone-200 hover:text-stone-800"
                  title="핀 고정 — 목록 상단에 표시"
                  onClick={() => api.updateAgent(a.id, { pinned: a.pinned ? 0 : 1 }).then(onRefresh).catch(() => {})}
                ><Pin size={11} className={a.pinned ? "text-amber-600" : ""} /></button>
                <button
                  className="rounded p-1 text-stone-500 hover:bg-stone-200 hover:text-stone-800"
                  title="복제 — 역할·모델·스킬만 복사 (대화·기억은 복사되지 않음)"
                  onClick={() => api.duplicateAgent(a.id).then(onRefresh).catch(() => {})}
                ><Copy size={11} /></button>
                <button
                  className="rounded p-1 text-stone-500 hover:bg-stone-200 hover:text-stone-800"
                  title={a.hidden ? "숨김 해제" : "숨기기 — 사이드바에서 감춤"}
                  onClick={() => api.updateAgent(a.id, { hidden: a.hidden ? 0 : 1 }).then(onRefresh).catch(() => {})}
                >{a.hidden ? <Eye size={11} /> : <EyeOff size={11} />}</button>
                <button
                  className="flex items-center gap-1 rounded-full bg-stone-900 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-stone-700"
                  onClick={() => onSelect(a)}
                ><MessageSquare size={11} /> 대화</button>
              </span>
            </div>
            <div className="mt-1 text-[11px] text-stone-500 truncate">{a.role_prompt || "범용 봇"}</div>
            <div className="mt-0.5 font-mono text-[10px] text-stone-400">{a.model_label ?? a.model ?? "subagent"}</div>
          </div>
        ))}

        {/* 새 봇 만들기 카드 */}
        <button
          onClick={() => setCreating(!creating)}
          className={`rounded-xl border border-dashed px-3.5 py-3 text-left transition-colors ${creating ? "border-stone-400 bg-white" : "border-stone-200 hover:bg-white hover:border-stone-300"}`}
        >
          <div className="flex items-center gap-2 text-sm text-stone-600">
            <Plus size={15} /> 새 봇 만들기
            {agents.length > 6 && (
              <span className="ml-auto text-[11px] text-stone-400" onClick={(e) => { e.stopPropagation(); setShowAll(!showAll); }}>
                {showAll ? <ChevronUp size={12} className="inline" /> : <ChevronDown size={12} className="inline" />} {agents.length - 6}개 더
              </span>
            )}
          </div>
          <div className="mt-1 text-[11px] text-stone-400">이름·역할을 정하고 바로 대화를 시작합니다</div>
        </button>
      </div>

      {creating && (
        <div className="mx-auto mt-3 max-w-2xl rounded-xl border border-stone-300 bg-white p-4">
          <div className="mb-3 flex items-center gap-1.5 text-[10px] font-medium text-stone-500">
            <span className={step === 1 ? "text-stone-800" : ""}>1. 이름·얼굴</span>
            <span>→</span>
            <span className={step === 2 ? "text-stone-800" : ""}>2. 페르소나·역할</span>
          </div>

          {step === 1 && (
            <div className="space-y-2.5">
              <div className="flex items-center gap-3">
                <button
                  className="shrink-0 rounded-xl bg-stone-200 p-2 hover:bg-stone-300 transition-colors"
                  onClick={() => setFaceSeed(Math.random().toString(36).slice(2, 10))}
                  title="다른 얼굴"
                >
                  <AgentIcon seed={`face:${faceSeed}`} size={38} />
                </button>
                <div className="flex-1">
                  <div className="flex gap-2">
                    <input
                      className="flex-1 rounded-lg bg-stone-200 px-2.5 py-1.5 text-sm outline-none"
                      placeholder="봇 이름 (예: 회의록 정리봇)"
                      value={name} onChange={(e) => setName(e.target.value)}
                      autoFocus
                      onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) setStep(2); }}
                    />
                    <button className="shrink-0 rounded-lg bg-stone-200 px-2.5 text-xs text-stone-600 hover:bg-stone-300 hover:text-stone-800" onClick={suggestName}>자동 이름</button>
                  </div>
                  <p className="mt-1.5 text-[10px] text-stone-400">얼굴은 자동으로 만들어집니다 — 아이콘을 눌러 다른 얼굴로 바꿀 수 있어요</p>
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  className="rounded-lg bg-stone-900 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-stone-700 disabled:opacity-40"
                  disabled={!name.trim()}
                  onClick={() => setStep(2)}
                >다음 →</button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-2.5">
              <div className="flex items-center gap-2 text-sm text-stone-700">
                <AgentIcon seed={`face:${faceSeed}`} size={20} />
                <span className="font-medium">{name}</span>
                <button className="text-[10px] text-stone-400 hover:text-stone-600" onClick={() => setStep(1)}>이름 변경</button>
              </div>
              <div className="flex gap-2">
                <textarea
                  className="flex-1 rounded-lg bg-stone-200 px-2.5 py-1.5 text-xs outline-none" rows={2}
                  placeholder="페르소나·역할 지침 (예: 회의록을 요약하고 액션 아이템을 뽑는 비서)"
                  value={role} onChange={(e) => setRole(e.target.value)} autoFocus
                />
                <select className="w-40 self-start rounded-lg bg-stone-200 px-2 py-1.5 text-xs outline-none" value={model} onChange={(e) => { setModel(e.target.value); setModelTouched(true); }} title={models.find((m) => m.id === model)?.id ?? model}>
                  {models.map((m) => <option key={m.id} value={m.id}>{m.label}{m.id === defaultModel ? " (기본)" : ""}</option>)}
                  {!models.find((m) => m.id === model) && <option value={model}>{model}</option>}
                </select>
              </div>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs text-stone-600">
                  <input type="checkbox" checked={asBoss} onChange={(e) => setAsBoss(e.target.checked)} />
                  <Crown size={12} className="text-amber-600" /> CEO로 지정 — 모든 봇의 관리자가 됩니다
                </label>
                <button
                  className="ml-auto rounded-lg bg-stone-900 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-stone-700"
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
