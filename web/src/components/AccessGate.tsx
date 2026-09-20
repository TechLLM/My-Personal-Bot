import { useEffect, useState, type ReactNode, type FormEvent } from "react";
import { authHeaders } from "../api";

export function AccessGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(true);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  async function check(key?: string, signal?: AbortSignal) {
    setChecking(true); setError("");
    try {
      const response = await fetch("/api/access", { headers: key ? { "x-mybot-key": key } : authHeaders(), signal });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? `접속 확인 실패 (${response.status})`);
      }
      if (signal?.aborted) return;
      if (key) localStorage.setItem("mybot_key", key);
      setPassword(""); setReady(true);
    } catch (e) {
      // 첫 방문(입력도 저장된 키도 없음)의 401은 오류가 아니라 정상적인 입력 대기 상태다
      if (!signal?.aborted && (key || localStorage.getItem("mybot_key"))) setError((e as Error).message);
    }
    finally { if (!signal?.aborted) setChecking(false); }
  }
  useEffect(() => { const c = new AbortController(); void check(undefined, c.signal); return () => c.abort(); }, []);
  useEffect(() => {
    const expired = () => { setReady(false); setChecking(false); setError("접속 인증을 다시 확인해 주세요"); };
    window.addEventListener("mybot-auth-required", expired);
    return () => window.removeEventListener("mybot-auth-required", expired);
  }, []);
  if (ready) return <>{children}</>;
  const submit = (e: FormEvent) => { e.preventDefault(); if (password.trim()) void check(password.trim()); };
  return <main className="flex min-h-screen items-center justify-center bg-stone-100 p-6">
    <form onSubmit={submit} className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-sm">
      <h1 className="text-lg font-semibold">MyBot 접속</h1>
      <p className="mt-2 text-sm text-stone-600">관리자가 준비한 접속 암호를 입력하세요. 이 브라우저에 저장됩니다.</p>
      <label className="mt-5 block text-sm" htmlFor="access-code">접속 암호</label>
      <input id="access-code" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} disabled={checking}
        className="mt-2 w-full rounded-lg border border-stone-300 p-3" />
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      <button disabled={checking || !password.trim()} className="mt-5 w-full rounded-lg bg-stone-900 p-3 text-white disabled:opacity-50">{checking ? "접속 확인 중…" : "접속"}</button>
    </form>
  </main>;
}
