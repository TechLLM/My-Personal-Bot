import { test, expect } from "bun:test";
import { backgroundize } from "./bsk";

// 봇이 사용자 브라우저를 쓸 때 화면이 앞으로 튀어나오면 사용자가 하던 일이 끊긴다.
// bsk는 --no-focus를 지원하지만 봇이 빠뜨리기 쉬우므로 코드에서 보장한다.

test("세션을 시작할 때 백그라운드 옵션을 붙인다", () => {
  expect(backgroundize("session start --json")).toBe("session start --json --no-focus");
  expect(backgroundize("session start")).toBe("session start --no-focus");
  expect(backgroundize("session start --browser chrome --json")).toBe("session start --browser chrome --json --no-focus");
});

test("이미 지정돼 있으면 덧붙이지 않는다", () => {
  expect(backgroundize("session start --no-focus --json")).toBe("session start --no-focus --json");
});

test("세션 시작이 아닌 명령은 건드리지 않는다", () => {
  for (const c of ["session stop abc123", "session list --json", "navigate https://x.test --session a", "observe --session a", "click @e3 --session a"])
    expect(backgroundize(c)).toBe(c);
});

test("이름이 비슷한 다른 명령에 잘못 붙지 않는다", () => {
  // session-start 같은 가상의 명령이나 문자열 중간의 일치에 반응하면 안 된다
  expect(backgroundize("status")).toBe("status");
  expect(backgroundize("navigate https://x.test/session/start --session a")).toBe("navigate https://x.test/session/start --session a");
});
