import { AuthenticatedImage } from "./AuthenticatedImage";
import { useEffect, useRef, useState } from "react";
import { ModelPicker } from "./ModelPicker";
import { mybotFetch, type Model } from "../api";
import { X } from "lucide-react";

export type Mode = "auto" | "think" | "deepsearch" | "image" | "team";
export type TaskMode = "default" | "readonly" | "guard";

export interface Persona { id: string; name: string; prompt: string; avatar: string | null; builtin: number }

export interface Attachment { url: string; name: string; mime: string }

export function Composer({
  models,
  model,
  onModelChange,
  onSend,
  onStop,
  streaming,
  queued,
  onRemoveQueued,
  onSteer,
  personas,
  personaId,
  onPersonaChange,
  skills,
}: {
  models: Model[];
  model: string;
  onModelChange: (id: string) => void;
  onSend: (text: string, mode: Mode, attachments: Attachment[], taskMode?: TaskMode) => void;
  onStop: () => void;
  streaming: boolean;
  queued: { text: string; mode: Mode; attachments: Attachment[]; taskMode?: TaskMode }[];
  onRemoveQueued: (i: number) => void;
  onSteer?: (i: number) => void;
  personas: Persona[];
  personaId: string;
  onPersonaChange: (id: string) => void;
  skills: { id: string; name: string; prompt: string }[];
}) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<Mode>("auto");
  const [taskMode, setTaskMode] = useState<TaskMode>("default");
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
    if (!t && !attachments.length) return; // 스트리밍 중이면 App의 대기열로 들어가 응답 후 자동 전송됨
    onSend(t, mode, attachments, taskMode);
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
      className={`h-9 shrink-0 whitespace-nowrap rounded-full px-3.5 text-sm font-medium transition-colors md:h-8 md:px-3 md:text-xs ${
        mode === m ? active_cls : "bg-stone-100 text-stone-600 hover:bg-stone-200 hover:text-stone-900"
      }`}
    >
      {label}
    </button>
  );
  const iconBtn = "grid size-10 shrink-0 place-items-center rounded-full transition-colors md:size-8";

  return (
    <div className="rounded-[26px] border border-stone-200/90 bg-white p-2.5 shadow-[0_12px_32px_-16px_rgba(28,25,23,0.22)] md:p-3">
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2 px-1 pt-1">
          {attachments.map((a, i) => (
            <div key={i} className="relative">
              {a.mime.startsWith("image/") ? (
                <AuthenticatedImage src={a.url} className="h-14 w-14 rounded-xl border border-stone-200 object-cover" />
              ) : (
                <span className="flex h-14 max-w-40 items-center truncate rounded-xl border border-stone-200 bg-stone-100 px-2.5 text-2xs text-stone-600">{a.name}</span>
              )}
              <button
                className="absolute -right-1.5 -top-1.5 grid size-6 place-items-center rounded-full bg-stone-800 text-white shadow hover:bg-red-600"
                onClick={() => setAttachments(attachments.filter((_, j) => j !== i))}
                aria-label="첨부 제거"
              ><X size={12} strokeWidth={2.5} /></button>
            </div>
          ))}
        </div>
      )}
      <input ref={fileRef} type="file" multiple accept="image/*,.pdf,.txt,.md" className="hidden" onChange={(e) => { if (e.target.files) upload(e.target.files); e.target.value = ""; }} />
      {queued.length > 0 && (
        <div className="mb-2 space-y-1 px-1">
          {queued.map((q, i) => (
            <div key={i} className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 py-1 pl-3 pr-1 text-xs text-stone-600">
              <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-500" />
              <span className="min-w-0 flex-1 truncate"><span className="text-amber-700">대기 중</span> {q.text}</span>
              {onSteer && (
                <button onClick={() => onSteer(i)} className="shrink-0 rounded-lg bg-amber-200 px-2 py-1 text-2xs text-amber-800 hover:bg-amber-300" title="대기하지 않고 지금 실행 중인 작업에 지시를 주입">
                  지금 지시
                </button>
              )}
              <button onClick={() => onRemoveQueued(i)} className="grid size-8 shrink-0 place-items-center rounded-lg text-stone-400 hover:bg-amber-100 hover:text-stone-700" title="대기열에서 제거"><X size={14} /></button>
            </div>
          ))}
        </div>
      )}
      {slashMatches.length > 0 && (
        <div className="mb-2 rounded-xl border border-stone-200 bg-white p-1">
          {slashMatches.map((sk) => (
            <button
              key={sk.id}
              className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-stone-100"
              onClick={() => { setText(`/${sk.name} `); ref.current?.focus(); }}
            >
              <span className="font-mono text-sky-600">/{sk.name}</span>
              <span className="truncate text-stone-500">{sk.prompt.slice(0, 40)}</span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        className="max-h-48 w-full resize-none bg-transparent px-2 py-1.5 text-base leading-relaxed outline-none placeholder:text-stone-400 md:text-[15px]"
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
      {/* 도구 줄 — 모바일은 [첨부·모델 … 마이크·전송] 한 줄 + 모드 칩 가로 스크롤 한 줄, 데스크톱은 한 줄 */}
      <div className="mt-1 flex flex-wrap items-center gap-1.5 md:mt-1.5 md:flex-nowrap md:gap-2">
        <button
          onClick={() => fileRef.current?.click()}
          className={`${iconBtn} text-stone-500 hover:bg-stone-100 hover:text-stone-800`}
          title="이미지/파일 첨부"
          aria-label="이미지/파일 첨부"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l8.57-8.57A4 4 0 1118 8.84l-8.59 8.57a2 2 0 01-2.83-2.83l8.49-8.48" /></svg>
        </button>
        <ModelPicker models={models} value={model} onChange={onModelChange} />
        <div className="flex-1" />
        <div className="no-scrollbar order-last -mx-2.5 flex w-[calc(100%+1.25rem)] items-center gap-1.5 overflow-x-auto px-2.5 pb-0.5 pt-1 md:order-none md:mx-0 md:w-auto md:overflow-visible md:p-0">
          <select
            className="h-9 max-w-[120px] shrink-0 rounded-full bg-stone-100 pl-3 pr-2 text-xs text-stone-700 outline-none hover:bg-stone-200 md:h-8"
            value={personaId}
            onChange={(e) => onPersonaChange(e.target.value)}
            title="페르소나"
          >
            {personas.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <select
            className={`h-9 max-w-[110px] shrink-0 rounded-full pl-3 pr-2 text-xs outline-none md:h-8 ${taskMode !== "default" ? "bg-red-100 text-red-700" : "bg-stone-100 text-stone-700 hover:bg-stone-200"}`}
            value={taskMode}
            onChange={(e) => setTaskMode(e.target.value as TaskMode)}
            title="작업 권한 — 읽기 전용: 조회·읽기 도구만 허용 / 승인 강화: 읽기 외 모든 도구에 승인 팝업"
          >
            <option value="default">권한 기본</option>
            <option value="readonly">읽기 전용</option>
            <option value="guard">승인 강화</option>
          </select>
          {chip("team", "팀", "bg-amber-600 text-white")}
          {chip("deepsearch", "DeepSearch", "bg-sky-600 text-white")}
          {chip("think", "Think", "bg-violet-600 text-white")}
          {chip("image", "이미지", "bg-emerald-600 text-white")}
        </div>
        <button
          onClick={toggleVoice}
          className={`${iconBtn} ${listening ? "animate-pulse bg-red-600 text-white" : "text-stone-500 hover:bg-stone-100 hover:text-stone-800"}`}
          title={listening ? "음성 입력 중지" : "음성으로 입력"}
          aria-label={listening ? "음성 입력 중지" : "음성으로 입력"}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" /><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4" /></svg>
        </button>
        {streaming && (
          <button onClick={onStop} className="grid size-10 shrink-0 place-items-center rounded-full border border-stone-300 bg-white text-stone-600 hover:bg-stone-100 md:size-9" title="중단 (대기 중인 명령도 취소)" aria-label="중단">
            <svg width="14" height="14" viewBox="0 0 14 14"><rect x="2" y="2" width="10" height="10" rx="2" fill="currentColor" /></svg>
          </button>
        )}
        <button
          onClick={send}
          disabled={!text.trim()}
          className="relative grid size-10 shrink-0 place-items-center rounded-full bg-stone-900 text-white transition hover:bg-stone-700 disabled:opacity-25 md:size-9"
          title={streaming ? "대기열에 추가 — 현재 응답 완료 후 자동 전송" : "전송"}
          aria-label="전송"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
          {queued.length > 0 && (
            <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-sky-600 px-1 text-micro font-bold text-white">{queued.length}</span>
          )}
        </button>
      </div>
    </div>
  );
}
