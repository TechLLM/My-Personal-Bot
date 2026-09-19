// 봇 아바타 — 이름/시드 해시로 결정되는 흑백 3D 얼굴
// 몸체(원형·둥근 사각·마름모·육각) × 톤(광택 검정 / 흰 세라믹)은 미리 렌더한 3D 이미지, 눈(6종)·입(3종)은 그 위의 SVG
// → 눈 깜빡임·시선·작업 중 들썩임 애니메이션은 그대로 동작
import circleDark from "./faces/circle-dark.webp";
import circleLight from "./faces/circle-light.webp";
import squircleDark from "./faces/squircle-dark.webp";
import squircleLight from "./faces/squircle-light.webp";
import diamondDark from "./faces/diamond-dark.webp";
import diamondLight from "./faces/diamond-light.webp";
import hexagonDark from "./faces/hexagon-dark.webp";
import hexagonLight from "./faces/hexagon-light.webp";
import logo3d from "./logo-3d.webp";

function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const INK = "#0B0B0C";
const PAPER = "#FAFAF9";

// 3D 몸체 — Three.js 정면 직교 카메라 렌더(256px 투명 WebP, 좌표가 viewBox 24와 일치)
// 쿠션형 돌출(bevel 4 · 두께 3.4) + 스튜디오 반사 환경, [광택 검정 clearcoat, 흰 세라믹]
const BODIES: [string, string][] = [
  [circleDark, circleLight],
  [squircleDark, squircleLight],
  [diamondDark, diamondLight],
  [hexagonDark, hexagonLight],
];

const EYE_Y = 12.6;
const EYE_X = 8.7; // 왼쪽 눈 x — 오른쪽은 24-x 대칭
const line = { fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round" as const };

function Eyes({ kind }: { kind: number }) {
  const l = EYE_X, r = 24 - EYE_X, y = EYE_Y;
  const arc = (x: number) => `M${x - 1.6} ${y + 0.7} Q${x} ${y - 1.5} ${x + 1.6} ${y + 0.7}`;
  switch (kind) {
    case 0: // 동그란 눈
      return (<><circle cx={l} cy={y} r="1.75" fill="currentColor" /><circle cx={r} cy={y} r="1.75" fill="currentColor" /></>);
    case 1: // 기쁜 눈 (∧∧)
      return (<><path d={arc(l)} {...line} /><path d={arc(r)} {...line} /></>);
    case 2: // 졸린 눈 (--)
      return (<><path d={`M${l - 1.6} ${y + 0.2} h3.2`} {...line} /><path d={`M${r - 1.6} ${y + 0.2} h3.2`} {...line} /></>);
    case 3: // 캡슐 눈
      return (<><rect x={l - 1.1} y={y - 2.2} width="2.2" height="4.4" rx="1.1" fill="currentColor" /><rect x={r - 1.1} y={y - 2.2} width="2.2" height="4.4" rx="1.1" fill="currentColor" /></>);
    case 4: // 윙크 (o-)
      return (<><circle cx={l} cy={y} r="1.7" fill="currentColor" /><path d={arc(r)} {...line} /></>);
    default: // 십자 눈 (++)
      return (<><path d={`M${l - 1.5} ${y} h3 M${l} ${y - 1.5} v3`} {...line} strokeWidth={1.8} /><path d={`M${r - 1.5} ${y} h3 M${r} ${y - 1.5} v3`} {...line} strokeWidth={1.8} /></>);
  }
}

function Mouth({ kind }: { kind: number }) {
  const s = { ...line, strokeWidth: 1.6 };
  switch (kind) {
    case 0: return <path d="M10.8 15.9 Q12 17.1 13.2 15.9" {...s} />; // 미소
    case 1: return <circle cx="12" cy="16.4" r="0.95" fill="currentColor" />; // 동그란 입
    default: return <path d="M10.9 16.3 h2.2" {...s} />; // 일자 입
  }
}

// seed가 "face:" 접두면 그것을, 아니면 name 해시 사용 — 같은 봇은 항상 같은 얼굴
export function AgentIcon({ name, seed, size = 14, className = "", working = false }: { name?: string | null; seed?: string | null; size?: number; className?: string; working?: boolean }) {
  const raw = seed?.startsWith("face:") ? seed.slice(5) : (name ?? seed ?? "?");
  const h = hash(raw);
  const shape = h % 4;
  const eye = (h >> 3) % 6;
  const solid = ((h >> 15) & 1) === 0; // 15비트 — 형태·눈 비트와 겹치지 않아 톤이 고르게 갈림
  const mouth = (h >> 9) % 3;
  const delay = ((h >> 11) % 50) / 10; // 인스턴스마다 다른 애니메이션 위상
  const lift = Math.max(1, Math.round(size * 0.06)); // 크기에 비례한 바닥 그림자
  return (
    <span
      className={`relative inline-block shrink-0 align-middle ${className}${working ? " mb-working" : ""}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <img
        src={BODIES[shape][solid ? 0 : 1]}
        alt=""
        draggable={false}
        className="pointer-events-none absolute inset-0 size-full select-none"
        style={{ filter: `drop-shadow(0 ${lift}px ${lift * 1.5}px rgba(28,25,23,${solid ? 0.26 : 0.24}))` }}
      />
      <svg width={size} height={size} viewBox="0 0 24 24" className="absolute inset-0" style={{ color: solid ? PAPER : INK }}>
        {/* 3D 몸체는 가장자리가 둥글게 떨어지므로 이목구비를 평평한 앞면 안쪽으로 모은다 */}
        <g transform="translate(12 12) scale(0.9) translate(-12 -12)">
          <g className="mb-look" style={{ animationDelay: `-${delay}s` }}>
            <g className="mb-eyes" style={{ animationDelay: `-${delay}s` }}>
              <Eyes kind={eye} />
            </g>
          </g>
          <Mouth kind={mouth} />
        </g>
      </svg>
    </span>
  );
}

// MyBot 브랜드 마크 — 3D 렌더: 광택 검정 타일 위 흰 세라믹 봇 머리(안테나·말풍선 꼬리·광택 캡슐 눈)
// 파비콘·홈 화면·PWA 아이콘(public/)도 같은 렌더에서 만듦
export function BrandMark({ size = 32, className = "" }: { size?: number; className?: string }) {
  const lift = Math.max(1, Math.round(size * 0.05));
  return (
    <img
      src={logo3d}
      width={size}
      height={size}
      alt=""
      aria-hidden
      draggable={false}
      className={`select-none ${className}`}
      style={{ filter: `drop-shadow(0 ${lift}px ${lift * 1.5}px rgba(28,25,23,0.22))` }}
    />
  );
}
