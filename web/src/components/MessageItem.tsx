import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Message } from "../api";
import { Brain, Bot, FileText, Volume2 } from "lucide-react";
import { AgentIcon } from "./icons";
import { WorkingStatus } from "./WorkingStatus";
import { HtmlPreview } from "./HtmlPreview";
import { AuthenticatedImage } from "./AuthenticatedImage";

// 저장된 과거 메시지·스트리밍 중간에 섞인 장식 이모지를 렌더 단에서 제거 — 정돈된 선형 표기 유지
const stripEmoji = (s: string) => s.replace(/\p{Extended_Pictographic}️?/gu, "").replace(/‍/g, "");

// rehypeHighlight가 만든 토큰 트리에서 원본 텍스트만 다시 모은다
interface HastElement { tagName?: string; type?: string; value?: string; properties?: { className?: unknown }; children?: HastElement[] }
function hastText(node?: HastElement): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

// 메시지 하단 액션 — 마우스 기기에선 hover 때만, 터치 기기에선 항상 보임
const actionRow = "flex items-center gap-0.5 text-xs text-stone-400 transition-opacity can-hover:opacity-0 can-hover:group-hover:opacity-100";
const actionBtn = "flex h-9 items-center rounded-lg px-2.5 hover:bg-stone-200/60 hover:text-stone-800 md:h-8 md:px-2";

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
  events?: { type: string; title?: string; url?: string }[];
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
  const siblingNav = sibs && (
    <span className="flex items-center text-xs">
      <button onClick={() => onSelectSibling?.(m, -1)} className="grid size-9 place-items-center rounded-lg hover:bg-stone-200/60 hover:text-stone-800 md:size-8" aria-label="이전 버전">‹</button>
      {(m.sibling_index ?? 0) + 1}/{m.sibling_count}
      <button onClick={() => onSelectSibling?.(m, 1)} className="grid size-9 place-items-center rounded-lg hover:bg-stone-200/60 hover:text-stone-800 md:size-8" aria-label="다음 버전">›</button>
    </span>
  );

  if (m.role === "user") {
    return (
      <div className="group flex flex-col items-end gap-1">
        {editing ? (
          <div className="w-full rounded-2xl bg-white p-3 ring-1 ring-stone-200">
            <textarea
              className="w-full resize-none bg-transparent text-body outline-none"
              rows={3}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
            />
            <div className="mt-1 flex justify-end gap-2">
              <button className="h-9 rounded-full px-3 text-xs text-stone-600 hover:bg-stone-100 hover:text-stone-900" onClick={() => setEditing(false)}>취소</button>
              <button
                className="h-9 rounded-full bg-stone-900 px-4 text-xs font-semibold text-white hover:bg-stone-700"
                onClick={() => { onEdit?.(m, editText); setEditing(false); }}
              >저장 후 재전송</button>
            </div>
          </div>
        ) : (
          <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-[22px] rounded-br-md bg-stone-200 px-4 py-2.5 text-body text-stone-900 md:max-w-[80%]">
            {m.attachments && (JSON.parse(m.attachments) as { url: string; mime: string; name: string }[]).map((a, i) =>
              a.mime.startsWith("image/") ? (
                <AuthenticatedImage key={i} src={a.url} className="mb-2 max-h-64 rounded-xl" alt={a.name} />
              ) : (
                <div key={i} className="mb-2 flex items-center gap-1.5 rounded-lg bg-white/60 px-2.5 py-1.5 text-xs"><FileText size={13} /> {a.name}</div>
              ),
            )}
            {m.content}
          </div>
        )}
        <div className={actionRow}>
          {siblingNav}
          <button className={actionBtn} onClick={() => { setEditText(m.content); setEditing(true); }}>편집</button>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex flex-col gap-2">
      {(m.reasoning || streaming) && m.reasoning !== null && m.reasoning !== "" && (
        <div className="rounded-xl border border-stone-200 bg-white/60">
          <button
            className="flex min-h-10 w-full items-center gap-2 px-3 text-xs text-stone-600 hover:text-stone-900"
            onClick={() => setShowReasoning(!showReasoning)}
          >
            <Brain size={15} className={streaming && !m.content ? "thinking-dot" : ""} />
            사고 과정
            <span className="ml-auto">{showReasoning ? "▾" : "▸"}</span>
          </button>
          {showReasoning && (
            <div className="max-h-64 overflow-y-auto whitespace-pre-wrap border-t border-stone-200 px-3 py-2.5 text-xs italic leading-relaxed text-stone-500">
              {m.reasoning}
            </div>
          )}
        </div>
      )}
      {streaming && !m.reasoning && !m.content && <WorkingStatus compact />}
      {m.content && (
        <div className="markdown text-body">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={{
              img: ({ src, alt }) => <AuthenticatedImage src={src} alt={alt} />,
              // html·svg 코드블록은 격리된 미리보기로 — 봇이 표·차트·카드 같은 결과 화면을 직접 그릴 수 있다.
              // 원문은 hast 노드에서 꺼낸다 — rehypeHighlight가 코드를 토큰 span으로 쪼개 children은 문자열이 아니다
              pre({ children, node, ...props }) {
                const codeNode = (node as HastElement | undefined)?.children?.find((c) => (c as HastElement).tagName === "code") as HastElement | undefined;
                const cls = codeNode?.properties?.className;
                const lang = /language-(\w+)/.exec(Array.isArray(cls) ? cls.join(" ") : String(cls ?? ""))?.[1];
                const code = hastText(codeNode).replace(/\n$/, "");
                if ((lang === "html" || lang === "svg") && code.includes("<"))
                  return <HtmlPreview code={code} streaming={streaming} />;
                return <pre {...props}>{children}</pre>;
              },
            }}
          >{stripEmoji(m.content)}</ReactMarkdown>
        </div>
      )}
      {meta?.type === "team" && meta.status === "pending" && meta.agents && (
        <div className="mt-1 rounded-2xl border border-amber-200 bg-amber-50 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-amber-700"><Bot size={15} /> 팀 작업 계획 — 실행할 봇을 선택하세요</div>
          <div className="space-y-1.5">
            {meta.agents.map((a, i) => (
              <label key={i} className="flex cursor-pointer items-start gap-2.5 rounded-xl bg-white/70 px-3 py-2.5 text-xs">
                <input type="checkbox" className="mt-1 size-4 accent-amber-600" checked={sel.has(i)} onChange={() => toggleSel(i)} />
                <AgentIcon name={a.name} size={20} className="shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="font-semibold text-stone-800">{a.name}</span>
                  <span className={`ml-1.5 rounded-full px-1.5 py-px text-micro font-semibold ${a.existing ? "bg-sky-100 text-sky-700" : "bg-emerald-100 text-emerald-700"}`}>
                    {a.existing ? "기존 봇" : "새 봇"}
                  </span>
                  <span className="ml-1.5 font-mono text-2xs text-stone-400">{a.model_label ?? a.model}</span>
                  <span className="mt-0.5 block truncate text-stone-500">{a.role}</span>
                  <span className="mt-0.5 block text-stone-600">작업: {a.task}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="mt-2.5 flex gap-2">
            <button
              className="h-9 rounded-full bg-amber-600 px-4 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-40"
              disabled={!sel.size}
              onClick={() => onTeamConfirm?.(m, meta.agents!.filter((_, i) => sel.has(i)))}
            >선택한 봇 {sel.size}개로 실행</button>
            <button
              className="h-9 rounded-full bg-white px-4 text-xs text-stone-600 ring-1 ring-stone-200 hover:text-stone-900"
              onClick={() => onTeamCancel?.(m)}
            >취소</button>
          </div>
        </div>
      )}
      {meta?.type === "team" && meta.status === "cancelled" && (
        <div className="mt-1 rounded-xl border border-stone-200 bg-white/40 px-3 py-2 text-xs text-stone-400">
          팀 작업 계획이 취소됐습니다 ({meta.agents?.length ?? 0}개 봇)
        </div>
      )}
      {meta?.type === "team" && meta.status !== "pending" && meta.status !== "cancelled" && meta.agents && (
        <div className="mt-1 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-amber-700"><Bot size={15} /> 팀 작업 — 봇 {meta.agents.length}개</div>
          <div className="space-y-1.5 text-xs text-stone-500">
            {meta.agents.map((a, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <span className={a.status === "done" ? "text-emerald-600" : "text-red-600"}>●</span>
                <AgentIcon name={a.name} size={18} className="shrink-0" />
                <span className="shrink-0 text-stone-700">{a.name}</span>
                {a.model_label && <span className="shrink-0 font-mono text-micro text-stone-400">{a.model_label}</span>}
                <span className="truncate text-stone-400"> — {(a.task ?? "").slice(0, 60)}{(a.task ?? "").length > 60 ? "…" : ""}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {meta?.events && meta.events.length > 0 && (
        <div className="mt-1 rounded-xl border border-stone-200 bg-white/50 px-3 py-2.5">
          <div className="mb-1.5 flex items-center gap-1 text-xs font-medium text-stone-600"><Bot size={13} /> 봇 도구 사용 {meta.events.filter((e) => e.title && !e.title.includes("라운드")).length}회</div>
          <div className="flex flex-wrap gap-1">
            {meta.events.filter((e) => e.title && !e.title.includes("라운드")).map((e, i) => (
              <span key={i} className={`rounded-full px-2.5 py-0.5 text-2xs ${e.title!.startsWith("⚠") ? "bg-red-50 text-red-600" : "bg-stone-100 text-stone-500"}`}>{e.title}</span>
            ))}
          </div>
        </div>
      )}
      {meta && meta.type !== "team" && (meta.sources?.length ?? 0) > 0 && (
        <div className="mt-1 rounded-xl border border-stone-200 bg-white/50 px-3 py-2.5">
          <div className="mb-1 text-xs font-medium text-stone-600">출처 {meta.sources!.length}개 · 검색 {meta.steps}회</div>
          <ol className="space-y-1 text-xs text-stone-500">
            {meta.sources!.map((s, i) => (
              <li key={i}>
                <a href={s.url} target="_blank" rel="noreferrer" className="hover:text-sky-600">
                  [{i + 1}] {s.title}
                </a>
              </li>
            ))}
          </ol>
        </div>
      )}
      <div className={actionRow}>
        {siblingNav}
        <button
          className={actionBtn}
          onClick={() => { navigator.clipboard.writeText(m.content); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
        >{copied ? "복사됨" : "복사"}</button>
        <button className={actionBtn} onClick={() => onRegenerate?.(m)}>재생성</button>
        <button
          className={`${actionBtn} w-9 justify-center px-0 md:w-8 md:px-0`}
          title="읽어주기"
          aria-label="읽어주기"
          onClick={() => {
            if (speechSynthesis.speaking) { speechSynthesis.cancel(); return; }
            const u = new SpeechSynthesisUtterance(m.content.replace(/[#*`\[\]]/g, "").slice(0, 3000));
            u.lang = "ko-KR";
            speechSynthesis.speak(u);
          }}
        ><Volume2 size={15} /></button>
        {m.model && <span className="ml-auto truncate pl-2 font-mono text-2xs">{m.model}{m.tokens_out ? ` · ${m.tokens_out}tok` : ""}</span>}
      </div>
    </div>
  );
}
