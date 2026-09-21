// 실행 종류(채팅·봇·승인 재실행)에 관계없이 사용자 중지 신호가 닿는 공용 registry.
// AbortController 자체는 프로세스 메모리에만 두며 DB에는 상관관계만 저장한다.

type Entry = { controller: AbortController; conversationId: string | null };

const entries = new Set<Entry>();

export function registerRunController(controller: AbortController, conversationId?: string | null): () => void {
  const entry: Entry = { controller, conversationId: conversationId ?? null };
  entries.add(entry);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    entries.delete(entry);
  };
}

export function abortAllRunControllers(reason = new DOMException("사용자 전체 중지", "AbortError")): number {
  const targets = [...entries];
  for (const entry of targets) if (!entry.controller.signal.aborted) entry.controller.abort(reason);
  return targets.length;
}

export function abortConversationControllers(conversationId: string, reason = new DOMException("사용자 대화 중지", "AbortError")): number {
  if (!conversationId) return 0;
  const targets = [...entries].filter((entry) => entry.conversationId === conversationId);
  for (const entry of targets) if (!entry.controller.signal.aborted) entry.controller.abort(reason);
  return targets.length;
}

export function registeredRunControllerCount(): number {
  return entries.size;
}
