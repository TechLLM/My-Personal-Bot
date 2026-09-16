import { Search, Bot } from "lucide-react";

export interface SearchEvent {
  type: "plan" | "search" | "read" | "round" | "synthesize" | "phase";
  queries?: string[];
  query?: string;
  results?: { title: string; url: string }[];
  url?: string;
  title?: string;
  round?: number;
  count?: number;
  phase?: string;
  label?: string;
}

// PGE 파이프라인 단계 — 서버 phase 이벤트로 진행 상황을 구동
const STAGES = [
  { key: "plan", label: "분석" },
  { key: "exec", label: "실행" },
  { key: "gen", label: "생성" },
  { key: "verify", label: "검증" },
  { key: "done", label: "완료" },
];

// 그록 DeepSearch 진행 패널 + PGE 단계 타임라인
export function SearchTrace({ events, done }: { events: SearchEvent[]; done: boolean }) {
  const reads = events.filter((e) => e.type === "read");
  const searches = events.filter((e) => e.type === "search");
  const plan = events.find((e) => e.type === "plan");
  const synthesizing = events.some((e) => e.type === "synthesize");
  const isSearch = searches.length > 0 || !!plan || synthesizing;

  // 단계 진행도 — 마지막 phase 이벤트가 현재 단계. verify_done은 verify 통과로 취급
  const phases = events.filter((e) => e.type === "phase");
  const lastPhase = phases[phases.length - 1]?.phase;
  const stageIdx = lastPhase === "verify_done" ? 3 : STAGES.findIndex((s) => s.key === lastPhase);
  const hasPhases = phases.length > 0;

  // 연속 동일 제목 제거 — 같은 행이 반복 출력되는 것 방지
  const dedupedReads = reads.filter((r, i) => i === 0 || r.title !== reads[i - 1].title);

  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm">
      <div className="flex items-center gap-2 font-medium text-sky-600">
        <span className={done ? "" : "thinking-dot"}>{isSearch ? <Search size={14} /> : <Bot size={14} />}</span>
        {isSearch
          ? done ? "DeepSearch 완료" : synthesizing ? "출처 종합 중…" : "DeepSearch 진행 중…"
          : done ? "봇 작업 완료" : "봇 작업 중…"}
      </div>
      {hasPhases && (
        <div className="mt-2 flex items-center gap-1.5">
          {STAGES.map((s, i) => {
            const passed = i < stageIdx || (done && i < STAGES.length) || (lastPhase === "verify_done" && i === 3);
            const current = i === stageIdx && !done && lastPhase !== "verify_done";
            return (
              <div key={s.key} className="flex items-center gap-1.5">
                {i > 0 && <span className="text-stone-300">→</span>}
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  current ? "bg-sky-100 text-sky-600 mb-shimmer"
                  : passed ? "bg-emerald-50 text-emerald-600"
                  : "bg-stone-200/60 text-stone-400"
                }`}>
                  {passed ? "✓ " : ""}{s.label}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {plan?.queries && (
        <div className="mt-2 text-xs text-stone-600">
          검색 계획: {plan.queries.map((q, i) => <span key={i} className="mr-1.5 inline-block rounded bg-stone-200 px-1.5 py-0.5">{q}</span>)}
        </div>
      )}
      <div className="mt-2 space-y-1 text-xs max-h-48 overflow-y-auto">
        {searches.map((s, i) => (
          <div key={`s${i}`} className="italic text-stone-500">· "{s.query}" → {s.results?.length ?? 0}건</div>
        ))}
        {dedupedReads.map((r, i) => (
          <div key={`r${i}`} className="italic text-stone-500">
            {!r.url ? (
              <span>· {r.title || r.url}</span>
            ) : (
              <span>· 읽음: <a href={r.url} target="_blank" rel="noreferrer" className="hover:text-sky-600 underline decoration-stone-300">{r.title}</a></span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
