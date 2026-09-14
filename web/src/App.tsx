import { useCallback, useEffect, useRef, useState } from "react";
import { api, streamChat, mybotFetch, type Conversation, type Endpoint, type Message, type Model } from "./api";
import { Sidebar } from "./components/Sidebar";
import { Composer, type Mode, type Persona } from "./components/Composer";
import { MessageItem } from "./components/MessageItem";
import { SearchTrace, type SearchEvent } from "./components/SearchTrace";
import { SettingsModal } from "./components/SettingsModal";

export default function App() {
  const [models, setModels] = useState<Model[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [personaId, setPersonaId] = useState<string>("");
  const [workspaces, setWorkspaces] = useState<{id:string;name:string}[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [skills, setSkills] = useState<{id:string;name:string;prompt:string}[]>([]);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [model, setModel] = useState<string>("main");
  const [streaming, setStreaming] = useState(false);
  const [searchEvents, setSearchEvents] = useState<SearchEvent[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const refreshConversations = useCallback(() => {
    api.conversations().then((d) => setConversations(d.conversations));
  }, []);

  useEffect(() => {
    api.models().then((d) => {
      setModels(d.models);
      setEndpoints(d.endpoints);
      if (d.models.length && !d.models.find((m) => m.id === "main")) setModel(d.models[0].id);
    }).catch(() => {});
    mybotFetch("/api/personas").then((r) => r.json()).then((d) => {
      setPersonas(d.personas);
      const def = d.personas.find((p: Persona) => p.name === "기본");
      if (def) setPersonaId(def.id);
    }).catch(() => {});
    mybotFetch("/api/workspaces").then((r) => r.json()).then((d) => setWorkspaces(d.workspaces)).catch(() => {});
    mybotFetch("/api/skills").then((r) => r.json()).then((d) => setSkills(d.skills)).catch(() => {});
    refreshConversations();
  }, [refreshConversations]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, searchEvents]);

  const loadConversation = useCallback((id: string) => {
    setConvId(id);
    api.conversation(id).then((d) => {
      setMessages(d.messages);
      if (d.conversation.model) setModel(d.conversation.model);
    });
  }, []);

  const newConversation = useCallback(() => {
    setConvId(null);
    setMessages([]);
    setSearchEvents([]);
  }, []);

  const patchMessage = useCallback((id: string, patch: Partial<Message>) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }, []);

  const send = useCallback((text: string, mode: Mode, attachments: { url: string; name: string; mime: string }[]) => {
    if (streaming) return;
    setStreaming(true);
    setSearchEvents([]);
    const abort = new AbortController();
    abortRef.current = abort;

    streamChat(
      { conversationId: convId ?? undefined, content: text, model, mode, attachments, personaId, workspaceId: workspaceId || undefined },
      {
        onConversation: (id) => {
          if (!convId) setConvId(id);
        },
        onUserMessage: (m) => setMessages((prev) => [...prev, m]),
        onAssistantMessage: (m) => setMessages((prev) => [...prev, m]),
        onDelta: (id, t) => setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content: m.content + t } : m))),
        onReasoning: (id, t) => setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, reasoning: (m.reasoning ?? "") + t } : m))),
        onSearch: (ev) => setSearchEvents((prev) => [...prev, ev]),
        onDone: (m) => {
          patchMessage(m.id, m);
          setStreaming(false);
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
            content: `⚠ 오류: ${msg}`, reasoning: null, model: null, search_meta: null, attachments: null,
            tokens_in: null, tokens_out: null, created_at: Date.now(),
          }]);
        },
      },
      abort.signal,
    ).catch((e) => {
      if (e.name !== "AbortError") {
        setMessages((prev) => [...prev, {
          id: "err" + Date.now(), conversation_id: convId ?? "", parent_id: null, role: "assistant",
          content: `⚠ 연결 오류: ${e.message}`, reasoning: null, model: null, search_meta: null, attachments: null,
          tokens_in: null, tokens_out: null, created_at: Date.now(),
        }]);
      }
      setStreaming(false);
    });
  }, [convId, model, streaming, patchMessage, refreshConversations]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
  }, []);

  const regenerate = useCallback((m: Message) => {
    if (streaming || m.role !== "assistant") return;
    setStreaming(true);
    const abort = new AbortController();
    abortRef.current = abort;
    streamChat(
      { conversationId: m.conversation_id, model, mode: "auto", regenerateMessageId: m.id },
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
  }, [model, streaming]);

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
        { conversationId: m.conversation_id, content, model, mode: "auto", parentMessageId: m.parent_id ?? undefined },
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
  }, [model, streaming]);

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
        conversations={workspaceId ? conversations.filter((c) => (c as any).workspace_id === workspaceId) : conversations}
        currentId={convId}
        onSelect={loadConversation}
        onNew={newConversation}
        onDelete={(id) => {
          api.deleteConversation(id).then(() => {
            refreshConversations();
            if (convId === id) newConversation();
          });
        }}
        onOpenSettings={() => setSettingsOpen(true)}
        open={sidebarOpen}
        workspaces={workspaces}
        workspaceId={workspaceId}
        onWorkspaceChange={setWorkspaceId}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-zinc-800/60 px-4 py-2.5">
          <button className="text-zinc-500 hover:text-zinc-200" onClick={() => setSidebarOpen(!sidebarOpen)}>☰</button>
          <span className="text-sm text-zinc-400 truncate">
            {convId ? conversations.find((c) => c.id === convId)?.title ?? "대화" : "새 대화"}
          </span>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-4 py-6">
            {empty && (
              <div className="mt-[20vh] text-center">
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-100 text-2xl font-bold text-zinc-900">M</div>
                <h1 className="text-xl font-semibold text-zinc-200">무엇이든 물어보세요</h1>
                <p className="mt-2 text-sm text-zinc-500">
                  {models.length ? `${models.length}개 모델 연결됨 · DeepSearch·Think·이미지 지원` : "모델 엔드포인트를 확인하세요"}
                </p>
                <div className="mt-6 grid grid-cols-2 gap-2 max-w-lg mx-auto text-left">
                  {["오늘 주요 뉴스를 DeepSearch로 요약해줘", "이 코드의 시간복잡도를 분석해줘", "한국어 시를 하나 지어줘", "최신 LLM 동향을 조사해줘"].map((s) => (
                    <button key={s} onClick={() => send(s, s.includes("DeepSearch") || s.includes("조사") ? "deepsearch" : "auto", [])}
                      className="rounded-xl border border-zinc-800 px-3 py-2.5 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 text-left">
                      {s}
                    </button>
                  ))}
                </div>
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
                />
              ))}
              {searchEvents.length > 0 && (
                <SearchTrace events={searchEvents} done={!streaming} />
              )}
            </div>
          </div>
        </div>

        <div className="px-4 pb-4 pt-1">
          <div className="mx-auto max-w-3xl">
            <Composer models={models} model={model} onModelChange={setModel} onSend={send} onStop={stop} streaming={streaming} personas={personas} personaId={personaId} onPersonaChange={setPersonaId} skills={skills} />
          </div>
        </div>
      </main>
      {settingsOpen && <SettingsModal endpoints={endpoints} onClose={() => { setSettingsOpen(false); api.models().then((d) => { setModels(d.models); setEndpoints(d.endpoints); }); }} />}
    </div>
  );
}
