import { useEffect, useState } from "react";
import { api, type Endpoint, type Agent, type Model, type SiteLogin, mybotFetch } from "../api";
import { X, Crown, AlarmClock, Trash2, Folder } from "lucide-react";
import { AgentIcon } from "./icons";

export function SettingsModal({ endpoints, models, onClose }: { endpoints: Endpoint[]; models: Model[]; onClose: () => void }) {
  const [s, setS] = useState<Record<string, string>>({});
  const [memories, setMemories] = useState<any[]>([]);
  const [personas, setPersonas] = useState<any[]>([]);
  const [epId, setEpId] = useState("");
  const [epUrl, setEpUrl] = useState("");
  const [epKey, setEpKey] = useState("");
  const [pName, setPName] = useState("");
  const [pPrompt, setPPrompt] = useState("");
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [skills, setSkills] = useState<any[]>([]);
  const [routines, setRoutines] = useState<any[]>([]);
  const [wName, setWName] = useState("");
  const [wInst, setWInst] = useState("");
  const [skName, setSkName] = useState("");
  const [skPrompt, setSkPrompt] = useState("");
  const [rName, setRName] = useState("");
  const [rPrompt, setRPrompt] = useState("");
  const [rSched, setRSched] = useState("daily:08:00");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [aName, setAName] = useState("");
  const [aRole, setARole] = useState("");
  const [aModel, setAModel] = useState("");
  const [rAgent, setRAgent] = useState("");
  const [brUrl, setBrUrl] = useState("");
  const [sites, setSites] = useState<SiteLogin[]>([]);
  const [siteName, setSiteName] = useState("");
  const [siteUrl, setSiteUrl] = useState("");
  const [siteUser, setSiteUser] = useState("");
  const [sitePass, setSitePass] = useState("");
  const [testMsg, setTestMsg] = useState("");

  const testNotify = (channel: string) => {
    setTestMsg("발송 중…");
    mybotFetch("/api/notify/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel }) })
      .then(async (r) => setTestMsg(r.ok ? `${channel === "telegram" ? "텔레그램" : "메일"} 테스트 발송 성공` : `실패: ${(await r.json()).error}`))
      .catch((e) => setTestMsg(`실패: ${e.message}`));
  };

  const load = () => {
    mybotFetch("/api/settings").then((r) => r.json()).then((d) => { setS(d.settings); setMemories(d.memories); setPersonas(d.personas); });
    mybotFetch("/api/workspaces").then((r) => r.json()).then((d) => setWorkspaces(d.workspaces));
    mybotFetch("/api/skills").then((r) => r.json()).then((d) => setSkills(d.skills));
    mybotFetch("/api/routines").then((r) => r.json()).then((d) => setRoutines(d.routines));
    mybotFetch("/api/agents").then((r) => r.json()).then((d) => setAgents(d.agents));
    api.sites().then((d) => setSites(d.sites));
  };
  useEffect(() => { load(); }, []);

  const [dirty, setDirty] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");

  // 입력은 로컬 상태만 변경 — "저장" 버튼을 눌러야 서버에 반영
  const update = (patch: Record<string, string>) => {
    setS((p) => ({ ...p, ...patch }));
    setDirty(true);
  };

  const saveAll = () => {
    mybotFetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s) })
      .then((r) => {
        if (r.ok) { setDirty(false); setSavedMsg("✓ 저장됨"); setTimeout(() => setSavedMsg(""), 1500); }
        else setSavedMsg("저장 실패");
      });
  };

  const Field = ({ k, label, ph }: { k: string; label: string; ph?: string }) => (
    <label className="block">
      <span className="text-xs text-zinc-400">{label}</span>
      <input
        className="mt-1 w-full rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs outline-none"
        value={s[k] ?? ""}
        placeholder={ph}
        onChange={(e) => update({ [k]: e.target.value })}
      />
    </label>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">설정</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200"><X size={16} /></button>
        </div>

        <section className="mb-5">
          <h3 className="mb-2 text-xs font-semibold text-zinc-400 uppercase">모델 엔드포인트</h3>
          {endpoints.map((e) => (
            <div key={e.id} className="mb-1 flex items-center gap-2 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-xs">
              <span className="font-medium">{e.name}</span>
              <span className="truncate text-zinc-500">{e.baseUrl}</span>
              {!e.builtin && (
                <button className="ml-auto text-zinc-600 hover:text-red-400" onClick={() => api.deleteEndpoint(e.id).then(onClose)}>삭제</button>
              )}
            </div>
          ))}
          <div className="mt-2 flex gap-1.5">
            <input className="w-24 rounded-lg bg-zinc-800 px-2 py-1.5 text-xs outline-none" placeholder="이름" value={epId} onChange={(e) => setEpId(e.target.value)} />
            <input className="flex-1 rounded-lg bg-zinc-800 px-2 py-1.5 text-xs outline-none" placeholder="http://host:port/v1" value={epUrl} onChange={(e) => setEpUrl(e.target.value)} />
            <input className="w-28 rounded-lg bg-zinc-800 px-2 py-1.5 text-xs outline-none" placeholder="API키(선택)" value={epKey} onChange={(e) => setEpKey(e.target.value)} />
            <button
              className="rounded-lg bg-zinc-100 px-2.5 text-xs font-medium text-zinc-900"
              onClick={() => { if (epId && epUrl) { api.addEndpoint({ id: epId, name: epId, baseUrl: epUrl, apiKey: epKey || undefined }); setEpId(""); setEpUrl(""); setEpKey(""); onClose(); } }}
            >추가</button>
          </div>
          <p className="mt-1 text-[10px] text-zinc-600">Ollama: http://127.0.0.1:11434/v1 · LM Studio: http://127.0.0.1:1234/v1</p>
          <label className="mt-3 block">
            <span className="text-xs text-zinc-400">기본 AI 모델 — 새 봇에 자동 적용</span>
            <select
              className="mt-1 w-full rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs outline-none"
              value={s.default_model ?? ""}
              onChange={(e) => update({ default_model: e.target.value })}
            >
              <option value="">서버 기본 (subagent)</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            <span className="mt-0.5 block text-[10px] text-zinc-600">인증된 엔드포인트의 모델만 선택할 수 있습니다 — 목록에 없으면 엔드포인트를 먼저 추가하세요</span>
          </label>
        </section>

        <section className="mb-5 space-y-2.5">
          <h3 className="text-xs font-semibold text-zinc-400 uppercase">DeepSearch 검색 백엔드</h3>
          <select
            className="w-full rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs outline-none"
            value={s.search_provider ?? "auto"}
            onChange={(e) => update({ search_provider: e.target.value })}
          >
            <option value="auto">자동 (설정된 것 우선, 없으면 Bing)</option>
            <option value="searxng">SearXNG (셀프호스트)</option>
            <option value="tavily">Tavily API</option>
            <option value="brave">Brave Search API</option>
            <option value="bing">Bing (키 불필요)</option>
            <option value="ddg">DuckDuckGo (차단 빈번)</option>
          </select>
          <Field k="searxng_url" label="SearXNG URL" ph="http://127.0.0.1:8080" />
          <Field k="tavily_key" label="Tavily API 키" />
          <Field k="brave_key" label="Brave API 키" />
        </section>

        <section className="mb-5 space-y-2.5">
          <h3 className="text-xs font-semibold text-zinc-400 uppercase">이미지 생성</h3>
          <Field k="image_endpoint" label="Images API 엔드포인트" ph="http://127.0.0.1:11441/v1 또는 Draw Things http://127.0.0.1:7888" />
          <Field k="image_key" label="이미지 API 키(선택)" />
          <Field k="image_model" label="이미지 모델" ph="dall-e-3 / flux 등" />
        </section>

        <section className="mb-5">
          <h3 className="mb-2 text-xs font-semibold text-zinc-400 uppercase">시스템 프롬프트</h3>
          <textarea
            className="w-full rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs outline-none" rows={3}
            value={s.system_prompt ?? ""}
            onChange={(e) => update({ system_prompt: e.target.value })}
          />
        </section>

        <section className="mb-5">
          <h3 className="mb-2 text-xs font-semibold text-zinc-400 uppercase">페르소나</h3>
          {personas.map((p) => (
            <div key={p.id} className="mb-1 flex items-center gap-2 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-xs">
              <AgentIcon name={p.name} size={13} className="text-zinc-500" />
              <span>{p.name}</span>
              <span className="flex-1 truncate text-zinc-500">{p.prompt || "(기본)"}</span>
              {!p.builtin && (
                <button className="text-zinc-600 hover:text-red-400" onClick={() => mybotFetch(`/api/personas/${p.id}`, { method: "DELETE" }).then(load)}>삭제</button>
              )}
            </div>
          ))}
          <div className="mt-2 space-y-1.5">
            <input className="w-full rounded-lg bg-zinc-800 px-2 py-1.5 text-xs outline-none" placeholder="페르소나 이름" value={pName} onChange={(e) => setPName(e.target.value)} />
            <textarea className="w-full rounded-lg bg-zinc-800 px-2 py-1.5 text-xs outline-none" rows={2} placeholder="행동 지침 (예: 유머러스하게 답변한다)" value={pPrompt} onChange={(e) => setPPrompt(e.target.value)} />
            <button
              className="rounded-lg bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-900"
              onClick={() => {
                if (!pName.trim()) return;
                mybotFetch("/api/personas", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: pName, prompt: pPrompt, avatar: "" }) }).then(() => { setPName(""); setPPrompt(""); load(); });
              }}
            >페르소나 추가</button>
          </div>
        </section>

        <section className="mb-5">
          <h3 className="mb-2 text-xs font-semibold text-zinc-400 uppercase">워크스페이스</h3>
          {workspaces.map((w) => (
            <div key={w.id} className="mb-1 flex items-center gap-2 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-xs">
              <Folder size={13} className="shrink-0 text-zinc-500" />
              <span>{w.name}</span>
              <span className="flex-1 truncate text-zinc-500">{w.instructions}</span>
              <button className="text-zinc-600 hover:text-red-400" onClick={() => mybotFetch(`/api/workspaces/${w.id}`, { method: "DELETE" }).then(load)}>삭제</button>
            </div>
          ))}
          <div className="mt-2 space-y-1.5">
            <input className="w-full rounded-lg bg-zinc-800 px-2 py-1.5 text-xs outline-none" placeholder="워크스페이스 이름" value={wName} onChange={(e) => setWName(e.target.value)} />
            <textarea className="w-full rounded-lg bg-zinc-800 px-2 py-1.5 text-xs outline-none" rows={2} placeholder="이 워크스페이스의 모든 대화에 적용할 지침" value={wInst} onChange={(e) => setWInst(e.target.value)} />
            <button className="rounded-lg bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-900" onClick={() => {
              if (!wName.trim()) return;
              mybotFetch("/api/workspaces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: wName, instructions: wInst }) }).then(() => { setWName(""); setWInst(""); load(); });
            }}>워크스페이스 추가</button>
          </div>
        </section>

        <section className="mb-5">
          <h3 className="mb-2 text-xs font-semibold text-zinc-400 uppercase">스킬 (/명령)</h3>
          {skills.map((sk) => (
            <div key={sk.id} className="mb-1 flex items-center gap-2 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-xs">
              <span className="font-mono text-sky-300">/{sk.name}</span>
              <span className="flex-1 truncate text-zinc-500">{sk.prompt}</span>
              <button className="text-zinc-600 hover:text-red-400" onClick={() => mybotFetch(`/api/skills/${sk.id}`, { method: "DELETE" }).then(load)}>삭제</button>
            </div>
          ))}
          <div className="mt-2 space-y-1.5">
            <input className="w-full rounded-lg bg-zinc-800 px-2 py-1.5 text-xs outline-none" placeholder="스킬 이름 (예: 요약)" value={skName} onChange={(e) => setSkName(e.target.value)} />
            <textarea className="w-full rounded-lg bg-zinc-800 px-2 py-1.5 text-xs outline-none" rows={2} placeholder="프롬프트 (입력 뒤에 붙는 지침)" value={skPrompt} onChange={(e) => setSkPrompt(e.target.value)} />
            <button className="rounded-lg bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-900" onClick={() => {
              if (!skName.trim()) return;
              mybotFetch("/api/skills", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: skName, prompt: skPrompt }) }).then(() => { setSkName(""); setSkPrompt(""); load(); });
            }}>스킬 추가</button>
          </div>
        </section>

        <section className="mb-5">
          <h3 className="mb-2 text-xs font-semibold text-zinc-400 uppercase">루틴 (예약 실행)</h3>
          {routines.map((r) => (
            <div key={r.id} className="mb-1 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-xs">
              <div className="flex items-center gap-2">
                <button onClick={() => mybotFetch(`/api/routines/${r.id}/toggle`, { method: "POST" }).then(load)} className={r.enabled ? "text-emerald-400" : "text-zinc-600"}>{r.enabled ? "●" : "○"}</button>
                <span className="font-medium">{r.name}</span>
                <span className="text-zinc-500">{r.schedule}</span>
                {r.agent_id && (
                  <span className="flex items-center gap-1 text-zinc-600">
                    <AgentIcon name={agents.find((a) => a.id === r.agent_id)?.name} seed={agents.find((a) => a.id === r.agent_id)?.avatar} size={12} />
                    {agents.find((a) => a.id === r.agent_id)?.name ?? "봇"}
                  </span>
                )}
                <button className="ml-auto text-zinc-600 hover:text-sky-400" onClick={() => mybotFetch(`/api/routines/${r.id}/run`, { method: "POST" }).then(load)}>지금 실행</button>
                <button className="text-zinc-600 hover:text-red-400" onClick={() => mybotFetch(`/api/routines/${r.id}`, { method: "DELETE" }).then(load)}>삭제</button>
              </div>
              <div className="mt-0.5 truncate text-zinc-500">{r.prompt}</div>
            </div>
          ))}
          <div className="mt-2 space-y-1.5">
            <div className="flex gap-1.5">
              <input className="flex-1 rounded-lg bg-zinc-800 px-2 py-1.5 text-xs outline-none" placeholder="루틴 이름" value={rName} onChange={(e) => setRName(e.target.value)} />
              <select className="rounded-lg bg-zinc-800 px-2 py-1.5 text-xs outline-none" value={rAgent} onChange={(e) => setRAgent(e.target.value)} title="담당 봇 (선택 시 그 봇의 역할·모델로 실행, 팀 모드에서 재사용 제외)">
                <option value="">담당 봇 없음</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              <select className="rounded-lg bg-zinc-800 px-2 py-1.5 text-xs outline-none" value={rSched} onChange={(e) => setRSched(e.target.value)}>
                <option value="every:30m">30분마다</option>
                <option value="every:2h">2시간마다</option>
                <option value="daily:08:00">매일 08:00</option>
                <option value="daily:17:00">매일 17:00</option>
              </select>
            </div>
            <textarea className="w-full rounded-lg bg-zinc-800 px-2 py-1.5 text-xs outline-none" rows={2} placeholder="예약 실행할 프롬프트 (예: 오늘 AI 뉴스 요약)" value={rPrompt} onChange={(e) => setRPrompt(e.target.value)} />
            <button className="rounded-lg bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-900" onClick={() => {
              if (!rName.trim() || !rPrompt.trim()) return;
              mybotFetch("/api/routines", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: rName, prompt: rPrompt, schedule: rSched, agent_id: rAgent || undefined }) }).then(() => { setRName(""); setRPrompt(""); setRAgent(""); load(); });
            }}>루틴 추가</button>
          </div>
        </section>

        <section className="mb-5">
          <h3 className="mb-2 text-xs font-semibold text-zinc-400 uppercase">에이전트 봇</h3>
          <p className="mb-2 text-[11px] text-zinc-600">CEO로 지정된 봇이 모든 봇의 관리자입니다 — 사용자 지시를 받아 작업을 직접 수행하거나 다른 봇에게 분배·관리합니다. 입력창의 "팀" 칩을 켜면 CEO가 작업을 분해해 계획을 제시합니다.</p>
          {agents.map((a) => (
            <div key={a.id} className="mb-1 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-xs">
              <div className="flex items-center gap-2">
                <AgentIcon name={a.name} seed={a.avatar} size={14} className="shrink-0" />
                <span className="font-medium">{a.name}</span>
                {a.is_boss ? (
                  <span className="flex items-center gap-0.5 rounded bg-amber-900/50 px-1 text-[9px] text-amber-300" title="모든 봇의 관리자"><Crown size={9} /> CEO</span>
                ) : (
                  <button className="rounded bg-zinc-800 px-1 text-[9px] text-zinc-500 hover:text-amber-300" title="이 봇을 CEO로 지정" onClick={() => api.setAgentBoss(a.id).then(load)}>CEO 지정</button>
                )}
                <select
                  className="max-w-[140px] truncate rounded bg-zinc-800 px-1 py-0.5 text-[10px] text-zinc-400 outline-none"
                  value={a.model ?? ""}
                  title={a.model_label ?? a.model ?? ""}
                  onChange={(e) => api.updateAgent(a.id, { model: e.target.value }).then(load)}
                >
                  {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  {a.model && !models.find((m) => m.id === a.model) && <option value={a.model}>{a.model}</option>}
                </select>
                {routines.some((r) => r.agent_id === a.id && r.enabled) && (
                  <span className="flex items-center gap-0.5 rounded bg-amber-900/50 px-1 text-[9px] text-amber-300" title="예약 루틴 담당 — 팀 모드에서 재사용 안 함"><AlarmClock size={9} /> 루틴</span>
                )}
                {!a.is_boss && (
                  <button className="ml-auto text-zinc-600 hover:text-red-400" onClick={() => mybotFetch(`/api/agents/${a.id}`, { method: "DELETE" }).then(load)}><Trash2 size={12} /></button>
                )}
              </div>
              <div className="mt-0.5 truncate text-zinc-500">{a.role_prompt}</div>
            </div>
          ))}
          {!agents.length && <p className="text-xs text-zinc-600">아직 봇이 없습니다 — 팀 모드로 지시하면 CEO가 자동 생성합니다</p>}
          <div className="mt-2 space-y-1.5">
            <div className="flex gap-1.5">
              <input className="flex-1 rounded-lg bg-zinc-800 px-2 py-1.5 text-xs outline-none" placeholder="봇 이름 (예: 리서치봇)" value={aName} onChange={(e) => setAName(e.target.value)} />
              <select className="w-32 rounded-lg bg-zinc-800 px-2 py-1.5 text-xs outline-none" value={aModel} onChange={(e) => setAModel(e.target.value)} title="비우면 기본 AI 모델 적용">
                <option value="">기본 모델</option>
                {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </div>
            <textarea className="w-full rounded-lg bg-zinc-800 px-2 py-1.5 text-xs outline-none" rows={2} placeholder="역할 지침 (예: 웹 검색으로 자료를 수집하고 출처를 정리한다)" value={aRole} onChange={(e) => setARole(e.target.value)} />
            <button className="rounded-lg bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-900" onClick={() => {
              if (!aName.trim()) return;
              api.addAgent({ name: aName, role_prompt: aRole, model: aModel || undefined, avatar: "" }).then(() => { setAName(""); setARole(""); setAModel(""); load(); });
            }}>봇 추가</button>
          </div>
        </section>

        <section className="mb-5 space-y-2.5">
          <h3 className="text-xs font-semibold text-zinc-400 uppercase">결과 알림</h3>
          <p className="text-[11px] text-zinc-600">기본은 채팅창에만 표시됩니다. 체크한 채널로 답변·루틴 결과를 함께 받습니다.</p>
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            <input type="checkbox" checked={s.notify_telegram === "1"} onChange={(e) => update({ notify_telegram: e.target.checked ? "1" : "0" })} />
            답변을 텔레그램으로도 받기
          </label>
          <Field k="telegram_bot_token" label="텔레그램 봇 토큰" ph="@BotFather에서 발급 (123456:ABC…)" />
          <Field k="telegram_chat_id" label="텔레그램 채팅 ID" ph="봇에게 말 건 뒤 getUpdates로 확인" />
          <label className="flex items-center gap-2 text-xs text-zinc-400">
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
          <div className="flex items-center gap-2">
            <button className="rounded-lg bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-700" onClick={() => testNotify("telegram")}>텔레그램 테스트</button>
            <button className="rounded-lg bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-700" onClick={() => testNotify("email")}>메일 테스트</button>
            {testMsg && <span className="text-[11px] text-zinc-500">{testMsg}</span>}
          </div>
        </section>

        <section className="mb-5">
          <h3 className="mb-2 text-xs font-semibold text-zinc-400 uppercase">브라우저 (봇이 사용)</h3>
          <p className="mb-2 text-[11px] text-zinc-600">
            팀 모드 봇이 쓰는 내장 Chromium입니다. "열기"를 누르면 맥미니 화면에 창이 뜨니,
            거기서 x.com 등에 한 번 로그인해 두면 봇이 그 세션을 그대로 사용합니다.
          </p>
          <div className="flex gap-1.5">
            <input
              className="flex-1 rounded-lg bg-zinc-800 px-2 py-1.5 text-xs outline-none"
              placeholder="열 URL (기본 x.com)"
              value={brUrl}
              onChange={(e) => setBrUrl(e.target.value)}
            />
            <button
              className="rounded-lg bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-900"
              onClick={() => mybotFetch("/api/browser/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: brUrl || "https://x.com" }) })}
            >로그인 창 열기</button>
            <button
              className="rounded-lg bg-zinc-800 px-2.5 py-1 text-xs text-zinc-400"
              onClick={() => mybotFetch("/api/browser/close", { method: "POST" })}
            >닫기</button>
          </div>
        </section>

        <section className="mb-5">
          <h3 className="mb-2 text-xs font-semibold text-zinc-400 uppercase">사이트 계정 (봇 자동 로그인)</h3>
          <p className="mb-2 text-[11px] text-zinc-600">
            회사 그룹웨어처럼 로그인이 필요한 사이트의 계정을 등록하면, 봇이 브라우저로 자동 로그인해 메일·결재 목록 등을 가져옵니다.
            비밀번호는 로컬 DB에만 저장되고 모델에는 노출되지 않습니다.
          </p>
          {sites.map((st) => (
            <div key={st.id} className="mb-1 flex items-center gap-2 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-xs">
              <span className="font-medium">{st.name}</span>
              <span className="truncate text-zinc-500">{st.url}</span>
              <span className="text-zinc-600">{st.username}</span>
              <button className="ml-auto text-zinc-600 hover:text-red-400" onClick={() => api.deleteSite(st.id).then(load)}><Trash2 size={12} /></button>
            </div>
          ))}
          <div className="mt-2 space-y-1.5">
            <div className="flex gap-1.5">
              <input className="w-28 rounded-lg bg-zinc-800 px-2 py-1.5 text-xs outline-none" placeholder="사이트 이름" value={siteName} onChange={(e) => setSiteName(e.target.value)} />
              <input className="flex-1 rounded-lg bg-zinc-800 px-2 py-1.5 text-xs outline-none" placeholder="로그인 URL" value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} />
            </div>
            <div className="flex gap-1.5">
              <input className="flex-1 rounded-lg bg-zinc-800 px-2 py-1.5 text-xs outline-none" placeholder="아이디" value={siteUser} onChange={(e) => setSiteUser(e.target.value)} />
              <input className="flex-1 rounded-lg bg-zinc-800 px-2 py-1.5 text-xs outline-none" type="password" placeholder="비밀번호" value={sitePass} onChange={(e) => setSitePass(e.target.value)} />
              <button className="rounded-lg bg-zinc-100 px-2.5 text-xs font-medium text-zinc-900" onClick={() => {
                if (!siteName.trim() || !siteUrl.trim() || !siteUser.trim() || !sitePass) return;
                api.addSite({ name: siteName, url: siteUrl, username: siteUser, password: sitePass }).then(() => { setSiteName(""); setSiteUrl(""); setSiteUser(""); setSitePass(""); load(); });
              }}>등록</button>
            </div>
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold text-zinc-400 uppercase">메모리 ({memories.length})</h3>
          {memories.map((m) => (
            <div key={m.id} className="mb-1 flex items-center gap-2 text-xs text-zinc-400">
              <span className="flex-1 truncate">{m.content}</span>
              <button className="text-zinc-600 hover:text-red-400" onClick={() => {
                mybotFetch(`/api/settings/memories/${m.id}`, { method: "DELETE" }).then(() => setMemories(memories.filter((x) => x.id !== m.id)));
              }}>삭제</button>
            </div>
          ))}
          {!memories.length && <p className="text-xs text-zinc-600">아직 기억된 정보가 없습니다</p>}
          <label className="mt-2 flex items-center gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={(s.memory_enabled ?? "1") !== "0"}
              onChange={(e) => update({ memory_enabled: e.target.checked ? "1" : "0" })}
            />
            대화에서 기억할 정보 자동 추출
          </label>
          <div className="mt-3">
            <Field k="access_code" label="접속 암호 (설정 시 API 전체에 필요)" ph="비워두면 LAN 개방" />
          </div>
        </section>

        <div className="sticky bottom-0 -mx-5 -mb-5 mt-2 flex items-center gap-3 border-t border-zinc-800 bg-zinc-950 px-5 py-3">
          <button
            onClick={saveAll}
            className="rounded-lg bg-zinc-100 px-4 py-1.5 text-xs font-semibold text-zinc-900 hover:bg-white"
          >저장</button>
          {dirty && <span className="text-[11px] text-amber-400">저장되지 않은 변경 사항 있음</span>}
          {savedMsg && <span className="text-[11px] text-emerald-400">{savedMsg}</span>}
          <button onClick={onClose} className="ml-auto text-xs text-zinc-500 hover:text-zinc-200">닫기</button>
        </div>
      </div>
    </div>
  );
}
