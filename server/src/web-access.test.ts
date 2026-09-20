import { expect, test } from "bun:test";
import { AuthenticatedEventStream } from "../../web/src/api";

test("UI event streams authenticate with headers, not query-string secrets", async () => {
  const previousFetch = globalThis.fetch;
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => "fixture-access" } });
  let received = "", requestUrl = "", header = "";
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    requestUrl = String(url);
    header = (init?.headers as Record<string, string>)["x-mybot-key"];
    return new Response('event: frame\r\ndata: {"fixture":true}\r\n\r\n', { headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  const stream = new AuthenticatedEventStream("/api/browser/view/fixture");
  stream.addEventListener("frame", e => { received = (e as MessageEvent).data; stream.close(); });
  try {
    for (let i = 0; i < 20 && !received; i++) await Bun.sleep(5);
    expect(requestUrl).toBe("/api/browser/view/fixture");
    expect(header).toBe("fixture-access");
    expect(JSON.parse(received)).toEqual({ fixture: true });
  } finally {
    stream.close(); globalThis.fetch = previousFetch;
    if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
    else delete (globalThis as any).localStorage;
  }
});
