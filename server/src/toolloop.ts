// 도구 루프 공용 유틸 — routes/chat.ts(일반 대화)와 team.ts(봇 실행)가 함께 쓴다.
// 두 곳에 같은 코드가 복붙돼 있어 한쪽만 고치면 다른 경로에서 도구 누수 응답이
// 그대로 통과하는 문제가 있었다. 여기 한 곳만 고치면 양쪽이 같이 고쳐진다.
// (Phase 21에서 루프 본체까지 이 파일로 통합 예정)

export interface LeakedCall {
  id: string;
  name: string;
  arguments: string;
}

// 모델이 도구 호출을 텍스트 형식(<invoke name=…>)으로 새어내면 파싱해 실제 호출로 전환
export function parseLeaked(text: string): LeakedCall[] {
  const calls: LeakedCall[] = [];
  const invRe = /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g;
  let inv; let i = 0;
  while ((inv = invRe.exec(text ?? ""))) {
    const args: Record<string, string> = {};
    const pRe = /<(\w+)>([\s\S]*?)<\/\1>/g;
    let pm; while ((pm = pRe.exec(inv[2]))) args[pm[1]] = pm[2];
    calls.push({ id: `leaked-${i++}`, name: inv[1], arguments: JSON.stringify(args) });
  }
  return calls;
}
