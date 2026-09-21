import { useEffect, useState } from "react";
import { AgentIcon } from "./icons";
import type { SearchEvent } from "./SearchTrace";

// 순환 상태어 — 도구 이벤트가 없을 때 순서대로 돎
const WORDS = ["생각하는 중", "검토하는 중", "작업하는 중", "이동하는 중", "읽는 중", "작성하는 중", "정리하는 중"];

// PGE 단계 → 상태어 — 파이프라인 진행 위치를 그대로 반영
export function phaseWord(phase?: string): string | null {
  if (!phase) return null;
  if (phase === "plan") return "계획하는 중";
  if (phase === "exec") return "실행하는 중";
  if (phase === "gen") return "결과 만드는 중";
  if (phase === "verify") return "확인하는 중";
  if (phase === "verify_done") return "확인 완료";
  if (phase === "done") return "마무리하는 중";
  return null;
}

// 마지막 도구 이벤트로 현재 상태어 추론 — 실제 무슨 일을 하는지 반영
export function toolWord(title?: string): string | null {
  const t = title ?? "";
  if (!t || t.includes("라운드")) return null;
  if (/web_search|DeepSearch/i.test(t)) return "검색하는 중";
  if (/browser_|ego_run/i.test(t)) return "웹 페이지 탐색 중";
  if (/agent_(direct|message|create|update|delete)/.test(t)) return "봇에게 전달하는 중";
  if (/request_credentials/.test(t)) return "계정 정보를 요청하는 중";
  if (/mail_(list|read)/.test(t)) return "메일을 확인하는 중";
  if (/org_audit/.test(t)) return "봇 조직을 점검하는 중";
  if (/write_file/.test(t)) return "작성하는 중";
  if (/read_file|list_files/.test(t)) return "읽는 중";
  if (/routine_/.test(t)) return "일정을 관리하는 중";
  if (/memory_save|checkpoint/i.test(t)) return "기억하는 중";
  if (/결과 정리|상한|제한/.test(t)) return "정리하는 중";
  return "작업하는 중";
}

// 도구명 → 한국어 작업 설명 — 사이드바에서 봇이 지금 무슨 일을 하는지 표시
export function toolLabel(tool?: string | null): string {
  const t = tool ?? "";
  if (!t) return "작업 시작";
  if (/web_search|DeepSearch/i.test(t)) return "웹 검색 중";
  if (/browser_login/i.test(t)) return "사이트 로그인 중";
  if (/browser_|ego_run/i.test(t)) return "웹 페이지 탐색 중";
  if (/agent_direct/.test(t)) return "하위 봇에 위임 중";
  if (/agent_message/.test(t)) return "다른 봇에 메시지 전달 중";
  if (/agent_(create|update|delete|list)/.test(t)) return "봇 조직 관리 중";
  if (/request_credentials/.test(t)) return "계정 입력 요청 중";
  if (/mail_(list|read)/.test(t)) return "메일 확인 중";
  if (/org_audit/.test(t)) return "봇 조직 점검 중";
  if (/write_file/.test(t)) return "파일 작성 중";
  if (/read_file|list_files/.test(t)) return "파일 읽는 중";
  if (/routine_/.test(t)) return "루틴 관리 중";
  if (/memory_save|checkpoint/i.test(t)) return "기억 저장 중";
  if (/결과 정리|상한|제한/.test(t)) return "결과 정리 중";
  return "작업 중";
}

// 봇 작업 중 표시 — 픽셀 반짝임 + 쉬머 상태어 + 움직이는 봇 얼굴
export function WorkingStatus({ events = [], agent, compact = false }: {
  events?: SearchEvent[];
  agent?: { name: string; avatar: string | null } | null;
  compact?: boolean;
}) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((v) => v + 1), 1700);
    return () => clearInterval(t);
  }, []);
  // 최신 이벤트 우선 — 단계 이벤트가 있으면 그 위치를, 없으면 도구 이벤트로 추론
  const lastPhase = [...events].reverse().find((e) => e.type === "phase")?.phase;
  const tw = phaseWord(lastPhase) ?? toolWord([...events].reverse().find((e) => e.title)?.title);
  const word = tw ?? WORDS[i % WORDS.length];
  return (
    <div className={`flex items-center gap-2 ${compact ? "text-xs" : "text-sm"} text-stone-600`}>
      {agent && !compact && <AgentIcon name={agent.name} seed={agent.avatar} size={20} working />}
      <span className="mb-spark text-sky-600/80"><i /><i /><i /><i /></span>
      <span key={word} className="mb-shimmer mb-word font-semibold tracking-wide">{word}…</span>
      {agent && !compact && <span className="text-2xs text-stone-400">{agent.name}</span>}
    </div>
  );
}
