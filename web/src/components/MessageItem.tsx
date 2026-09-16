import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Message } from "../api";
import { Brain, Bot, FileText, Volume2 } from "lucide-react";
import { AgentIcon } from "./icons";
import { WorkingStatus } from "./WorkingStatus";

// 저장된 과거 메시지·스트리밍 중간에 섞인 장식 이모지를 렌더 단에서 제거 — 정돈된 선형 표기 유지
const stripEmoji = (s: string) => s.replace(/\p{Extended_Pictographic}\uFE0F?/gu, "").replace(/\u200D/g, "");

interface TeamPlanAgent {
  name: string; avatar: string; role: string; task: string; model: string; model_label?: string;
  status?: string; result?: string; existing?: boolean;
}

interface SearchMeta {
  type?: string;
  status?: string;
  queries?: string[];
  sources?: { url: string; title: string }[];
  steps?: number;
  agents?: TeamPlanAgent[];
  events?: { type: string; title: string; url: string }[];
}

export function MessageItem({
  m,
  streaming,
  onRegenerate,
  onEdit,
  onSelectSibling,
  onTeamConfirm,
  onTeamCancel,
}: {
  m: Message;
  streaming: boolean;
  onRegenerate?: (m: Message) => void;
  onEdit?: (m: Message, content: string) => void;
  onSelectSibling?: (m: Message, dir: -1 | 1) => void;
  onTeamConfirm?: (m: Message, tasks: TeamPlanAgent[]) => void;
  onTeamCancel?: (m: Message) => void;
}) {
  const [showReasoning, setShowReasoning] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(m.content);
  const [copied, setCopied] = useState(false);
  const [planSel, setPlanSel] = useState<Set<number> | null>(null);

  const meta: SearchMeta | null = m.search_meta ? JSON.parse(m.search_meta) : null;
  // 승인 대기 계획: 기본 전체 선택
  const sel = planSel ?? new Set<number>((meta?.agents ?? []).map((_, i) => i));
  const toggleSel = (i: number) => {
    const next = new Set(sel);
    if (next.has(i)) next.delete(i); else next.add(i);
    setPlanSel(next);
  };
  const sibs = (m.sibling_count ?? 1) > 1;

  if (m.role === "user") {
    return (
      <div className="group flex flex-col items-end gap-1">
        {editing ? (
          <div className="w-full rounded-2xl bg-zinc-800 p-3">
            <textarea
              className="w-full bg-transparent outline-none resize-none text-sm"
              rows={3}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
            />
            <div className="flex justify-end gap-2 mt-1">
              <button className="text-xs text-zinc-400 hover:text-zinc-200" onClick={() => setEditing(false)}>취소</button>
              <button
                className="text-xs bg-zinc-100 text-zinc-900 rounded-full px-3 py-1 font-medium"
                onClick={() => { onEdit?.(m, editText); setEditing(false); }}
              >저장 후 재전송</button>
            </div>
          </div>
        ) : (
          <div className="max-w-[80%] rounded-2xl bg-zinc-800 px-4 py-2.5 text-[15px] whitespace-pre-wrap break-words">
            {m.attachments && (JSON.parse(m.attachments) as { url: string; mime: string; name: string }[]).map((a, i) =>
              a.mime.startsWith("image/") ? (
                <img key={i} src={a.url} className="mb-2 max-h-64 rounded-lg" alt={a.name} />
              ) : (
                <div key={i} className="mb-2 flex items-center gap-1 rounded-lg bg-zinc-700 px-2 py-1 text-xs"><FileText size={11} /> {a.name}</div>
              ),
            )}
            {m.content}
          </div>
        )}
        <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity text-zinc-500">
          {sibs && (
            <span className="flex items-center gap-1 text-xs">
              <button onClick={() => onSelectSibling?.(m, -1)} className="hover:text-zinc-200">‹</button>
              {(m.sibling_index ?? 0) + 1}/{m.sibling_count}
              <button onClick={() => onSelectSibling?.(m, 1)} className="hover:text-zinc-200">›</button>
            </span>
          )}
          <button className="text-xs hover:text-zinc-200" onClick={() => { setEditText(m.content); setEditing(true); }}>편집</button>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex flex-col gap-2">
      {(m.reasoning || streaming) && m.reasoning !== null && m.reasoning !== "" && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50">
          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-xs text-zinc-400 hover:text-zinc-200"
            onClick={() => setShowReasoning(!showReasoning)}
          >
            <Brain size={13} className={streaming && !m.content ? "thinking-dot" : ""} />
            사고 과정
            <span className="ml-auto">{showReasoning ? "▾" : "▸"}</span>
          </button>
          {showReasoning && (
            <div className="border-t border-zinc-800 px-3 py-2 text-xs italic text-zinc-500 whitespace-pre-wrap max-h-64 overflow-y-auto">
              {m.reasoning}
            </div>
          )}
        </div>
      )}
      {streaming && !m.reasoning && !m.content && <WorkingStatus compact />}
      {m.content && (
        <div className="markdown text-[15px] leading-relaxed">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{stripEmoji(m.content)}</ReactMarkdown>
        </div>
      )}
      {meta?.type === "team" && meta.status === "pending" && meta.agents && (
        <div className="mt-1 rounded-xl border border-amber-900/40 bg-amber-950/20 px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-amber-300/90 mb-2"><Bot size={13} /> 팀 작업 계획 — 실행할 봇을 선택하세요</div>
          <div className="space-y-1.5">
            {meta.agents.map((a, i) => (
              <label key={i} className="flex items-start gap-2 rounded-lg bg-zinc-900/60 px-2.5 py-2 text-xs cursor-pointer">
                <input type="checkbox" className="mt-0.5" checked={sel.has(i)} onChange={() => toggleSel(i)} />
                <AgentIcon name={a.name} size={13} className="mt-0.5 shrink-0 text-zinc-500" />
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-zinc-200">{a.name}</span>
                  <span className={`ml-1.5 rounded px-1 text-[9px] ${a.existing ? "bg-sky-900/60 text-sky-300" : "bg-emerald-900/60 text-emerald-300"}`}>
                    {a.existing ? "기존 봇" : "새 봇"}
                  </span>
                  <span className="ml-1.5 font-mono text-[10px] text-zinc-600">{a.model_label ?? a.model}</span>
                  <span className="block truncate text-zinc-500">{a.role}</span>
                  <span className="block text-zinc-400">작업: {a.task}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <button
              className="rounded-full bg-amber-500 px-3 py-1 text-xs font-medium text-zinc-950 disabled:opacity-40 hover:bg-amber-400"
              disabled={!sel.size}
              onClick={() => onTeamConfirm?.(m, meta.agents!.filter((_, i) => sel.has(i)))}
            >선택한 봇 {sel.size}개로 실행</button>
            <button
              className="rounded-full bg-zinc-800 px-3 py-1 text-xs text-zinc-400 hover:text-zinc-200"
              onClick={() => onTeamCancel?.(m)}
            >취소</button>
          </div>
        </div>
      )}
      {meta?.type === "team" && meta.status === "cancelled" && (
        <div className="mt-1 rounded-xl border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs text-zinc-600">
          팀 작업 계획이 취소됐습니다 ({meta.agents?.length ?? 0}개 봇)
        </div>
      )}
      {meta?.type === "team" && meta.status !== "pending" && meta.status !== "cancelled" && meta.agents && (
        <div className="mt-1 rounded-xl border border-amber-900/40 bg-amber-950/20 px-3 py-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-amber-300/90 mb-1"><Bot size={13} /> 팀 작업 — 봇 {meta.agents.length}개</div>
          <div className="space-y-1 text-xs text-zinc-500">
            {meta.agents.map((a, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <span className={a.status === "done" ? "text-emerald-400" : "text-red-400"}>●</span>
                <AgentIcon name={a.name} size={12} className="text-zinc-500" />
                <span className="text-zinc-300">{a.name}</span>
                {a.model_label && <span className="font-mono text-[9px] text-zinc-600">{a.model_label}</span>}
                <span className="text-zinc-600"> — {a.task.slice(0, 60)}{a.task.length > 60 ? "…" : ""}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {meta?.events && meta.events.length > 0 && (
        <div className="mt-1 rounded-xl border border-zinc-800 bg-zinc-900/40 px-3 py-2">
          <div className="text-xs font-medium text-zinc-400 mb-1"><Bot size={11} className="inline -mt-0.5" /> 봇 도구 사용 {meta.events.filter((e) => !e.title.includes("라운드")).length}회</div>
          <div className="flex flex-wrap gap-1">
            {meta.events.filter((e) => !e.title.includes("라운드")).map((e, i) => (
              <span key={i} className={`rounded-full px-2 py-0.5 text-[10px] ${e.title.startsWith("⚠") ? "bg-red-950/50 text-red-400" : "bg-zinc-800 text-zinc-500"}`}>{e.title}</span>
            ))}
          </div>
        </div>
      )}
      {meta && meta.type !== "team" && (meta.sources?.length ?? 0) > 0 && (
        <div className="mt-1 rounded-xl border border-zinc-800 bg-zinc-900/40 px-3 py-2">
          <div className="text-xs font-medium text-zinc-400 mb-1">출처 {meta.sources!.length}개 · 검색 {meta.steps}회</div>
          <ol className="text-xs text-zinc-500 space-y-0.5">
            {meta.sources!.map((s, i) => (
              <li key={i}>
                <a href={s.url} target="_blank" rel="noreferrer" className="hover:text-sky-400">
                  [{i + 1}] {s.title}
                </a>
              </li>
            ))}
          </ol>
        </div>
      )}
      <div className="flex items-center gap-3 text-zinc-600 text-xs opacity-0 group-hover:opacity-100 transition-opacity">
        {sibs && (
          <span className="flex items-center gap-1">
            <button onClick={() => onSelectSibling?.(m, -1)} className="hover:text-zinc-200">‹</button>
            {(m.sibling_index ?? 0) + 1}/{m.sibling_count}
            <button onClick={() => onSelectSibling?.(m, 1)} className="hover:text-zinc-200">›</button>
          </span>
        )}
        <button
          className="hover:text-zinc-200"
          onClick={() => { navigator.clipboard.writeText(m.content); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
        >{copied ? "복사됨" : "복사"}</button>
        <button className="hover:text-zinc-200" onClick={() => onRegenerate?.(m)}>재생성</button>
        <button
          className="hover:text-zinc-200"
          title="읽어주기"
          onClick={() => {
            if (speechSynthesis.speaking) { speechSynthesis.cancel(); return; }
            const u = new SpeechSynthesisUtterance(m.content.replace(/[#*`\[\]]/g, "").slice(0, 3000));
            u.lang = "ko-KR";
            speechSynthesis.speak(u);
          }}
        ><Volume2 size={13} /></button>
        {m.model && <span className="ml-auto font-mono text-[10px]">{m.model}{m.tokens_out ? ` · ${m.tokens_out}tok` : ""}</span>}
      </div>
    </div>
  );
}
