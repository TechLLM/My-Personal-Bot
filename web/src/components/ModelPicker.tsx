import { useEffect, useRef, useState } from "react";
import type { Model } from "../api";

export function ModelPicker({ models, value, onChange }: { models: Model[]; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const current = models.find((m) => m.id === value);
  const filtered = models.filter((m) => m.id.toLowerCase().includes(filter.toLowerCase()));
  const virtual = filtered.filter((m) => m.virtual);
  const rest = filtered.filter((m) => !m.virtual);

  return (
    <div ref={ref} className="relative">
      <button
        className="rounded-full bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-700 max-w-[220px] truncate"
        onClick={() => setOpen(!open)}
        title={value}
      >
        {current?.label ?? value ?? "모델 선택"} ▾
      </button>
      {open && (
        <div className="absolute bottom-full mb-2 left-0 z-50 w-80 rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl">
          <div className="p-2 border-b border-zinc-800">
            <input
              autoFocus
              className="w-full rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs outline-none placeholder:text-zinc-600"
              placeholder="모델 검색… (210+ 모델)"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <div className="max-h-80 overflow-y-auto p-1">
            {virtual.length > 0 && (
              <>
                <div className="px-2 py-1 text-[10px] font-semibold text-zinc-500 uppercase">스마트 라우트</div>
                {virtual.map((m) => <Row key={m.id} m={m} value={value} pick={(id) => { onChange(id); setOpen(false); }} />)}
              </>
            )}
            <div className="px-2 py-1 text-[10px] font-semibold text-zinc-500 uppercase">전체 모델</div>
            {rest.slice(0, 200).map((m) => <Row key={m.id} m={m} value={value} pick={(id) => { onChange(id); setOpen(false); }} />)}
            {rest.length > 200 && <div className="px-2 py-1 text-[10px] text-zinc-600">+{rest.length - 200}개 — 검색으로 좁히세요</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ m, value, pick }: { m: Model; value: string; pick: (id: string) => void }) {
  return (
    <button
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-zinc-800 ${m.id === value ? "bg-zinc-800 text-sky-300" : "text-zinc-300"}`}
      onClick={() => pick(m.id)}
    >
      <span className="truncate">{m.label}</span>
      <span className="ml-auto flex gap-1 shrink-0">
        {m.virtual && <span className="rounded bg-amber-900/40 text-amber-300 px-1 text-[9px]">AUTO</span>}
        {m.reasoning && <span className="rounded bg-violet-900/40 text-violet-300 px-1 text-[9px]">THINK</span>}
        {m.vision && <span className="rounded bg-emerald-900/40 text-emerald-300 px-1 text-[9px]">EYE</span>}
        {m.provider !== "airoute" && <span className="rounded bg-zinc-800 text-zinc-400 px-1 text-[9px]">{m.provider}</span>}
      </span>
    </button>
  );
}
