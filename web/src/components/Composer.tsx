import { useEffect, useRef, useState } from "react";
import { ModelPicker } from "./ModelPicker";
import { mybotFetch, type Model } from "../api";
import { X } from "lucide-react";

export type Mode = "auto" | "think" | "deepsearch" | "image" | "team";

export interface Persona { id: string; name: string; prompt: string; avatar: string | null; builtin: number }

export interface Attachment { url: string; name: string; mime: string }

export function Composer({
  models,
  model,
  onModelChange,
  onSend,
  onStop,
  streaming,
  personas,
  personaId,
  onPersonaChange,
  skills,
}: {
  models: Model[];
  model: string;
  onModelChange: (id: string) => void;
  onSend: (text: string, mode: Mode, attachments: Attachment[]) => void;
  onStop: () => void;
  streaming: boolean;
  personas: Persona[];
  personaId: string;
  onPersonaChange: (id: string) => void;
  skills: { id: string; name: string; prompt: string }[];
}) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<Mode>("auto");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [listening, setListening] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const recogRef = useRef<any>(null);

  useEffect(() => { ref.current?.focus(); }, []);

  const toggleVoice = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { alert("이 브라우저는 음성 인식을 지원하지 않습니다 (Chrome/Safari 사용)"); return; }
    if (listening) { recogRef.current?.stop(); setListening(false); return; }
    const rec = new SR();
    rec.lang = "ko-KR";
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e: any) => {
      const t = Array.from(e.results).map((r: any) => r[0].transcript).join("");
      setText(t);
      if (e.results[e.results.length - 1].isFinal) setListening(false);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    rec.start();
    recogRef.current = rec;
    setListening(true);
  };

  const send = () => {
    const t = text.trim();
    if ((!t && !attachments.length) || streaming) return;
    onSend(t, mode, attachments);
    setText("");
    setAttachments([]);
    if (ref.current) ref.current.style.height = "auto";
  };

  const upload = async (files: FileList) => {
    for (const f of Array.from(files)) {
      const fd = new FormData();
      fd.append("file", f);
      const res = await mybotFetch("/api/chat/upload", { method: "POST", body: fd });
      if (res.ok) {
        const d = await res.json();
        setAttachments((prev) => [...prev, { url: d.url, name: d.name, mime: d.mime }]);
      }
    }
  };

  const slashQuery = text.startsWith("/") && !text.includes(" ") ? text.slice(1).toLowerCase() : null;
  const slashMatches = slashQuery !== null ? skills.filter((sk) => sk.name.toLowerCase().includes(slashQuery)) : [];

  const chip = (m: Mode, label: string, active_cls: string) => (
    <button
      key={m}
      onClick={() => setMode(mode === m ? "auto" : m)}
      className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
        mode === m ? active_cls : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="rounded-3xl border border-zinc-800 bg-zinc-900/80 p-3 shadow-xl backdrop-blur">
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2 px-1">
          {attachments.map((a, i) => (
            <div key={i} className="relative">
              {a.mime.startsWith("image/") ? (
                <img src={a.url} className="h-14 w-14 rounded-lg object-cover border border-zinc-700" />
              ) : (
                <span className="flex h-14 items-center rounded-lg border border-zinc-700 bg-zinc-800 px-2 text-[10px]">{a.name}</span>
              )}
              <button
                className="absolute -right-1 -top-1 rounded-full bg-zinc-700 px-1 text-[10px] text-zinc-300 hover:bg-red-600"
                onClick={() => setAttachments(attachments.filter((_, j) => j !== i))}
              ><X size={10} strokeWidth={2.5} /></button>
            </div>
          ))}
        </div>
      )}
      <input ref={fileRef} type="file" multiple accept="image/*,.pdf,.txt,.md" className="hidden" onChange={(e) => { if (e.target.files) upload(e.target.files); e.target.value = ""; }} />
      {slashMatches.length > 0 && (
        <div className="mb-2 rounded-xl border border-zinc-800 bg-zinc-900 p-1">
          {slashMatches.map((sk) => (
            <button
              key={sk.id}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-zinc-800"
              onClick={() => { setText(`/${sk.name} `); ref.current?.focus(); }}
            >
              <span className="font-mono text-sky-300">/{sk.name}</span>
              <span className="truncate text-zinc-500">{sk.prompt.slice(0, 40)}</span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        className="w-full resize-none bg-transparent px-2 py-1 text-[15px] outline-none placeholder:text-zinc-600 max-h-48"
        rows={1}
        placeholder={mode === "deepsearch" ? "DeepSearch: 웹을 뒤져 종합 리포트 생성…" : mode === "image" ? "생성할 이미지를 설명하세요…" : mode === "team" ? "팀 모드: 대장 봇이 역할 봇들에게 작업을 분배합니다…" : "무엇이든 물어보세요"}
        value={text}
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={(e) => {
          composing.current = false;
          setText(e.currentTarget.value);
          e.currentTarget.style.height = "auto";
          e.currentTarget.style.height = Math.min(e.currentTarget.scrollHeight, 192) + "px";
        }}
        onChange={(e) => {
          setText(e.target.value); // 항상 동기화 — React가 조합 중 value를 유지
          if (composing.current) return; // IME 조합 중 DOM 높이 조작은 자모 분리를 유발 — 건너뜀
          e.target.style.height = "auto";
          e.target.style.height = Math.min(e.target.scrollHeight, 192) + "px";
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          onClick={() => fileRef.current?.click()}
          className="shrink-0 rounded-full p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          title="이미지/파일 첨부"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l8.57-8.57A4 4 0 1118 8.84l-8.59 8.57a2 2 0 01-2.83-2.83l8.49-8.48" /></svg>
        </button>
        <ModelPicker models={models} value={model} onChange={onModelChange} />
        <select
          className="shrink-0 rounded-full bg-zinc-800 px-2 py-1.5 text-xs text-zinc-300 outline-none hover:bg-zinc-700 max-w-[110px]"
          value={personaId}
          onChange={(e) => onPersonaChange(e.target.value)}
          title="페르소나"
        >
          {personas.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <div className="flex-1" />
        {chip("team", "팀", "bg-amber-600 text-white")}
        {chip("deepsearch", "DeepSearch", "bg-sky-600 text-white")}
        {chip("think", "Think", "bg-violet-600 text-white")}
        {chip("image", "이미지", "bg-emerald-600 text-white")}
        <button
          onClick={toggleVoice}
          className={`rounded-full p-1.5 transition-colors ${listening ? "bg-red-600 text-white animate-pulse" : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"}`}
          title={listening ? "음성 입력 중지" : "음성으로 입력"}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" /><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4" /></svg>
        </button>
        {streaming ? (
          <button onClick={onStop} className="rounded-full bg-zinc-100 p-2 text-zinc-900 hover:bg-white" title="중단">
            <svg width="14" height="14" viewBox="0 0 14 14"><rect x="2" y="2" width="10" height="10" rx="2" fill="currentColor" /></svg>
          </button>
        ) : (
          <button
            onClick={send}
            disabled={!text.trim()}
            className="rounded-full bg-zinc-100 p-2 text-zinc-900 hover:bg-white disabled:opacity-30"
            title="전송"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
          </button>
        )}
      </div>
    </div>
  );
}
