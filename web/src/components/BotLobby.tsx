import { useEffect, useState } from "react";
import { api, type Agent, type Model } from "../api";
import { Crown, AlarmClock, Plus, ChevronDown, ChevronUp, Copy, Pin, EyeOff, Eye, MoreHorizontal } from "lucide-react";
import { AgentIcon, BrandMark } from "./icons";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 역할 지침 요약 — "1. 이름 / 역할" 같은 목차 머리와 봇 이름 반복을 떼고 첫 설명부터 보여줌
export function roleSummary(prompt: string | null | undefined, name?: string): string {
  let s = (prompt || "").replace(/\s+/g, " ").trim();
  s = s.replace(/^[[\-\s]*(?:\d+\.\s*)?이름\s*\/\s*역할(?:\s*\(한 문장\))?\]?\s*/, "");
  if (name) s = s.replace(new RegExp(`^${escapeRe(name)}\\s*[/—–:-]\\s*`), "");
  return s.slice(0, 160) || "범용 봇";
}

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
  const [menuFor, setMenuFor] = useState<string | null>(null); // 관리 메뉴(핀·복제·숨기기)가 열린 봇 — 터치 기기에서도 누를 수 있게 hover 대신 메뉴
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

  const manage = (p: Promise<unknown>) => { setMenuFor(null); p.then(onRefresh).catch(() => {}); };
  const menuBtn = "flex h-10 items-center justify-center gap-1.5 rounded-xl bg-stone-100 text-caption font-medium text-stone-600 hover:bg-stone-200 hover:text-stone-900 md:h-9";
  const field = "rounded-xl bg-stone-100 outline-none ring-1 ring-transparent transition focus:bg-white focus:ring-stone-300";

  const list = showAll ? agents : agents.slice(0, 6);

  return (
    <div className="mt-3 pb-4 md:mt-[7vh]">
      <div className="mb-rise mb-7 text-center">
        {!agentsLoaded ? (
          <div className="mb-5 h-14" />
        ) : agents.length > 0 ? (
          <div className="mx-auto mb-5 flex w-fit items-center -space-x-2.5">
            {agents.slice(0, 5).map((a, i) => (
              <span key={a.id} className="relative" style={{ zIndex: 5 - i }}>
                <AgentIcon name={a.name} seed={a.avatar} size={44} />
              </span>
            ))}
          </div>
        ) : (
          <BrandMark size={56} className="mx-auto mb-5 block" />
        )}
        <h1 className="font-display text-[26px] font-bold leading-tight text-stone-900 md:text-[30px]">{agentsLoaded && agents.length === 0 ? "첫 봇을 만드세요" : "봇을 선택하거나 새로 만드세요"}</h1>
        <p className="mx-auto mt-2.5 max-w-md text-balance text-sm leading-relaxed text-stone-500">
          {agentsLoaded && agents.length === 0
            ? "모든 대화는 봇이 담당합니다 — 먼저 봇을 만들어야 대화할 수 있습니다. CEO로 지정하면 다른 봇들을 관리합니다"
            : "모든 대화는 봇이 담당합니다 — 봇을 고르면 그 봇의 기억·역할·도구로 일합니다"}
        </p>
      </div>

      <div className="mx-auto grid max-w-2xl grid-cols-1 gap-2.5 md:grid-cols-2 md:gap-3">
        {list.map((a) => (
          <div
            key={a.id}
            onClick={() => onSelect(a)}
            className="group relative cursor-pointer rounded-2xl border border-stone-200/80 bg-white/75 p-3.5 shadow-[0_1px_2px_rgba(28,25,23,0.04)] transition-[transform,box-shadow,background-color,border-color] duration-200 hover:-translate-y-0.5 hover:border-stone-300/80 hover:bg-white hover:shadow-[0_12px_28px_-14px_rgba(28,25,23,0.25)] active:scale-[0.99]"
            title={`${a.role_prompt || "범용 봇"} — 클릭하면 이 봇과 대화`}
          >
            <div className="flex items-start gap-3">
              <AgentIcon name={a.name} seed={a.avatar} size={40} className="shrink-0 transition-transform duration-300 group-hover:-rotate-6 group-hover:scale-105" />
              <div className="min-w-0 flex-1 pr-8">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-base font-semibold tracking-tight text-stone-900 md:text-[15px]">{a.name}</span>
                  {!!a.is_boss && (
                    <span className="flex shrink-0 items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-micro font-semibold text-amber-700"><Crown size={10} /> CEO</span>
                  )}
                  {routineAgentIds.has(a.id) && (
                    <AlarmClock size={14} className="shrink-0 text-amber-600" />
                  )}
                </div>
                <p className="mt-0.5 line-clamp-2 text-caption text-stone-500">{roleSummary(a.role_prompt, a.name)}</p>
                <div className="mt-1.5 truncate font-mono text-2xs text-stone-400">{a.model_label ?? a.model ?? "subagent"}</div>
              </div>
            </div>
            <button
              className={`absolute right-2 top-2 grid size-9 place-items-center rounded-xl transition md:size-8 ${
                menuFor === a.id ? "bg-stone-100 text-stone-800" : "text-stone-400 hover:bg-stone-100 hover:text-stone-700 can-hover:opacity-0 can-hover:group-hover:opacity-100 can-hover:focus-visible:opacity-100"
              }`}
              title="봇 관리 — 핀 고정·복제·숨기기"
              aria-label={`${a.name} 관리`}
              onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === a.id ? null : a.id); }}
            ><MoreHorizontal size={18} /></button>
            {menuFor === a.id && (
              <div className="mt-3 grid grid-cols-3 gap-1.5 border-t border-stone-100 pt-3" onClick={(e) => e.stopPropagation()}>
                <button className={menuBtn} title="핀 고정 — 목록 상단에 표시" onClick={() => manage(api.updateAgent(a.id, { pinned: a.pinned ? 0 : 1 }))}>
                  <Pin size={15} className={a.pinned ? "text-amber-600" : ""} /> {a.pinned ? "고정 해제" : "핀 고정"}
                </button>
                <button className={menuBtn} title="복제 — 역할·모델·스킬만 복사 (대화·기억은 복사되지 않음)" onClick={() => manage(api.duplicateAgent(a.id))}>
                  <Copy size={15} /> 복제
                </button>
                <button className={menuBtn} title={a.hidden ? "숨김 해제" : "숨기기 — 사이드바에서 감춤"} onClick={() => manage(api.updateAgent(a.id, { hidden: a.hidden ? 0 : 1 }))}>
                  {a.hidden ? <Eye size={15} /> : <EyeOff size={15} />} {a.hidden ? "숨김 해제" : "숨기기"}
                </button>
              </div>
            )}
          </div>
        ))}

        {/* 새 봇 만들기 카드 */}
        <button
          onClick={() => setCreating(!creating)}
          className={`group flex items-center gap-3 rounded-2xl border border-dashed p-3.5 text-left transition-colors ${creating ? "border-stone-400 bg-white" : "border-stone-300/80 hover:border-stone-400 hover:bg-white/70"}`}
        >
          <span className="grid size-11 shrink-0 place-items-center rounded-full bg-stone-900 text-white transition-transform duration-300 group-hover:rotate-90"><Plus size={20} strokeWidth={2.2} /></span>
          <span className="min-w-0 flex-1">
            <span className="block text-base font-semibold text-stone-800 md:text-[15px]">새 봇 만들기</span>
            <span className="mt-0.5 block text-caption text-stone-500">이름·역할을 정하고 바로 대화를 시작합니다</span>
          </span>
        </button>
      </div>

      {agents.length > 6 && (
        <button
          className="mx-auto mt-3 flex h-10 items-center gap-1 rounded-full px-4 text-sm font-medium text-stone-500 hover:bg-stone-200/60 hover:text-stone-800"
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? <ChevronUp size={16} /> : <ChevronDown size={16} />} {showAll ? "접기" : `봇 ${agents.length - 6}개 더 보기`}
        </button>
      )}

      {creating && (
        <div className="mb-rise mx-auto mt-3 max-w-2xl rounded-2xl border border-stone-200 bg-white p-4 shadow-[0_12px_32px_-18px_rgba(28,25,23,0.28)] md:p-5">
          <div className="mb-4 flex items-center gap-2 text-caption font-medium text-stone-400">
            <span className={`flex items-center gap-1.5 ${step === 1 ? "text-stone-900" : ""}`}>
              <span className={`grid size-5 place-items-center rounded-full text-micro ${step === 1 ? "bg-stone-900 text-white" : "bg-stone-200 text-stone-500"}`}>1</span> 이름·얼굴
            </span>
            <span className="h-px w-6 bg-stone-200" />
            <span className={`flex items-center gap-1.5 ${step === 2 ? "text-stone-900" : ""}`}>
              <span className={`grid size-5 place-items-center rounded-full text-micro ${step === 2 ? "bg-stone-900 text-white" : "bg-stone-200 text-stone-500"}`}>2</span> 페르소나·역할
            </span>
          </div>

          {step === 1 && (
            <div className="space-y-3">
              <div className="flex items-center gap-3.5">
                <button
                  className="group shrink-0 rounded-2xl bg-stone-100 p-2 transition-colors hover:bg-stone-200"
                  onClick={() => setFaceSeed(Math.random().toString(36).slice(2, 10))}
                  title="다른 얼굴"
                  aria-label="다른 얼굴로 바꾸기"
                >
                  <AgentIcon seed={`face:${faceSeed}`} size={52} className="transition-transform group-active:scale-90" />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex gap-2">
                    <input
                      className={`h-11 min-w-0 flex-1 px-3.5 text-sm md:h-10 ${field}`}
                      placeholder="봇 이름 (예: 회의록 정리봇)"
                      value={name} onChange={(e) => setName(e.target.value)}
                      autoFocus
                      onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) setStep(2); }}
                    />
                    <button className="h-11 shrink-0 rounded-xl bg-stone-100 px-3 text-xs font-medium text-stone-600 hover:bg-stone-200 hover:text-stone-900 md:h-10" onClick={suggestName}>자동 이름</button>
                  </div>
                  <p className="mt-2 text-2xs text-stone-400">얼굴은 자동으로 만들어집니다 — 아이콘을 눌러 다른 얼굴로 바꿀 수 있어요</p>
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  className="h-11 rounded-xl bg-stone-900 px-5 text-sm font-semibold text-white hover:bg-stone-700 disabled:opacity-40 md:h-10"
                  disabled={!name.trim()}
                  onClick={() => setStep(2)}
                >다음 →</button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2.5">
                <AgentIcon seed={`face:${faceSeed}`} size={30} />
                <span className="text-base font-semibold text-stone-900">{name}</span>
                <button className="h-8 rounded-lg px-2 text-2xs text-stone-400 hover:bg-stone-100 hover:text-stone-700" onClick={() => setStep(1)}>이름 변경</button>
              </div>
              <div className="flex flex-col gap-2 md:flex-row">
                <textarea
                  className={`min-h-[88px] flex-1 px-3.5 py-2.5 text-sm ${field}`} rows={3}
                  placeholder="페르소나·역할 지침 (예: 회의록을 요약하고 액션 아이템을 뽑는 비서)"
                  value={role} onChange={(e) => setRole(e.target.value)} autoFocus
                />
                <select className={`h-11 px-3 text-xs md:h-10 md:w-44 md:self-start ${field}`} value={model} onChange={(e) => { setModel(e.target.value); setModelTouched(true); }} title={models.find((m) => m.id === model)?.id ?? model}>
                  {models.map((m) => <option key={m.id} value={m.id}>{m.label}{m.id === defaultModel ? " (기본)" : ""}</option>)}
                  {!models.find((m) => m.id === model) && <option value={model}>{model}</option>}
                </select>
              </div>
              <div className="flex flex-col-reverse gap-3 md:flex-row md:items-center">
                <label className="flex min-h-10 items-center gap-2 text-xs text-stone-600">
                  <input type="checkbox" className="size-4 accent-stone-900" checked={asBoss} onChange={(e) => setAsBoss(e.target.checked)} />
                  <Crown size={14} className="text-amber-600" /> CEO로 지정 — 모든 봇의 관리자가 됩니다
                </label>
                <button
                  className="h-11 rounded-xl bg-stone-900 px-5 text-sm font-semibold text-white hover:bg-stone-700 md:ml-auto md:h-10"
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
