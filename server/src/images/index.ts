import { getSetting, uid } from "../db";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILES_DIR = join(import.meta.dir, "..", "..", "data", "files");
mkdirSync(FILES_DIR, { recursive: true });

export async function generateImage(prompt: string): Promise<{ file: string; revisedPrompt?: string } | { error: string }> {
  const base = getSetting("image_endpoint");
  const model = getSetting("image_model") || "flux";
  const key = getSetting("image_key");

  if (!base) return { error: "이미지 엔드포인트 미설정 — 설정에서 Images API 주소를 입력하세요 (Draw Things: http://127.0.0.1:7888, airoute 등 OpenAI Images 호환)" };

  // Draw Things HTTP API (Stable Diffusion 로컬)
  if (base.includes(":7888")) {
    try {
      const res = await fetch(`${base}/sdapi/v1/txt2img`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, steps: 20, width: 1024, height: 1024 }),
        signal: AbortSignal.timeout(180000),
      });
      if (!res.ok) return { error: `Draw Things ${res.status}` };
      const data = (await res.json()) as { images?: string[] };
      const b64 = data.images?.[0];
      if (!b64) return { error: "이미지 없음" };
      const name = `${uid()}.png`;
      writeFileSync(join(FILES_DIR, name), Buffer.from(b64, "base64"));
      return { file: `/api/files/${name}` };
    } catch (e: any) {
      return { error: `Draw Things 연결 실패: ${e.message}` };
    }
  }

  // OpenAI Images 호환
  try {
    const res = await fetch(`${base}/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, prompt, n: 1, size: "1024x1024" }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) return { error: `${res.status}: ${(await res.text()).slice(0, 200)}` };
    const data = (await res.json()) as { data?: { b64_json?: string; url?: string; revised_prompt?: string }[] };
    const img = data.data?.[0];
    if (img?.b64_json) {
      const name = `${uid()}.png`;
      writeFileSync(join(FILES_DIR, name), Buffer.from(img.b64_json, "base64"));
      return { file: `/api/files/${name}`, revisedPrompt: img.revised_prompt };
    }
    if (img?.url) {
      // URL → 로컬 저장
      const imgRes = await fetch(img.url, { signal: AbortSignal.timeout(60000) });
      if (imgRes.ok) {
        const name = `${uid()}.png`;
        writeFileSync(join(FILES_DIR, name), Buffer.from(await imgRes.arrayBuffer()));
        return { file: `/api/files/${name}`, revisedPrompt: img.revised_prompt };
      }
      return { file: img.url };
    }
    return { error: "응답에 이미지 없음" };
  } catch (e: any) {
    return { error: `이미지 생성 실패: ${e.message}` };
  }
}
