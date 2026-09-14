import { useEffect, useMemo, useRef, useState } from "react";
import type { Model } from "../api";

// 모델 id의 네임스페이스 (airoute 내부 상세 모델 그룹핑)
// "openai/gpt-6" → "openai", "claude-3-5-haiku" → "claude"
function nsOf(m: Model): string {
  const i = m.id.indexOf("/");
  if (i > 0) return m.id.slice(0, i);
  const d = m.id.indexOf("-");
  return d > 0 ? m.id.slice(0, d) : m.id;
}

export function ModelPicker({ models, value, onChange }: { models: Model[]; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [provider, setProvider] = useState<string>("all");
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const providers = useMemo(() => [...new Set(models.map((m) => m.provider))].sort(), [models]);
  const current = models.find((m) => m.id === value);

  const filtered = useMemo(() => {
    let list = models;
    if (provider !== "all") list = list.filter((m) => m.provider === provider);
    if (filter) list = list.filter((m) => m.id.toLowerCase().includes(filter.toLowerCase()));
    return list;
  }, [models, provider, filter]);

  const virtual = filtered.filter((m) => m.virtual);
  const groups = useMemo(() => {
    const g = new Map<string, Model[]>();
    for (const m of filtered.filter((x) => !x.virtual)) {
      const ns = nsOf(m);
      if (!g.has(ns)) g.set(ns, []);
      g.get(ns)!.push(m);
    }
    // 1개짜리 그룹은 "기타"로 병합
    const merged = new Map<string, Model[]>();
    const misc: Model[] = [];
    for (const [ns, ms] of g) {
      if (ms.length === 1) misc.push(...ms);
      else merged.set(ns, ms);
    }
    if (misc.length) merged.set("기타", misc.sort((a, b) => a.id.localeCompare(b.id)));
    return [...merged.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [filtered]);

  const toggleGroup = (g: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g); else next.add(g);
      return next;
    });
  };

  const pick = (id: string) => { onChange(id); setOpen(false); };

  // 검색 중이면 모든 그룹 자동 확장, 아니면 현재 모델 그룹 + 첫 그룹만
  const expanded = (g: string) => filter ? true : (openGroups.has(g) || current && nsOf(current) === g);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        className="rounded-full bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-700 max-w-[200px] truncate whitespace-nowrap"
        onClick={() => setOpen(!open)}
        title={value}
      >
        {current?.label ?? value ?? "모델 선택"} ▾
      </button>
      {open && (
        <div className="absolute bottom-full mb-2 left-0 z-50 w-96 max-w-[85vw] rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl">
          <div className="flex gap-1 overflow-x-auto border-b border-zinc-800 p-2">
            <button
              onClick={() => setProvider("all")}
              className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${provider === "all" ? "bg-sky-600 text-white" : "bg-zinc-800 text-zinc-400"}`}
            >전체</button>
            {providers.map((p) => (
              <button
                key={p}
                onClick={() => setProvider(p)}
                className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${provider === p ? "bg-sky-600 text-white" : "bg-zinc-800 text-zinc-400"}`}
              >{p}</button>
            ))}
          </div>
          <div className="border-b border-zinc-800 p-2">
            <input
              autoFocus
              className="w-full rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs outline-none placeholder:text-zinc-600"
              placeholder="모델 검색…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <div className="max-h-[50vh] overflow-y-auto p-1">
            {virtual.length > 0 && (
              <>
                <div className="px-2 py-1 text-[10px] font-semibold uppercase text-zinc-500">스마트 라우트</div>
                {virtual.map((m) => <Row key={m.id} m={m} value={value} pick={pick} />)}
              </>
            )}
            {groups.map(([ns, ms]) => (
              <div key={ns}>
                <button
                  className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-[10px] font-semibold uppercase text-zinc-500 hover:text-zinc-300"
                  onClick={() => toggleGroup(ns)}
                >
                  <span>{expanded(ns) ? "▾" : "▸"}</span>
                  {ns}
                  <span className="font-normal text-zinc-600">({ms.length})</span>
                </button>
                {expanded(ns) && ms.map((m) => <Row key={m.id} m={m} value={value} pick={pick} />)}
              </div>
            ))}
            {!filtered.length && <div className="px-3 py-4 text-xs text-zinc-600">일치하는 모델 없음</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ m, value, pick }: { m: Model; value: string; pick: (id: string) => void }) {
  const name = m.id.includes("/") ? m.id.slice(m.id.indexOf("/") + 1) : m.id;
  return (
    <button
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 pl-6 text-left text-xs hover:bg-zinc-800 ${m.id === value ? "bg-zinc-800 text-sky-300" : "text-zinc-300"}`}
      onClick={() => pick(m.id)}
    >
      <span className="truncate">{name}</span>
      <span className="ml-auto flex shrink-0 gap-1">
        {m.virtual && <span className="rounded bg-amber-900/40 px-1 text-[9px] text-amber-300">AUTO</span>}
        {m.reasoning && <span className="rounded bg-violet-900/40 px-1 text-[9px] text-violet-300">THINK</span>}
        {m.vision && <span className="rounded bg-emerald-900/40 px-1 text-[9px] text-emerald-300">EYE</span>}
        {m.provider !== "airoute" && <span className="rounded bg-zinc-800 px-1 text-[9px] text-zinc-400">{m.provider}</span>}
      </span>
    </button>
  );
}
