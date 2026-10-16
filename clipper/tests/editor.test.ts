import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { initAuth } from "../server/auth";
import { useMemoryBackend } from "../server/db";

// The editor's AI chat goes through UGCMediaClips: the server's key, a pinned
// model, capped output, the workspace's daily limit — and streams pass through.
let upstream: http.Server;
let app: http.Server;
let base = "";
const seen: Record<string, unknown>[] = [];

beforeAll(async () => {
  upstream = http
    .createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const j = JSON.parse(body);
        seen.push({ ...j, auth: req.headers.authorization });
        if (j.stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n`);
          res.end("data: [DONE]\n\n");
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }], model: j.model }));
        }
      });
    })
    .listen(0);
  process.env.OPENROUTER_API_KEY = "test-server-key";
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  process.env.EDITOR_MODEL = "anthropic/claude-sonnet-5.5";
  useMemoryBackend();
  initAuth();
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(() => {
  app?.close();
  upstream?.close();
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_BASE_URL;
  delete process.env.EDITOR_MODEL;
});

describe("editor AI proxy", () => {
  it("forwards chat on the server's key with the model pinned, and streams through", async () => {
    const anon = await fetch(`${base}/api/ai/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [] }) });
    expect(anon.status).toBe(401);

    const su = await fetch(`${base}/api/auth/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "ed@test.dev", password: "password123" }) });
    const cookie = su.headers.get("set-cookie")!.split(";")[0];
    const post = (body: unknown) => fetch(`${base}/api/ai/v1/chat/completions`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });

    const models = await (await fetch(`${base}/api/ai/v1/models`, { headers: { cookie } })).json();
    expect(models.data.map((m: { id: string }) => m.id)).toEqual(["anthropic/claude-sonnet-5.5"]);

    const r = await post({ model: "openai/gpt-5-pro", max_tokens: 100000, messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "split_clip", parameters: {} } }] });
    expect(r.status).toBe(200);
    expect((await r.json()).choices[0].message.content).toBe("ok");
    expect(seen[0]).toMatchObject({ model: "anthropic/claude-sonnet-5.5", max_tokens: 8192, auth: "Bearer test-server-key" });
    expect((seen[0].tools as unknown[]).length).toBe(1);

    // Schemas with a top-level oneOf are flattened (Anthropic rejects them).
    await post({
      messages: [{ role: "user", content: "zoom" }],
      tools: [{ type: "function", function: { name: "set_clip_transform", parameters: { type: "object", properties: { clipId: { type: "string" } }, required: ["clipId"], oneOf: [{ properties: { scale: { type: "number" } }, required: ["scale"] }, { properties: { position: { type: "object" } }, required: ["position"] }] } } }],
    });
    const flat = (seen[1].tools as { function: { parameters: Record<string, unknown> } }[])[0].function.parameters;
    expect(flat.oneOf).toBeUndefined();
    expect(Object.keys(flat.properties as object).sort()).toEqual(["clipId", "position", "scale"]);
    expect(flat.required).toEqual(["clipId"]);

    const st = await post({ stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(st.headers.get("content-type")).toContain("text/event-stream");
    const text = await st.text();
    expect(text).toContain('"Hel"');
    expect(text).toContain("[DONE]");

    expect((await post({ nope: true })).status).toBe(400);
  });
});
