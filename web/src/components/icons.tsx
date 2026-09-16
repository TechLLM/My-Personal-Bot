// 봇 아바타 — 이름/시드 해시로 결정되는 선형 얼굴 아이콘
// 테두리(원형·사각·마름모·육각) × 눈 표정(6종) × 색조 해시 조합 + 눈 깜빡임·시선 애니메이션
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const EYES_AT: [number, number] = [9.4, 12.3]; // 왼쪽 눈 x, 눈 y — 오른쪽은 24-x 대칭

function EyeShapes({ kind }: { kind: number }) {
  const [lx, y] = EYES_AT;
  const rx = 24 - lx;
  switch (kind) {
    case 0: // 동그란 눈
      return (<><circle cx={lx} cy={y} r="1.35" fill="currentColor" /><circle cx={rx} cy={y} r="1.35" fill="currentColor" /></>);
    case 1: // 기쁜 눈 (∧∧)
      return (<><path d={`M${lx - 1.3} ${y + 0.5} Q${lx} ${y - 1.4} ${lx + 1.3} ${y + 0.5}`} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><path d={`M${rx - 1.3} ${y + 0.5} Q${rx} ${y - 1.4} ${rx + 1.3} ${y + 0.5}`} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></>);
    case 2: // 졸린 눈 (--)
      return (<><path d={`M${lx - 1.2} ${y} h2.4`} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><path d={`M${rx - 1.2} ${y} h2.4`} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></>);
    case 3: // 세로 타원 눈
      return (<><ellipse cx={lx} cy={y} rx="0.95" ry="1.7" fill="currentColor" /><ellipse cx={rx} cy={y} rx="0.95" ry="1.7" fill="currentColor" /></>);
    case 4: // 윙크 (o-)
      return (<><circle cx={lx} cy={y} r="1.3" fill="currentColor" /><path d={`M${rx - 1.3} ${y + 0.4} Q${rx} ${y - 0.9} ${rx + 1.3} ${y + 0.4}`} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></>);
    default: // 반짝임 눈 (++)
      return (<><path d={`M${lx - 1.1} ${y} h2.2 M${lx} ${y - 1.1} v2.2`} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><path d={`M${rx - 1.1} ${y} h2.2 M${rx} ${y - 1.1} v2.2`} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></>);
  }
}

function BorderShape({ kind }: { kind: number }) {
  const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.7 };
  switch (kind) {
    case 0: return <circle cx="12" cy="12" r="8.6" {...p} />;
    case 1: return <rect x="4" y="4" width="16" height="16" rx="4.5" {...p} />;
    case 2: return <rect x="5.7" y="5.7" width="12.6" height="12.6" rx="2.5" transform="rotate(45 12 12)" {...p} />;
    default: return <polygon points="12,3.2 19.8,7.6 19.8,16.4 12,20.8 4.2,16.4 4.2,7.6" {...p} strokeLinejoin="round" />;
  }
}

// seed가 "face:" 접두면 그것을, 아니면 name 해시 사용 — 같은 봇은 항상 같은 얼굴
export function AgentIcon({ name, seed, size = 14, className = "", working = false }: { name?: string | null; seed?: string | null; size?: number; className?: string; working?: boolean }) {
  const raw = seed?.startsWith("face:") ? seed.slice(5) : (name ?? seed ?? "?");
  const h = hash(raw);
  const shape = h % 4;
  const eye = (h >> 3) % 6;
  const hue = 175 + ((h >> 6) % 165); // 청록~보라 계열 차가운 톤
  const delay = ((h >> 11) % 50) / 10; // 인스턴스마다 다른 애니메이션 위상
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24"
      className={`${className}${working ? " mb-working" : ""}`}
      style={{ color: `hsl(${hue} 38% 44%)` }}
      aria-hidden
    >
      <g className="mb-look" style={{ animationDelay: `-${delay}s` }}>
        <g className="mb-eyes" style={{ animationDelay: `-${delay}s` }}>
          <EyeShapes kind={eye} />
        </g>
      </g>
      <BorderShape kind={shape} />
    </svg>
  );
}
