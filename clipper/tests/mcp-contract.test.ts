import fs from "node:fs";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApp } from "../server/app";
import { createMcpServer, type ApiCall } from "../server/mcp";
import { initAuth } from "../server/auth";
import { useMemoryBackend } from "../server/db";
import { setAISimulated } from "../server/llm";

// B6.2: a machine contract for agents: strict arguments, structured errors
// with stable codes, a versioned format on every result, and next steps.
const brief = fs.readFileSync(new URL("./fixtures/car-league-brief.txt", import.meta.url), "utf8").replace(/\(https:\/\/drive[^)]+\)/g, "");
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let client: Client;
const parse = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);

beforeAll(async () => {
  useMemoryBackend();
  setAISimulated(true);
  initAuth();
  server = createApp().listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = "";
  const call = async (p: string, method = "GET", body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return r.json();
  };
  await call("/api/auth/signup", "POST", { email: "contract@test.dev", password: "password123", name: "C" });
  const { key } = await call("/api/workspace/agent-key", "POST", {});
  client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
});
afterAll(async () => {
  await client?.close();
  server?.close();
});

describe("MCP contract", () => {
  it("refuses arguments it doesn't know instead of ignoring them", async () => {
    const r = await client.callTool({ name: "render_clip", arguments: { clipID: "clip_x", voice: "ash" } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/clipID|unrecognized|Unrecognized/);
    expect(parse(r).error.code).toBe("INVALID_ARGUMENT");
    const listed = (await client.listTools()).tools.find((t) => t.name === "render_clip")!;
    expect(listed.inputSchema.additionalProperties).toBe(false);
  });

  it("returns errors with a stable code", async () => {
    const r = await client.callTool({ name: "review_clip", arguments: { clipId: "clip_nope", decision: "approve" } });
    expect(r.isError).toBe(true);
    expect(parse(r)).toMatchObject({ ok: false, error: { code: "NOT_FOUND", message: expect.stringMatching(/not found/i) } });
  });

  it("stamps every result with its format and suggests next steps", async () => {
    expect(parse(await client.callTool({ name: "overview", arguments: {} })).format).toBe("ugc.overview@1");
    const made = parse(await client.callTool({ name: "brief_to_shorts", arguments: { briefText: brief, count: 1, render: false } }));
    expect(made.format).toBe("ugc.brief_to_shorts@1");
    expect(made.next[0]).toMatchObject({ tool: "edit_clip", args: { clipId: made.plans[0].id }, why: expect.any(String) });
    const approved = parse(await client.callTool({ name: "review_clip", arguments: { clipId: made.plans[0].id, decision: "approve", override: true } }));
    expect(approved.next[0]).toMatchObject({ tool: "render_clip", args: { clipId: made.plans[0].id } });
    // Dry runs: nothing created, queued or charged.
    const dry = parse(await client.callTool({ name: "render_clip", arguments: { clipId: made.plans[0].id, voice: "none", dryRun: true } }));
    expect(dry).toMatchObject({ format: "ugc.render_clip@1", dryRun: true, clipId: made.plans[0].id });
    const pre = parse(await client.callTool({ name: "preflight_render", arguments: { clipIds: [made.plans[0].id], voice: "none" } }));
    expect(pre.clips[0].clipId).toBe(made.plans[0].id);
    const before = parse(await client.callTool({ name: "overview", arguments: {} })).campaigns.length;
    const dryBrief = parse(await client.callTool({ name: "brief_to_shorts", arguments: { briefText: brief, dryRun: true } }));
    expect(dryBrief.estimate.totalUsd).toBeGreaterThan(0);
    expect(parse(await client.callTool({ name: "overview", arguments: {} })).campaigns.length).toBe(before);
  });

  it("returns pictures as image content, and refuses frames of an unrendered clip", async () => {
    const calls: unknown[] = [];
    const fake: ApiCall = async (method, path, body) => {
      calls.push({ method, path, body });
      return { source: "clip", window: { start: 0, end: 2 }, times: [0.5, 1.5], images: [{ mimeType: "image/jpeg", data: "AAAA" }, { mimeType: "image/jpeg", data: "BBBB" }] } as never;
    };
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer(fake).connect(a);
    const local = new Client({ name: "t", version: "1" });
    await local.connect(b);
    const r = await local.callTool({ name: "get_frames", arguments: { clipId: "clip_1", aroundPhrase: "car league", occurrence: 2 } });
    const content = r.content as { type: string; text?: string; data?: string }[];
    expect(content.map((c) => c.type)).toEqual(["text", "image", "image"]);
    expect(JSON.parse(content[0].text!)).toMatchObject({ format: "ugc.get_frames@1", times: [0.5, 1.5], images: 2 });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/frames", body: { clipId: "clip_1", aroundPhrase: "car league", occurrence: 2, sheet: false } });
    await local.close();

    const made = parse(await client.callTool({ name: "brief_to_shorts", arguments: { briefText: brief, count: 1, render: false } }));
    const no = await client.callTool({ name: "contact_sheet", arguments: { clipId: made.plans[0].id } });
    expect(parse(no).error.code).toBe("CONFLICT");
  });
});
