// 화면 테마 — 팔레트 변수만 뒤집으면 되므로(index.css) 여기서는 html.dark 토글만 관리한다
export type Theme = "light" | "dark" | "system";

const KEY = "mybot-theme";
const media = () => window.matchMedia("(prefers-color-scheme: dark)");

export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export const isDark = () => document.documentElement.classList.contains("dark");

export function applyTheme(t: Theme) {
  try { localStorage.setItem(KEY, t); } catch {}
  const dark = t === "dark" || (t === "system" && media().matches);
  document.documentElement.classList.toggle("dark", dark);
  // iframe 미리보기처럼 문서를 직접 만드는 곳이 다시 그리도록 알린다
  window.dispatchEvent(new CustomEvent("mybot-theme", { detail: { dark } }));
}

// 시스템 설정을 따르는 중이면 OS 전환에 맞춰 같이 바뀐다
media().addEventListener("change", () => { if (getTheme() === "system") applyTheme("system"); });
