import { useEffect, useState } from "react";
import { api, type ProviderCard, type Agent, type Model, type SiteLogin, mybotFetch } from "../api";
import {
  X, Crown, AlarmClock, Trash2, Folder, Cpu, Search, Image as ImageIcon, Bot,
  Clock, Wrench, Globe, Bell, Brain, Settings2, Loader2, ScrollText,
  ChevronDown, ChevronUp, Plus, Zap, KeyRound, LogIn,
} from "lucide-react";
import { AgentIcon } from "./icons";

type Section = "providers" | "search" | "image" | "agents" | "audit" | "routines" | "tools" | "browser" | "notify" | "memory" | "updates" | "general";

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
  { id: "updates", label: "업데이트", icon: Zap },
  { id: "general", label: "일반", icon: Settings2 },
];

// 프로바이더 한 장 — 인증 상태·출처·테스트·키 입력·토글
function ProviderRow({ p, onChanged }: { p: ProviderCard; onChanged: () => void }) {
  const [key, setKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  const [reauthing, setReauthing] = useState(false);
  const [waiting, setWaiting] = useState(false); // 브라우저 로그인 완료 대기 — 인증 반영까지 폴링

  // 브라우저 로그인 진행 중 인증이 반영될 때까지 5초 간격으로 카드 상태를 갱신 (최대 ~2분)
  useEffect(() => {
    if (!waiting) return;
    let n = 0;
    const t = setInterval(() => { n++; onChanged(); if (p.authed || n >= 24) { setWaiting(false); clearInterval(t); } }, 5000);
    return () => clearInterval(t);
  }, [waiting, p.authed]);

  const test = async () => {
    setTesting(true); setResult(null);
    try {
      const r = await api.testProvider(p.id);
      setResult(r.ok ? `✓ 연결 성공 (${r.ms}ms)${r.detail ? ` — ${r.detail}` : ""}` : `✗ ${r.error}`);
    } catch (e) { setResult(`✗ ${(e as Error).message}`); }
    setTesting(false);
  };
  const reauth = async () => {
    setReauthing(true); setResult(null);
    try {
      const r = await api.reauthProvider(p.id);
      if (r.ok) {
        setResult(`✓ ${r.detail ?? "인증됐습니다"}`);
        if (r.method === "login") setWaiting(true); // 브라우저 로그인 완료를 기다리며 상태 폴링
        onChanged();
      } else {
        setResult(`✗ ${r.error ?? "재인증 실패"}`);
        if (r.needsKey) setKeyOpen(true);
      }
    } catch (e) { setResult(`✗ ${(e as Error).message}`); }
    setReauthing(false);
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
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs font-medium">{p.name}</span>
            <span className="shrink-0 whitespace-nowrap rounded bg-stone-200 px-1.5 py-0.5 text-micro text-stone-600">{p.authLabel}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
            <span className={`text-2xs ${status.c}`}>{status.t}</span>
            {p.staticModels.length > 0 && <span className="text-2xs text-stone-400">· 모델 {p.staticModels.length}개</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {(p.authType === "oauth" || p.authType === "cli") && (!p.authed || p.expired) && (
            <button onClick={reauth} disabled={reauthing || !p.enabled} className="rounded-lg p-1.5 text-amber-600 hover:bg-amber-100 hover:text-amber-700 disabled:opacity-40" title={p.expired ? "토큰 만료 — 재인증" : "로그인 / 재인증"}>
              {reauthing || waiting ? <Loader2 size={13} className="animate-spin" /> : <LogIn size={13} />}
            </button>
          )}
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
      {p.doc && p.enabled && !p.authed && <p className="mt-1.5 text-2xs text-stone-400">{p.doc}</p>}
      {keyOpen && (
        <div className="mt-2 flex gap-1.5">
          <input type="password" className="flex-1 rounded-lg bg-stone-200 px-2.5 py-1.5 text-xs outline-none" placeholder="API 키 입력" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && saveKey()} autoFocus />
          <button onClick={saveKey} className="rounded-lg bg-stone-900 px-2.5 text-xs font-medium text-white">저장</button>
        </div>
      )}
      {result && <p className={`mt-1.5 text-2xs ${result.startsWith("✓") ? "text-emerald-600" : "text-red-600"}`}>{result}</p>}
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
  const [updates, setUpdates] = useState<any[]>([]);
  const [updProg, setUpdProg] = useState<{ id: string; pct: number } | null>(null); // 적용 중인 업데이트의 진행 표시
  const [updErr, setUpdErr] = useState<Record<string, string>>({}); // 카드별 오류 메시지 — 실패를 조용히 삼키지 않는다
  const [appVersion, setAppVersion] = useState(0);
  const [updBusy, setUpdBusy] = useState(false);
  const [wName, setWName] = useState(""); const [wInst, setWInst] = useState("");
  const [skName, setSkName] = useState(""); const [skPrompt, setSkPrompt] = useState("");
  const [rName, setRName] = useState(""); const [rPrompt, setRPrompt] = useState("");
  const [rSched, setRSched] = useState("daily:08:00");
  const [rTrig, setRTrig] = useState<"schedule" | "email" | "webhook">("schedule");
  const [rMatchField, setRMatchField] = useState(""); const [rMatchSender, setRMatchSender] = useState(""); const [rMatchKw, setRMatchKw] = useState("");
  const [rMailFrom, setRMailFrom] = useState(""); const [rMailSubj, setRMailSubj] = useState("");
  const [hookUrl, setHookUrl] = useState("");
  const [rRuns, setRRuns] = useState<Record<string, any[]>>({}); // 펼쳐진 루틴별 실행 이력 (A10)
  // MCP 서버 추가 폼 (A11)
  const [mcName, setMcName] = useState(""); const [mcType, setMcType] = useState<"remote" | "stdio">("remote");
  const [mcUrl, setMcUrl] = useState(""); const [mcHdrs, setMcHdrs] = useState(""); const [mcCmd, setMcCmd] = useState("");
  const [wsAgentsOpen, setWsAgentsOpen] = useState(""); // C19 — 봇 배정 펼친 워크스페이스 id
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
  // 시연 녹화 → 스킬 초안 (A8)
  const [recActive, setRecActive] = useState(false);
  const [recUrl, setRecUrl] = useState("");
  const [recCount, setRecCount] = useState(0);
  const [recBusy, setRecBusy] = useState(false);
  const [recDraft, setRecDraft] = useState<{ name: string; trigger: string; steps: string; notes: string } | null>(null);

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
  const loadUpdates = () => api.evolveUpdates().then((d) => { setUpdates(d.updates); setAppVersion(d.appVersion); }).catch(() => {});
  useEffect(() => { if (section === "updates") loadUpdates(); }, [section]);
  // 업데이트 동작 실행 — 적용은 진행 바를 보여주고, 실패는 서버 오류 메시지를 카드에 표시한다
  const updAct = (id: string, fn: () => Promise<unknown>, withProgress = false) => {
    setUpdBusy(true);
    setUpdErr((m) => { const n = { ...m }; delete n[id]; return n; });
    let tick: ReturnType<typeof setInterval> | undefined;
    if (withProgress) {
      setUpdProg({ id, pct: 10 });
      // 서버 확정 전에는 92%까지만 진행 — 응답이 오면 100%로 완료한다
      tick = setInterval(() => setUpdProg((p) => (p && p.id === id ? { id, pct: Math.min(92, p.pct + Math.max(2, (92 - p.pct) * 0.3)) } : p)), 200);
    }
    fn()
      .then(async () => {
        if (tick) clearInterval(tick);
        if (withProgress) setUpdProg({ id, pct: 100 });
        await loadUpdates();
        if (withProgress) setTimeout(() => setUpdProg((p) => (p?.id === id ? null : p)), 1400);
      })
      .catch((e) => {
        if (tick) clearInterval(tick);
        setUpdProg(null);
        setUpdErr((m) => ({ ...m, [id]: (e as Error).message || "요청 실패" }));
      })
      .finally(() => setUpdBusy(false));
  };

  // 녹화 중 상태 폴링 — 10분 자동 종료도 UI에 반영
  useEffect(() => {
    if (!recActive) return;
    const t = setInterval(() => api.recordStatus().then((d) => { setRecCount(d.count); if (!d.active) setRecActive(false); }).catch(() => {}), 2000);
    return () => clearInterval(t);
  }, [recActive]);

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
  const Btn = "rounded-lg bg-stone-900 px-3 py-2 text-xs font-medium text-white hover:bg-stone-700 md:px-2.5 md:py-1";
  const Sub = "rounded-lg bg-stone-200 px-3 py-2 text-xs text-stone-700 hover:bg-stone-300 md:px-2.5 md:py-1";
  const H = ({ children }: { children: React.ReactNode }) => <h3 className="mb-3 font-display text-[15px] font-semibold text-stone-900">{children}</h3>;

  const authed = providers.filter((p) => p.enabled && p.authed);
  const shownMemories = memOpen ? memories : memories.slice(0, 5);

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-stone-950/30 md:items-center md:p-4" onClick={onClose}>
      <div className="flex h-full w-full max-w-3xl flex-col overflow-hidden bg-white md:h-[80vh] md:flex-row md:rounded-2xl md:border md:border-stone-200" onClick={(e) => e.stopPropagation()}>
        {/* ─── 섹션 내비 — 데스크톱은 좌측 사이드바, 모바일은 전체 화면 상단의 가로 탭 ─── */}
        <nav className="no-scrollbar flex shrink-0 items-center gap-1 overflow-x-auto border-b border-stone-200/80 bg-white px-2 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] md:w-44 md:flex-col md:items-stretch md:gap-0 md:overflow-visible md:border-b-0 md:border-r md:p-2">
          <div className="mr-1 flex shrink-0 items-center px-2 md:mb-2 md:mr-0 md:justify-between md:pt-1">
            <h2 className="font-display text-base font-semibold text-stone-900">설정</h2>
          </div>
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setSection(id)}
              className={`flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 text-left text-xs transition-colors md:mb-0.5 md:h-auto md:shrink md:px-2.5 md:py-2 ${section === id ? "bg-stone-200 text-stone-900" : "text-stone-500 hover:bg-stone-100 hover:text-stone-700"}`}
            >
              <Icon size={14} className="shrink-0" />
              <span className="truncate">{label}</span>
              {id === "providers" && authed.length > 0 && <span className="ml-auto rounded bg-emerald-50 px-1 text-micro text-emerald-600">{authed.length}</span>}
            </button>
          ))}
          <div className="mt-auto hidden px-2 pb-1 text-2xs text-stone-300 md:block">MyBot 로컬 설정</div>
        </nav>

        {/* ─── 우측 콘텐츠 ─── */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto p-4 md:p-5">

            {section === "providers" && (
              <div>
                <H>모델 · 프로바이더</H>
                <p className="mb-3 text-caption leading-relaxed text-stone-500">
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
                    {cpMsg && <span className="text-2xs text-red-600">{cpMsg}</span>}
                  </div>
                  <p className="mt-1.5 text-2xs text-stone-400">Ollama: http://127.0.0.1:11434/v1 · LM Studio: http://127.0.0.1:1234/v1</p>
                </div>

                <label className="mt-4 block">
                  <span className="text-xs text-stone-600">기본 AI 모델 — 새 봇에 자동 적용</span>
                  <select className="mt-1 w-full rounded-lg bg-stone-200 px-2.5 py-1.5 text-xs outline-none" value={s.default_model ?? ""} onChange={(e) => update({ default_model: e.target.value })}>
                    <option value="">자동 (인증된 첫 프로바이더)</option>
                    {models.map((m) => <option key={m.id} value={m.id}>{m.providerName} · {m.label}</option>)}
                  </select>
                  <span className="mt-0.5 block text-2xs text-stone-400">인증된 프로바이더의 모델만 표시됩니다 — 목록에 없으면 위에서 프로바이더를 연결하세요</span>
                </label>

                <label className="mt-3 block">
                  <span className="text-xs text-stone-600">폴백 체인 — 모델 장애(429·5xx·잔액부족) 시 자동 전환 순서</span>
                  <input className="mt-1 w-full rounded-lg bg-stone-200 px-2.5 py-1.5 text-xs outline-none" value={s.fallback_chain ?? ""} placeholder="예: minimax/MiniMax-M3 → zai/glm-5.3 → opencode-zen" onChange={(e) => update({ fallback_chain: e.target.value })} />
                  <span className="mt-0.5 block text-2xs text-stone-400">쉼표나 → 로 구분. 프로바이더만 적으면 첫 모델 사용. 비워두면 폴백 없음</span>
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
                <p className="mb-3 text-caption leading-relaxed text-stone-500">
                  CEO 봇이 모든 봇의 관리자입니다 — 지시를 받아 직접 수행하거나 팀장·전문 봇에게 분배합니다.
                  모든 봇은 해당 분야 20년 경력의 시니어 전문가로 동작합니다.
                </p>
                <div className="space-y-1.5">
                  {agents.map((a) => (
                    <div key={a.id} className="rounded-lg bg-white px-2.5 py-2 text-xs">
                      <div className="flex items-center gap-2">
                        <AgentIcon name={a.name} seed={a.avatar} size={16} className="shrink-0" />
                        <span className="font-medium">{a.name}</span>
                        {a.is_boss ? (
                          <span className="flex items-center gap-0.5 rounded bg-amber-100 px-1 text-micro text-amber-700"><Crown size={9} /> CEO</span>
                        ) : (
                          <button className="rounded bg-stone-200 px-1 text-micro text-stone-500 hover:text-amber-700" title="이 봇을 CEO로 지정" onClick={() => api.setAgentBoss(a.id).then(load)}>CEO 지정</button>
                        )}
                        {a.is_lead ? <span className="rounded bg-sky-100 px-1 text-micro text-sky-600">팀장</span> : null}
                        <select className="max-w-[160px] truncate rounded bg-stone-200 px-1 py-0.5 text-2xs text-stone-600 outline-none" value={a.model ?? ""} title={a.model_label ?? a.model ?? ""} onChange={(e) => api.updateAgent(a.id, { model: e.target.value }).then(load)}>
                          {models.map((m) => <option key={m.id} value={m.id}>{m.providerName} · {m.label}</option>)}
                          {a.model && !models.find((m) => m.id === a.model) && <option value={a.model}>{a.model}</option>}
                        </select>
                        {routines.some((r) => r.agent_id === a.id && r.enabled) && (
                          <span className="flex items-center gap-0.5 rounded bg-amber-100 px-1 text-micro text-amber-700"><AlarmClock size={9} /> 루틴</span>
                        )}
                        <button className="ml-auto text-stone-400 hover:text-stone-700" title="봇 구성을 JSON으로보내기" onClick={() => {
                          mybotFetch(`/api/agents/${a.id}/export`).then((r) => r.json()).then((d) => {
                            const blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
                            const el = document.createElement("a");
                            el.href = URL.createObjectURL(blob); el.download = `mybot-${a.name}.json`; el.click();
                            URL.revokeObjectURL(el.href);
                          });
                        }}>보내기</button>
                        {!a.is_boss && (
                          <button className="text-stone-400 hover:text-red-600" onClick={() => mybotFetch(`/api/agents/${a.id}`, { method: "DELETE" }).then(load)}><Trash2 size={12} /></button>
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
                  <label className="block cursor-pointer text-center">
                    <input type="file" accept=".json" className="hidden" onChange={(e) => {
                      const f = e.target.files?.[0]; if (!f) return;
                      f.text().then((t) => mybotFetch("/api/agents/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: t }).then((r) => r.json()).then((d) => {
                        if (d.error) alert(d.error); else load();
                      }));
                      e.target.value = "";
                    }} />
                    <span className="inline-block rounded-lg bg-stone-200 px-2.5 py-1.5 text-xs text-stone-600 hover:bg-stone-300">JSON 파일에서 봇 가져오기</span>
                  </label>
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
                <p className="mb-1 text-2xs font-medium text-stone-500">실행 이력 ({audit?.runs.length ?? 0})</p>
                <div className="max-h-52 space-y-1 overflow-y-auto">
                  {(audit?.runs ?? []).map((r) => (
                    <div key={r.id} className="rounded-lg bg-white px-2.5 py-1.5 text-caption">
                      <div className="flex items-center gap-1.5">
                        <AgentIcon name={r.agent_name ?? "?"} seed={r.avatar} size={16} className="shrink-0" />
                        <span className="font-medium">{r.agent_name ?? "(삭제된 봇)"}</span>
                        <span className={`rounded px-1 text-micro ${r.status === "done" ? "bg-emerald-100 text-emerald-700" : r.status === "error" ? "bg-red-100 text-red-600" : "bg-stone-200 text-stone-500"}`}>{r.status}</span>
                        {r.routine_id && <span className="rounded bg-amber-100 px-1 text-micro text-amber-700">루틴</span>}
                        {r.resume_count > 0 && <span className="rounded bg-sky-100 px-1 text-micro text-sky-600">재개{r.resume_count}회</span>}
                        <span className="ml-auto text-micro text-stone-400">{new Date(r.created_at).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                      </div>
                      <div className="mt-0.5 truncate text-stone-500">{r.task}</div>
                    </div>
                  ))}
                  {audit && !audit.runs.length && <p className="text-xs text-stone-400">기록 없음</p>}
                </div>
                <p className="mb-1 mt-3 text-2xs font-medium text-stone-500">승인 요청 ({audit?.approvals.length ?? 0})</p>
                <div className="max-h-40 space-y-1 overflow-y-auto">
                  {(audit?.approvals ?? []).map((r) => (
                    <div key={r.id} className="rounded-lg bg-white px-2.5 py-1.5 text-caption">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium">{r.tool}</span>
                        <span className={`rounded px-1 text-micro ${r.status === "approved" ? "bg-emerald-100 text-emerald-700" : r.status === "denied" ? "bg-red-100 text-red-600" : "bg-amber-100 text-amber-700"}`}>{r.status}</span>
                        <span className="ml-auto text-micro text-stone-400">{r.agent_name ?? "—"} · {new Date(r.created_at).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
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
                        <span className="text-stone-500">{r.trigger_type === "webhook" ? "웹훅" : r.trigger_type === "email" ? "이메일" : r.schedule}</span>
                        {r.agent_id && (
                          <span className="flex items-center gap-1 text-stone-400">
                            <AgentIcon name={agents.find((a) => a.id === r.agent_id)?.name} seed={agents.find((a) => a.id === r.agent_id)?.avatar} size={16} />
                            {agents.find((a) => a.id === r.agent_id)?.name ?? "봇"}
                          </span>
                        )}
                        <button className="ml-auto text-stone-400 hover:text-stone-700" title="최근 실행 이력"
                          onClick={() => rRuns[r.id]
                            ? setRRuns((p) => { const n = { ...p }; delete n[r.id]; return n; })
                            : mybotFetch(`/api/routines/${r.id}/runs`).then((x) => x.json()).then((d) => setRRuns((p) => ({ ...p, [r.id]: d.runs })))}>{rRuns[r.id] ? "이력 ▴" : "이력 ▾"}</button>
                        <button className="text-stone-400 hover:text-sky-600" onClick={() => mybotFetch(`/api/routines/${r.id}/run`, { method: "POST" }).then(load)}>지금 실행</button>
                        <button className="text-stone-400 hover:text-red-600" onClick={() => mybotFetch(`/api/routines/${r.id}`, { method: "DELETE" }).then(load)}>삭제</button>
                      </div>
                      <div className="mt-0.5 truncate text-stone-500">{r.prompt}</div>
                      {r.webhook_token && (
                        <div className="mt-1 truncate text-2xs text-stone-400">
                          웹훅 URL: <code className="rounded bg-stone-100 px-1">POST /api/hooks/{r.webhook_token}</code>
                        </div>
                      )}
                      {rRuns[r.id] && (
                        <div className="mt-1.5 max-h-40 space-y-1 overflow-y-auto rounded bg-stone-50 p-1.5">
                          {rRuns[r.id]!.length === 0 && <div className="text-2xs text-stone-400">실행 이력 없음</div>}
                          {rRuns[r.id]!.map((run: any) => (
                            <div key={run.id} className="text-2xs text-stone-600">
                              <span className={run.status === "done" ? "text-emerald-600" : run.status === "error" ? "text-red-500" : "text-amber-600"}>{run.status === "done" ? "성공" : run.status === "error" ? "실패" : run.status}</span>
                              {" "}{new Date(run.created_at).toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                              {run.finished_at && <span className="text-stone-400"> · {Math.round((run.finished_at - run.created_at) / 1000)}s · {run.steps}단계</span>}
                              {(() => { try { const tl = JSON.parse(run.tool_log ?? "[]"); return tl.length ? <span className="text-stone-400"> · 도구 {tl.length}회</span> : null; } catch { return null; } })()}
                              {run.result && <div className="truncate text-stone-400">{run.result.slice(0, 120)}</div>}
                            </div>
                          ))}
                        </div>
                      )}
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
                    <select className="rounded-lg bg-stone-200 px-2 py-1.5 text-xs outline-none" value={rTrig} onChange={(e) => setRTrig(e.target.value as any)} title="트리거">
                      <option value="schedule">예약</option>
                      <option value="email">이메일 수신</option>
                      <option value="webhook">웹훅</option>
                    </select>
                    {rTrig === "schedule" && (
                      <select className="rounded-lg bg-stone-200 px-2 py-1.5 text-xs outline-none" value={rSched} onChange={(e) => setRSched(e.target.value)}>
                        <option value="every:30m">30분마다</option>
                        <option value="every:2h">2시간마다</option>
                        <option value="daily:08:00">매일 08:00</option>
                        <option value="daily:17:00">매일 17:00</option>
                      </select>
                    )}
                  </div>
                  {rTrig === "email" && (
                    <div className="flex gap-1.5">
                      <input className={`${Input} flex-1`} placeholder="발신자 필터 (선택 — 예: boss@corp.com)" value={rMailFrom} onChange={(e) => setRMailFrom(e.target.value)} />
                      <input className={`${Input} flex-1`} placeholder="제목 필터 (선택 — 예: [긴급])" value={rMailSubj} onChange={(e) => setRMailSubj(e.target.value)} />
                    </div>
                  )}
                  {rTrig === "webhook" && (
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-1.5">
                        <span className="text-2xs text-stone-500">매칭 규칙:</span>
                        <button className="rounded bg-stone-200 px-1.5 py-0.5 text-2xs hover:bg-stone-300" onClick={() => { setRMatchField("user_name"); setRMatchSender(""); setRMatchKw(""); }}>Slack 프리셋</button>
                        <button className="rounded bg-stone-200 px-1.5 py-0.5 text-2xs hover:bg-stone-300" onClick={() => { setRMatchField("sender.login"); setRMatchSender(""); setRMatchKw(""); }}>GitHub 프리셋</button>
                      </div>
                      <div className="flex gap-1.5">
                        <input className={`${Input} flex-1`} placeholder="발신자 필드 (점 경로 — Slack: user_name, GitHub: sender.login)" value={rMatchField} onChange={(e) => setRMatchField(e.target.value)} />
                        <input className={`${Input} flex-1`} placeholder="발신자 값 (선택 — 정확 일치)" value={rMatchSender} onChange={(e) => setRMatchSender(e.target.value)} />
                      </div>
                      <input className={Input} placeholder="본문 필수 키워드 (쉼표 구분 — 모두 포함돼야 발화, 비우면 전부 수신)" value={rMatchKw} onChange={(e) => setRMatchKw(e.target.value)} />
                    </div>
                  )}
                  <textarea className={Input} rows={2} placeholder="실행할 프롬프트 (예: 오늘 AI 뉴스 요약)" value={rPrompt} onChange={(e) => setRPrompt(e.target.value)} />
                  <button className={Btn} onClick={() => {
                    if (!rName.trim() || !rPrompt.trim()) return;
                    const body: any = { name: rName, prompt: rPrompt, schedule: rSched, agent_id: rAgent || undefined, trigger_type: rTrig };
                    if (rTrig === "email") body.email_filter = { from: rMailFrom || undefined, subject: rMailSubj || undefined };
                    if (rTrig === "webhook") body.match_rule = { sender_field: rMatchField || undefined, sender: rMatchSender || undefined, contains: rMatchKw.split(",").map((s) => s.trim()).filter(Boolean) };
                    mybotFetch("/api/routines", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
                      .then((r) => r.json()).then((d) => {
                        if (d.routine?.webhook_url) setHookUrl(`${location.origin}${d.routine.webhook_url}`);
                        setRName(""); setRPrompt(""); setRAgent(""); load();
                      });
                  }}>루틴 추가</button>
                  {hookUrl && (
                    <div className="rounded-lg bg-sky-50 px-2.5 py-2 text-caption text-sky-800">
                      웹훅 URL이 발급됐습니다 — 이 주소로 POST하면 루틴이 발화됩니다:
                      <code className="mt-1 block select-all break-all rounded bg-white px-2 py-1 font-mono text-2xs">{hookUrl}</code>
                    </div>
                  )}
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
                      <div key={w.id} className="rounded-lg bg-white px-2.5 py-1.5 text-xs">
                        <div className="flex items-center gap-2">
                          <Folder size={13} className="shrink-0 text-stone-500" />
                          <span>{w.name}</span>
                          <span className="flex-1 truncate text-stone-500">{w.instructions}</span>
                          <button className="text-stone-400 hover:text-stone-700" onClick={() => setWsAgentsOpen(wsAgentsOpen === w.id ? "" : w.id)}>봇 배정</button>
                          <button className="text-stone-400 hover:text-red-600" onClick={() => mybotFetch(`/api/workspaces/${w.id}`, { method: "DELETE" }).then(load)}>삭제</button>
                        </div>
                        {/* C19 — 프로젝트 배정 봇: 이 프로젝트 대화는 봇들의 공유 메모리·전용 파일 폴더를 쓴다 */}
                        <div className="mt-1 flex flex-wrap gap-1">
                          {agents.filter((a) => a.workspace_id === w.id).map((a) => (
                            <span key={a.id} className="rounded bg-sky-100 px-1.5 py-0.5 text-2xs text-sky-700">{a.name}</span>
                          ))}
                          {wsAgentsOpen === w.id && agents.map((a) => (
                            <label key={a.id} className="flex items-center gap-1 rounded bg-stone-100 px-1.5 py-0.5 text-2xs">
                              <input type="checkbox" checked={a.workspace_id === w.id} onChange={() => {
                                const cur = new Set(agents.filter((x) => x.workspace_id === w.id).map((x) => x.id));
                                if (cur.has(a.id)) cur.delete(a.id); else cur.add(a.id);
                                mybotFetch(`/api/workspaces/${w.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent_ids: [...cur] }) }).then(load);
                              }} />
                              {a.name}
                            </label>
                          ))}
                        </div>
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
                      <div key={sk.id} className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs ${sk.disabled ? "bg-stone-200 opacity-70" : "bg-white"}`}>
                        <span className="font-mono text-sky-600">/{sk.name}</span>
                        <span className="flex-1 truncate text-stone-500" title={sk.last_fail ? `최근 실패: ${sk.last_fail}` : sk.prompt}>{sk.prompt}</span>
                        {sk.run_count > 0 && (
                          <span className={`shrink-0 text-2xs ${sk.run_count && sk.ok_count / sk.run_count < 0.5 ? "text-red-500" : "text-stone-400"}`}>
                            성공 {sk.ok_count}/{sk.run_count}
                          </span>
                        )}
                        {sk.disabled ? (
                          <button className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-2xs text-amber-700 hover:bg-amber-200" title="성공률 미달로 자동 비활성됨 — 재학습 후 다시 켜세요"
                            onClick={() => mybotFetch(`/api/skills/${sk.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ disabled: false }) }).then(load)}>비활성 — 켜기</button>
                        ) : null}
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
                  <H>MCP 서버 (stdio · remote HTTP)</H>
                  <p className="mb-2 text-caption leading-relaxed text-stone-400">
                    외부 MCP 서버의 도구를 봇이 사용합니다. stdio는 로컬 명령 실행, remote는 HTTP 엔드포인트 URL입니다.
                  </p>
                  <div className="space-y-1.5">
                    {(() => { try { return JSON.parse(s.mcp_servers ?? "[]") as any[]; } catch { return []; } })().map((m: any, i: number) => (
                      <div key={i} className="flex items-center gap-2 rounded-lg bg-white px-2.5 py-1.5 text-xs">
                        <span className="font-medium">{m.name}</span>
                        <span className="flex-1 truncate text-stone-500">{m.url ? `remote: ${m.url}` : `stdio: ${m.command} ${(m.args ?? []).join(" ")}`}</span>
                        <button className="text-stone-400 hover:text-red-600" onClick={() => {
                          const list = (JSON.parse(s.mcp_servers ?? "[]") as any[]).filter((_: any, j: number) => j !== i);
                          mybotFetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mcp_servers: JSON.stringify(list) }) }).then(load);
                        }}>삭제</button>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 space-y-1.5">
                    <div className="flex gap-1.5">
                      <input className="w-28 rounded-lg bg-stone-200 px-2 py-1.5 text-xs outline-none" placeholder="서버 이름" value={mcName} onChange={(e) => setMcName(e.target.value)} />
                      <select className="rounded-lg bg-stone-200 px-2 py-1.5 text-xs outline-none" value={mcType} onChange={(e) => setMcType(e.target.value as any)}>
                        <option value="remote">remote HTTP</option>
                        <option value="stdio">stdio</option>
                      </select>
                    </div>
                    {mcType === "remote" ? (
                      <>
                        <input className={Input} placeholder="엔드포인트 URL (예: https://mcp.example.com/mcp)" value={mcUrl} onChange={(e) => setMcUrl(e.target.value)} />
                        <input className={Input} placeholder='헤더 JSON (선택 — {"Authorization":"Bearer …"})' value={mcHdrs} onChange={(e) => setMcHdrs(e.target.value)} />
                      </>
                    ) : (
                      <input className={Input} placeholder="실행 명령 (예: npx -y @modelcontextprotocol/server-everything)" value={mcCmd} onChange={(e) => setMcCmd(e.target.value)} />
                    )}
                    <button className={Btn} onClick={() => {
                      if (!mcName.trim()) return;
                      let list: any[] = []; try { list = JSON.parse(s.mcp_servers ?? "[]"); } catch {}
                      if (mcType === "remote") {
                        if (!mcUrl.trim()) return;
                        let hdrs: any; try { hdrs = mcHdrs.trim() ? JSON.parse(mcHdrs) : undefined; } catch { return; }
                        list.push({ name: mcName.trim(), url: mcUrl.trim(), headers: hdrs });
                      } else {
                        const parts = mcCmd.trim().split(/\s+/).filter(Boolean);
                        if (!parts.length) return;
                        list.push({ name: mcName.trim(), command: parts[0], args: parts.slice(1) });
                      }
                      mybotFetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mcp_servers: JSON.stringify(list) }) })
                        .then(() => { setMcName(""); setMcUrl(""); setMcHdrs(""); setMcCmd(""); load(); });
                    }}>서버 추가</button>
                  </div>
                </div>
                <div>
                  <H>페르소나</H>
                  <div className="space-y-1.5">
                    {personas.map((p) => (
                      <div key={p.id} className="flex items-center gap-2 rounded-lg bg-white px-2.5 py-1.5 text-xs">
                        <AgentIcon name={p.name} size={16} className="text-stone-500" />
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
                  <p className="mb-2 text-caption leading-relaxed text-stone-400">
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
                  <p className="mb-2 text-caption leading-relaxed text-stone-400">
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
                <div>
                  <H>시연 녹화 → 스킬</H>
                  <p className="mb-2 text-caption leading-relaxed text-stone-400">
                    녹화를 시작하면 브라우저 창이 열립니다. 그 안에서 업무를 직접 한 번 수행하면 조작이 기록돼, 봇이 재사용할 절차(스킬) 초안으로 변환됩니다. 최대 10분 — 비밀번호 입력은 자동으로 마스킹됩니다.
                  </p>
                  {recDraft ? (
                    <div className="space-y-1.5">
                      <input className={Input} placeholder="스킬 이름 (예: 다우오피스 메일 확인)" value={recDraft.name} onChange={(e) => setRecDraft({ ...recDraft, name: e.target.value })} />
                      <input className={Input} placeholder="적용 조건 — 어떤 작업에서 쓰는지" value={recDraft.trigger} onChange={(e) => setRecDraft({ ...recDraft, trigger: e.target.value })} />
                      <textarea className={`${Input} h-28 resize-y font-mono`} placeholder="절차" value={recDraft.steps} onChange={(e) => setRecDraft({ ...recDraft, steps: e.target.value })} />
                      <textarea className={`${Input} h-14 resize-y`} placeholder="주의·실패 경험" value={recDraft.notes} onChange={(e) => setRecDraft({ ...recDraft, notes: e.target.value })} />
                      <div className="flex gap-1.5">
                        <button className={Btn} onClick={() => {
                          if (!recDraft.name.trim() || !recDraft.steps.trim()) return;
                          api.saveSkill({ name: recDraft.name.trim(), prompt: `[적용 조건] ${recDraft.trigger}\n\n[절차]\n${recDraft.steps}\n\n[주의·실패 경험]\n${recDraft.notes}` })
                            .then(() => { setRecDraft(null); load(); });
                        }}>스킬로 저장</button>
                        <button className={Sub} onClick={() => setRecDraft(null)}>버리기</button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-1.5">
                      <input className={`${Input} flex-1`} placeholder="시작 URL (선택 — 예: https://mail.daouoffice.com)" value={recUrl} onChange={(e) => setRecUrl(e.target.value)} />
                      {!recActive ? (
                        <button className={Btn} disabled={recBusy} onClick={async () => {
                          setRecBusy(true);
                          try { await api.recordStart(recUrl); setRecActive(true); setRecCount(0); } catch {} setRecBusy(false);
                        }}>녹화 시작</button>
                      ) : (
                        <button className={Btn} disabled={recBusy} onClick={async () => {
                          setRecBusy(true);
                          try { const r = await api.recordStop(); setRecActive(false); setRecDraft({ name: "", ...r.draft }); } catch {} setRecBusy(false);
                        }}>중지 ({recCount}개 조작)</button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {section === "notify" && (
              <div>
                <H>결과 알림</H>
                <p className="mb-3 text-caption text-stone-400">기본은 채팅창에만 표시됩니다. 체크한 채널로 답변·루틴 결과를 함께 받습니다.</p>
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
                    {testMsg && <span className="text-caption text-stone-500">{testMsg}</span>}
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
                  <button onClick={() => setMemOpen(!memOpen)} className="mt-2 flex items-center gap-1 text-caption text-stone-500 hover:text-stone-700">
                    {memOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    {memOpen ? "접기" : `${memories.length - 5}개 더 보기`}
                  </button>
                )}
              </div>
            )}

            {section === "updates" && (
              <div>
                <H>버전 업데이트 <span className="ml-1 text-xs font-normal text-stone-500">현재 v{appVersion}</span></H>
                <p className="mb-3 text-caption text-stone-500">개발 인스턴스가 검증을 마친 개선 패키지입니다. 적용은 여기서 수동으로만 이뤄집니다.</p>
                <div className="space-y-2">
                  {updates.map((u) => {
                    const m = u.payload?.measurement;
                    const prog = updProg && updProg.id === u.id ? updProg : null;
                    const gain = m?.baseline && m?.candidate
                      ? `통과율 ${Math.round(m.baseline.passRate * 100)}%→${Math.round(m.candidate.passRate * 100)}% · 지연 ${Math.round(m.baseline.avgLatencyMs / 1000)}s→${Math.round(m.candidate.avgLatencyMs / 1000)}s`
                      : m?.reason ?? "";
                    return (
                      <div key={u.id} className="rounded-lg bg-white px-3 py-2.5 text-xs">
                        <div className="flex items-center gap-2">
                          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${{ pending: "bg-amber-100 text-amber-700", applied: "bg-emerald-100 text-emerald-700", rejected: "bg-stone-200 text-stone-500", reverted: "bg-stone-200 text-stone-500" }[u.status as string] ?? "bg-stone-200 text-stone-500"}`}>
                            {{ pending: "대기", applied: `v${u.version} 적용됨`, rejected: "거부됨", reverted: "되돌림" }[u.status as string] ?? u.status}
                          </span>
                          <span className="flex-1 font-medium text-stone-800">{u.payload?.summary}</span>
                        </div>
                        {gain && <div className="mt-1 text-caption text-stone-500">{gain}</div>}
                        <div className="mt-1 text-caption text-stone-400">{u.payload?.ops?.map((o: any) => `${o.kind === "db" ? "설정" : "코드"}:${o.target}`).join(" · ")}</div>
                        {!!u.restart_required && <div className="mt-1 text-caption text-amber-600">코드 변경 포함 — 서버 재시작 후 반영됩니다</div>}
                        <div className="mt-2 flex gap-1.5">
                          {u.status === "pending" && (
                            <>
                              <button disabled={updBusy} onClick={() => updAct(u.id, () => api.applyUpdate(u.id), true)}
                                className="rounded-md bg-stone-900 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-stone-700 disabled:opacity-40">업데이트 적용</button>
                              <button disabled={updBusy} onClick={() => updAct(u.id, () => api.rejectUpdate(u.id))}
                                className="rounded-md bg-stone-200 px-2.5 py-1 text-[11px] text-stone-600 hover:bg-stone-300 disabled:opacity-40">거부</button>
                            </>
                          )}
                          {u.status === "applied" && (
                            <button disabled={updBusy} onClick={() => updAct(u.id, () => api.revertUpdate(u.id))}
                              className="rounded-md bg-stone-200 px-2.5 py-1 text-[11px] text-stone-600 hover:bg-stone-300 disabled:opacity-40">이 버전 되돌리기</button>
                          )}
                        </div>
                        {prog && (
                          <div className="mt-2">
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-stone-200">
                              <div className={`h-full rounded-full transition-all duration-200 ${prog.pct >= 100 ? "bg-emerald-500" : "bg-stone-700"}`} style={{ width: `${prog.pct}%` }} />
                            </div>
                            <div className="mt-1 text-[10px] text-stone-500">{prog.pct >= 100 ? "적용 완료" : "업데이트 적용 중…"}</div>
                          </div>
                        )}
                        {!!updErr[u.id] && <div className="mt-1.5 text-[11px] font-medium text-red-600">{updErr[u.id]}</div>}
                      </div>
                    );
                  })}
                  {!updates.length && <p className="text-xs text-stone-400">수신된 업데이트가 없습니다 — 개발 인스턴스에서 검증된 개선이 생기면 여기에 표시됩니다</p>}
                </div>
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
          <div className="flex items-center gap-3 border-t border-stone-200 px-4 pb-[max(0.625rem,env(safe-area-inset-bottom))] pt-2.5 md:px-5 md:py-3">
            <button onClick={saveAll} className="h-10 rounded-lg bg-stone-900 px-5 text-xs font-semibold text-white hover:bg-stone-700 md:h-8 md:px-4">저장</button>
            {dirty && <span className="text-caption text-amber-600">저장되지 않은 변경 사항 있음</span>}
            {savedMsg && <span className="text-caption text-emerald-600">{savedMsg}</span>}
            <button onClick={onClose} className="ml-auto h-10 rounded-lg px-3 text-xs text-stone-500 hover:bg-stone-100 hover:text-stone-800 md:h-8">닫기</button>
          </div>
        </div>
      </div>
    </div>
  );
}
