import { Search, Bot } from "lucide-react";

export interface SearchEvent {
  type: "plan" | "search" | "read" | "round" | "synthesize";
  queries?: string[];
  query?: string;
  results?: { title: string; url: string }[];
  url?: string;
  title?: string;
  round?: number;
  count?: number;
}

// 그록 DeepSearch 진행 패널: 단계 타임라인
export function SearchTrace({ events, done }: { events: SearchEvent[]; done: boolean }) {
  const reads = events.filter((e) => e.type === "read");
  const searches = events.filter((e) => e.type === "search");
  const plan = events.find((e) => e.type === "plan");
  const synthesizing = events.some((e) => e.type === "synthesize");
  const isSearch = searches.length > 0 || !!plan || synthesizing;

  return (
    <div className="rounded-xl border border-sky-900/40 bg-sky-950/20 px-4 py-3 text-sm">
      <div className="flex items-center gap-2 font-medium text-sky-300">
        <span className={done ? "" : "thinking-dot"}>{isSearch ? <Search size={14} /> : <Bot size={14} />}</span>
        {isSearch
          ? done ? "DeepSearch 완료" : synthesizing ? "출처 종합 중…" : "DeepSearch 진행 중…"
          : done ? "봇 작업 완료" : "봇 작업 중…"}
      </div>
      {plan?.queries && (
        <div className="mt-2 text-xs text-zinc-400">
          검색 계획: {plan.queries.map((q, i) => <span key={i} className="mr-1.5 inline-block rounded bg-zinc-800 px-1.5 py-0.5">{q}</span>)}
        </div>
      )}
      <div className="mt-2 space-y-1 text-xs text-zinc-500 max-h-48 overflow-y-auto">
        {searches.map((s, i) => (
          <div key={`s${i}`}>· "{s.query}" → {s.results?.length ?? 0}건</div>
        ))}
        {reads.map((r, i) => (
          <div key={`r${i}`} className="text-zinc-400">
            {!r.url ? (
              <span>· {r.title || r.url}</span>
            ) : (
              <span>· 읽음: <a href={r.url} target="_blank" rel="noreferrer" className="hover:text-sky-400 underline decoration-zinc-700">{r.title}</a></span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
