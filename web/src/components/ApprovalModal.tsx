import { useEffect, useRef, useState } from "react";
import { api, type ApprovalRequest } from "../api";
import { ShieldAlert, Check, X, Ban } from "lucide-react";

// 승인 경계 — 봇이 위험 액션(발신·삭제·결제 류)을 실행하기 전 사용자 승인을 받는 팝업.
// 그록봇 Auto Review 대응: Allow once / Deny / Always allow. 승인 시 서버가 저장된 도구를 실행하고 봇 작업을 재개한다.
export function ApprovalModal({ request, onDone }: { request: ApprovalRequest; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [alwaysConfirmed, setAlwaysConfirmed] = useState(false);
  const requestIdRef = useRef(request.id);
  const requestSeqRef = useRef(0);

  // 새 요청은 이전 요청의 진행 중 Promise와 완전히 다른 작업 범위다. 렌더 시점에
  // 즉시 세대를 바꿔 effect 실행 전 완료되는 오래된 응답도 새 요청을 건드리지 못하게 한다.
  if (requestIdRef.current !== request.id) {
    requestIdRef.current = request.id;
    requestSeqRef.current++;
  }

  useEffect(() => {
    const sequence = requestSeqRef.current;
    setAlwaysConfirmed(false);
    setError("");
    setBusy(false);
    return () => {
      if (requestSeqRef.current === sequence) requestSeqRef.current++;
    };
  }, [request.id]);

  const act = async (fn: () => Promise<unknown>) => {
    const requestId = request.id;
    const sequence = requestSeqRef.current;
    const current = () => requestIdRef.current === requestId && requestSeqRef.current === sequence;
    setBusy(true); setError("");
    try {
      await fn();
      if (current()) onDone();
    } catch {
      if (current()) setError("요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      if (current()) setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/30 p-4">
      <div className="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-2xl border border-stone-200 bg-white p-5 shadow-[0_8px_30px_rgba(0,0,0,0.06)]">
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
          <div className="text-sm font-semibold text-stone-800">{request.title}</div>
          <div className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-stone-700">{request.summary}</div>
          <div className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-caption leading-relaxed text-amber-800">주의: {request.risk}</div>
          {request.details?.length > 0 && (
            <dl className="mt-2 space-y-1 text-caption">
              {request.details.map((d, i) => <div key={i} className="grid grid-cols-[5rem_1fr] gap-2"><dt className="text-stone-500">{d.label}</dt><dd className="whitespace-pre-wrap break-words text-stone-700">{d.value}</dd></div>)}
            </dl>
          )}
          {request.technicalDetails && (
            <details className="mt-2 text-caption text-stone-600">
              <summary className="cursor-pointer font-medium">세부 내용 확인</summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-white/70 p-2 font-mono text-2xs">{request.technicalDetails}</pre>
            </details>
          )}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button onClick={() => act(() => api.approveRequest(request.id))} disabled={busy}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 py-2 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-40">
            <Check size={13} /> 이번 요청 실행
          </button>
          <button onClick={() => act(() => api.denyRequest(request.id))} disabled={busy}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-stone-200 py-2 text-xs text-stone-700 hover:bg-stone-300 disabled:opacity-40">
            <X size={13} /> 실행하지 않기
          </button>
        </div>
        <label className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-caption leading-relaxed text-amber-900">
          <input type="checkbox" className="mt-0.5" checked={alwaysConfirmed} disabled={busy} onChange={(e) => setAlwaysConfirmed(e.target.checked)} />
          <span><b>이 종류의 작업을 앞으로도 허용</b><br />대상이나 받는 사람이 달라도 같은 종류의 모든 작업이 추가 확인 없이 실행될 수 있습니다.</span>
        </label>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button onClick={() => act(() => api.approveRequest(request.id, true))} disabled={busy || !alwaysConfirmed}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-stone-200 py-2 text-caption text-stone-600 hover:text-stone-800 disabled:opacity-40">
            <Check size={12} /> 앞으로도 허용
          </button>
          <button onClick={() => act(() => api.denyRequest(request.id, true))} disabled={busy}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-stone-200 py-2 text-caption text-stone-500 hover:text-stone-700 disabled:opacity-40">
            <Ban size={12} /> 거부하고 계속 매번 확인
          </button>
        </div>
        {error && <p role="alert" className="mt-2 rounded-lg bg-red-50 px-2.5 py-2 text-caption text-red-700">{error}</p>}
        <p className="mt-3 text-2xs leading-relaxed text-stone-400">
          승인하면 서버가 이 작업을 실제로 실행하고 봇의 원래 업무를 자동으로 이어갑니다.
        </p>
      </div>
    </div>
  );
}
