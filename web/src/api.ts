export interface Model {
  id: string;
  label: string;
  provider: string;
  providerName: string;
  virtual?: boolean;
  vision: boolean;
  reasoning: boolean;
  image: boolean;
}

export interface Endpoint {
  id: string;
  name: string;
  baseUrl: string;
  builtin: boolean;
  hasKey: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  model: string | null;
  mode: string;
  agent_id?: string | null;
  agent_name?: string | null;
  agent_avatar?: string | null;
  created_at: number;
  updated_at: number;
}

export interface Message {
  id: string;
  conversation_id: string;
  parent_id: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  reasoning: string | null;
  model: string | null;
  search_meta: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  attachments: string | null;
  created_at: number;
  sibling_count?: number;
  sibling_index?: number;
}

export function authHeaders(): Record<string, string> {
  const k = localStorage.getItem("mybot_key");
  return k ? { "x-mybot-key": k } : {};
}

export function mybotFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = { ...authHeaders(), ...(init.headers as Record<string, string> ?? {}) };
  return fetch(input, { ...init, headers }).then((r) => {
    if (r.status === 401) {
      const k = prompt("MyBot 접속 암호를 입력하세요");
      if (k) {
        localStorage.setItem("mybot_key", k);
        const h2 = { ...authHeaders(), ...(init.headers as Record<string, string> ?? {}) };
        return fetch(input, { ...init, headers: h2 });
      }
    }
    return r;
  });
}

const j = (r: Response) => {
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
};

export const api = {
  health: () => mybotFetch("/api/health").then(j),
  models: () => mybotFetch("/api/models").then(j) as Promise<{ models: Model[]; endpoints: Endpoint[] }>,
  conversations: () => mybotFetch("/api/chat/conversations").then(j) as Promise<{ conversations: Conversation[] }>,
  conversation: (id: string) => mybotFetch(`/api/chat/conversations/${id}`).then(j) as Promise<{ conversation: Conversation; messages: Message[] }>,
  renameConversation: (id: string, patch: { title?: string; model?: string }) =>
    mybotFetch(`/api/chat/conversations/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).then(j),
  deleteConversation: (id: string) => mybotFetch(`/api/chat/conversations/${id}`, { method: "DELETE" }).then(j),
  selectMessage: (id: string) => mybotFetch(`/api/chat/messages/${id}/select`, { method: "POST" }).then(j) as Promise<{ messages: Message[] }>,
  addEndpoint: (ep: { id: string; name?: string; baseUrl: string; apiKey?: string }) =>
    mybotFetch("/api/models/endpoints", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ep) }).then(j),
  deleteEndpoint: (id: string) => mybotFetch(`/api/models/endpoints/${id}`, { method: "DELETE" }).then(j),
  agents: () => mybotFetch("/api/agents").then(j) as Promise<{ agents: Agent[] }>,
  addAgent: (a: { name: string; role_prompt: string; model?: string; avatar?: string }) =>
    mybotFetch("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(a) }).then(j),
  updateAgent: (id: string, patch: Partial<Agent>) =>
    mybotFetch(`/api/agents/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).then(j),
  deleteAgent: (id: string) => mybotFetch(`/api/agents/${id}`, { method: "DELETE" }).then(j),
  setAgentBoss: (id: string) => mybotFetch(`/api/agents/${id}/boss`, { method: "POST" }).then(j),
  sites: () => mybotFetch("/api/sites").then(j) as Promise<{ sites: SiteLogin[] }>,
  addSite: (s: { name: string; url: string; username: string; password: string; request_id?: string }) =>
    mybotFetch("/api/sites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s) }).then(j),
  deleteSite: (id: string) => mybotFetch(`/api/sites/${id}`, { method: "DELETE" }).then(j),
  siteRequests: () => mybotFetch("/api/sites/requests").then(j) as Promise<{ requests: SiteRequest[] }>,
  dismissSiteRequest: (id: string) => mybotFetch(`/api/sites/requests/${id}/dismiss`, { method: "POST" }).then(j),
};

export interface SiteRequest {
  id: string;
  name: string;
  url: string | null;
  reason: string | null;
  created_at: number;
}

export interface Agent {
  id: string;
  name: string;
  role_prompt: string;
  model: string | null;
  model_label?: string;
  avatar: string | null;
  persistent: number;
  is_boss: number;
  is_lead: number;
  created_at: number;
}

export interface SiteLogin {
  id: string;
  name: string;
  url: string;
  username: string;
  created_at: number;
}

export interface StreamHandlers {
  onConversation?: (id: string) => void;
  onUserMessage?: (m: Message) => void;
  onAssistantMessage?: (m: Message) => void;
  onDelta?: (id: string, text: string) => void;
  onReasoning?: (id: string, text: string) => void;
  onSearch?: (ev: any) => void;
  onTeam?: (ev: any) => void;
  onDone?: (m: Message) => void;
  onTitle?: (conv: Conversation) => void;
  onError?: (msg: string) => void;
}

async function ssePost(url: string, body: unknown, handlers: StreamHandlers, signal?: AbortSignal) {
  const res = await mybotFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`스트림 실패: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        const data = JSON.parse(line.slice(5));
        switch (event) {
          case "conversation": handlers.onConversation?.(data.id); break;
          case "user_message": handlers.onUserMessage?.(data.message); break;
          case "assistant_message": handlers.onAssistantMessage?.(data.message); break;
          case "delta": handlers.onDelta?.(data.id, data.text); break;
          case "reasoning": handlers.onReasoning?.(data.id, data.text); break;
          case "search": handlers.onSearch?.(data); break;
          case "team": handlers.onTeam?.(data); break;
          case "done": handlers.onDone?.(data.message); break;
          case "title": handlers.onTitle?.(data.conversation); break;
          case "error": handlers.onError?.(data.message); break;
        }
      } else if (line === "" || line === "\r") {
        event = "";
      }
    }
  }
}

export function streamChat(
  body: { conversationId?: string; content?: string; model: string; mode?: string; regenerateMessageId?: string; parentMessageId?: string; attachments?: { url: string; name: string; mime: string }[]; personaId?: string; workspaceId?: string; agentId?: string },
  handlers: StreamHandlers,
  signal?: AbortSignal,
) {
  return ssePost("/api/chat/stream", body, handlers, signal);
}

export interface TeamPlanTask {
  name?: string; avatar?: string; role?: string; task: string; model?: string; agent?: string; existing?: boolean;
}

// 승인된 팀 계획 실행
export function runTeam(
  body: { conversationId: string; messageId: string; tasks: TeamPlanTask[]; model?: string },
  handlers: StreamHandlers,
  signal?: AbortSignal,
) {
  return ssePost("/api/team/run", body, handlers, signal);
}
