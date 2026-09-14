import { Hono } from "hono";
import { db, uid, now, getSetting } from "../db";
import { resolveModel } from "../providers";
import { streamChat, type ChatMessage } from "../providers/openaiCompat";
import { runDeepSearch } from "../deepsearch";
import { join } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";

const FILES_DIR = join(import.meta.dir, "..", "..", "data", "files");
mkdirSync(FILES_DIR, { recursive: true });

const q = {
  convList: db.prepare("SELECT * FROM conversations ORDER BY updated_at DESC"),
  convGet: db.prepare("SELECT * FROM conversations WHERE id = ?"),
  convInsert: db.prepare("INSERT INTO conversations (id, title, model, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"),
  convUpdate: db.prepare("UPDATE conversations SET title = ?, model = ?, updated_at = ? WHERE id = ?"),
  convTouch: db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?"),
  convDelete: db.prepare("DELETE FROM conversations WHERE id = ?"),
  msgInsert: db.prepare("INSERT INTO messages (id, conversation_id, parent_id, active, role, content, reasoning, model, search_meta, tokens_in, tokens_out, attachments, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
  msgUpdate: db.prepare("UPDATE messages SET content = ?, reasoning = ?, model = ?, search_meta = ?, tokens_in = ?, tokens_out = ? WHERE id = ?"),
  msgGet: db.prepare("SELECT * FROM messages WHERE id = ?"),
  msgChildren: db.prepare("SELECT * FROM messages WHERE parent_id IS ? ORDER BY created_at"),
  msgSiblingsDeactivate: db.prepare("UPDATE messages SET active = 0 WHERE parent_id IS ? AND id != ?"),
  msgActivate: db.prepare("UPDATE messages SET active = 1 WHERE id = ?"),
};

type Msg = {
  id: string; conversation_id: string; parent_id: string | null; active: number;
  role: string; content: string; reasoning: string | null; model: string | null;
  search_meta: string | null; tokens_in: number | null; tokens_out: number | null;
  attachments: string | null; created_at: number;
};

// 활성 분기를 따라 루트→리프 경로 반환
function activePath(convId: string): Msg[] {
  const path: Msg[] = [];
  let parent: string | null = null;
  for (let i = 0; i < 500; i++) {
    const children: Msg[] = (q.msgChildren.all(parent) as Msg[]).filter((m: Msg) => m.conversation_id === convId);
    if (!children.length) break;
    const next: Msg = children.find((m: Msg) => m.active) ?? children[children.length - 1];
    path.push(next);
    parent = next.id;
  }
  return path;
}

function leafOf(convId: string): Msg | null {
  const path = activePath(convId);
  return path.length ? path[path.length - 1] : null;
}

function insertMessage(convId: string, parentId: string | null, role: string, content = "", attachments: string | null = null): Msg {
  const id = uid();
  q.msgInsert.run(id, convId, parentId, role, content, null, null, null, null, null, attachments, now());
  q.msgSiblingsDeactivate.run(parentId, id);
  return q.msgGet.get(id) as Msg;
}

function withSiblings(m: Msg) {
  const sibs = q.msgChildren.all(m.parent_id) as Msg[];
  const idx = sibs.findIndex((s) => s.id === m.id);
  return { ...m, sibling_count: sibs.length, sibling_index: idx };
}

function systemPrompt(mode: string, personaId?: string | null, workspaceId?: string | null): string {
  const base = getSetting("system_prompt") ?? "당신은 MyBot입니다. 정확하고 유용하게 답변하세요. 마크다운을 적절히 사용하세요.";
  let p = base;
  if (workspaceId) {
    const ws = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(workspaceId) as any;
    if (ws?.instructions) p += `\n\n[워크스페이스: ${ws.name}]\n${ws.instructions}`;
  }
  if (personaId) {
    const persona = db.prepare("SELECT * FROM personas WHERE id = ?").get(personaId) as any;
    if (persona?.prompt) p += `\n\n[페르소나: ${persona.name}]\n${persona.prompt}`;
  }
  const memories = db.prepare("SELECT content FROM memories ORDER BY created_at DESC LIMIT 20").all() as { content: string }[];
  if (memories.length) p += "\n\n[사용자에 대해 기억하는 정보]\n" + memories.map((m) => `- ${m.content}`).join("\n");
  if (mode === "think") p += "\n\n중요하거나 복잡한 질문에는 단계별로 깊이 생각한 뒤 답하세요.";
  return p;
}

// 대화에서 지속 저장할 가치가 있는 사실 추출 (fast 모델, 백그라운드)
async function extractMemories(userText: string, assistantText: string) {
  if (getSetting("memory_enabled") === "0") return;
  try {
    const { endpoint, model } = resolveModel("fast");
    let out = "";
    for await (const ev of streamChat(endpoint, model, [
      { role: "user", content: `아래 대화 조각에서 나중 대화에 도움될 사용자 관련 사실(이름, 직업, 선호, 프로젝트, 제약 등)만 JSON 배열로 추출. 없으면 []. 각 항목은 한 줄 요약.\n\n사용자: ${userText.slice(0, 500)}\nAI: ${assistantText.slice(0, 500)}` },
    ])) {
      if (ev.type === "content") out += ev.text ?? "";
    }
    const m = out.match(/\[[\s\S]*\]/);
    if (!m) return;
    const facts: string[] = JSON.parse(m[0]);
    const existing = new Set((db.prepare("SELECT content FROM memories").all() as any[]).map((r) => r.content));
    for (const f of facts.slice(0, 5)) {
      const c = String(f).trim();
      if (c && !existing.has(c)) {
        db.prepare("INSERT INTO memories (id, content, created_at) VALUES (?, ?, ?)").run(uid(), c, now());
      }
    }
  } catch {}
}

async function autoTitle(convId: string, userText: string) {
  try {
    const { endpoint, model } = resolveModel("fast");
    let title = "";
    for await (const ev of streamChat(endpoint, model, [
      { role: "user", content: `다음 사용자 메시지를 대표하는 대화 제목을 15자 이내 한국어 명사구로만 출력. 따옴표 없이.\n\n${userText.slice(0, 300)}` },
    ])) {
      if (ev.type === "content") title += ev.text;
    }
    title = title.trim().replace(/['".]/g, "").slice(0, 40);
    if (title) db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title, convId);
  } catch {}
}

export const chatRoute = new Hono()
  .get("/conversations", (c) => c.json({ conversations: q.convList.all() }))
  .post("/conversations", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const id = uid();
    const t = now();
    q.convInsert.run(id, "새 대화", body.model ?? null, body.mode ?? "auto", t, t);
    if (body.persona_id) db.prepare("UPDATE conversations SET persona_id = ? WHERE id = ?").run(body.persona_id, id);
    return c.json({ conversation: q.convGet.get(id) });
  })
  .get("/conversations/:id", (c) => {
    const conv = q.convGet.get(c.req.param("id")) as any;
    if (!conv) return c.json({ error: "not found" }, 404);
    return c.json({ conversation: conv, messages: activePath(conv.id).map(withSiblings) });
  })
  .patch("/conversations/:id", async (c) => {
    const body = await c.req.json();
    const conv = q.convGet.get(c.req.param("id")) as any;
    if (!conv) return c.json({ error: "not found" }, 404);
    q.convUpdate.run(body.title ?? conv.title, body.model ?? conv.model, now(), conv.id);
    if (body.workspace_id !== undefined) db.prepare("UPDATE conversations SET workspace_id = ? WHERE id = ?").run(body.workspace_id || null, conv.id);
    if (body.persona_id !== undefined) db.prepare("UPDATE conversations SET persona_id = ? WHERE id = ?").run(body.persona_id || null, conv.id);
    return c.json({ conversation: q.convGet.get(conv.id) });
  })
  .delete("/conversations/:id", (c) => {
    q.convDelete.run(c.req.param("id"));
    return c.json({ ok: true });
  })
  // 형제 분기 선택 (편집/재생성 변형 탐색)
  .post("/messages/:id/select", (c) => {
    const m = q.msgGet.get(c.req.param("id")) as Msg | null;
    if (!m) return c.json({ error: "not found" }, 404);
    q.msgActivate.run(m.id);
    q.msgSiblingsDeactivate.run(m.parent_id, m.id);
    return c.json({ messages: activePath(m.conversation_id).map(withSiblings) });
  })
  .post("/conversations/:id/select", (c) => {
    return c.json({ messages: activePath(c.req.param("id")).map(withSiblings) });
  })
  // 스트리밍 전송. body: {conversationId?, content?, model, mode?, parentMessageId?, regenerateMessageId?}
  .post("/stream", async (c) => {
    const body = await c.req.json();
    const signal = c.req.raw.signal;
    const model = body.model ?? "main";
    const mode = body.mode ?? "auto";

    let convId = body.conversationId as string | undefined;
    if (!convId) {
      convId = uid();
      q.convInsert.run(convId, "새 대화", model, mode, now(), now());
      if (body.personaId) db.prepare("UPDATE conversations SET persona_id = ? WHERE id = ?").run(body.personaId, convId);
      if (body.workspaceId) db.prepare("UPDATE conversations SET workspace_id = ? WHERE id = ?").run(body.workspaceId, convId);
    }
    const conv = q.convGet.get(convId) as any;
    if (conv) {
      q.convTouch.run(now(), convId);
      if (body.personaId !== undefined) db.prepare("UPDATE conversations SET persona_id = ? WHERE id = ?").run(body.personaId || null, convId);
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch {}
        };
        send("conversation", { id: convId });
        try {
          let userMsg: Msg | null = null;
          let parentId: string | null;

          if (body.regenerateMessageId) {
            const orig = q.msgGet.get(body.regenerateMessageId) as Msg;
            parentId = orig.parent_id;
          } else {
            parentId = body.parentMessageId ?? leafOf(convId!)?.id ?? null;
            let content = body.content ?? "";
            // /스킬 확장: "/요약 본문..." → 스킬 프롬프트 + 본문
            const skillMatch = content.match(/^\/([^\s]+)\s*([\s\S]*)$/);
            if (skillMatch) {
              const { getSkill } = await import("./workspaces");
              const skill = getSkill(skillMatch[1]);
              if (skill) content = skill.prompt + skillMatch[2];
            }
            // 텍스트 파일 첨부 → 내용 주입
            const atts = (body.attachments ?? []) as { url: string; name: string; mime: string }[];
            for (const att of atts) {
              if (!att.mime?.startsWith("image/")) {
                const fpath = join(FILES_DIR, att.url.split("/").pop()!);
                if (existsSync(fpath)) {
                  const txt = readFileSync(fpath, "utf8").slice(0, 20000);
                  content += `\n\n[첨부 파일: ${att.name}]\n\`\`\`\n${txt}\n\`\`\``;
                }
              }
            }
            userMsg = insertMessage(convId!, parentId, "user", content, atts.length ? JSON.stringify(atts) : null);
            send("user_message", { message: withSiblings(userMsg) });
          }

          // 컨텍스트: 현재 활성 분기 (재생성이면 부모 메시지까지만)
          let path = activePath(convId!);
          if (body.regenerateMessageId) {
            const pi = path.findIndex((m) => m.id === parentId);
            if (pi >= 0) path = path.slice(0, pi + 1);
          }
          const history: ChatMessage[] = [
            { role: "system", content: systemPrompt(mode, conv?.persona_id ?? body.personaId, conv?.workspace_id) },
            ...path
              .filter((m) => m.role === "user" || m.role === "assistant")
              .map((m) => {
                // 이미지 첨부 → 비전 포맷 (data URL — 원격 프로바이더가 로컬 URL 못 읽음)
                if (m.role === "user" && m.attachments) {
                  try {
                    const parts: any[] = [{ type: "text", text: m.content }];
                    for (const att of JSON.parse(m.attachments) as { url: string; mime: string }[]) {
                      if (att.mime?.startsWith("image/")) {
                        const name = att.url.split("/").pop()!;
                        const filePath = join(FILES_DIR, name);
                        if (existsSync(filePath)) {
                          const b64 = Buffer.from(readFileSync(filePath)).toString("base64");
                          parts.push({ type: "image_url", image_url: { url: `data:${att.mime};base64,${b64}` } });
                        }
                      }
                    }
                    if (parts.length > 1) return { role: "user" as const, content: parts };
                  } catch {}
                }
                return { role: m.role as "user" | "assistant", content: m.content };
              }),
          ];

          const asstMsg = insertMessage(convId!, userMsg ? userMsg.id : parentId, "assistant", "");
          send("assistant_message", { message: withSiblings(asstMsg) });

          // 이미지 생성 모드: 채팅 대신 이미지 API
          if (mode === "image" && userMsg) {
            const { generateImage } = await import("../images");
            send("search", { type: "synthesize", count: 0 });
            const img = await generateImage(userMsg.content);
            const md = "file" in img ? `![${userMsg.content}](${img.file})` : `⚠ 이미지 생성 실패: ${img.error}`;
            send("delta", { id: asstMsg.id, text: md });
            q.msgUpdate.run(md, null, "image-gen", null, null, null, asstMsg.id);
            send("done", { message: withSiblings(q.msgGet.get(asstMsg.id) as Msg) });
            return;
          }

          const { endpoint, model: realModel } = resolveModel(model);
          let content = "";
          let reasoning = "";
          let usage: any = null;
          let usedModel = model;
          let searchMeta: any = null;

          if (mode === "deepsearch") {
            const ds = await runDeepSearch(endpoint, realModel, body.content ?? "", signal, (ev) => send("search", ev));
            searchMeta = ds.meta;
            // 마지막 사용자 메시지를 증강 프롬프트로 교체
            for (let i = history.length - 1; i >= 0; i--) {
              if (history[i].role === "user") {
                history[i] = { role: "user", content: ds.augmentedPrompt };
                break;
              }
            }
          }

          // 팀 모드: 대장 봇이 작업 분해 → 역할 봇 병렬 실행 → 결과 취합 후 대장이 종합
          if (mode === "team" && userMsg) {
            const { orchestrateTeam } = await import("../team");
            const agents = await orchestrateTeam(endpoint, realModel, userMsg.content, convId!, (ev) => send("team", ev), signal);
            if (agents?.length) {
              searchMeta = {
                type: "team",
                agents: agents.map((a) => ({ name: a.name, avatar: a.avatar, role: a.role, task: a.task, model: a.model, status: a.status, result: (a.result ?? "").slice(0, 4000) })),
              };
              const report = agents.map((a) => `## ${a.avatar} ${a.name} — ${a.status === "done" ? "완료" : "실패"}\n작업: ${a.task}\n\n${a.result ?? "(결과 없음)"}`).join("\n\n");
              for (let i = history.length - 1; i >= 0; i--) {
                if (history[i].role === "user") {
                  history[i] = {
                    role: "user",
                    content: `${userMsg.content}\n\n[팀 에이전트 실행 결과 — 각 전문 봇이 완료한 보고서]\n\n${report}\n\n---\n위 결과를 종합해 사용자에게 최종 답변을 작성하세요. 어떤 봇이 무엇을 담당했는지 간략히 언급하고, 실패한 봇이 있으면 그 한계도 솔직히 밝히세요.`,
                  };
                  break;
                }
              }
            }
          }

          // MCP 도구 루프: 도구 호출이 완료될 때까지 비스트림 라운드 후 최종 답변만 스트리밍
          const { mcpConfigured, mcpTools, mcpCall } = await import("../mcp");
          if (mcpConfigured()) {
            const tools = await mcpTools();
            if (tools.length) {
              const openaiTools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
              const { chatOnce } = await import("../providers/openaiCompat");
              for (let round = 0; round < 4; round++) {
                const res = await chatOnce(endpoint, realModel, history, { signal, tools: openaiTools });
                if (!res.toolCalls?.length) {
                  if (res.content) history.push({ role: "assistant", content: res.content });
                  break;
                }
                history.push({ role: "assistant", content: res.content || "", tool_calls: res.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } })) } as any);
                for (const tc of res.toolCalls) {
                  send("search", { type: "read", title: `🔧 ${tc.name}`, url: "" });
                  let out: string;
                  try { out = await mcpCall(tc.name, JSON.parse(tc.arguments || "{}")); }
                  catch { out = "도구 인자 파싱 실패"; }
                  history.push({ role: "tool", tool_call_id: tc.id, content: String(out).slice(0, 8000) } as any);
                }
              }
            }
          }

          for await (const ev of streamChat(endpoint, realModel, history, { signal })) {
            if (ev.type === "content" && ev.text) {
              content += ev.text;
              send("delta", { id: asstMsg.id, text: ev.text });
            } else if (ev.type === "reasoning" && ev.text) {
              reasoning += ev.text;
              send("reasoning", { id: asstMsg.id, text: ev.text });
            } else if (ev.type === "usage") {
              usage = ev.usage;
              if (ev.model) usedModel = ev.model;
            } else if (ev.type === "error") {
              send("error", { message: ev.error });
            } else if (ev.type === "done" && ev.model) {
              usedModel = ev.model;
            }
          }

          q.msgUpdate.run(content, reasoning || null, usedModel, searchMeta ? JSON.stringify(searchMeta) : null, usage?.prompt_tokens ?? null, usage?.completion_tokens ?? null, asstMsg.id);
          send("done", { message: withSiblings(q.msgGet.get(asstMsg.id) as Msg) });

          // 첫 교환이면 제목 자동 생성
          const count = (db.prepare("SELECT COUNT(*) as n FROM messages WHERE conversation_id = ?").get(convId!) as any).n;
          if (count <= 2 && userMsg) {
            await autoTitle(convId!, userMsg.content);
            send("title", { conversation: q.convGet.get(convId!) });
          }
          // 메모리 추출 (비차단)
          if (userMsg && content) extractMemories(userMsg.content, content).catch(() => {});
        } catch (e: any) {
          if (e?.name !== "AbortError") send("error", { message: String(e?.message ?? e) });
        } finally {
          try { controller.close(); } catch {}
        }
      },
    });

    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  })
  // 파일 업로드 (이미지 분석용)
  .post("/upload", async (c) => {
    const form = await c.req.formData();
    const file = form.get("file") as File | null;
    if (!file) return c.json({ error: "file 필요" }, 400);
    const ext = (file.name.split(".").pop() ?? "bin").replace(/[^a-zA-Z0-9]/g, "");
    const name = `${uid()}.${ext}`;
    writeFileSync(join(FILES_DIR, name), Buffer.from(await file.arrayBuffer()));
    return c.json({ url: `/api/files/${name}`, name: file.name, mime: file.type });
  })
  // 메시지 편집 → 같은 부모 아래 새 형제로 분기
  .post("/messages/:id/edit", async (c) => {
    const m = q.msgGet.get(c.req.param("id")) as Msg | null;
    if (!m || m.role !== "user") return c.json({ error: "user 메시지만 편집 가능" }, 400);
    const body = await c.req.json();
    const clone = insertMessage(m.conversation_id, m.parent_id, "user", body.content ?? m.content);
    return c.json({ message: withSiblings(clone), messages: activePath(m.conversation_id).map(withSiblings) });
  });
