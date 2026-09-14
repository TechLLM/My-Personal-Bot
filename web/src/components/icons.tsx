import { Bot, Search, PenLine, Code2, BarChart3, Globe, FileText, Cpu, Zap, BrainCircuit, ShieldCheck, MessagesSquare } from "lucide-react";

// 봇 아이콘 풀 — 이름 해시로 결정적 배정 (이모지 아바타 대체)
const POOL = [Bot, Search, PenLine, Code2, BarChart3, Globe, FileText, Cpu, Zap, BrainCircuit, ShieldCheck, MessagesSquare];

export function AgentIcon({ name, size = 14, className = "" }: { name?: string | null; size?: number; className?: string }) {
  const h = [...(name ?? "")].reduce((a, c) => a + c.charCodeAt(0), 0);
  const I = POOL[h % POOL.length];
  return <I size={size} strokeWidth={1.8} className={className} />;
}
