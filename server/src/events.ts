import { Hono } from "hono";

// UI 실시간 갱신 버스 — 봇 생성·삭제·수정 같은 조직 변화를 열린 탭에 SSE로 즉시 푸시
// (마운트 시 1회 로딩 + 폴링만으로는 다른 세션·봇의 변경이 새로고침 전까지 반영되지 않는다)
type UICb = (type: string) => void;
const subscribers = new Set<UICb>();

export function emitUI(type: string) {
  for (const cb of subscribers) {
    try { cb(type); } catch {}
  }
}

export const eventsRoute = new Hono().get("/", (c) => {
  const encoder = new TextEncoder();
  let unsub: (() => void) | undefined;
  let hb: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const cb: UICb = (type) => {
        try { controller.enqueue(encoder.encode(`event: ${type}\ndata: {}\n\n`)); } catch {}
      };
      subscribers.add(cb);
      unsub = () => { subscribers.delete(cb); };
      hb = setInterval(() => {
        try { controller.enqueue(encoder.encode(": ping\n\n")); } catch {}
      }, 25_000);
    },
    cancel() {
      unsub?.();
      if (hb) clearInterval(hb);
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
});
