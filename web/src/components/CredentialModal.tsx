import { useState } from "react";
import { api, type SiteRequest } from "../api";
import { X, ShieldCheck } from "lucide-react";

// 봇이 request_credentials 도구로 요청한 계정을 사용자가 안전하게 입력하는 팝업.
// 비밀번호는 암호화되어 로컬 DB에만 저장되고 채팅 기록·모델 컨텍스트에 남지 않는다.
export function CredentialModal({ request, onDone }: { request: SiteRequest; onDone: () => void }) {
  const [name, setName] = useState(request.name);
  const [url, setUrl] = useState(request.url ?? "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim() || !url.trim() || !username.trim() || !password) return;
    setBusy(true);
    try {
      await api.addSite({ name: name.trim(), url: url.trim(), username: username.trim(), password, request_id: request.id });
      onDone();
    } finally {
      setBusy(false);
    }
  };

  const later = async () => {
    setBusy(true);
    try {
      await api.dismissSiteRequest(request.id); // 나중에 — 요청을 닫고 다시 띄우지 않음
      onDone();
    } finally {
      setBusy(false);
    }
  };

  const input = "w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm outline-none placeholder:text-zinc-600";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl">
        <div className="mb-4 flex items-start gap-3">
          <div className="rounded-xl bg-emerald-500/10 p-2 text-emerald-400"><ShieldCheck size={18} /></div>
          <div className="flex-1">
            <h2 className="text-sm font-semibold">봇이 계정 정보를 요청했습니다</h2>
            <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
              {request.reason || `"${request.name}" 로그인에 필요합니다.`}
              <br />입력한 계정은 <b className="text-zinc-300">암호화되어 이 맥미니에만</b> 저장되며, 대화 기록과 AI 모델에는 노출되지 않습니다.
            </p>
          </div>
          <button onClick={later} className="text-zinc-500 hover:text-zinc-200"><X size={16} /></button>
        </div>
        <div className="space-y-2">
          <input className={input} placeholder="사이트 이름" value={name} onChange={(e) => setName(e.target.value)} />
          <input className={input} placeholder="로그인 URL" value={url} onChange={(e) => setUrl(e.target.value)} />
          <input className={input} placeholder="아이디" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
          <input className={input} type="password" placeholder="비밀번호" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
        </div>
        <div className="mt-4 flex gap-2">
          <button onClick={later} disabled={busy} className="flex-1 rounded-lg bg-zinc-800 py-2 text-xs text-zinc-400 hover:text-zinc-200">나중에</button>
          <button onClick={save} disabled={busy || !name.trim() || !url.trim() || !username.trim() || !password}
            className="flex-1 rounded-lg bg-zinc-100 py-2 text-xs font-semibold text-zinc-900 disabled:opacity-40">
            {busy ? "저장 중…" : "암호화하여 저장"}
          </button>
        </div>
      </div>
    </div>
  );
}
