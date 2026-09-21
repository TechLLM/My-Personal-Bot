import { expect, test } from "bun:test";
import { db } from "./db";
import {
  acquireBrowserLease,
  browserApprovalSnapshot,
  browserTool,
  browserToolApproved,
  cancelBrowserContext,
  captureBrowserApprovalSnapshot,
  closeAgentPage,
  evaluateBrowserVerification,
  hasBrowserLease,
  installBrowserPageForTest,
  ownsBrowserLease,
  releaseBrowserLease,
  setHandoffBrowserFactoryForTest,
} from "./browser";
import type { BrowserContext, Frame, Page } from "playwright";

if (db.filename !== ":memory:") throw new Error(`테스트가 운영 DB를 열었습니다: ${db.filename}`);

const observed = {
  url: "https://example.com/messages/sent/42",
  title: "전송 완료 | Example",
  text: "메시지를 성공적으로 보냈습니다. 받은 사람: 홍길동",
  selectors: { ".success": true, ".error": false },
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakePage(opts: { url?: string; beforeEvaluate?: () => Promise<void> } = {}) {
  let closed = false;
  let evaluations = 0;
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const frame = { url: () => opts.url ?? "https://example.test/original" } as Frame;
  const emit = (event: string, ...args: any[]) => {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  };
  const page = {
    isClosed: () => closed,
    on(event: string, listener: (...args: any[]) => void) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return page;
    },
    url: () => opts.url ?? "https://example.test/original",
    mainFrame: () => frame,
    frames: () => [frame],
    evaluate: async () => {
      evaluations++;
      await opts.beforeEvaluate?.();
      return { ok: true, value: "original-page" };
    },
    close: async () => {
      if (closed) return;
      closed = true;
      emit("close");
    },
  } as unknown as Page;
  return {
    page,
    frame,
    emit,
    evaluations: () => evaluations,
    closed: () => closed,
  };
}

test("browser_verify — 지정한 완료 증거가 모두 맞아야 통과한다", () => {
  const out = evaluateBrowserVerification({
    url_contains: "/sent/",
    title_contains: "전송 완료",
    text: "성공적으로",
    absent_text: "실패",
    selector: ".success",
    selector_absent: ".error",
  }, observed);
  expect(out.ok).toBe(true);
  expect(out.checks.length).toBe(6);
});

test("browser_verify — 조건 하나라도 어긋나면 실패한다", () => {
  const out = evaluateBrowserVerification({ text: "성공적으로", url_contains: "/draft/" }, observed);
  expect(out.ok).toBe(false);
  expect(out.checks.some((c) => !c.ok)).toBe(true);
});

test("browser_verify — 조건이 없으면 fail-closed한다", () => {
  expect(evaluateBrowserVerification({}, observed)).toEqual({ ok: false, checks: [] });
});

test("browser_verify — 본문·선택자 관측 실패를 '없음'으로 오인하지 않는다", () => {
  const out = evaluateBrowserVerification({ absent_text: "오류", selector_absent: "[" }, {
    ...observed,
    text: null,
    selectors: { "[": null },
  });
  expect(out.ok).toBe(false);
  expect(out.checks.every((c) => !c.ok)).toBe(true);
});

test("브라우저 lease는 같은 key의 독립 owner를 모두 보존하고 마지막 release에서 풀린다", async () => {
  const key = `browser-lease-${Date.now()}`;
  acquireBrowserLease(key, `${key}-a`);
  acquireBrowserLease(key, `${key}-b`);
  expect(hasBrowserLease(key)).toBe(true);
  expect(ownsBrowserLease(key, `${key}-a`)).toBe(true);
  expect(await releaseBrowserLease(`${key}-a`)).toBe(true);
  expect(hasBrowserLease(key)).toBe(true);
  expect(await releaseBrowserLease(`${key}-a`)).toBe(false);
  expect(await releaseBrowserLease(`${key}-b`)).toBe(true);
  expect(hasBrowserLease(key)).toBe(false);
});

test("원래 page가 없는 승인 browser_click은 Chromium을 새로 열지 않고 fail-closed한다", async () => {
  const key = `browser-empty-${Date.now()}`;
  const snapshot = browserApprovalSnapshot(key);
  const out = await browserToolApproved(key, "browser_click", { ref: "@1" }, snapshot);
  expect(out).toContain("원래 페이지가 없습니다");
  expect(browserApprovalSnapshot(key).hasLivePage).toBe(false);
});

test("승인 후 page generation이 변하면 원래 action을 실행하지 않는다", async () => {
  const key = `browser-stale-${Date.now()}`;
  const snapshot = browserApprovalSnapshot(key);
  await cancelBrowserContext(key);
  const out = await browserToolApproved(key, "browser_click", { ref: "@1" }, snapshot);
  expect(out).toContain("이동·교체·종료됐습니다");
  expect(browserApprovalSnapshot(key).hasLivePage).toBe(false);
});

test("브라우저 lease는 원래 live page의 close를 미루고 승인 replay가 같은 page를 실행한다", async () => {
  const key = `browser-live-${Date.now()}`;
  const owner = `${key}-owner`;
  const fake = fakePage();
  const cleanup = installBrowserPageForTest(key, fake.page);
  try {
    const snapshot = await captureBrowserApprovalSnapshot(key);
    acquireBrowserLease(key, owner);
    await closeAgentPage(key);
    expect(fake.closed()).toBe(false);

    const out = await browserToolApproved(key, "browser_eval", { script: "return 'ok'" }, snapshot);
    expect(out).toContain("original-page");
    expect(fake.evaluations()).toBe(1);
    expect(fake.closed()).toBe(false);

    expect(await releaseBrowserLease(owner)).toBe(true);
    expect(fake.closed()).toBe(true);
  } finally {
    await releaseBrowserLease(owner);
    await cleanup();
  }
});

test("승인 뒤 navigation 또는 popup 교체가 생기면 원래 page action 전에 거절한다", async () => {
  for (const change of ["navigation", "popup"] as const) {
    const key = `browser-${change}-${Date.now()}`;
    const fake = fakePage();
    const popup = fakePage({ url: "https://example.test/popup" });
    const cleanup = installBrowserPageForTest(key, fake.page);
    try {
      const snapshot = await captureBrowserApprovalSnapshot(key);
      if (change === "navigation") fake.emit("framenavigated", fake.frame);
      else fake.emit("popup", popup.page);
      const out = await browserToolApproved(key, "browser_eval", { script: "return 'unsafe'" }, snapshot);
      expect(out).toContain("이동·교체·종료됐습니다");
      expect(fake.evaluations()).toBe(0);
      expect(popup.evaluations()).toBe(0);
    } finally {
      await cleanup();
    }
  }
});

test("승인 snapshot 검증과 action 사이에 같은 key의 일반 브라우저 호출이 끼어들지 않는다", async () => {
  const key = `browser-lock-${Date.now()}`;
  const entered = deferred<void>();
  const release = deferred<void>();
  const fake = fakePage({ beforeEvaluate: async () => {
    if (fake.evaluations() === 1) {
      entered.resolve();
      await release.promise;
    }
  } });
  const cleanup = installBrowserPageForTest(key, fake.page);
  try {
    const snapshot = await captureBrowserApprovalSnapshot(key);
    const approved = browserToolApproved(key, "browser_eval", { script: "return 'approved'" }, snapshot);
    await entered.promise;
    const ordinary = browserTool(key, "browser_eval", { script: "return 'ordinary'" });
    // lock이 없다면 ordinary가 page action까지 도달할 수 있도록 event-loop turn을 준다.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.evaluations()).toBe(1);
    release.resolve();
    expect(await approved).toContain("original-page");
    expect(await ordinary).toContain("original-page");
    expect(fake.evaluations()).toBe(2);
  } finally {
    release.resolve();
    await cleanup();
  }
});

test("브라우저 인계 시작 중 취소해도 pending 행과 늦게 열린 context를 남기지 않는다", async () => {
  const key = `browser-handoff-${Date.now()}`;
  const reason = `handoff-cancel-${Date.now()}`;
  const entered = deferred<void>();
  const factory = deferred<BrowserContext>();
  const closed = deferred<void>();
  let closeCount = 0;
  setHandoffBrowserFactoryForTest(async () => {
    entered.resolve();
    return await factory.promise;
  });
  const ctl = new AbortController();
  try {
    const running = browserTool(key, "browser_handoff", { reason }, ctl.signal);
    await entered.promise;
    ctl.abort(new DOMException("사용자 중지", "AbortError"));
    const out = await running;
    expect(out).toContain("인계를 취소했습니다");
    const row = db.prepare("SELECT status, resolved_at FROM handoff_requests WHERE reason = ? ORDER BY created_at DESC LIMIT 1").get(reason) as any;
    expect(row?.status).toBe("cancelled");
    expect(row?.resolved_at).toBeNumber();

    factory.resolve({ close: async () => { closeCount++; closed.resolve(); } } as unknown as BrowserContext);
    await closed.promise;
    expect(closeCount).toBe(1);
  } finally {
    setHandoffBrowserFactoryForTest(null);
    db.prepare("DELETE FROM handoff_requests WHERE reason = ?").run(reason);
    await cancelBrowserContext(key);
  }
});
