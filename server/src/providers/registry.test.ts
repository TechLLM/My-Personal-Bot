import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../db";
import { airouteLocal, findProvider, dedupeAirouteModels } from "./registry";

if (db.filename !== ":memory:") throw new Error(`테스트가 운영 DB를 열었습니다: ${db.filename}`);

// airoute — 로컬에 설치된 AI 프록시. 실행 중이면 포트·토큰을 자기 설정 디렉터리에 둔다
test("airoute 설정 디렉터리에서 포트와 토큰을 읽는다", () => {
  const dir = mkdtempSync(join(tmpdir(), "airoute-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ host: "127.0.0.1", port: 11441, token: "t-abc" }));
  writeFileSync(join(dir, "airoute.port"), "12345\n"); // 실행 중 포트가 설정값보다 우선
  expect(airouteLocal(dir)).toEqual({ port: 12345, token: "t-abc" });
});

test("airoute가 설치돼 있지 않으면 null을 돌려준다", () => {
  expect(airouteLocal(mkdtempSync(join(tmpdir(), "airoute-none-")))).toBeNull();
});

test("airoute가 프로바이더로 등록돼 있고 로컬 OpenAI 호환 엔드포인트를 가리킨다", () => {
  const p = findProvider("airoute");
  expect(p).toBeTruthy();
  expect(p!.kind).toBe("openai"); // /v1/chat/completions 호환
  expect(p!.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
});

test("airoute 모델 목록에서 짧은 중복 이름은 접고 역할 별칭은 남긴다", () => {
  const got = dedupeAirouteModels([
    { id: "openai/gpt-6-astra", label: "openai/gpt-6-astra" },
    { id: "gpt-6-astra", label: "gpt-6-astra" },      // 위와 같은 모델 — 접는다
    { id: "cursor/auto", label: "cursor/auto" },
    { id: "auto", label: "auto" },
    { id: "auto", label: "auto" },                     // airoute가 같은 id를 두 번 주는 경우
    { id: "main", label: "main" },                     // 역할 별칭 — 대응하는 제공자/모델이 없으니 남긴다
    { id: "fast", label: "fast" },
  ].map((m) => ({ ...m })));
  expect(got.map((m) => m.id)).toEqual(["openai/gpt-6-astra", "cursor/auto", "main", "fast"]);
});
