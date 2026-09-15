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
  convList: db.prepare("SELECT c.*, a.name AS agent_name, a.avatar AS agent_avatar FROM conversations c LEFT JOIN agents a ON a.id = c.agent_id ORDER BY c.updated_at DESC"),
  convGet: db.prepare("SELECT c.*, a.name AS agent_name, a.avatar AS agent_avatar FROM conversations c LEFT JOIN agents a ON a.id = c.agent_id WHERE c.id = ?"),
  convInsert: db.prepare("INSERT INTO conversations (id, title, model, mode, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  convUpdate: db.prepare("UPDATE conversations SET title = ?, model = ?, updated_at = ? WHERE id = ?"),
  convTouch: db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?"),
  convDelete: db.prepare("DELETE FROM conversations WHERE id = ?"),
  msgInsert: db.prepare("INSERT INTO messages (id, conversation_id, parent_id, active, role, content, reasoning, model, search_meta, tokens_in, tokens_out, attachments, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
  msgUpdate: db.prepare("UPDATE messages SET content = ?, reasoning = ?, model = ?, search_meta = ?, tokens_in = ?, tokens_out = ? WHERE id = ?"),
  msgGet: db.prepare("SELECT * FROM messages WHERE id = ?"),
  msgChildren: db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND parent_id IS ? ORDER BY created_at"),
  msgSiblingsDeactivate: db.prepare("UPDATE messages SET active = 0 WHERE conversation_id = ? AND parent_id IS ? AND id != ?"),
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
    const children = q.msgChildren.all(convId, parent) as Msg[];
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

function insertMessage(convId: string, parentId: string | null, role: string, content = "", attachments: string | null = null, model: string | null = null): Msg {
  const id = uid();
  q.msgInsert.run(id, convId, parentId, role, content, null, model, null, null, null, attachments, now());
  q.msgSiblingsDeactivate.run(convId, parentId, id);
  return q.msgGet.get(id) as Msg;
}

// 외부 채널(텔레그램)·봇 보고를 봇 세션에 기록 — 사용자가 대장 세션에서 확인
export function appendToAgentSession(convId: string, userText: string, assistantText: string, model?: string | null) {
  const leaf = leafOf(convId);
  const u = insertMessage(convId, leaf?.id ?? null, "user", userText);
  insertMessage(convId, u.id, "assistant", assistantText, null, model ?? null);
  q.convTouch.run(now(), convId);
}

function withSiblings(m: Msg) {
  const sibs = q.msgChildren.all(m.conversation_id, m.parent_id) as Msg[];
  const idx = sibs.findIndex((s) => s.id === m.id);
  return { ...m, sibling_count: sibs.length, sibling_index: idx };
}

export function systemPrompt(mode: string, personaId?: string | null, workspaceId?: string | null, agentId?: string | null): string {
  const base = getSetting("system_prompt") ?? "당신은 MyBot입니다. 정확하고 유용하게 답변하세요. 마크다운을 적절히 사용하세요.";
  let p = base;
  // 이 대화를 담당하는 봇 — 페르소나와 장기 기억이 봇에 귀속됨
  if (agentId) {
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
    if (agent) {
      p += `\n\n[당신은 봇 "${agent.name}"입니다 — 역할]\n${agent.role_prompt || "사용자의 업무를 수행하는 봇"}`;
      const amems = db.prepare("SELECT content FROM memories WHERE agent_id = ? ORDER BY created_at DESC LIMIT 20").all(agentId) as { content: string }[];
      if (amems.length) p += "\n\n[이 봇이 기억하는 업무 맥락]\n" + amems.map((m) => `- ${m.content}`).join("\n");
      p += "\n\n[도구 사용 규칙 — 반드시 준수] 봇 생성(agent_create)·업무 지시(agent_direct)·검색·파일·브라우저 같은 실제 작업은 반드시 도구를 호출해 수행하고, 도구 결과를 확인한 뒤에만 완료를 보고하세요. 도구 호출 없이 '생성했다/지시했다/완료했다'고 주장하면 안 됩니다 — 도구 호출 없이는 아무 일도 일어나지 않습니다. 도구가 실패하거나 필요한 도구가 없으면 할 수 없다고 솔직히 답하세요. 계정·비밀번호 같은 개인정보가 필요하면 request_credentials 도구로 보안 입력 팝업을 띄우세요 — 채팅으로 비밀번호를 직접 요청하거나 받지 마세요.";
    }
  }
  if (workspaceId) {
    const ws = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(workspaceId) as any;
    if (ws?.instructions) p += `\n\n[워크스페이스: ${ws.name}]\n${ws.instructions}`;
  }
  if (personaId) {
    const persona = db.prepare("SELECT * FROM personas WHERE id = ?").get(personaId) as any;
    if (persona?.prompt) p += `\n\n[페르소나: ${persona.name}]\n${persona.prompt}`;
  }
  const memories = db.prepare("SELECT content FROM memories WHERE agent_id IS NULL ORDER BY created_at DESC LIMIT 20").all() as { content: string }[];
  if (memories.length) p += "\n\n[사용자에 대해 기억하는 정보]\n" + memories.map((m) => `- ${m.content}`).join("\n");
  if (mode === "think") p += "\n\n중요하거나 복잡한 질문에는 단계별로 깊이 생각한 뒤 답하세요.";
  return p;
}

// 대화에서 지속 저장할 가치가 있는 사실 추출 (fast 모델, 백그라운드)
// agentId가 있으면 그 봇의 장기기억으로 저장 — 모델을 바꿔도 봇의 업무 맥락은 유지됨
async function extractMemories(userText: string, assistantText: string, agentId?: string | null) {
  if (getSetting("memory_enabled") === "0") return;
  try {
    const { endpoint, model } = resolveModel("fast");
    let out = "";
    for await (const ev of streamChat(endpoint, model, [
      { role: "user", content: `아래 대화 조각에서 나중 대화에 도움될 사실(사용자 정보, 프로젝트 상태, 진행 중인 업무, 결정 사항, 선호 등)만 JSON 배열로 추출. 없으면 []. 각 항목은 한 줄 요약.\n\n사용자: ${userText.slice(0, 500)}\nAI: ${assistantText.slice(0, 500)}` },
    ])) {
      if (ev.type === "content") out += ev.text ?? "";
    }
    const m = out.match(/\[[\s\S]*\]/);
    if (!m) return;
    const facts: string[] = JSON.parse(m[0]);
    const existing = new Set((db.prepare("SELECT content FROM memories WHERE agent_id IS ?").all(agentId ?? null) as any[]).map((r) => r.content));
    for (const f of facts.slice(0, 5)) {
      const c = String(f).trim();
      if (c && !existing.has(c)) {
        db.prepare("INSERT INTO memories (id, content, agent_id, created_at) VALUES (?, ?, ?, ?)").run(uid(), c, agentId ?? null, now());
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
    const { ensureBossAgent } = await import("../team");
    const id = uid();
    const t = now();
    q.convInsert.run(id, "새 대화", body.model ?? null, body.mode ?? "auto", body.agentId ?? ensureBossAgent().id, t, t);
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
    if (body.agent_id !== undefined) db.prepare("UPDATE conversations SET agent_id = ? WHERE id = ?").run(body.agent_id || null, conv.id);
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
    q.msgSiblingsDeactivate.run(m.conversation_id, m.parent_id, m.id);
    return c.json({ messages: activePath(m.conversation_id).map(withSiblings) });
  })
  .post("/conversations/:id/select", (c) => {
    return c.json({ messages: activePath(c.req.param("id")).map(withSiblings) });
  })
  // 스트리밍 전송. body: {conversationId?, content?, model, mode?, parentMessageId?, regenerateMessageId?}
  .post("/stream", async (c) => {
    const body = await c.req.json();
    const signal = c.req.raw.signal;
    const reqModel = body.model ?? "main";
    const mode = body.mode ?? "auto";

    let convId = body.conversationId as string | undefined;
    if (!convId) {
      const { ensureBossAgent } = await import("../team");
      convId = uid();
      // 모든 대화는 봇에게 귀속 — 기본은 대장 봇
      q.convInsert.run(convId, "새 대화", reqModel, mode, body.agentId ?? ensureBossAgent().id, now(), now());
      if (body.personaId) db.prepare("UPDATE conversations SET persona_id = ? WHERE id = ?").run(body.personaId, convId);
      if (body.workspaceId) db.prepare("UPDATE conversations SET workspace_id = ? WHERE id = ?").run(body.workspaceId, convId);
    }
    const conv = q.convGet.get(convId) as any;
    // 봇 세션은 담당 봇의 모델로 응답 — 클라이언트가 보낸 model보다 봇의 모델이 우선
    let model = reqModel;
    if (conv?.agent_id) {
      const { getAgent } = await import("../team");
      model = getAgent(conv.agent_id)?.model ?? reqModel;
    }
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
            { role: "system", content: systemPrompt(mode, conv?.persona_id ?? body.personaId, conv?.workspace_id, conv?.agent_id) },
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

          // 팀 모드: 대장 봇이 작업 분해만 수행 → 계획을 보여주고 사용자 승인 대기 (실행은 /api/team/run)
          if (mode === "team" && userMsg) {
            const { planTeam } = await import("../team");
            const plan = await planTeam(endpoint, realModel, userMsg.content, (ev) => send("team", ev), signal);
            if (plan?.length) {
              const agents = plan.map((t) => ({ name: t.name, avatar: t.avatar, role: t.role ?? "", task: t.task, model: t.model, model_label: t.model_label, existing: t.existing }));
              send("team", { type: "team_plan", pending: true, agents });
              const notice = "대장 봇이 작업 계획을 세웠습니다. 실행할 봇을 선택해 주세요.";
              const meta = JSON.stringify({ type: "team", status: "pending", agents });
              send("delta", { id: asstMsg.id, text: notice });
              q.msgUpdate.run(notice, null, realModel, meta, null, null, asstMsg.id);
              send("done", { message: withSiblings(q.msgGet.get(asstMsg.id) as Msg) });
              const count = (db.prepare("SELECT COUNT(*) as n FROM messages WHERE conversation_id = ?").get(convId!) as any).n;
              if (count <= 2) {
                await autoTitle(convId!, userMsg.content);
                send("title", { conversation: q.convGet.get(convId!) });
              }
              return;
            }
            // 계획 없음 → 일반 답변으로 계속 진행
          }

          // 도구 루프: 봇이 모든 메시지를 처리 — 내장 도구(검색·파일) + 브라우저 + MCP 도구(설정 시)
          {
            const { mcpConfigured, mcpTools, mcpCall } = await import("../mcp");
            const { BROWSER_TOOLS, browserTool, closeAgentPage } = await import("../browser");
            const { BUILTIN_TOOLS, BOSS_TOOLS, callBuiltin, getAgent } = await import("../team");
            const convAgent = getAgent(conv?.agent_id);
            const openaiTools: any[] = [...BUILTIN_TOOLS, ...(convAgent?.is_boss ? BOSS_TOOLS : []), ...BROWSER_TOOLS];
            if (mcpConfigured()) {
              const tools = await mcpTools();
              openaiTools.push(...tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })));
            }
            const builtinNames = new Set([...BUILTIN_TOOLS, ...BOSS_TOOLS].map((t) => t.function.name));
            const { chatOnce } = await import("../providers/openaiCompat");
            const browserKey = `${convId}:${asstMsg.id}`;
            const deadline = Date.now() + 3 * 60_000; // 일반 대화 도구 루프 최대 3분
            let browserUsed = false;
            const toolEvents: any[] = []; // search_meta에 누적 — 새로고침 후에도 도구 사용 내역 표시
            const emitTool = (title: string) => {
              const ev = { type: "read", title, url: "" };
              toolEvents.push(ev);
              send("search", ev);
            };
            for (let round = 0; round < 4; round++) {
              if (Date.now() > deadline) break;
              emitTool(`봇 작업 중… (라운드 ${round + 1})`);
              const res = await chatOnce(endpoint, realModel, history, { signal, tools: openaiTools });
              if (!res.toolCalls?.length) {
                if (res.content) history.push({ role: "assistant", content: res.content });
                break;
              }
              history.push({ role: "assistant", content: res.content || "", tool_calls: res.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } })) } as any);
              for (const tc of res.toolCalls) {
                let out = "";
                let args: Record<string, unknown> | null = null;
                try {
                  args = JSON.parse(tc.arguments || "{}");
                } catch {
                  out = `도구 오류: ${tc.name}의 인자 JSON이 깨져 있습니다(길이 ${tc.arguments.length}자). content가 크면 짧게 나눠 쓰고, 따옴표·줄바꿈을 올바르게 이스케이프한 유효한 JSON으로 다시 호출하세요.`;
                }
                if (args) {
                  emitTool(tc.name);
                  try {
                    if (builtinNames.has(tc.name)) {
                      out = await callBuiltin(tc.name, args, conv?.agent_id, signal);
                    } else if (tc.name.startsWith("browser_")) {
                      browserUsed = true;
                      out = await browserTool(browserKey, tc.name, args);
                    } else {
                      out = await mcpCall(tc.name, args);
                    }
                    if (/^(도구 오류|알 수 없는 도구|브라우저 오류):/.test(out)) {
                      console.error(`[mybot] 도구 실패 — 도구:${tc.name} ${out.slice(0, 120)}`);
                      emitTool(`⚠ ${tc.name} 실패`);
                    }
                  } catch (e) {
                    out = `도구 오류: ${(e as Error).message}`;
                    console.error(`[mybot] 도구 예외 — 도구:${tc.name} ${(e as Error).message}`);
                    emitTool(`⚠ ${tc.name} 오류`);
                  }
                }
                history.push({ role: "tool", tool_call_id: tc.id, content: String(out).slice(0, 8000) } as any);
              }
            }
            if (toolEvents.length) searchMeta = { ...(searchMeta ?? {}), type: searchMeta?.type ?? "tools", events: toolEvents };
            if (browserUsed) closeAgentPage(browserKey).catch(() => {});
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
          // 메모리 추출 (비차단) — 담당 봇의 장기기억으로 저장
          if (userMsg && content) extractMemories(userMsg.content, content, conv?.agent_id).catch(() => {});
          // 설정된 알림 채널로 결과 발송 (기본은 채팅창만)
          if (content) {
            const { notifyResult } = await import("../notify");
            notifyResult(conv?.title ?? "MyBot", content);
          }
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
  // 메시지 메타 패치 (팀 계획 취소 등): body.meta를 search_meta에 병합
  .post("/messages/:id/meta", async (c) => {
    const m = q.msgGet.get(c.req.param("id")) as Msg | null;
    if (!m) return c.json({ error: "not found" }, 404);
    const body = await c.req.json();
    const meta = m.search_meta ? JSON.parse(m.search_meta) : {};
    Object.assign(meta, body.meta ?? {});
    q.msgUpdate.run(m.content, m.reasoning, m.model, JSON.stringify(meta), m.tokens_in, m.tokens_out, m.id);
    return c.json({ message: withSiblings(q.msgGet.get(m.id) as Msg) });
  })
  // 메시지 편집 → 같은 부모 아래 새 형제로 분기
  .post("/messages/:id/edit", async (c) => {
    const m = q.msgGet.get(c.req.param("id")) as Msg | null;
    if (!m || m.role !== "user") return c.json({ error: "user 메시지만 편집 가능" }, 400);
    const body = await c.req.json();
    const clone = insertMessage(m.conversation_id, m.parent_id, "user", body.content ?? m.content);
    return c.json({ message: withSiblings(clone), messages: activePath(m.conversation_id).map(withSiblings) });
  });
