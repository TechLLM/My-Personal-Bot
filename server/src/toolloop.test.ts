import { test, expect } from "bun:test";
import { db } from "./db";
import { PARALLEL_SAFE, parallelQueryHint, isBrowserish } from "./toolloop";

if (db.filename !== ":memory:") throw new Error(`테스트가 운영 DB를 열었습니다: ${db.filename}`);

// --- 조회 병렬 안내 (개선지침서 A-3 후속) ---
// 인프라는 조회 도구를 한 라운드에 병렬 실행하는데, 프롬프트는 위임(agent_direct)만 그렇게 하라고
// 안내하고 있었다. 실측 2026-09-21: 병렬 가능한 조회 도구의 연속 호출 815회(전체 6171회의 13%)가
// 한 라운드씩 소모됐고, 상한에 걸린 실행은 라운드당 호출이 1.0회로 병렬을 전혀 쓰지 않았다.

test("안내하는 도구는 모두 실제로 병렬 실행되는 것이다", () => {
  // 손으로 적은 목록이 PARALLEL_SAFE와 어긋나면 봇에게 거짓을 알려주게 된다
  for (const name of parallelQueryHint().split("·")) expect(PARALLEL_SAFE.has(name)).toBe(true);
});

test("위임·메시지는 안내에서 뺀다 — 프롬프트가 따로 설명한다", () => {
  const hint = parallelQueryHint();
  expect(hint).not.toContain("agent_direct");
  expect(hint).not.toContain("agent_message");
  expect(parallelQueryHint().split("·").length).toBe(PARALLEL_SAFE.size - 2);
});

test("실측에서 순차로 소모되던 조회 도구가 안내에 들어 있다", () => {
  // web_search 465회 · read_file 173 · list_files 121 · agent_list 49 (연속 중복)
  for (const t of ["web_search", "read_file", "list_files", "agent_list"]) expect(parallelQueryHint()).toContain(t);
});

test("쓰기·브라우저 도구는 병렬 대상이 아니다", () => {
  // 경로·페이지를 공유하므로 순차여야 한다 — agent_delete 438회 연속은 줄일 대상이 아니다
  for (const t of ["agent_delete", "agent_update", "write_file", "browser_eval", "browser_open"])
    expect(PARALLEL_SAFE.has(t)).toBe(false);
});

test("브라우저 판정은 예산 상한과 같은 기준을 쓴다", () => {
  for (const t of ["browser_open", "browser_read", "ego_run", "bsk"]) expect(isBrowserish(t)).toBe(true);
  for (const t of ["web_search", "read_file", "agent_list"]) expect(isBrowserish(t)).toBe(false);
});
