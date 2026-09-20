export interface Model {
  id: string;            // "provider/model" 형식
  label: string;
  provider: string;
  providerName: string;
  tools?: boolean;
  vision: boolean;
  reasoning: boolean;
  image: boolean;
}

export interface ProviderCard {
  id: string;
  name: string;
  kind: string;
  authType: "apikey" | "oauth" | "cli" | "none";
  authLabel: string;
  doc?: string;
  custom?: boolean;
  enabled: boolean;
  authed: boolean;
  source?: string | null;   // 자격증명 출처: 설정|opencode|codex|gemini|keychain|env|cli|로컬
  expired?: boolean;
  hasManualKey?: boolean;
  baseUrl?: string;
  staticModels: string[];
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
  full_content?: string | null;
  reasoning: string | null;
  model: string | null;
  search_meta: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  attachments: string | null;
  created_at: number;
  sibling_count?: number;
  sibling_index?: number;
  command_status?: "running" | "waiting_approval" | "waiting_children" | "completed" | "interrupted";
}

export function authHeaders(): Record<string, string> {
  const k = localStorage.getItem("mybot_key");
  return k ? { "x-mybot-key": k } : {};
}

// SSE over fetch keeps the access code out of URLs and proxy logs.
export class AuthenticatedEventStream extends EventTarget {
  onerror: (() => void) | null = null;
  private closed = false;
  private controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private url: string) { super(); void this.connect(); }
  close() { this.closed = true; clearTimeout(this.timer); this.controller.abort(); }
  private async connect() {
    try {
      const response = await fetch(this.url, { headers: authHeaders(), signal: this.controller.signal });
      if (!response.ok || !response.body) throw new Error("stream unavailable");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "", event = "message", data: string[] = [];
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end).replace(/\r$/, ""); buffer = buffer.slice(end + 1);
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
            else if (!line) {
              if (data.length) this.dispatchEvent(new MessageEvent(event, { data: data.join("\n") }));
              event = "message"; data = [];
            }
          }
        }
      } finally { reader.releaseLock(); }
    } catch { if (!this.closed) this.onerror?.(); }
    if (!this.closed) this.timer = setTimeout(() => void this.connect(), 3000);
  }
}

export function mybotFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = { ...authHeaders(), ...(init.headers as Record<string, string> ?? {}) };
  return fetch(input, { ...init, headers }).then((r) => {
    if (r.status === 401 || r.status === 503) window.dispatchEvent(new Event("mybot-auth-required"));
    return r;
  });
}

const j = async (r: Response) => {
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${r.status}`);
  }
  return r.json();
};

export const api = {
  health: () => mybotFetch("/api/health").then(j),
  models: () => mybotFetch("/api/models").then(j) as Promise<{ models: Model[] }>,
  providers: () => mybotFetch("/api/models/providers").then(j) as Promise<{ providers: ProviderCard[] }>,
  testProvider: (id: string) => mybotFetch(`/api/models/providers/${id}/test`, { method: "POST" }).then(j) as Promise<{ ok: boolean; ms?: number; detail?: string; error?: string }>,
  setProviderKey: (id: string, key: string) => mybotFetch(`/api/models/providers/${id}/key`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) }).then(j),
  reauthProvider: (id: string) => mybotFetch(`/api/models/providers/${id}/reauth`, { method: "POST" }).then(j) as Promise<{ ok: boolean; method?: string; detail?: string; error?: string; needsKey?: boolean }>,
  toggleProvider: (id: string) => mybotFetch(`/api/models/providers/${id}/toggle`, { method: "POST" }).then(j),
  addCustomProvider: (p: { id: string; name?: string; baseUrl: string; apiKey?: string; models?: string[] }) =>
    mybotFetch("/api/models/providers/custom", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) }).then(j),
  deleteCustomProvider: (id: string) => mybotFetch(`/api/models/providers/custom/${id}`, { method: "DELETE" }).then(j),
  conversations: () => mybotFetch("/api/chat/conversations").then(j) as Promise<{ conversations: Conversation[] }>,
  conversation: (id: string) => mybotFetch(`/api/chat/conversations/${id}`).then(j) as Promise<{ conversation: Conversation; messages: Message[] }>,
  renameConversation: (id: string, patch: { title?: string; model?: string }) =>
    mybotFetch(`/api/chat/conversations/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).then(j),
  deleteConversation: (id: string) => mybotFetch(`/api/chat/conversations/${id}`, { method: "DELETE" }).then(j),
  createConversation: (body: { agentId?: string; model?: string; from_conv?: string }) =>
    mybotFetch("/api/chat/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(j) as Promise<{ conversation: Conversation }>,
  selectMessage: (id: string) => mybotFetch(`/api/chat/messages/${id}/select`, { method: "POST" }).then(j) as Promise<{ messages: Message[] }>,

  agents: () => mybotFetch("/api/agents").then(j) as Promise<{ agents: Agent[] }>,
  agentsRunning: () => mybotFetch("/api/agents/running").then(j) as Promise<{ running: { id: string; tool: string | null }[] }>,
  stopAllRuns: () => mybotFetch("/api/agents/stop-all", { method: "POST" }).then(j) as Promise<{ ok: boolean; stopped: { runs: number; chats: number; messages: number } }>,
  addAgent: (a: { name: string; role_prompt: string; model?: string; avatar?: string }) =>
    mybotFetch("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(a) }).then(j),
  updateAgent: (id: string, patch: Partial<Agent>) =>
    mybotFetch(`/api/agents/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).then(j),
  deleteAgent: (id: string) => mybotFetch(`/api/agents/${id}`, { method: "DELETE" }).then(j),
  setAgentBoss: (id: string) => mybotFetch(`/api/agents/${id}/boss`, { method: "POST" }).then(j),
  sites: () => mybotFetch("/api/sites").then(j) as Promise<{ sites: SiteLogin[] }>,
  addSite: (s: { name: string; url: string; username: string; password: string; success_check?: string; request_id?: string }) =>
    mybotFetch("/api/sites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s) }).then(j),
  deleteSite: (id: string) => mybotFetch(`/api/sites/${id}`, { method: "DELETE" }).then(j),
  siteRequests: () => mybotFetch("/api/sites/requests").then(j) as Promise<{ requests: SiteRequest[] }>,
  dismissSiteRequest: (id: string) => mybotFetch(`/api/sites/requests/${id}/dismiss`, { method: "POST" }).then(j),
  // 테이크오버 — 봇이 사람에게 넘긴 브라우저 인계 대기열
  handoffs: () => mybotFetch("/api/browser/handoffs").then(j) as Promise<{ requests: HandoffRequest[] }>,
  handoffDone: (id: string) => mybotFetch(`/api/browser/handoffs/${id}/done`, { method: "POST" }).then(j),
  // 시연 레코더 — 사용자 조작 녹화 → 스킬 초안
  recordStart: (url: string) => mybotFetch("/api/browser/record/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) }).then(j),
  recordStatus: () => mybotFetch("/api/browser/record/status").then(j) as Promise<{ active: boolean; count: number; elapsed: number }>,
  recordStop: () => mybotFetch("/api/browser/record/stop", { method: "POST" }).then(j) as Promise<{ events: unknown[]; draft: { trigger: string; steps: string; notes: string } }>,
  saveSkill: (s: { name: string; prompt: string }) =>
    mybotFetch("/api/skills", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s) }).then(j),
  // 승인 경계 — 위험 액션 승인 큐
  approvals: () => mybotFetch("/api/approvals").then(j) as Promise<{ requests: ApprovalRequest[]; rules: ApprovalRule[] }>,
  approveRequest: (id: string, always = false) =>
    mybotFetch(`/api/approvals/${id}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ always }) }).then(j),
  denyRequest: (id: string, always = false) =>
    mybotFetch(`/api/approvals/${id}/deny`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ always }) }).then(j),
  // 그룹채팅
  groups: () => mybotFetch("/api/groups").then(j) as Promise<{ groups: Group[] }>,
  createGroup: (name: string, agent_ids: string[]) =>
    mybotFetch("/api/groups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, agent_ids }) }).then(j),
  deleteGroup: (id: string) => mybotFetch(`/api/groups/${id}`, { method: "DELETE" }).then(j),
  groupConversation: (id: string) => mybotFetch(`/api/groups/${id}/conversation`, { method: "POST" }).then(j) as Promise<{ conversation_id: string }>,
  duplicateAgent: (id: string) => mybotFetch(`/api/agents/${id}/duplicate`, { method: "POST" }).then(j),
  // 자기개선 업데이트 센터 — 개발 인스턴스가 검증한 개선 패키지를 사용자가 버전 업데이트로 적용
  evolveUpdates: () => mybotFetch("/api/evolve/updates").then(j) as Promise<{ appVersion: number; updates: EvolveUpdate[] }>,
  applyUpdate: (id: string) => mybotFetch(`/api/evolve/updates/${id}/apply`, { method: "POST" }).then(j),
  revertUpdate: (id: string) => mybotFetch(`/api/evolve/updates/${id}/revert`, { method: "POST" }).then(j),
  rejectUpdate: (id: string) => mybotFetch(`/api/evolve/updates/${id}/reject`, { method: "POST" }).then(j),
  // 서비스 릴리스 — 개발 인스턴스가 release 브랜치로 민 커밋을 관리자가 직접 반영
  releaseStatus: () => mybotFetch("/api/release").then(j) as Promise<ReleaseStatus>,
  applyRelease: () => mybotFetch("/api/release/apply", { method: "POST" }).then(j) as Promise<{ version: number; sha: string; release: string; tier: ReleaseTier; restarting: boolean }>,
  revertRelease: () => mybotFetch("/api/release/revert", { method: "POST" }).then(j) as Promise<{ sha: string; restarting: boolean }>,
  winbackRelease: (sha?: string) => mybotFetch("/api/release/winback", { method: "POST", body: JSON.stringify(sha ? { sha } : {}) }).then(j) as Promise<{ sha: string; release: string; restarting: boolean }>,
};

export type ReleaseTier = "patch" | "minor" | "major";

export interface ReleaseRecord {
  version: string; tier: ReleaseTier; sha: string; prevSha: string;
  appliedAt: number; subjects: string[]; status: "applied" | "reverted";
}

export interface ReleaseStatus {
  branch: string; current: string; currentSubject: string; clean: boolean;
  pending: { sha: string; subject: string; date: string }[];
  files: string[];
  pendingTier: ReleaseTier | null; pendingTierLabel: string | null;
  version: string | null; nextVersion: string | null;
  history: ReleaseRecord[];
  canApply: boolean; reason: string;
  canRevert: boolean; prevSha: string; appliedAt: number; appVersion: number;
  receipts: ReleaseReceipt[];
}

export interface ReleaseReceipt {
  ts: number; from: string; to: string; subjects: string[]; gates: string[];
  result: "applied" | "rolled-back" | "interrupted" | "winback" | "rejected"; error?: string;
  version?: string; tier?: ReleaseTier;
}

export interface EvolveUpdate {
  id: string; version: number | null; status: "pending" | "applied" | "rejected" | "reverted";
  restart_required: number; source: string | null; created_at: number; applied_at: number | null;
  payload: { summary: string; measurement: { verdict: string; reason: string; baseline?: { passRate: number; avgLatencyMs: number }; candidate?: { passRate: number; avgLatencyMs: number } }; ops: { kind: string; surface: string; target: string }[]; rejectedReason?: string };
}

export interface ApprovalRequest {
  id: string;
  tool: string;
  title: string;
  summary: string;
  risk: string;
  details: { label: string; value: string }[];
  technicalDetails?: string;
  agent_name: string | null;
  created_at: number;
}

export interface ApprovalRule {
  id: string;
  pattern: string;
  action: "require" | "allow";
  created_at: number;
}

export interface Group {
  id: string;
  name: string;
  agent_ids: string[];
  members: { id: string; name: string; avatar: string | null; role_prompt: string; model: string | null }[];
  created_at: number;
}

export interface SiteRequest {
  id: string;
  name: string;
  url: string | null;
  reason: string | null;
  created_at: number;
}

export interface HandoffRequest {
  id: string;
  agent_id: string | null;
  run_id: string;
  reason: string;
  url: string;
  created_at: number;
  agent_name?: string;
  avatar?: string;
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
  parent_id?: string | null;
  pinned?: number;
  hidden?: number;
  workspace_id?: string | null;
  created_at: number;
}

export interface SiteLogin {
  id: string;
  name: string;
  url: string;
  username: string;
  success_check?: string | null;
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
  let finished = false; // done/error 종료 이벤트 수신 여부 — 없이 끊기면 호출자에 실패 전달

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
        let data: any;
        try { data = JSON.parse(line.slice(5)); } catch { continue; } // 깨진 이벤트 한 줄이 전체 스트림을 죽이지 않게
        switch (event) {
          case "conversation": handlers.onConversation?.(data.id); break;
          case "user_message": handlers.onUserMessage?.(data.message); break;
          case "assistant_message": handlers.onAssistantMessage?.(data.message); break;
          case "delta": handlers.onDelta?.(data.id, data.text); break;
          case "reasoning": handlers.onReasoning?.(data.id, data.text); break;
          case "search": handlers.onSearch?.(data); break;
          case "team": handlers.onTeam?.(data); break;
          case "done": finished = true; handlers.onDone?.(data.message); break;
          case "title": handlers.onTitle?.(data.conversation); break;
          case "error": finished = true; handlers.onError?.(data.message); break;
        }
      } else if (line === "" || line === "\r") {
        event = "";
      }
    }
  }
  // 서버가 done/error 없이 연결을 끝낸 경우(재시작·프록시 끊김) — 무한 로딩 대신 명확한 실패 표시
  if (!finished) handlers.onError?.("응답이 완료되기 전에 연결이 종료됐습니다 — 다시 시도해 주세요.");
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
