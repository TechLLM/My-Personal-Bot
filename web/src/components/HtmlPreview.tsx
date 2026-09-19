import { useEffect, useRef, useState } from "react";
import { Code2, Eye, Maximize2 } from "lucide-react";

// 봇이 낸 HTML을 대화창에서 렌더한다.
// 봇 출력에는 읽어온 메일·웹페이지 내용이 섞이므로 격리가 전제다:
//   sandbox="allow-scripts"만 준다 — allow-same-origin이 없으니 부모 DOM·쿠키·저장소에 닿지 못한다.
//   CSP로 default-src 'none' — fetch·XHR·외부 이미지/폰트/스크립트가 모두 막혀 화면의 업무 데이터가 밖으로 나가지 못한다.
//   인라인 <style>·<script>만 허용해 애니메이션·차트·인터랙션은 그대로 동작한다.
const CSP = `default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:;`;

// 내용 높이를 부모에 알린다 — 스크롤바 없이 딱 맞는 높이로 보여주기 위해서다
const MEASURE = `<script>
(function () {
  var send = function () {
    try { parent.postMessage({ __mybotHeight: document.documentElement.scrollHeight }, "*"); } catch (e) {}
  };
  if (window.ResizeObserver) new ResizeObserver(send).observe(document.documentElement);
  window.addEventListener("load", send);
  setTimeout(send, 60); setTimeout(send, 400); send();
})();
</script>`;

const BASE = `<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 14px; background: #fff; color: #1c1917;
    font-family: Pretendard, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 14px; line-height: 1.6; }
  * { box-sizing: border-box; }
  table { border-collapse: collapse; }
</style>`;

export function HtmlPreview({ code, streaming }: { code: string; streaming?: boolean }) {
  // 스트리밍 중에는 태그가 끊긴 상태라 렌더가 깜빡인다 — 들어오는 동안엔 코드로 보여주고 끝나면 미리보기로 전환
  const [tab, setTab] = useState<"view" | "code">(streaming ? "code" : "view");
  const [touched, setTouched] = useState(false);
  useEffect(() => { if (!streaming && !touched) setTab("view"); }, [streaming, touched]);
  const [height, setHeight] = useState(180);
  const [full, setFull] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return; // 다른 미리보기·확장 프로그램 메시지 무시
      const h = Number((e.data as { __mybotHeight?: unknown })?.__mybotHeight);
      if (Number.isFinite(h) && h > 0) setHeight(Math.min(Math.max(Math.ceil(h), 60), 1200));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const doc = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">${BASE}</head><body>${code}${MEASURE}</body></html>`;

  return (
    <div className={`my-2 overflow-hidden rounded-2xl border border-stone-200 bg-white ${full ? "fixed inset-3 z-50 flex flex-col shadow-2xl" : ""}`}>
      <div className="flex items-center gap-1 border-b border-stone-100 bg-stone-50 px-2 py-1.5">
        <button
          onClick={() => { setTouched(true); setTab("view"); }}
          className={`flex items-center gap-1 rounded-lg px-2 py-1 text-2xs ${tab === "view" ? "bg-stone-900 text-white" : "text-stone-500 hover:bg-stone-200"}`}
        >
          <Eye size={12} /> 미리보기
        </button>
        <button
          onClick={() => { setTouched(true); setTab("code"); }}
          className={`flex items-center gap-1 rounded-lg px-2 py-1 text-2xs ${tab === "code" ? "bg-stone-900 text-white" : "text-stone-500 hover:bg-stone-200"}`}
        >
          <Code2 size={12} /> 코드
        </button>
        <span className="ml-auto text-micro text-stone-400">외부 연결 차단됨</span>
        <button onClick={() => setFull(!full)} className="rounded-lg p-1 text-stone-400 hover:bg-stone-200 hover:text-stone-700" title={full ? "닫기" : "크게 보기"}>
          <Maximize2 size={12} />
        </button>
      </div>
      {tab === "view" ? (
        <iframe
          ref={frame}
          srcDoc={doc}
          sandbox="allow-scripts"
          title="결과 화면"
          className={full ? "w-full flex-1" : "w-full"}
          style={full ? undefined : { height }}
        />
      ) : (
        <pre className={`overflow-auto bg-stone-50 p-3 text-2xs leading-relaxed text-stone-700 ${full ? "flex-1" : "max-h-96"}`}>{code}</pre>
      )}
    </div>
  );
}
