import { useState } from "react";
import { api, type ApprovalRequest } from "../api";
import { ShieldAlert, Check, X, Ban } from "lucide-react";

// 승인 경계 — 봇이 위험 액션(발신·삭제·결제 류)을 실행하기 전 사용자 승인을 받는 팝업.
// 그록봇 Auto Review 대응: Allow once / Deny / Always allow. 승인 시 서버가 저장된 도구를 실행하고 봇 작업을 재개한다.
export function ApprovalModal({ request, onDone }: { request: ApprovalRequest; onDone: () => void }) {
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); onDone(); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/30 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-stone-200 bg-white p-5 shadow-[0_8px_30px_rgba(0,0,0,0.06)]">
        <div className="mb-4 flex items-start gap-3">
          <div className="rounded-xl bg-amber-50 p-2 text-amber-600"><ShieldAlert size={18} /></div>
          <div className="flex-1">
            <h2 className="text-sm font-semibold">봇이 승인을 요청했습니다</h2>
            <p className="mt-0.5 text-xs leading-relaxed text-stone-500">
              {request.agent_name ? <b className="text-stone-700">{request.agent_name}</b> : "봇"}이 외부 영향이 있는 작업을 실행하려 합니다.
            </p>
          </div>
        </div>
        <div className="rounded-lg bg-stone-200/70 px-3 py-2.5">
          <div className="font-mono text-caption text-amber-700">{request.tool}</div>
          <div className="mt-1 break-all text-xs leading-relaxed text-stone-600">{request.summary}</div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button onClick={() => act(() => api.approveRequest(request.id))} disabled={busy}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 py-2 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-40">
            <Check size={13} /> 승인
          </button>
          <button onClick={() => act(() => api.denyRequest(request.id))} disabled={busy}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-stone-200 py-2 text-xs text-stone-700 hover:bg-stone-300 disabled:opacity-40">
            <X size={13} /> 거부
          </button>
          <button onClick={() => act(() => api.approveRequest(request.id, true))} disabled={busy}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-stone-200 py-2 text-caption text-stone-600 hover:text-stone-800 disabled:opacity-40">
            <Check size={12} /> 이 도구 항상 허용
          </button>
          <button onClick={() => act(() => api.denyRequest(request.id, true))} disabled={busy}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-stone-200 py-2 text-caption text-stone-500 hover:text-stone-700 disabled:opacity-40">
            <Ban size={12} /> 이 도구 항상 승인 필요
          </button>
        </div>
        <p className="mt-3 text-2xs leading-relaxed text-stone-400">
          승인하면 서버가 이 작업을 실제로 실행하고 봇의 원래 업무를 자동으로 이어갑니다.
        </p>
      </div>
    </div>
  );
}
