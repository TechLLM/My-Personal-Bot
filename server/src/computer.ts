// macOS 데스크톱 컴퓨터 사용 — 그록봇의 "이 컴퓨터에서 실행"에 대응.
// 비전 모델이 화면을 보고 조작 좌표를 정하면 CGEvent로 실제 클릭·입력한다.
// 브라우저 밖(네이티브 앱·Finder·메뉴)까지 닿는 점이 browser_*·ego_run과 다른 점.
// 추가 설치 불필요 — macOS 기본 screencapture + osascript(JXA CGEvent)만 사용한다.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, unlinkSync } from "node:fs";

const execFileP = promisify(execFile);
const SHOT = join(tmpdir(), `mybot-screen-${process.pid}.png`);
const SHOT_JPG = join(tmpdir(), `mybot-screen-${process.pid}.jpg`);

// osascript -l JavaScript 로 CGEvent를 보낸다. 실측으로 확인된 동작 경로.
async function jxa(body: string): Promise<string> {
  const src = `ObjC.import("Quartz");ObjC.import("CoreGraphics");ObjC.import("AppKit");${body}`;
  const { stdout } = await execFileP("osascript", ["-l", "JavaScript", "-e", src], { timeout: 15_000 });
  return String(stdout ?? "").trim();
}
async function applescript(line: string): Promise<string> {
  const { stdout } = await execFileP("osascript", ["-e", line], { timeout: 15_000 });
  return String(stdout ?? "").trim();
}

// 화면 논리 크기 (포인트) — Retina는 스크린샷 픽셀=논리×배율. 클릭 좌표는 논리 포인트.
async function screenSize(): Promise<{ w: number; h: number }> {
  const out = await jxa(`var f=$.NSScreen.mainScreen.frame; JSON.stringify({w:f.size.width,h:f.size.height});`);
  try { const p = JSON.parse(out); return { w: Math.round(p.w), h: Math.round(p.h) }; }
  catch { return { w: 1920, h: 1080 }; }
}

async function shotPath(): Promise<string> {
  await execFileP("screencapture", ["-x", SHOT], { timeout: 10_000 });
  return SHOT;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export async function computerTool(name: string, args: Record<string, unknown>): Promise<string> {
  const { w: SW, h: SH } = await screenSize();
  switch (name) {
    case "computer_look": {
      // 전체 화면 캡처 → JPEG로 줄여 비전 모델이 UI 요소와 좌표를 읽는다.
      await shotPath();
      await execFileP("sips", ["-Z", "1440", "-s", "format", "jpeg", "-s", "formatOptions", "70", SHOT, "--out", SHOT_JPG], { timeout: 15_000 });
      const { resolveVisionModel } = await import("./browser");
      const pick = await resolveVisionModel();
      if (!pick) return `[화면 분석 불가 — 이미지 입력 모델이 인증돼 있지 않습니다. 설정에서 비전 모델을 지정하세요]`;
      const q = String(args.question ?? "이 macOS 화면을 분석해줘");
      const scaleNote = `이 이미지는 화면 픽셀 기준입니다. 실제 클릭 좌표는 논리 포인트(화면 ${SW}x${SH})로 나눠야 합니다. 각 요소의 좌표를 알려줄 때는 반드시 논리 포인트(x,y)로 — 이미지 픽셀 좌표를 논리 화면 크기 비율로 환산해서 답하세요.`;
      try {
        const { chatOnce } = await import("./providers/openaiCompat");
        const res = await chatOnce(pick.endpoint, pick.model, [
          { role: "user", content: [
            { type: "text", text: `${q}\n\n${scaleNote}\n\n보이는 앱·창·버튼·입력 필드를 나열하고, 클릭 가능한 주요 요소는 "이름 — 논리좌표 (x,y)" 형식으로 적어주세요.` },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${readFileSync(SHOT_JPG).toString("base64")}` } },
          ] },
        ], { signal: AbortSignal.timeout(120_000) });
        if (res.content?.trim()) return `[화면 분석 — ${pick.endpoint.id}/${pick.model} · 논리화면 ${SW}x${SH}]\n${res.content}`;
        return "화면 분석 결과가 비어 있습니다 — 다시 시도하거나 computer_apps로 실행 중인 앱을 확인하세요.";
      } catch (e) {
        return `화면 분석 실패 — ${(e as Error).message}`;
      } finally { try { unlinkSync(SHOT); unlinkSync(SHOT_JPG); } catch {} }
    }
    case "computer_apps": {
      const names = await applescript(`tell application "System Events" to get name of every process whose background only is false`);
      return `[실행 중인 앱]\n${names}\n\ncomputer_activate("이름")으로 전면에 띄운 뒤 computer_look으로 화면을 확인하세요.`;
    }
    case "computer_activate": {
      const app = String(args.app ?? "").trim();
      if (!app) return "app 이름이 필요합니다 — computer_apps로 실행 중인 앱을 확인하세요.";
      await applescript(`tell application "${app.replace(/"/g, "")}" to activate`);
      await new Promise((r) => setTimeout(r, 700));
      return `${app}을(를) 전면으로 올렸습니다 — computer_look으로 결과를 확인하세요.`;
    }
    case "computer_click": case "computer_doubleclick": case "computer_rightclick": {
      const x = clamp(Number(args.x ?? 0), 0, SW), y = clamp(Number(args.y ?? 0), 0, SH);
      const dbl = name === "computer_doubleclick", right = name === "computer_rightclick";
      const btn = right ? "$.kCGMouseButtonRight" : "$.kCGMouseButtonLeft";
      const dn = right ? "$.kCGEventRightMouseDown" : "$.kCGEventLeftMouseDown";
      const up = right ? "$.kCGEventRightMouseUp" : "$.kCGEventLeftMouseUp";
      await jxa(`var p=$.CGPointMake(${x},${y});var m=$.CGEventCreateMouseEvent(null,$.kCGEventMouseMoved,p,0);$.CGEventPost($.kCGHIDEventTap,m);delay(0.08);` +
        (dbl
          ? `for(var i=0;i<2;i++){var d=$.CGEventCreateMouseEvent(null,${dn},p,${btn});$.CGEventPost($.kCGHIDEventTap,d);var u=$.CGEventCreateMouseEvent(null,${up},p,${btn});$.CGEventPost($.kCGHIDEventTap,u);delay(0.05);}`
          : `var d=$.CGEventCreateMouseEvent(null,${dn},p,${btn});$.CGEventPost($.kCGHIDEventTap,d);delay(0.05);var u=$.CGEventCreateMouseEvent(null,${up},p,${btn});$.CGEventPost($.kCGHIDEventTap,u);`));
      return `${name} (${Math.round(x)},${Math.round(y)}) — computer_look으로 결과를 확인하세요.`;
    }
    case "computer_type": {
      const text = String(args.text ?? "");
      if (!text) return "text가 필요합니다.";
      // 한글·유니코드 안전을 위해 클립보드 경유 붙여넣기 (keystroke는 한글을 못 침)
      await jxa(`var pb=$.NSPasteboard.generalPasteboard;pb.clearContents;pb.setStringForType(${JSON.stringify(text)},$.NSPasteboardTypeString);` +
        `var app=Application("System Events");app.keystroke("v",{using:"command down"});`);
      return `텍스트 입력 (${text.length}자) — computer_look으로 결과를 확인하세요.`;
    }
    case "computer_key": {
      const key = String(args.key ?? "").toLowerCase();
      const codes: Record<string, number> = { return: 36, enter: 36, esc: 53, escape: 53, tab: 48, space: 49, delete: 51, backspace: 51, up: 126, down: 125, left: 123, right: 124, home: 115, end: 119, pageup: 116, pagedown: 121 };
      // 수정키 목록 — command/option/shift/control 조합
      const modList = [args.command && "command down", args.option && "option down", args.shift && "shift down", args.control && "control down"].filter(Boolean).join(",");
      const using = modList ? ` using {${modList}}` : "";
      if (key in codes) {
        await applescript(`tell application "System Events" to key code ${codes[key]}${using}`);
      } else if (/^[a-z0-9]$/.test(key)) {
        await applescript(`tell application "System Events" to keystroke "${key}"${using}`);
      } else {
        return `지원 키: ${Object.keys(codes).join(", ")} 또는 단일 문자(a-z,0-9) — 수정키와 조합해 단축키로 씁니다.`;
      }
      return `${key}${using ? ` ${using}` : ""} 입력 — computer_look으로 결과를 확인하세요.`;
    }
    case "computer_scroll": {
      const x = clamp(Number(args.x ?? SW / 2), 0, SW), y = clamp(Number(args.y ?? SH / 2), 0, SH);
      const clicks = Number(args.clicks ?? -3); // 음수=아래로
      await jxa(`var m=$.CGEventCreateMouseEvent(null,$.kCGEventMouseMoved,$.CGPointMake(${x},${y}),0);$.CGEventPost($.kCGHIDEventTap,m);delay(0.08);var e=$.CGEventCreateScrollWheelEvent(null,$.kCGScrollEventUnitLine,1,${clicks});$.CGEventPost($.kCGHIDEventTap,e);`);
      return `스크롤 (${Math.round(x)},${Math.round(y)}) ${clicks < 0 ? "아래로" : "위로"} ${Math.abs(clicks)}줄 — computer_look으로 확인하세요.`;
    }
    case "computer_drag": {
      const x1 = clamp(Number(args.x1 ?? 0), 0, SW), y1 = clamp(Number(args.y1 ?? 0), 0, SH);
      const x2 = clamp(Number(args.x2 ?? 0), 0, SW), y2 = clamp(Number(args.y2 ?? 0), 0, SH);
      await jxa(`var a=$.CGPointMake(${x1},${y1}),b=$.CGPointMake(${x2},${y2});var d=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseDown,a,$.kCGMouseButtonLeft);$.CGEventPost($.kCGHIDEventTap,d);delay(0.15);var m=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseDragged,b,$.kCGMouseButtonLeft);$.CGEventPost($.kCGHIDEventTap,m);delay(0.15);var u=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseUp,b,$.kCGMouseButtonLeft);$.CGEventPost($.kCGHIDEventTap,u);`);
      return `드래그 (${Math.round(x1)},${Math.round(y1)}) → (${Math.round(x2)},${Math.round(y2)}) — computer_look으로 확인하세요.`;
    }
    default:
      return `알 수 없는 도구: ${name}`;
  }
}

export const COMPUTER_TOOLS = [
  { type: "function", function: { name: "computer_look", description: "macOS 화면 전체를 캡처해 비전 모델이 분석합니다 — 앱·창·버튼·입력 필드와 클릭 가능 요소의 논리 좌표를 돌려줍니다. 데스크톱 작업은 반드시 이걸로 화면을 확인한 뒤 좌표로 조작하세요.", parameters: { type: "object", properties: { question: { type: "string", description: "화면에서 알고 싶은 것" } } } } },
  { type: "function", function: { name: "computer_apps", description: "실행 중인 macOS 앱 목록을 확인합니다 — 데스크톱 작업 전 어떤 앱이 떠 있는지 파악할 때 쓰세요.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "computer_activate", description: "앱을 전면으로 올립니다 — 대상 앱이 뒤에 있으면 먼저 호출해 앞에 띄우세요.", parameters: { type: "object", properties: { app: { type: "string", description: "앱 이름 (computer_apps로 확인)" } }, required: ["app"] } } },
  { type: "function", function: { name: "computer_click", description: "화면 논리 좌표를 클릭합니다 — computer_look이 준 좌표로 지목하세요.", parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } } },
  { type: "function", function: { name: "computer_doubleclick", description: "화면 논리 좌표를 더블클릭합니다.", parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } } },
  { type: "function", function: { name: "computer_rightclick", description: "화면 논리 좌표를 우클릭합니다 — 컨텍스트 메뉴를 열 때.", parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } } },
  { type: "function", function: { name: "computer_type", description: "현재 포커스된 곳에 텍스트를 입력합니다 — 한글·유니코드도 안전하게 들어갑니다. 입력할 필드를 먼저 computer_click으로 포커스하세요.", parameters: { type: "object", properties: { text: { type: "string", description: "입력할 텍스트" } }, required: ["text"] } } },
  { type: "function", function: { name: "computer_key", description: "특수 키를 누릅니다 — return/esc/tab/space/delete/방향키/home/end/pageup/pagedown. command/option/shift/control을 true로 주면 수정키와 함께 누릅니다 (예: command+space=Spotlight).", parameters: { type: "object", properties: { key: { type: "string" }, command: { type: "boolean" }, option: { type: "boolean" }, shift: { type: "boolean" }, control: { type: "boolean" } }, required: ["key"] } } },
  { type: "function", function: { name: "computer_scroll", description: "화면 좌표에서 스크롤합니다 — clicks가 음수면 아래로, 양수면 위로.", parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, clicks: { type: "number", description: "음수=아래, 양수=위 (기본 -3)" } } } } },
  { type: "function", function: { name: "computer_drag", description: "좌표 (x1,y1)에서 (x2,y2)로 드래그합니다.", parameters: { type: "object", properties: { x1: { type: "number" }, y1: { type: "number" }, x2: { type: "number" }, y2: { type: "number" } }, required: ["x1", "y1", "x2", "y2"] } } },
];
