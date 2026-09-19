import { useEffect, useState } from "react";
import { mybotFetch } from "../api";

// Only local protected files receive auth headers; remote image URLs never do.
export function AuthenticatedImage({ src = "", alt = "", className }: { src?: string; alt?: string; className?: string }) {
  const local = (() => {
    try { const u = new URL(src, window.location.href); return u.origin === window.location.origin && u.pathname.startsWith("/api/files/") ? u.pathname : null; }
    catch { return null; }
  })();
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    if (!local) return;
    const controller = new AbortController();
    let blobUrl: string | null = null;
    setImage(null);
    void mybotFetch(local, { signal: controller.signal }).then(async r => {
      if (!r.ok) throw new Error("image unavailable");
      const blob = await r.blob();
      if (!controller.signal.aborted) { blobUrl = URL.createObjectURL(blob); setImage(blobUrl); }
    }).catch(() => {});
    return () => { controller.abort(); if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [local]);
  if (local && !image) return <span role="status" className="text-xs text-stone-500">이미지 로딩 대기 · 인증 또는 연결을 확인하세요</span>;
  return <img src={local ? image! : src} alt={alt} className={className} />;
}
