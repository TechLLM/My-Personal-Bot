import { useState } from "react";
import { api, type HandoffRequest } from "../api";
import { MousePointerClick } from "lucide-react";

// 테이크오버 — 봇이 2FA·CAPTCHA·결제처럼 사람만 풀 수 있는 화면을 만났을 때 뜨는 인계 팝업.
// 열린 브라우저 창에서 직접 처리한 뒤 "반환"을 누르면 봇이 같은 세션으로 작업을 이어간다.
export function HandoffModal({ request, onDone }: { request: HandoffRequest; onDone: () => void }) {
  const [busy, setBusy] = useState(false);

  const done = async () => {
    setBusy(true);
    try {
      await api.handoffDone(request.id);
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/30 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-stone-200 bg-white p-5 shadow-[0_8px_30px_rgba(0,0,0,0.06)]">
        <div className="mb-4 flex items-start gap-3">
          <div className="rounded-xl bg-amber-50 p-2 text-amber-600"><MousePointerClick size={18} /></div>
          <div className="flex-1">
            <h2 className="text-sm font-semibold">봇이 브라우저 제어를 넘겼습니다</h2>
            <p className="mt-0.5 text-xs leading-relaxed text-stone-500">
              {request.agent_name ? <b className="text-stone-700">{request.agent_name}</b> : "봇"} — {request.reason}
              <br />화면에 열린 브라우저 창에서 직접 처리한 뒤 <b className="text-stone-700">반환</b>을 누르세요. 로그인·인증 상태는 그대로 이어집니다.
            </p>
          </div>
        </div>
        {request.url && request.url !== "about:blank" && (
          <div className="mb-3 truncate rounded-lg bg-stone-100 px-3 py-1.5 font-mono text-[11px] text-stone-500">{request.url}</div>
        )}
        <button
          onClick={done}
          disabled={busy}
          className="w-full rounded-xl bg-amber-500 py-2.5 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
        >
          {busy ? "처리 중…" : "완료 — 봇에게 반환"}
        </button>
      </div>
    </div>
  );
}
