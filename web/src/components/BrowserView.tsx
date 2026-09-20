import { useEffect, useRef, useState } from "react";
import { X, Monitor } from "lucide-react";
import { AuthenticatedEventStream } from "../api";

interface Frame {
  image: string;
  url: string;
  title: string;
  action: string;
}

// 컴퓨터 뷰 (A3) — 봇 실행 중 브라우저 화면을 2.5초 간격 SSE 프레임으로 받아 표시.
// run 키별로 구독하며, 서버는 보는 사람이 있을 때만 캡처를 돌린다.
export function BrowserView({ viewKey, onClose }: { viewKey: string; onClose: () => void }) {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [live, setLive] = useState(false);
  const esRef = useRef<AuthenticatedEventStream | null>(null);

  useEffect(() => {
    const es = new AuthenticatedEventStream(`/api/browser/view/${encodeURIComponent(viewKey)}`);
    esRef.current = es;
    es.addEventListener("frame", (e) => {
      try { setFrame(JSON.parse((e as MessageEvent).data)); setLive(true); } catch {}
    });
    es.onerror = () => setLive(false);
    return () => { es.close(); esRef.current = null; };
  }, [viewKey]);

  return (
    <div className="fixed inset-x-3 top-[calc(4rem+env(safe-area-inset-top))] z-40 overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-[0_12px_40px_rgba(0,0,0,0.12)] md:inset-x-auto md:bottom-4 md:right-4 md:top-auto md:w-[420px]">
      <div className="flex items-center gap-2 border-b border-stone-100 py-1 pl-3 pr-1">
        <Monitor size={14} className={live ? "text-emerald-600" : "text-stone-400"} />
        <span className="flex-1 truncate text-xs font-medium text-stone-700">
          봇 화면{live ? "" : " — 대기 중"}
        </span>
        <button onClick={onClose} className="grid size-9 place-items-center rounded-lg text-stone-400 hover:bg-stone-100 hover:text-stone-700 md:size-8" aria-label="봇 화면 닫기"><X size={16} /></button>
      </div>
      <div className="aspect-[16/10] w-full bg-stone-950">
        {frame ? (
          <img src={`data:image/jpeg;base64,${frame.image}`} alt="봇 브라우저 화면" className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-stone-500">화면 수신 대기 중 — 봇이 브라우저를 열면 표시됩니다</div>
        )}
      </div>
      {frame && (
        <div className="border-t border-stone-100 px-3 py-1.5">
          {frame.action && <div className="truncate text-2xs text-stone-400">{frame.action}</div>}
          <div className="truncate font-mono text-2xs text-stone-500">{frame.url}</div>
        </div>
      )}
    </div>
  );
}
