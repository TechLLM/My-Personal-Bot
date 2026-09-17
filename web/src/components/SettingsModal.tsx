import { useEffect, useState } from "react";
import { api, type ProviderCard, type Agent, type Model, type SiteLogin, mybotFetch } from "../api";
import {
  X, Crown, AlarmClock, Trash2, Folder, Cpu, Search, Image as ImageIcon, Bot,
  Clock, Wrench, Globe, Bell, Brain, Settings2, Loader2, ScrollText,
  ChevronDown, ChevronUp, Plus, Zap, KeyRound,
} from "lucide-react";
import { AgentIcon } from "./icons";

type Section = "providers" | "search" | "image" | "agents" | "audit" | "routines" | "tools" | "browser" | "notify" | "memory" | "general";

const SECTIONS: { id: Section; label: string; icon: any }[] = [
  { id: "providers", label: "모델 · 프로바이더", icon: Cpu },
  { id: "agents", label: "에이전트 봇", icon: Bot },
  { id: "audit", label: "봇 활동 이력", icon: ScrollText },
  { id: "routines", label: "루틴", icon: Clock },
  { id: "search", label: "검색", icon: Search },
  { id: "image", label: "이미지", icon: ImageIcon },
  { id: "tools", label: "워크스페이스·스킬", icon: Wrench },
  { id: "browser", label: "브라우저·계정", icon: Globe },
  { id: "notify", label: "알림", icon: Bell },
  { id: "memory", label: "메모리", icon: Brain },
  { id: "general", label: "일반", icon: Settings2 },
];

// 프로바이더 한 장 — 인증 상태·출처·테스트·키 입력·토글
function ProviderRow({ p, onChanged }: { p: ProviderCard; onChanged: () => void }) {
  const [key, setKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);

  const test = async () => {
    setTesting(true); setResult(null);
    try {
      const r = await api.testProvider(p.id);
      setResult(r.ok ? `✓ 연결 성공 (${r.ms}ms)${r.detail ? ` — ${r.detail}` : ""}` : `✗ ${r.error}`);
    } catch (e) { setResult(`✗ ${(e as Error).message}`); }
    setTesting(false);
  };
  const saveKey = async () => {
    if (!key.trim()) return;
    await api.setProviderKey(p.id, key.trim());
    setKey(""); setKeyOpen(false); onChanged();
  };

  const status = !p.enabled ? { t: "비활성", c: "text-stone-500", dot: "bg-stone-400" }
    : p.authed ? (p.expired ? { t: "토큰 만료 — 재로그인 필요", c: "text-amber-600", dot: "bg-amber-500" } : { t: `연결됨${p.source ? ` · ${p.source}` : ""}`, c: "text-emerald-600", dot: "bg-emerald-500" })
    : { t: "인증 필요", c: "text-stone-500", dot: "bg-stone-400" };

  return (
    <div className={`rounded-xl border px-3 py-2.5 ${p.enabled ? "border-stone-200 bg-white/60" : "border-stone-200/50 bg-white/20 opacity-60"}`}>
      <div className="flex items-center gap-2.5">
        <button
          onClick={() => api.toggleProvider(p.id).then(onChanged)}
          className={`relative h-4.5 w-8 shrink-0 rounded-full transition-colors ${p.enabled ? "bg-emerald-500/80" : "bg-stone-300"}`}
          title={p.enabled ? "비활성화" : "활성화"}
          style={{ height: 18, width: 32 }}
        >
          <span className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all ${p.enabled ? "left-[16px]" : "left-[2px]"}`} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium">{p.name}</span>
            <span className="rounded bg-stone-200 px-1.5 py-0.5 text-[9px] text-stone-600">{p.authLabel}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
            <span className={`text-[10px] ${status.c}`}>{status.t}</span>
            {p.staticModels.length > 0 && <span className="text-[10px] text-stone-400">· 모델 {p.staticModels.length}개</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {p.authType === "apikey" && (
            <button onClick={() => setKeyOpen(!keyOpen)} className="rounded-lg p-1.5 text-stone-500 hover:bg-stone-200 hover:text-stone-800" title={p.hasManualKey ? "키 교체" : "API 키 입력"}>
              <KeyRound size={13} />
            </button>
          )}
          <button onClick={test} disabled={testing || !p.enabled} className="rounded-lg p-1.5 text-stone-500 hover:bg-stone-200 hover:text-stone-800 disabled:opacity-40" title="연결 테스트">
            {testing ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
          </button>
          {p.custom && (
            <button onClick={() => api.deleteCustomProvider(p.id).then(onChanged)} className="rounded-lg p-1.5 text-stone-400 hover:bg-stone-200 hover:text-red-600" title="삭제">
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>
      {p.doc && p.enabled && !p.authed && <p className="mt-1.5 text-[10px] text-stone-400">{p.doc}</p>}
      {keyOpen && (
        <div className="mt-2 flex gap-1.5">
          <input type="password" className="flex-1 rounded-lg bg-stone-200 px-2.5 py-1.5 text-xs outline-none" placeholder="API 키 입력" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && saveKey()} autoFocus />
          <button onClick={saveKey} className="rounded-lg bg-stone-900 px-2.5 text-xs font-medium text-white">저장</button>
        </div>
      )}
      {result && <p className={`mt-1.5 text-[10px] ${result.startsWith("✓") ? "text-emerald-600" : "text-red-600"}`}>{result}</p>}
    </div>
  );
}

export function SettingsModal({ models: initialModels, onClose }: { models: Model[]; onClose: () => void }) {
  const [section, setSection] = useState<Section>("providers");
  const [models, setModels] = useState<Model[]>(initialModels); // 모달 내부 모델 목록 — 프로바이더 변경 시 즉시 갱신
  const [s, setS] = useState<Record<string, string>>({});
  const [memories, setMemories] = useState<any[]>([]);
  const [memOpen, setMemOpen] = useState(false);
  const [personas, setPersonas] = useState<any[]>([]);
  const [providers, setProviders] = useState<ProviderCard[]>([]);
  const [cpId, setCpId] = useState(""); const [cpName, setCpName] = useState(""); const [cpUrl, setCpUrl] = useState(""); const [cpKey, setCpKey] = useState(""); const [cpModels, setCpModels] = useState("");
  const [cpMsg, setCpMsg] = useState("");
  const [pName, setPName] = useState(""); const [pPrompt, setPPrompt] = useState("");
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [skills, setSkills] = useState<any[]>([]);
  const [routines, setRoutines] = useState<any[]>([]);
  const [wName, setWName] = useState(""); const [wInst, setWInst] = useState("");
  const [skName, setSkName] = useState(""); const [skPrompt, setSkPrompt] = useState("");
  const [rName, setRName] = useState(""); const [rPrompt, setRPrompt] = useState("");
  const [rSched, setRSched] = useState("daily:08:00");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [aName, setAName] = useState(""); const [aRole, setARole] = useState(""); const [aModel, setAModel] = useState("");
  const [rAgent, setRAgent] = useState("");
  const [brUrl, setBrUrl] = useState("");
  const [sites, setSites] = useState<SiteLogin[]>([]);
  const [siteName, setSiteName] = useState(""); const [siteUrl, setSiteUrl] = useState("");
  const [siteUser, setSiteUser] = useState(""); const [sitePass, setSitePass] = useState("");
  const [siteCheck, setSiteCheck] = useState(""); // 로그인 성공 기준 — CSS 선택자 또는 url:정규식 (C20)
  const [testMsg, setTestMsg] = useState("");
  const [dirty, setDirty] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");
  const [audit, setAudit] = useState<{ runs: any[]; approvals: any[] } | null>(null);
  const [auditAgent, setAuditAgent] = useState("");
  const [auditDays, setAuditDays] = useState("7");

  const testNotify = (channel: string) => {
    setTestMsg("발송 중…");
    mybotFetch("/api/notify/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel }) })
      .then(async (r) => setTestMsg(r.ok ? `${channel === "telegram" ? "텔레그램" : "메일"} 테스트 발송 성공` : `실패: ${(await r.json()).error}`))
      .catch((e) => setTestMsg(`실패: ${e.message}`));
  };

  const loadProviders = () => api.providers().then((d) => setProviders(d.providers)).catch(() => {});
  // 프로바이더 변경은 모델 목록에도 영향 — 카드와 모델 드롭다운을 함께 갱신
  const refreshProviders = () => { loadProviders(); api.models().then((d) => setModels(d.models)).catch(() => {}); };
  const load = () => {
    mybotFetch("/api/settings").then((r) => r.json()).then((d) => { setS(d.settings); setMemories(d.memories); setPersonas(d.personas); }).catch(() => {});
    api.models().then((d) => setModels(d.models)).catch(() => {});
    mybotFetch("/api/workspaces").then((r) => r.json()).then((d) => setWorkspaces(d.workspaces)).catch(() => {});
    mybotFetch("/api/skills").then((r) => r.json()).then((d) => setSkills(d.skills)).catch(() => {});
    mybotFetch("/api/routines").then((r) => r.json()).then((d) => setRoutines(d.routines)).catch(() => {});
    mybotFetch("/api/agents").then((r) => r.json()).then((d) => setAgents(d.agents)).catch(() => {});
    api.sites().then((d) => setSites(d.sites)).catch(() => {});
    loadProviders();
  };
  useEffect(() => { load(); }, []);

  // 감사 뷰 — 섹션을 열 때만 조회 (실행 이력 + 승인 요청 통합)
  const loadAudit = () => {
    const qs = new URLSearchParams();
    if (auditAgent) qs.set("agent_id", auditAgent);
    qs.set("days", auditDays || "7");
    mybotFetch(`/api/approvals/activity?${qs}`).then((r) => r.json()).then(setAudit).catch(() => {});
  };
  useEffect(() => { if (section === "audit") loadAudit(); }, [section, auditAgent, auditDays]);

  // 입력은 로컬 상태만 변경 — "저장" 버튼을 눌러야 서버에 반영
  const update = (patch: Record<string, string>) => { setS((p) => ({ ...p, ...patch })); setDirty(true); };
  const saveAll = () => {
    mybotFetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s) })
      .then((r) => { if (r.ok) { setDirty(false); setSavedMsg("✓ 저장됨"); setTimeout(() => setSavedMsg(""), 1500); } else setSavedMsg("저장 실패"); });
  };

  const Field = ({ k, label, ph }: { k: string; label: string; ph?: string }) => (
    <label className="block">
      <span className="text-xs text-stone-600">{label}</span>
      <input className="mt-1 w-full rounded-lg bg-stone-200 px-2.5 py-1.5 text-xs outline-none" value={s[k] ?? ""} placeholder={ph} onChange={(e) => update({ [k]: e.target.value })} />
    </label>
  );
  const Input = "w-full rounded-lg bg-stone-200 px-2.5 py-1.5 text-xs outline-none";
  const Btn = "rounded-lg bg-stone-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-stone-700";
  const Sub = "rounded-lg bg-stone-200 px-2.5 py-1 text-xs text-stone-700 hover:bg-stone-300";
  const H = ({ children }: { children: React.ReactNode }) => <h3 className="mb-3 font-display text-[15px] font-semibold text-stone-900">{children}</h3>;

  const authed = providers.filter((p) => p.enabled && p.authed);
  const shownMemories = memOpen ? memories : memories.slice(0, 5);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/30 p-4" onClick={onClose}>
      <div className="flex h-[80vh] w-full max-w-3xl overflow-hidden rounded-2xl border border-stone-200 bg-white" onClick={(e) => e.stopPropagation()}>
        {/* ─── 좌측 섹션 사이드바 ─── */}
        <nav className="flex w-44 shrink-0 flex-col border-r border-stone-200/80 bg-white p-2">
          <div className="mb-2 flex items-center justify-between px-2 pt-1">
            <h2 className="font-display text-base font-semibold text-stone-900">설정</h2>
          </div>
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setSection(id)}
              className={`mb-0.5 flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${section === id ? "bg-stone-200 text-stone-900" : "text-stone-500 hover:bg-white hover:text-stone-700"}`}
            >
              <Icon size={13} className="shrink-0" />
              <span className="truncate">{label}</span>
              {id === "providers" && authed.length > 0 && <span className="ml-auto rounded bg-emerald-50 px-1 text-[9px] text-emerald-600">{authed.length}</span>}
            </button>
          ))}
          <div className="mt-auto px-2 pb-1 text-[10px] text-stone-300">MyBot 로컬 설정</div>
        </nav>

        {/* ─── 우측 콘텐츠 ─── */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto p-5">

            {section === "providers" && (
              <div>
                <H>모델 · 프로바이더</H>
                <p className="mb-3 text-[11px] leading-relaxed text-stone-500">
                  각 AI 서비스에 프록시 없이 직접 연결합니다. OAuth 프로바이더는 해당 CLI의 로그인 상태를 자동으로 재사용하고,
                  API 키는 설정에 직접 입력하거나 로컬 자격증명 저장소에서 자동 인식됩니다.
                </p>
                <div className="space-y-2">
                  {providers.map((p) => <ProviderRow key={p.id} p={p} onChanged={refreshProviders} />)}
                </div>

                {/* 커스텀 프로바이더 등록 */}
                <div className="mt-4 rounded-xl border border-dashed border-stone-200 p-3">
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-stone-600"><Plus size={12} /> 커스텀 프로바이더 (OpenAI 호환)</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <input className={Input} placeholder="id (예: lmstudio)" value={cpId} onChange={(e) => setCpId(e.target.value)} />
                    <input className={Input} placeholder="표시 이름 (선택)" value={cpName} onChange={(e) => setCpName(e.target.value)} />
                    <input className={`${Input} col-span-2`} placeholder="Base URL — http://127.0.0.1:1234/v1" value={cpUrl} onChange={(e) => setCpUrl(e.target.value)} />
                    <input className={Input} type="password" placeholder="API 키 (선택)" value={cpKey} onChange={(e) => setCpKey(e.target.value)} />
                    <input className={Input} placeholder="모델 목록 — 쉼표 구분 (선택)" value={cpModels} onChange={(e) => setCpModels(e.target.value)} />
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <button className={Btn} onClick={async () => {
                      if (!cpId.trim() || !cpUrl.trim()) return;
                      const r: any = await api.addCustomProvider({ id: cpId, name: cpName || undefined, baseUrl: cpUrl, apiKey: cpKey || undefined, models: cpModels ? cpModels.split(",").map((x) => x.trim()).filter(Boolean) : undefined }).catch((e) => ({ error: e.message }));
                      if (r?.error) setCpMsg(`실패: ${r.error}`);
                      else { setCpMsg(""); setCpId(""); setCpName(""); setCpUrl(""); setCpKey(""); setCpModels(""); refreshProviders(); }
                    }}>등록</button>
                    {cpMsg && <span className="text-[10px] text-red-600">{cpMsg}</span>}
                  </div>
                  <p className="mt-1.5 text-[10px] text-stone-400">Ollama: http://127.0.0.1:11434/v1 · LM Studio: http://127.0.0.1:1234/v1</p>
                </div>

                <label className="mt-4 block">
                  <span className="text-xs text-stone-600">기본 AI 모델 — 새 봇에 자동 적용</span>
                  <select className="mt-1 w-full rounded-lg bg-stone-200 px-2.5 py-1.5 text-xs outline-none" value={s.default_model ?? ""} onChange={(e) => update({ default_model: e.target.value })}>
                    <option value="">자동 (인증된 첫 프로바이더)</option>
                    {models.map((m) => <option key={m.id} value={m.id}>{m.providerName} · {m.label}</option>)}
                  </select>
                  <span className="mt-0.5 block text-[10px] text-stone-400">인증된 프로바이더의 모델만 표시됩니다 — 목록에 없으면 위에서 프로바이더를 연결하세요</span>
                </label>

                <label className="mt-3 block">
                  <span className="text-xs text-stone-600">폴백 체인 — 모델 장애(429·5xx·잔액부족) 시 자동 전환 순서</span>
                  <input className="mt-1 w-full rounded-lg bg-stone-200 px-2.5 py-1.5 text-xs outline-none" value={s.fallback_chain ?? ""} placeholder="예: minimax/MiniMax-M3 → zai/glm-5.3 → opencode-zen" onChange={(e) => update({ fallback_chain: e.target.value })} />
                  <span className="mt-0.5 block text-[10px] text-stone-400">쉼표나 → 로 구분. 프로바이더만 적으면 첫 모델 사용. 비워두면 폴백 없음</span>
                </label>

                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Field k="run_deadline_sec" label="봇 작업 상한(초)" ph="480" />
                  <Field k="tool_rounds" label="도구 단계 상한" ph="12" />
                  <Field k="delegate_cap_sec" label="위임 상한(초)" ph="540" />
                  <Field k="run_total_cap_sec" label="실행 총 상한(초)" ph="900" />
                </div>
              </div>
            )}

            {section === "agents" && (
              <div>
                <H>에이전트 봇</H>
                <p className="mb-3 text-[11px] leading-relaxed text-stone-500">
                  CEO 봇이 모든 봇의 관리자입니다 — 지시를 받아 직접 수행하거나 팀장·전문 봇에게 분배합니다.
                  모든 봇은 해당 분야 20년 경력의 시니어 전문가로 동작합니다.
                </p>
                <div className="space-y-1.5">
                  {agents.map((a) => (
                    <div key={a.id} className="rounded-lg bg-white px-2.5 py-2 text-xs">
                      <div className="flex items-center gap-2">
                        <AgentIcon name={a.name} seed={a.avatar} size={14} className="shrink-0" />
                        <span className="font-medium">{a.name}</span>
                        {a.is_boss ? (
                          <span className="flex items-center gap-0.5 rounded bg-amber-100 px-1 text-[9px] text-amber-700"><Crown size={9} /> CEO</span>
                        ) : (
                          <button className="rounded bg-stone-200 px-1 text-[9px] text-stone-500 hover:text-amber-700" title="이 봇을 CEO로 지정" onClick={() => api.setAgentBoss(a.id).then(load)}>CEO 지정</button>
                        )}
                        {a.is_lead ? <span className="rounded bg-sky-100 px-1 text-[9px] text-sky-600">팀장</span> : null}
                        <select className="max-w-[160px] truncate rounded bg-stone-200 px-1 py-0.5 text-[10px] text-stone-600 outline-none" value={a.model ?? ""} title={a.model_label ?? a.model ?? ""} onChange={(e) => api.updateAgent(a.id, { model: e.target.value }).then(load)}>
                          {models.map((m) => <option key={m.id} value={m.id}>{m.providerName} · {m.label}</option>)}
                          {a.model && !models.find((m) => m.id === a.model) && <option value={a.model}>{a.model}</option>}
                        </select>
                        {routines.some((r) => r.agent_id === a.id && r.enabled) && (
                          <span className="flex items-center gap-0.5 rounded bg-amber-100 px-1 text-[9px] text-amber-700"><AlarmClock size={9} /> 루틴</span>
                        )}
                        {!a.is_boss && (
                          <button className="ml-auto text-stone-400 hover:text-red-600" onClick={() => mybotFetch(`/api/agents/${a.id}`, { method: "DELETE" }).then(load)}><Trash2 size={12} /></button>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-stone-500">{a.role_prompt}</div>
                    </div>
                  ))}
                  {!agents.length && <p className="text-xs text-stone-400">아직 봇이 없습니다 — 대장에게 지시하면 자동 생성됩니다</p>}
                </div>
                <div className="mt-3 space-y-1.5">
                  <div className="flex gap-1.5">
                    <input className={`${Input} flex-1`} placeholder="봇 이름 (예: 리서치봇)" value={aName} onChange={(e) => setAName(e.target.value)} />
                    <select className="w-40 rounded-lg bg-stone-200 px-2 py-1.5 text-xs outline-none" value={aModel} onChange={(e) => setAModel(e.target.value)} title="비우면 기본 AI 모델 적용">
                      <option value="">기본 모델</option>
                      {models.map((m) => <option key={m.id} value={m.id}>{m.providerName} · {m.label}</option>)}
                    </select>
                  </div>
                  <textarea className={Input} rows={2} placeholder="역할 지침 — '20년 경력의 <분야> 시니어 전문가로서 …' 형식 권장" value={aRole} onChange={(e) => setARole(e.target.value)} />
                  <button className={Btn} onClick={() => {
                    if (!aName.trim()) return;
                    api.addAgent({ name: aName, role_prompt: aRole, model: aModel || undefined, avatar: "" }).then(() => { setAName(""); setARole(""); setAModel(""); load(); });
                  }}>봇 추가</button>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Field k="agent_cap_total" label="전체 봇 정원(초과 시 승인 필요)" ph="20" />
                </div>
              </div>
            )}

            {section === "audit" && (
              <div>
                <H>봇 활동 이력</H>
                <div className="mb-3 flex gap-1.5">
                  <select className="flex-1 rounded-lg bg-stone-200 px-2 py-1.5 text-xs outline-none" value={auditAgent} onChange={(e) => setAuditAgent(e.target.value)}>
                    <option value="">전체 봇</option>
                    {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                  <select className="w-24 rounded-lg bg-stone-200 px-2 py-1.5 text-xs outline-none" value={auditDays} onChange={(e) => setAuditDays(e.target.value)}>
                    <option value="1">1일</option>
                    <option value="7">7일</option>
                    <option value="30">30일</option>
                    <option value="90">90일</option>
                  </select>
                </div>
                <p className="mb-1 text-[10px] font-medium text-stone-500">실행 이력 ({audit?.runs.length ?? 0})</p>
                <div className="max-h-52 space-y-1 overflow-y-auto">
                  {(audit?.runs ?? []).map((r) => (
                    <div key={r.id} className="rounded-lg bg-white px-2.5 py-1.5 text-[11px]">
                      <div className="flex items-center gap-1.5">
                        <AgentIcon name={r.agent_name ?? "?"} seed={r.avatar} size={12} className="shrink-0" />
                        <span className="font-medium">{r.agent_name ?? "(삭제된 봇)"}</span>
                        <span className={`rounded px-1 text-[9px] ${r.status === "done" ? "bg-emerald-100 text-emerald-700" : r.status === "error" ? "bg-red-100 text-red-600" : "bg-stone-200 text-stone-500"}`}>{r.status}</span>
                        {r.routine_id && <span className="rounded bg-amber-100 px-1 text-[9px] text-amber-700">루틴</span>}
                        {r.resume_count > 0 && <span className="rounded bg-sky-100 px-1 text-[9px] text-sky-600">재개{r.resume_count}회</span>}
                        <span className="ml-auto text-[9px] text-stone-400">{new Date(r.created_at).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                      </div>
                      <div className="mt-0.5 truncate text-stone-500">{r.task}</div>
                    </div>
                  ))}
                  {audit && !audit.runs.length && <p className="text-xs text-stone-400">기록 없음</p>}
                </div>
                <p className="mb-1 mt-3 text-[10px] font-medium text-stone-500">승인 요청 ({audit?.approvals.length ?? 0})</p>
                <div className="max-h-40 space-y-1 overflow-y-auto">
                  {(audit?.approvals ?? []).map((r) => (
                    <div key={r.id} className="rounded-lg bg-white px-2.5 py-1.5 text-[11px]">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium">{r.tool}</span>
                        <span className={`rounded px-1 text-[9px] ${r.status === "approved" ? "bg-emerald-100 text-emerald-700" : r.status === "denied" ? "bg-red-100 text-red-600" : "bg-amber-100 text-amber-700"}`}>{r.status}</span>
                        <span className="ml-auto text-[9px] text-stone-400">{r.agent_name ?? "—"} · {new Date(r.created_at).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                      </div>
                      <div className="mt-0.5 truncate text-stone-500">{r.summary}</div>
                    </div>
                  ))}
                  {audit && !audit.approvals.length && <p className="text-xs text-stone-400">기록 없음</p>}
                </div>
              </div>
            )}

            {section === "routines" && (
              <div>
                <H>루틴 (예약 실행)</H>
                <div className="space-y-1.5">
                  {routines.map((r) => (
                    <div key={r.id} className="rounded-lg bg-white px-2.5 py-2 text-xs">
                      <div className="flex items-center gap-2">
                        <button onClick={() => mybotFetch(`/api/routines/${r.id}/toggle`, { method: "POST" }).then(load)} className={r.enabled ? "text-emerald-600" : "text-stone-400"}>{r.enabled ? "●" : "○"}</button>
                        <span className="font-medium">{r.name}</span>
                        <span className="text-stone-500">{r.schedule}</span>
                        {r.agent_id && (
                          <span className="flex items-center gap-1 text-stone-400">
                            <AgentIcon name={agents.find((a) => a.id === r.agent_id)?.name} seed={agents.find((a) => a.id === r.agent_id)?.avatar} size={12} />
                            {agents.find((a) => a.id === r.agent_id)?.name ?? "봇"}
                          </span>
                        )}
                        <button className="ml-auto text-stone-400 hover:text-sky-600" onClick={() => mybotFetch(`/api/routines/${r.id}/run`, { method: "POST" }).then(load)}>지금 실행</button>
                        <button className="text-stone-400 hover:text-red-600" onClick={() => mybotFetch(`/api/routines/${r.id}`, { method: "DELETE" }).then(load)}>삭제</button>
                      </div>
                      <div className="mt-0.5 truncate text-stone-500">{r.prompt}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-3 space-y-1.5">
                  <div className="flex gap-1.5">
                    <input className={`${Input} flex-1`} placeholder="루틴 이름" value={rName} onChange={(e) => setRName(e.target.value)} />
                    <select className="rounded-lg bg-stone-200 px-2 py-1.5 text-xs outline-none" value={rAgent} onChange={(e) => setRAgent(e.target.value)} title="담당 봇">
                      <option value="">담당 봇 없음</option>
                      {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                    <select className="rounded-lg bg-stone-200 px-2 py-1.5 text-xs outline-none" value={rSched} onChange={(e) => setRSched(e.target.value)}>
                      <option value="every:30m">30분마다</option>
                      <option value="every:2h">2시간마다</option>
                      <option value="daily:08:00">매일 08:00</option>
                      <option value="daily:17:00">매일 17:00</option>
                    </select>
                  </div>
                  <textarea className={Input} rows={2} placeholder="예약 실행할 프롬프트 (예: 오늘 AI 뉴스 요약)" value={rPrompt} onChange={(e) => setRPrompt(e.target.value)} />
                  <button className={Btn} onClick={() => {
                    if (!rName.trim() || !rPrompt.trim()) return;
                    mybotFetch("/api/routines", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: rName, prompt: rPrompt, schedule: rSched, agent_id: rAgent || undefined }) }).then(() => { setRName(""); setRPrompt(""); setRAgent(""); load(); });
                  }}>루틴 추가</button>
                </div>
              </div>
            )}

            {section === "search" && (
              <div>
                <H>DeepSearch 검색 백엔드</H>
                <select className="mb-3 w-full rounded-lg bg-stone-200 px-2.5 py-1.5 text-xs outline-none" value={s.search_provider ?? "auto"} onChange={(e) => update({ search_provider: e.target.value })}>
                  <option value="auto">자동 (설정된 것 우선, 없으면 Bing)</option>
                  <option value="searxng">SearXNG (셀프호스트)</option>
                  <option value="tavily">Tavily API</option>
                  <option value="brave">Brave Search API</option>
                  <option value="exa">Exa (뉴럴 검색·에이전트 최적화)</option>
                  <option value="jina">Jina Search (본문 포함)</option>
                  <option value="bing">Bing (키 불필요)</option>
                  <option value="headless">Headless 브라우저 (키 불필요·차단 우회)</option>
                  <option value="ego">ego lite (실제 로그인 브라우저)</option>
                  <option value="ddg">DuckDuckGo (차단 빈번)</option>
                </select>
                <div className="space-y-2.5">
                  <Field k="searxng_url" label="SearXNG URL" ph="http://127.0.0.1:8080" />
                  <Field k="tavily_key" label="Tavily API 키" />
                  <Field k="brave_key" label="Brave API 키" />
                  <Field k="exa_key" label="Exa API 키" ph="exa.ai — 무료 크레딧" />
                  <Field k="jina_key" label="Jina API 키" ph="jina.ai — 무료 10M 토큰" />
                </div>
              </div>
            )}

            {section === "image" && (
              <div>
                <H>이미지 생성</H>
                <div className="space-y-2.5">
                  <Field k="image_endpoint" label="Images API 엔드포인트" ph="http://127.0.0.1:11441/v1 또는 Draw Things http://127.0.0.1:7888" />
                  <Field k="image_key" label="이미지 API 키(선택)" />
                  <Field k="image_model" label="이미지 모델" ph="dall-e-3 / flux 등" />
                </div>
              </div>
            )}

            {section === "tools" && (
              <div className="space-y-6">
                <div>
                  <H>워크스페이스</H>
                  <div className="space-y-1.5">
                    {workspaces.map((w) => (
                      <div key={w.id} className="flex items-center gap-2 rounded-lg bg-white px-2.5 py-1.5 text-xs">
                        <Folder size={13} className="shrink-0 text-stone-500" />
                        <span>{w.name}</span>
                        <span className="flex-1 truncate text-stone-500">{w.instructions}</span>
                        <button className="text-stone-400 hover:text-red-600" onClick={() => mybotFetch(`/api/workspaces/${w.id}`, { method: "DELETE" }).then(load)}>삭제</button>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 space-y-1.5">
                    <input className={Input} placeholder="워크스페이스 이름" value={wName} onChange={(e) => setWName(e.target.value)} />
                    <textarea className={Input} rows={2} placeholder="이 워크스페이스의 모든 대화에 적용할 지침" value={wInst} onChange={(e) => setWInst(e.target.value)} />
                    <button className={Btn} onClick={() => {
                      if (!wName.trim()) return;
                      mybotFetch("/api/workspaces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: wName, instructions: wInst }) }).then(() => { setWName(""); setWInst(""); load(); });
                    }}>워크스페이스 추가</button>
                  </div>
                </div>
                <div>
                  <H>스킬 (/명령)</H>
                  <div className="space-y-1.5">
                    {skills.map((sk) => (
                      <div key={sk.id} className="flex items-center gap-2 rounded-lg bg-white px-2.5 py-1.5 text-xs">
                        <span className="font-mono text-sky-600">/{sk.name}</span>
                        <span className="flex-1 truncate text-stone-500">{sk.prompt}</span>
                        <button className="text-stone-400 hover:text-red-600" onClick={() => mybotFetch(`/api/skills/${sk.id}`, { method: "DELETE" }).then(load)}>삭제</button>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 space-y-1.5">
                    <input className={Input} placeholder="스킬 이름 (예: 요약)" value={skName} onChange={(e) => setSkName(e.target.value)} />
                    <textarea className={Input} rows={2} placeholder="프롬프트 (입력 뒤에 붙는 지침)" value={skPrompt} onChange={(e) => setSkPrompt(e.target.value)} />
                    <button className={Btn} onClick={() => {
                      if (!skName.trim()) return;
                      mybotFetch("/api/skills", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: skName, prompt: skPrompt }) }).then(() => { setSkName(""); setSkPrompt(""); load(); });
                    }}>스킬 추가</button>
                  </div>
                </div>
                <div>
                  <H>페르소나</H>
                  <div className="space-y-1.5">
                    {personas.map((p) => (
                      <div key={p.id} className="flex items-center gap-2 rounded-lg bg-white px-2.5 py-1.5 text-xs">
                        <AgentIcon name={p.name} size={13} className="text-stone-500" />
                        <span>{p.name}</span>
                        <span className="flex-1 truncate text-stone-500">{p.prompt || "(기본)"}</span>
                        {!p.builtin && <button className="text-stone-400 hover:text-red-600" onClick={() => mybotFetch(`/api/personas/${p.id}`, { method: "DELETE" }).then(load)}>삭제</button>}
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 space-y-1.5">
                    <input className={Input} placeholder="페르소나 이름" value={pName} onChange={(e) => setPName(e.target.value)} />
                    <textarea className={Input} rows={2} placeholder="행동 지침 (예: 유머러스하게 답변한다)" value={pPrompt} onChange={(e) => setPPrompt(e.target.value)} />
                    <button className={Btn} onClick={() => {
                      if (!pName.trim()) return;
                      mybotFetch("/api/personas", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: pName, prompt: pPrompt, avatar: "" }) }).then(() => { setPName(""); setPPrompt(""); load(); });
                    }}>페르소나 추가</button>
                  </div>
                </div>
              </div>
            )}

            {section === "browser" && (
              <div className="space-y-6">
                <div>
                  <H>브라우저 (봇이 사용)</H>
                  <p className="mb-2 text-[11px] leading-relaxed text-stone-400">
                    봇이 쓰는 내장 Chromium입니다. "열기"를 누르면 맥미니 화면에 창이 뜨니, 거기서 한 번 로그인해 두면 봇이 그 세션을 그대로 사용합니다.
                  </p>
                  <div className="flex gap-1.5">
                    <input className={`${Input} flex-1`} placeholder="열 URL (기본 x.com)" value={brUrl} onChange={(e) => setBrUrl(e.target.value)} />
                    <button className={Btn} onClick={() => mybotFetch("/api/browser/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: brUrl || "https://x.com" }) })}>로그인 창 열기</button>
                    <button className={Sub} onClick={() => mybotFetch("/api/browser/close", { method: "POST" })}>닫기</button>
                  </div>
                </div>
                <div>
                  <H>사이트 계정 (봇 자동 로그인)</H>
                  <p className="mb-2 text-[11px] leading-relaxed text-stone-400">
                    로그인이 필요한 사이트의 계정을 등록하면 봇이 브라우저로 자동 로그인합니다. 비밀번호는 로컬 DB에만 저장되고 모델에는 노출되지 않습니다.
                  </p>
                  <div className="space-y-1.5">
                    {sites.map((st) => (
                      <div key={st.id} className="flex items-center gap-2 rounded-lg bg-white px-2.5 py-1.5 text-xs">
                        <span className="font-medium">{st.name}</span>
                        <span className="truncate text-stone-500">{st.url}</span>
                        <span className="text-stone-400">{st.username}</span>
                        <button className="ml-auto text-stone-400 hover:text-red-600" onClick={() => api.deleteSite(st.id).then(load)}><Trash2 size={12} /></button>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 space-y-1.5">
                    <div className="flex gap-1.5">
                      <input className="w-28 rounded-lg bg-stone-200 px-2 py-1.5 text-xs outline-none" placeholder="사이트 이름" value={siteName} onChange={(e) => setSiteName(e.target.value)} />
                      <input className={`${Input} flex-1`} placeholder="로그인 URL" value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} />
                    </div>
                    <div className="flex gap-1.5">
                      <input className={`${Input} flex-1`} placeholder="아이디" value={siteUser} onChange={(e) => setSiteUser(e.target.value)} />
                      <input className={`${Input} flex-1`} type="password" placeholder="비밀번호" value={sitePass} onChange={(e) => setSitePass(e.target.value)} />
                      <button className={Btn} onClick={() => {
                        if (!siteName.trim() || !siteUrl.trim() || !siteUser.trim() || !sitePass) return;
                        api.addSite({ name: siteName, url: siteUrl, username: siteUser, password: sitePass, success_check: siteCheck.trim() || undefined }).then(() => { setSiteName(""); setSiteUrl(""); setSiteUser(""); setSitePass(""); setSiteCheck(""); load(); });
                      }}>등록</button>
                    </div>
                    <input className={`${Input} w-full`} placeholder="로그인 성공 기준 (선택) — CSS 선택자 또는 url:정규식. 비우면 비밀번호 칸 소멸로 판정" value={siteCheck} onChange={(e) => setSiteCheck(e.target.value)} />
                  </div>
                </div>
              </div>
            )}

            {section === "notify" && (
              <div>
                <H>결과 알림</H>
                <p className="mb-3 text-[11px] text-stone-400">기본은 채팅창에만 표시됩니다. 체크한 채널로 답변·루틴 결과를 함께 받습니다.</p>
                <div className="space-y-2.5">
                  <label className="flex items-center gap-2 text-xs text-stone-600">
                    <input type="checkbox" checked={s.notify_telegram === "1"} onChange={(e) => update({ notify_telegram: e.target.checked ? "1" : "0" })} />
                    답변을 텔레그램으로도 받기
                  </label>
                  <Field k="telegram_bot_token" label="텔레그램 봇 토큰" ph="@BotFather에서 발급 (123456:ABC…)" />
                  <Field k="telegram_chat_id" label="텔레그램 채팅 ID" ph="봇에게 말 건 뒤 getUpdates로 확인" />
                  <label className="flex items-center gap-2 text-xs text-stone-600">
                    <input type="checkbox" checked={s.telegram_listen === "1"} onChange={(e) => update({ telegram_listen: e.target.checked ? "1" : "0" })} />
                    텔레그램으로 대장봇에게 업무 지시 받기 — 봇이 읽고 실행한 뒤 회신
                  </label>
                  <label className="flex items-center gap-2 text-xs text-stone-600">
                    <input type="checkbox" checked={s.notify_email === "1"} onChange={(e) => update({ notify_email: e.target.checked ? "1" : "0" })} />
                    답변을 이메일로도 받기
                  </label>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Field k="smtp_host" label="SMTP 호스트" ph="smtp.gmail.com" />
                    <Field k="smtp_port" label="포트" ph="587 (465는 SSL)" />
                    <Field k="smtp_user" label="SMTP 계정" />
                    <Field k="smtp_pass" label="SMTP 비밀번호/앱 비밀번호" />
                    <Field k="smtp_from" label="보내는 주소(선택)" />
                    <Field k="email_to" label="받는 주소" />
                  </div>
                  <div className="flex items-center gap-2 pt-1">
                    <button className={Sub} onClick={() => testNotify("telegram")}>텔레그램 테스트</button>
                    <button className={Sub} onClick={() => testNotify("email")}>메일 테스트</button>
                    {testMsg && <span className="text-[11px] text-stone-500">{testMsg}</span>}
                  </div>
                </div>
              </div>
            )}

            {section === "memory" && (
              <div>
                <H>메모리 ({memories.length})</H>
                <label className="mb-3 flex items-center gap-2 text-xs text-stone-600">
                  <input type="checkbox" checked={(s.memory_enabled ?? "1") !== "0"} onChange={(e) => update({ memory_enabled: e.target.checked ? "1" : "0" })} />
                  대화에서 기억할 정보 자동 추출
                </label>
                <div className="space-y-1">
                  {shownMemories.map((m) => (
                    <div key={m.id} className="flex items-center gap-2 rounded-lg bg-white px-2.5 py-1.5 text-xs text-stone-600">
                      <span className="flex-1 truncate">{m.content}</span>
                      <button className="shrink-0 text-stone-400 hover:text-red-600" onClick={() => {
                        mybotFetch(`/api/settings/memories/${m.id}`, { method: "DELETE" }).then(() => setMemories(memories.filter((x) => x.id !== m.id)));
                      }}>삭제</button>
                    </div>
                  ))}
                  {!memories.length && <p className="text-xs text-stone-400">아직 기억된 정보가 없습니다</p>}
                </div>
                {memories.length > 5 && (
                  <button onClick={() => setMemOpen(!memOpen)} className="mt-2 flex items-center gap-1 text-[11px] text-stone-500 hover:text-stone-700">
                    {memOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    {memOpen ? "접기" : `${memories.length - 5}개 더 보기`}
                  </button>
                )}
              </div>
            )}

            {section === "general" && (
              <div className="space-y-6">
                <div>
                  <H>시스템 프롬프트</H>
                  <textarea className={Input} rows={4} value={s.system_prompt ?? ""} onChange={(e) => update({ system_prompt: e.target.value })} />
                </div>
                <div>
                  <H>보안</H>
                  <Field k="access_code" label="접속 암호 (설정 시 API 전체에 필요)" ph="비워두면 LAN 개방" />
                </div>
              </div>
            )}
          </div>

          {/* 하단 저장 바 */}
          <div className="flex items-center gap-3 border-t border-stone-200 px-5 py-3">
            <button onClick={saveAll} className="rounded-lg bg-stone-900 px-4 py-1.5 text-xs font-semibold text-white hover:bg-stone-700">저장</button>
            {dirty && <span className="text-[11px] text-amber-600">저장되지 않은 변경 사항 있음</span>}
            {savedMsg && <span className="text-[11px] text-emerald-600">{savedMsg}</span>}
            <button onClick={onClose} className="ml-auto text-xs text-stone-500 hover:text-stone-800">닫기</button>
          </div>
        </div>
      </div>
    </div>
  );
}
