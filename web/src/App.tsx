import { useCallback, useEffect, useRef, useState } from "react";
import { api, streamChat, runTeam, mybotFetch, type Agent, type Conversation, type Message, type Model, type TeamPlanTask, type SiteRequest, type Group, type ApprovalRequest } from "./api";
import { Sidebar } from "./components/Sidebar";
import { Composer, type Mode, type Persona } from "./components/Composer";
import { MessageItem } from "./components/MessageItem";
import { SearchTrace, type SearchEvent } from "./components/SearchTrace";
import { TeamTrace, type TeamEvent } from "./components/TeamTrace";
import { SettingsModal } from "./components/SettingsModal";
import { CredentialModal } from "./components/CredentialModal";
import { ApprovalModal } from "./components/ApprovalModal";
import { BotLobby } from "./components/BotLobby";
import { Menu, Crown } from "lucide-react";
import { AgentIcon } from "./components/icons";
import { WorkingStatus } from "./components/WorkingStatus";

export default function App() {
  const [models, setModels] = useState<Model[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [personaId, setPersonaId] = useState<string>("");
  const [workspaces, setWorkspaces] = useState<{id:string;name:string}[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [skills, setSkills] = useState<{id:string;name:string;prompt:string}[]>([]);
  
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [model, setModel] = useState<string>("main");
  const [streaming, setStreaming] = useState(false);
  const [searchEvents, setSearchEvents] = useState<SearchEvent[]>([]);
  const [teamEvents, setTeamEvents] = useState<TeamEvent[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 768); // 모바일은 닫힌 채 시작
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false); // 봇 목록 로드 완료 전엔 "봇 없음" UI를 띄우지 않음
  const [routineAgentIds, setRoutineAgentIds] = useState<Set<string>>(new Set());
  const [pendingAgent, setPendingAgent] = useState<Agent | null>(null); // 새 세션을 담당할 봇 (첫 전송 시 귀속)
  const [defaultModel, setDefaultModel] = useState(""); // 설정의 기본 AI 모델 — 새 봇의 기본값
  const [createSignal, setCreateSignal] = useState(0); // 로비의 생성 마법사를 여는 신호 ("+ 새 봇")
  const [credRequests, setCredRequests] = useState<SiteRequest[]>([]); // 봇이 요청한 계정 입력 대기열
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]); // 봇의 위험 액션 승인 대기열
  const [groups, setGroups] = useState<Group[]>([]); // 그룹채팅 목록
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null); // 현재 열린 그룹 대화
  const [runningInfo, setRunningInfo] = useState<Record<string, string | null>>({}); // 서버에서 실행 중인 봇: id → 현재 도구 — 사이드바 실시간 작업 표시용
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true); // 사용자가 하단 근처를 보고 있을 때만 자동 스크롤 — 위쪽 읽기 중엔 위치 고정
  const [showJump, setShowJump] = useState(false); // 위를 읽는 중 새 콘텐츠 도착 시 "최신으로" 버튼
  // 응답 스트리밍 중 전송된 명령 대기열 — 현재 응답이 끝나면 순서대로 자동 전송 ("1번→2번→3번" 연속 지시)
  const [queued, setQueued] = useState<{ text: string; mode: Mode; attachments: { url: string; name: string; mime: string }[] }[]>([]);

  const refreshConversations = useCallback(() => {
    api.conversations().then((d) => setConversations(d.conversations)).catch(() => {});
  }, []);

  const refreshAgents = useCallback(() => {
    api.agents().then((d) => { setAgents(d.agents); setAgentsLoaded(true); }).catch(() => {});
    mybotFetch("/api/routines").then((r) => r.json())
      .then((d) => setRoutineAgentIds(new Set<string>((d.routines ?? []).filter((r: any) => r.enabled && r.agent_id).map((r: any) => r.agent_id))))
      .catch(() => {});
  }, []);

  // 설정 변경은 봇·루틴·모델·페르소나 전반에 영향 — 모달 닫을 때 전부 다시 불러와 새로고침 없이 반영
  const reloadAll = useCallback(() => {
    api.models().then((d) => setModels(d.models)).catch(() => {});
    mybotFetch("/api/settings").then((r) => r.json()).then((d) => setDefaultModel(d.settings?.default_model ?? "")).catch(() => {});
    mybotFetch("/api/personas").then((r) => r.json()).then((d) => setPersonas(d.personas)).catch(() => {});
    refreshConversations();
    refreshAgents();
  }, [refreshConversations, refreshAgents]);

  useEffect(() => {
    api.models().then((d) => {
      setModels(d.models);

      if (d.models.length && !d.models.find((m) => m.id === model)) setModel(d.models[0].id);
    }).catch(() => {});
    mybotFetch("/api/personas").then((r) => r.json()).then((d) => {
      setPersonas(d.personas);
      const def = d.personas.find((p: Persona) => p.name === "기본");
      if (def) setPersonaId(def.id);
    }).catch(() => {});
    mybotFetch("/api/workspaces").then((r) => r.json()).then((d) => setWorkspaces(d.workspaces)).catch(() => {});
    mybotFetch("/api/skills").then((r) => r.json()).then((d) => setSkills(d.skills)).catch(() => {});
    api.groups().then((d) => setGroups(d.groups)).catch(() => {});
    mybotFetch("/api/settings").then((r) => r.json()).then((d) => setDefaultModel(d.settings?.default_model ?? "")).catch(() => {});
    refreshConversations();
    refreshAgents();
  }, [refreshConversations, refreshAgents]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    nearBottomRef.current = near;
    if (near) setShowJump(false);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (nearBottomRef.current) el.scrollTo({ top: el.scrollHeight });
    else setShowJump(true);
  }, [messages, searchEvents]);

  // 봇이 request_credentials로 요청한 계정 입력을 주기적으로 확인해 팝업 표시
  useEffect(() => {
    const poll = () => api.siteRequests().then((d) => setCredRequests(d.requests)).catch(() => {});
    poll();
    const t = setInterval(poll, 8000);
    return () => clearInterval(t);
  }, []);

  // 승인 경계 — 위험 액션 승인 대기열을 폴링해 팝업 표시
  useEffect(() => {
    const poll = () => api.approvals().then((d) => setApprovals(d.requests)).catch(() => {});
    poll();
    const t = setInterval(poll, 6000);
    return () => clearInterval(t);
  }, []);

  // 실행 중인 봇 폴링 — 위임·루틴 등 백그라운드 작업도 사이드바에 표시
  useEffect(() => {
    const poll = () => api.agentsRunning().then((d) => setRunningInfo(Object.fromEntries(d.running.map((r) => [r.id, r.tool])))).catch(() => {});
    poll();
    const t = setInterval(poll, 4000);
    return () => clearInterval(t);
  }, []);

  // 백그라운드 봇의 회신·완료 보고를 열린 대화에 실시간 반영 — 각 봇이 끝나는 순서대로 메시지가 도착.
  // 회신 기록이 run 종료보다 늦을 수 있어(normalizeReport LLM 호출) 유휴 중엔 항상 4초 주기로 읽되,
  // 변화가 없으면 같은 배열을 반환해 스크롤 점프를 막는다.
  useEffect(() => {
    if (streaming || !convId) return;
    api.conversation(convId).then((d) => {
      setMessages((prev) => {
        const last = prev[prev.length - 1], lastD = d.messages[d.messages.length - 1];
        if (prev.length === d.messages.length && last?.id === lastD?.id && last?.content === lastD?.content) return prev;
        const ids = new Set(d.messages.map((m) => m.id));
        return [...d.messages, ...prev.filter((m) => m.id.startsWith("err") && !ids.has(m.id))];
      });
    }).catch(() => {});
  }, [runningInfo, convId, streaming]);

  const loadConversation = useCallback((id: string) => {
    setConvId(id);
    setPendingAgent(null);
    refreshConversations(); // 목록이 오래돼 현재 대화가 없으면 담당 봇 칩이 안 뜸 — 열 때마다 갱신
    api.conversation(id).then((d) => {
      setMessages(d.messages);
      if (d.conversation.model) setModel(d.conversation.model);
    }).catch(() => {
      setMessages([{ // 로드 실패가 조용히 지나가지 않게 명시 — 서버 재시작 중 열기 등
        id: "err" + Date.now(), conversation_id: id, parent_id: null, role: "assistant",
        content: "⚠️ 대화를 불러오지 못했습니다 — 서버 연결을 확인한 뒤 다시 시도해 주세요.", reasoning: null, model: null, search_meta: null, attachments: null,
        tokens_in: null, tokens_out: null, created_at: Date.now(),
      }]);
    });
  }, [refreshConversations]);

  const newConversation = useCallback(() => {
    setConvId(null);
    setPendingAgent(null);
    setMessages([]);
    setSearchEvents([]);
    setTeamEvents([]);
  }, []);

  // 봇 선택 = 그 봇의 메인 세션으로 진입 — 루틴 단발 대화가 아닌 메인 세션(위임·루틴 작업 내역이 쌓이는 곳)
  const selectBot = useCallback((a: Agent) => {
    setActiveGroupId(null);
    const latest = conversations.find((c) => c.agent_id === a.id && c.mode !== "routine") ?? conversations.find((c) => c.agent_id === a.id);
    if (latest) loadConversation(latest.id);
    else { newConversation(); setPendingAgent(a); }
    if (window.innerWidth < 768) setSidebarOpen(false);
  }, [conversations, loadConversation, newConversation]);

  // 그룹 선택 = 그룹 대화로 진입 — 없으면 서버가 대화를 새로 만듦
  const selectGroup = useCallback((g: Group) => {
    setPendingAgent(null);
    api.groupConversation(g.id).then((d) => {
      setActiveGroupId(g.id);
      refreshConversations();
      loadConversation(d.conversation_id);
    }).catch(() => {});
    if (window.innerWidth < 768) setSidebarOpen(false);
  }, [loadConversation, refreshConversations]);

  const createGroup = useCallback((name: string, agentIds: string[]) => {
    api.createGroup(name, agentIds).then((d) => {
      setGroups((prev) => [...prev, d.group]);
      selectGroup(d.group);
    }).catch(() => {});
  }, [selectGroup]);

  // 현재 세션의 담당 봇 — 있으면 모델 피커는 봇의 모델을 보여주고 변경 시 봇에 저장됨
  const currentConv = conversations.find((c) => c.id === convId) ?? null;
  const activeAgent = pendingAgent ?? agents.find((a) => a.id === currentConv?.agent_id) ?? null;
  const effectiveModel = activeAgent?.model ?? model;

  const changeModel = useCallback((id: string) => {
    if (activeAgent) {
      // 봇의 모델 변경 = 봇 설정에 영구 반영
      setAgents((prev) => prev.map((a) => (a.id === activeAgent.id ? { ...a, model: id } : a)));
      if (pendingAgent?.id === activeAgent.id) setPendingAgent((p) => (p ? { ...p, model: id } : p));
      api.updateAgent(activeAgent.id, { model: id }).then(refreshAgents).catch(() => {});
    } else setModel(id);
  }, [activeAgent, pendingAgent, refreshAgents]);

  const patchMessage = useCallback((id: string, patch: Partial<Message>) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }, []);

  const send = useCallback(async (text: string, mode: Mode, attachments: { url: string; name: string; mime: string }[]) => {
    if (streaming) {
      // 응답 진행 중 보낸 명령은 대기열에 쌓음 — 응답 완료 후 순서대로 자동 전송
      setQueued((prev) => [...prev, { text, mode, attachments }]);
      return;
    }
    // "/new" — 현재 봇의 새 세션 시작. 이전 세션은 삭제되지 않고 요약만 이어받아 맥락 유지 (계정·키값은 봇 장기기억이 보존)
    const newMatch = text.trim().match(/^\/new(?:\s+([\s\S]*))?$/);
    if (newMatch) {
      const agent = pendingAgent ?? agents.find((a) => a.id === currentConv?.agent_id) ?? agents.find((a) => a.is_boss) ?? null;
      const d = await api.createConversation({ agentId: agent?.id, from_conv: convId ?? undefined }).catch(() => null);
      if (!d) return;
      setConvId(d.conversation.id); setPendingAgent(null);
      setMessages([]); setSearchEvents([]); setTeamEvents([]);
      refreshConversations();
      const rest = (newMatch[1] ?? "").trim();
      if (rest) send(rest, mode, attachments);
      return;
    }
    // 봇 미선택 상태에서 전송 → CEO(관리자) 봇, 없으면 첫 봇의 세션으로 라우팅. 봇이 아예 없으면 전송 불가
    let sendConvId = convId;
    let sendAgent = pendingAgent;
    if (!sendConvId && !sendAgent) {
      sendAgent = agents.find((a) => a.is_boss) ?? agents[0] ?? null;
      if (!sendAgent) return;
      const existing = conversations.find((c) => c.agent_id === sendAgent!.id);
      if (existing) {
        sendConvId = existing.id;
        setConvId(existing.id);
        try { const d = await api.conversation(existing.id); setMessages(d.messages); } catch {}
      } else setPendingAgent(sendAgent);
    }
    setStreaming(true);
    setSearchEvents([]);
    setTeamEvents([]);
    const abort = new AbortController();
    abortRef.current = abort;

    streamChat(
      { conversationId: sendConvId ?? undefined, content: text, model: effectiveModel, mode, attachments, personaId, workspaceId: workspaceId || undefined, agentId: sendConvId ? undefined : sendAgent?.id },
      {
        onConversation: (id) => {
          if (!sendConvId) { setConvId(id); setPendingAgent(null); }
        },
        onUserMessage: (m) => setMessages((prev) => [...prev, m]),
        onAssistantMessage: (m) => setMessages((prev) => [...prev, m]),
        onDelta: (id, t) => setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content: m.content + t } : m))),
        onReasoning: (id, t) => setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, reasoning: (m.reasoning ?? "") + t } : m))),
        onSearch: (ev) => setSearchEvents((prev) => [...prev, ev]),
        onTeam: (ev) => setTeamEvents((prev) => [...prev, ev]),
        onDone: (m) => {
          patchMessage(m.id, m);
          setStreaming(false);
          refreshAgents(); // 봇이 새 봇을 만들었을 수 있음
        },
        onTitle: (conv) => {
          setConversations((prev) => {
            const i = prev.findIndex((c) => c.id === conv.id);
            if (i >= 0) {
              const next = [...prev];
              next[i] = conv;
              return next;
            }
            return [conv, ...prev];
          });
          refreshConversations();
        },
        onError: (msg) => {
          setStreaming(false);
          setMessages((prev) => [...prev, {
            id: "err" + Date.now(), conversation_id: convId ?? "", parent_id: null, role: "assistant",
            content: `오류: ${msg}`, reasoning: null, model: null, search_meta: null, attachments: null,
            tokens_in: null, tokens_out: null, created_at: Date.now(),
          }]);
        },
      },
      abort.signal,
    ).catch((e) => {
      if (e.name !== "AbortError") {
        setMessages((prev) => [...prev, {
          id: "err" + Date.now(), conversation_id: convId ?? "", parent_id: null, role: "assistant",
          content: `연결 오류: ${e.message}`, reasoning: null, model: null, search_meta: null, attachments: null,
          tokens_in: null, tokens_out: null, created_at: Date.now(),
        }]);
      }
      setStreaming(false);
    });
  }, [convId, currentConv, effectiveModel, streaming, patchMessage, refreshConversations, refreshAgents, pendingAgent, agents, conversations, personaId, workspaceId]);

  // 스트리밍이 끝나면 대기 중인 명령을 한 건씩 자동 전송 — 다음 건은 다시 스트리밍이 끝날 때 전송
  useEffect(() => {
    if (!streaming && queued.length) {
      const [next, ...rest] = queued;
      setQueued(rest);
      send(next.text, next.mode, next.attachments);
    }
  }, [streaming, queued, send]);

  const stop = useCallback(() => {
    setQueued([]);
    abortRef.current?.abort();
    setStreaming(false);
  }, []);

  const regenerate = useCallback((m: Message) => {
    if (streaming || m.role !== "assistant") return;
    setStreaming(true);
    const abort = new AbortController();
    abortRef.current = abort;
    streamChat(
      { conversationId: m.conversation_id, model: effectiveModel, mode: "auto", regenerateMessageId: m.id },
      {
        onAssistantMessage: (nm) => setMessages((prev) => [...prev.filter((x) => x.id !== m.id), nm]),
        onDelta: (id, t) => setMessages((prev) => prev.map((x) => (x.id === id ? { ...x, content: x.content + t } : x))),
        onReasoning: (id, t) => setMessages((prev) => prev.map((x) => (x.id === id ? { ...x, reasoning: (x.reasoning ?? "") + t } : x))),
        onDone: (nm) => {
          setMessages((prev) => {
            const i = prev.findIndex((x) => x.id === nm.id);
            const next = i >= 0 ? [...prev.slice(0, i), nm, ...prev.slice(i + 1)] : prev;
            // 재생성 후 활성 경로 다시 로드해 형제 인덱스 반영
            api.conversation(m.conversation_id).then((d) => setMessages(d.messages));
            return next;
          });
          setStreaming(false);
        },
        onError: () => setStreaming(false),
      },
      abort.signal,
    ).catch(() => setStreaming(false));
  }, [effectiveModel, streaming]);

  const editMessage = useCallback((m: Message, content: string) => {
    // 편집 = 새 형제 메시지로 전송
    if (streaming) return;
    setStreaming(true);
    const abort = new AbortController();
    abortRef.current = abort;
    // 서버에 편집 메시지 생성 요청 후 스트림
    mybotFetch(`/api/chat/messages/${m.id}/edit`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }),
    }).then(() => {
      streamChat(
        { conversationId: m.conversation_id, content, model: effectiveModel, mode: "auto", parentMessageId: m.parent_id ?? undefined },
        {
          onUserMessage: () => {},
          onAssistantMessage: (nm) => setMessages((prev) => [...prev, nm]),
          onDelta: (id, t) => setMessages((prev) => prev.map((x) => (x.id === id ? { ...x, content: x.content + t } : x))),
          onReasoning: (id, t) => setMessages((prev) => prev.map((x) => (x.id === id ? { ...x, reasoning: (x.reasoning ?? "") + t } : x))),
          onDone: () => {
            api.conversation(m.conversation_id).then((d) => setMessages(d.messages));
            setStreaming(false);
          },
          onError: () => setStreaming(false),
        },
        abort.signal,
      );
    });
  }, [effectiveModel, streaming]);

  // 팀 계획 승인 → 선택된 봇들로 실행 (같은 assistant 메시지에 결과 스트리밍)
  const teamConfirm = useCallback((m: Message, tasks: TeamPlanTask[]) => {
    if (streaming) return;
    setStreaming(true);
    const abort = new AbortController();
    abortRef.current = abort;
    // 첫 델타에서 안내 문구를 답변으로 교체
    let started = false;
    runTeam(
      { conversationId: m.conversation_id, messageId: m.id, tasks, model: effectiveModel },
      {
        onTeam: (ev) => setTeamEvents((prev) => [...prev, ev]),
        onDelta: (id, t) => {
          const first = !started;
          started = true;
          setMessages((prev) => prev.map((x) => (x.id === id ? { ...x, content: first ? t : x.content + t } : x)));
        },
        onDone: (nm) => { patchMessage(nm.id, nm); setStreaming(false); },
        onError: (msg) => {
          setStreaming(false);
          setMessages((prev) => [...prev, {
            id: "err" + Date.now(), conversation_id: m.conversation_id, parent_id: null, role: "assistant",
            content: `오류: ${msg}`, reasoning: null, model: null, search_meta: null, attachments: null,
            tokens_in: null, tokens_out: null, created_at: Date.now(),
          }]);
        },
      },
      abort.signal,
    ).catch(() => setStreaming(false));
  }, [effectiveModel, streaming, patchMessage]);

  // 팀 계획 취소 → 메타만 cancelled로
  const teamCancel = useCallback((m: Message) => {
    mybotFetch(`/api/chat/messages/${m.id}/meta`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meta: { status: "cancelled" } }),
    }).then((r) => r.json()).then((d) => patchMessage(m.id, d.message));
  }, [patchMessage]);

  const selectSibling = useCallback((m: Message, dir: -1 | 1) => {
    // 형제 목록에서 이전/다음 선택: 부모의 자식들 중에서 이동 — 서버가 활성 경로 반환
    mybotFetch(`/api/chat/messages/${m.id}/select`, { method: "POST" }).then((r) => r.json()).then((d) => {
      setMessages(d.messages);
    });
    void dir;
  }, []);

  const empty = messages.length === 0;

  return (
    <div className="flex h-full">
      <Sidebar
        agents={agents}
        groups={groups}
        activeAgentId={activeAgent?.id ?? null}
        activeGroupId={activeGroupId}
        onSelectBot={selectBot}
        onSelectGroup={selectGroup}
        onCreateGroup={createGroup}
        onNew={() => { newConversation(); setCreateSignal((s) => s + 1); if (window.innerWidth < 768) setSidebarOpen(false); }}
        onOpenSettings={() => setSettingsOpen(true)}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        workingId={streaming ? activeAgent?.id ?? null : null}
        working={runningInfo}
      />
      <main className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-stone-200/60 px-3 py-2 sm:px-4 sm:py-2.5">
          <button className="-ml-1 p-1.5 text-stone-500 hover:text-stone-800" onClick={() => setSidebarOpen(!sidebarOpen)}><Menu size={16} strokeWidth={1.8} /></button>
          <span className="text-sm text-stone-600 truncate">
            {convId ? currentConv?.agent_name ?? currentConv?.title ?? "세션" : pendingAgent ? `${pendingAgent.name}와의 새 세션` : "봇 선택"}
          </span>
          {!convId && pendingAgent && (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-stone-200 px-2 py-0.5 text-[11px] text-stone-600">
              {!!pendingAgent.is_boss && <Crown size={10} className="text-amber-600" />}
              <AgentIcon name={pendingAgent.name} seed={pendingAgent.avatar} size={11} /> {pendingAgent.name}
              <button className="ml-0.5 text-stone-400 hover:text-stone-700" onClick={() => setPendingAgent(null)}>×</button>
            </span>
          )}
          {convId && currentConv?.agent_name && (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-stone-200 px-2 py-0.5 text-[11px] text-stone-600" title="이 세션을 담당하는 봇 — 모델을 바꿔도 봇의 기억·맥락은 유지됩니다">
              <AgentIcon name={currentConv.agent_name} seed={currentConv.agent_avatar} size={11} /> {currentConv.agent_name}
            </span>
          )}
        </header>

        <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-4 py-6">
            {/* 봇 로비는 "세션 없음"일 때만 — convId가 있는 빈 세션(새 대화·/new)까지 덮으면 봇 선택이 풀린 것처럼 보임 */}
            {empty && !convId && !pendingAgent && (
              <BotLobby agents={agents} agentsLoaded={agentsLoaded} models={models} defaultModel={defaultModel} routineAgentIds={routineAgentIds} createSignal={createSignal} onSelect={selectBot} onRefresh={refreshAgents} />
            )}
            {empty && convId && (
              <div className="mt-[25vh] text-center">
                {currentConv?.agent_name && (
                  <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-stone-200 text-stone-700">
                    <AgentIcon name={currentConv.agent_name} seed={currentConv.agent_avatar} size={22} />
                  </div>
                )}
                <h1 className="font-display text-2xl font-semibold text-stone-900">{currentConv?.agent_name ?? currentConv?.title ?? "새 세션"}</h1>
                <p className="mt-1 text-xs text-stone-500">이 봇에게 업무를 지시하세요</p>
              </div>
            )}
            {empty && !convId && pendingAgent && (
              <div className="mt-[25vh] text-center">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-stone-200 text-stone-700">
                  <AgentIcon name={pendingAgent.name} seed={pendingAgent.avatar} size={22} />
                </div>
                <h1 className="font-display text-2xl font-semibold text-stone-900">{pendingAgent.name}</h1>
                <p className="mt-1 text-xs text-stone-500 max-w-md mx-auto">{pendingAgent.role_prompt || "이 봇에게 업무를 지시하세요"}</p>
                <p className="mt-0.5 font-mono text-[10px] text-stone-400">{pendingAgent.model_label ?? pendingAgent.model}</p>
              </div>
            )}
            <div className="space-y-6">
              {messages.map((m) => (
                <MessageItem
                  key={m.id}
                  m={m}
                  streaming={streaming && m === messages[messages.length - 1]}
                  onRegenerate={regenerate}
                  onEdit={editMessage}
                  onSelectSibling={selectSibling}
                  onTeamConfirm={teamConfirm}
                  onTeamCancel={teamCancel}
                />
              ))}
              {streaming && (
                <div className="rounded-xl border border-stone-200/60 bg-white/30 px-4 py-2.5">
                  <WorkingStatus events={searchEvents} agent={activeAgent} />
                </div>
              )}
              {searchEvents.length > 0 && (
                <SearchTrace events={searchEvents} done={!streaming} />
              )}
              {teamEvents.length > 0 && (
                <TeamTrace events={teamEvents} done={!streaming} />
              )}
            </div>
          </div>
        </div>

        {/* 위쪽을 읽는 동안 새 메시지·회신이 도착하면 표시 — 누르면 최신으로 이동 */}
        {showJump && (
          <button
            onClick={() => { nearBottomRef.current = true; setShowJump(false); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }}
            className="absolute bottom-32 left-1/2 z-10 -translate-x-1/2 rounded-full border border-stone-200 bg-white px-3.5 py-1.5 text-xs font-medium text-stone-600 shadow-[0_4px_16px_rgba(0,0,0,0.08)] hover:bg-stone-50"
          >↓ 새 내용 — 최신으로</button>
        )}

        {/* 봇이 하나도 없으면 입력창 없음 — 첫 화면은 봇 생성부터 */}
        {(!agentsLoaded || agents.length > 0 || convId || pendingAgent) && (
          <div className="px-3 pt-1 sm:px-4 pb-[calc(3.5rem+env(safe-area-inset-bottom))]">
            <div className="mx-auto max-w-3xl">
              <Composer models={models} model={effectiveModel} onModelChange={changeModel} onSend={send} onStop={stop} streaming={streaming} queued={queued} onRemoveQueued={(i) => setQueued((prev) => prev.filter((_, j) => j !== i))} personas={personas} personaId={personaId} onPersonaChange={setPersonaId} skills={skills} />
            </div>
          </div>
        )}
      </main>
      {settingsOpen && <SettingsModal models={models} onClose={() => { setSettingsOpen(false); reloadAll(); }} />}
      {credRequests[0] && (
        <CredentialModal
          request={credRequests[0]}
          onDone={() => setCredRequests((prev) => prev.filter((r) => r.id !== credRequests[0].id))}
        />
      )}
      {!credRequests[0] && approvals[0] && (
        <ApprovalModal
          request={approvals[0]}
          onDone={() => setApprovals((prev) => prev.filter((r) => r.id !== approvals[0].id))}
        />
      )}
    </div>
  );
}
