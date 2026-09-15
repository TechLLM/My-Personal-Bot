import { getSetting } from "./db";
import type { Subprocess } from "bun";

export interface McpServerConf {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class McpClient {
  name: string;
  confKey: string; // 설정 스냅샷 — 설정이 바뀌면 재연결 판정용
  private proc: Subprocess;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = "";

  private constructor(conf: McpServerConf) {
    this.name = conf.name;
    this.confKey = JSON.stringify(conf);
    this.proc = Bun.spawn([conf.command, ...(conf.args ?? [])], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      env: { ...process.env, ...(conf.env ?? {}) },
    });
    this.readLoop();
  }

  static async connect(conf: McpServerConf): Promise<McpClient> {
    const client = new McpClient(conf);
    await client.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "mybot", version: "0.1.0" },
    });
    client.notify("notifications/initialized");
    return client;
  }

  private async readLoop() {
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, i).trim();
          this.buf = this.buf.slice(i + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && this.pending.has(msg.id)) {
              const p = this.pending.get(msg.id)!;
              this.pending.delete(msg.id);
              clearTimeout(p.timer);
              if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
              else p.resolve(msg.result);
            }
          } catch {}
        }
      }
    } catch {}
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("MCP 프로세스 종료")); }
    this.pending.clear();
  }

  private send(msg: object) {
    (this.proc.stdin as { write: (s: string) => void }).write(JSON.stringify(msg) + "\n");
  }

  private request(method: string, params?: object): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP ${method} 타임아웃`)); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params?: object) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async listTools(): Promise<{ name: string; description?: string; inputSchema?: object }[]> {
    const res = await this.request("tools/list");
    return (res?.tools ?? []).map((t: any) => ({ name: `${this.name}__${t.name}`, description: t.description, inputSchema: t.inputSchema, _orig: t.name }));
  }

  async callTool(origName: string, args: object): Promise<string> {
    const res = await this.request("tools/call", { name: origName, arguments: args });
    const parts = res?.content ?? [];
    return parts.map((p: any) => (p.type === "text" ? p.text : JSON.stringify(p))).join("\n");
  }

  close() { try { this.proc.kill(); } catch {} }
}

// --- 도구 레지스트리: 설정된 MCP 서버들을 지연 연결 ---
const clients = new Map<string, McpClient>();
const toolMap = new Map<string, { client: McpClient; orig: string; description?: string; inputSchema?: object }>();

export function getMcpServers(): McpServerConf[] {
  try { return JSON.parse(getSetting("mcp_servers") ?? "[]"); } catch { return []; }
}

export async function mcpTools(): Promise<{ name: string; description?: string; inputSchema?: object }[]> {
  const confs = getMcpServers();
  const wanted = new Map(confs.map((c) => [c.name, JSON.stringify(c)]));
  // 설정에서 제거되거나 내용이 바뀐 서버의 연결을 끊고 도구도 제거 — stale subprocess 방지
  for (const [name, client] of clients) {
    if (client.confKey !== wanted.get(name)) {
      client.close();
      clients.delete(name);
      for (const [tn, te] of toolMap) if (te.client === client) toolMap.delete(tn);
    }
  }
  const out: { name: string; description?: string; inputSchema?: object }[] = [];
  for (const conf of confs) {
    try {
      if (!clients.has(conf.name)) clients.set(conf.name, await McpClient.connect(conf));
      const client = clients.get(conf.name)!;
      // 죽은 프로세스면 listTools가 throw → 클라이언트를 버려 다음 호출 때 재연결
      const tools = await client.listTools();
      for (const t of tools) {
        toolMap.set(t.name, { client, orig: (t as any)._orig, description: t.description, inputSchema: t.inputSchema });
        out.push(t);
      }
    } catch (e) {
      console.error(`[mcp ${conf.name}] 연결 실패:`, (e as Error).message);
      const dead = clients.get(conf.name);
      if (dead) { dead.close(); clients.delete(conf.name); for (const [tn, te] of toolMap) if (te.client === dead) toolMap.delete(tn); }
    }
  }
  return out;
}

export async function mcpCall(name: string, args: object): Promise<string> {
  const t = toolMap.get(name);
  if (!t) return `알 수 없는 도구: ${name}`;
  try {
    return await t.client.callTool(t.orig, args);
  } catch (e) {
    return `도구 오류: ${(e as Error).message}`;
  }
}

export function mcpConfigured(): boolean {
  return getMcpServers().length > 0;
}
