import { test, expect } from "bun:test";
import { db, setSetting } from "../db";
import { chatRoute } from "./chat";

if (db.filename !== ":memory:") throw new Error(`테스트가 운영 DB를 열었습니다: ${db.filename}`);

test("도구 루프가 완성한 답은 스트리밍으로 한 번 더 생성하지 않는다", async () => {
  db.prepare("INSERT INTO agents (id, name, role_prompt, model, created_at) VALUES ('t-chat-bot', '채팅테스트봇', '', 'zai/glm-5.3-flash', 0)").run();
  db.prepare("INSERT INTO conversations (id, title, mode, agent_id, created_at, updated_at) VALUES ('t-chat-conv', '테스트', 'auto', 't-chat-bot', 0, 0)").run();
  const bodies: string[] = [];
  const saved = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    bodies.push(body);
    if (body.includes('"stream":true')) return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    return new Response(JSON.stringify({ choices: [{ message: { content: "안녕하세요. 오늘 일정 정리를 도와드릴 수 있습니다." } }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  try {
    const res = await chatRoute.request("/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: "t-chat-conv", content: "안녕" }),
    });
    const events = await res.text();
    expect(events).toContain("event: done");
    const answer = db.prepare("SELECT content FROM messages WHERE conversation_id = 't-chat-conv' AND role = 'assistant'").get() as { content: string };
    expect(answer.content).toContain("일정 정리를 도와드릴 수 있습니다");
    // 봇 시스템 프롬프트가 실린 답변 생성 요청은 도구 루프의 1회뿐 (수정 전: 루프 1회 + 스트리밍 재생성 1회)
    expect(bodies.filter((b) => b.includes("채팅테스트봇")).length).toBe(1);
  } finally {
    globalThis.fetch = saved;
  }
});

test("대화 요약은 답변을 막지 않고 백그라운드로 만들어진다", async () => {
  db.prepare("INSERT INTO agents (id, name, role_prompt, model, created_at) VALUES ('t-sum-bot', '요약테스트봇', '', 'zai/glm-5.3-flash', 0)").run();
  db.prepare("INSERT INTO conversations (id, title, mode, agent_id, created_at, updated_at) VALUES ('t-sum-conv', '요약', 'auto', 't-sum-bot', 0, 0)").run();
  // 요약 기준(30건)을 넘는 40건의 대화 — 봇 보고가 쌓인 세션과 같은 상황
  const ins = db.prepare("INSERT INTO messages (id, conversation_id, parent_id, active, role, content, created_at) VALUES (?, 't-sum-conv', ?, 1, ?, ?, ?)");
  let parent: string | null = null;
  for (let i = 0; i < 40; i++) { const id = `t-sum-m${i}`; ins.run(id, parent, i % 2 ? "assistant" : "user", `메시지 ${i}`, 1000 + i); parent = id; }
  // 요약 모델은 키를 가진 사용자 정의 프로바이더로 고정 — 실제 인증 정보에 기대지 않는다
  setSetting("custom_providers", JSON.stringify([{ id: "t-sum", baseUrl: "http://sum.test/v1", apiKey: "k", models: ["m"] }]));
  setSetting("default_model", "t-sum/m");
  let releaseSummary!: () => void;
  const summaryGate = new Promise<void>((r) => { releaseSummary = r; });
  const summaryCount = () => (db.prepare("SELECT COUNT(*) c FROM conversation_summaries WHERE conversation_id = 't-sum-conv'").get() as { c: number }).c;
  const saved = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    const sse = (text: string) => new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
    if (body.includes("이전 대화 요약과 새 대화를 하나로 합쳐")) {
      await summaryGate; // 요약 모델이 오래 걸리는 상황
      return sse('data: {"choices":[{"delta":{"content":"요약: 메시지 0~25"}}]}\n\ndata: [DONE]\n\n');
    }
    if (body.includes('"stream":true')) return sse("data: [DONE]\n\n");
    return new Response(JSON.stringify({ choices: [{ message: { content: "이어서 진행하겠습니다. 다음 작업 내용을 알려 주세요." } }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  try {
    const events = await Promise.race([
      (async () => (await chatRoute.request("/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: "t-sum-conv", content: "계속하자" }),
      })).text())(),
      Bun.sleep(5000).then(() => "시간 초과 — 요약을 기다림"),
    ]);
    expect(events).toContain("event: done");
    expect(summaryCount()).toBe(0); // 답변은 끝났고 요약은 아직 진행 중
    releaseSummary();
    for (let i = 0; i < 50 && summaryCount() === 0; i++) await Bun.sleep(20);
    const row = db.prepare("SELECT summary FROM conversation_summaries WHERE conversation_id = 't-sum-conv'").get() as { summary: string };
    expect(row.summary).toContain("요약: 메시지");
  } finally {
    releaseSummary();
    globalThis.fetch = saved;
    setSetting("custom_providers", "[]");
    setSetting("default_model", "");
  }
});
