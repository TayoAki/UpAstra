import fs from "node:fs";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { initAuth } from "../server/auth";
import { useMemoryBackend } from "../server/db";
import { setAISimulated } from "../server/llm";

const brief = fs.readFileSync(new URL("./fixtures/car-league-brief.txt", import.meta.url), "utf8").replace(/\(https:\/\/drive[^)]+\)/g, "");
let base = "";
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;

beforeAll(() => {
  useMemoryBackend();
  setAISimulated(true);
  initAuth();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

function session() {
  let cookie = "";
  return async (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
}

const parse = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);

describe("agent access", () => {
  it("runs the workflow headless over MCP with a workspace key, within limits", async () => {
    const human = session();
    await human("/api/auth/signup", "POST", { email: "agent-owner@test.dev", password: "password123", name: "Owner" });
    expect((await human("/api/auth/me")).body.workspace.hasAgentKey).toBe(false);
    const k = await human("/api/workspace/agent-key", "POST", {});
    expect(k.status).toBe(201);
    const key: string = k.body.key;
    expect(key).toMatch(/^co_agent_/);
    expect(k.body.me.workspace.hasAgentKey).toBe(true);

    // The key works on the plain API, but not for account or key management.
    const bearer = { Authorization: `Bearer ${key}` };
    const agent = session();
    expect((await agent("/api/state", "GET", undefined, bearer)).status).toBe(200);
    expect((await agent("/api/workspace/agent-key", "POST", {}, bearer)).status).toBe(403);
    expect((await agent("/api/auth/account", "DELETE", { password: "password123" }, bearer)).status).toBe(403);
    expect((await agent("/api/state", "GET", undefined, { Authorization: "Bearer co_agent_wrongwrongwrongwrongwrong" })).status).toBe(401);
    expect((await fetch(`${base}/mcp`, { method: "POST" })).status).toBe(401);

    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: bearer } }));
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["overview", "brief_to_shorts", "plan_clips", "render_clip", "wait_for_renders", "log_post", "update_post_metrics", "whats_working"]));
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toContain("make_shorts");

    // Brief in, plans out. The test brief has no footage, so plans fail the footage rule and wait for review.
    const made = parse(await client.callTool({ name: "brief_to_shorts", arguments: { briefText: brief, count: 2 } }));
    expect(made.campaign.payout.cpm).toBe(0.9);
    expect(made.campaign.requiredPhrases.join(" ")).toMatch(/Car League/);
    expect(made.plans).toHaveLength(2);
    expect(made.renderQueued).toEqual([]);
    expect(made.next).toMatch(/No plan passed/);

    const clipId = made.plans[0].id;
    const failed = await client.callTool({ name: "review_clip", arguments: { clipId, decision: "approve" } });
    expect(failed.isError).toBe(true);
    const approved = parse(await client.callTool({ name: "review_clip", arguments: { clipId, decision: "approve", override: true } }));
    expect(approved.status).toBe("approved");

    const post = parse(await client.callTool({ name: "log_post", arguments: { clipId, platform: "tiktok", account: "carclips", url: "https://www.tiktok.com/@carclips/video/1", postedAt: new Date(Date.now() - 3 * 864e5).toISOString(), views: 1000 } }));
    const upd = parse(await client.callTool({ name: "update_post_metrics", arguments: { postId: post.id, views: 50_000, likes: 2500 } }));
    expect(upd.post.metrics.views).toBe(50_000);
    expect(upd.campaign.estimatedEarnings).toBe(45);

    const ww = parse(await client.callTool({ name: "whats_working", arguments: {} }));
    expect(ww.report.maturePosts).toBe(1);
    await client.close();

    // Everything the agent did is marked in Activity; revoking the key cuts it off.
    const st = (await human("/api/state")).body;
    expect(st.activity.some((a: { actor?: string; kind: string }) => a.actor === "agent" && a.kind === "post")).toBe(true);
    expect(st.activity.find((a: { message: string }) => /Agent key created/.test(a.message)).actor).toBeUndefined();
    await human("/api/workspace/agent-key", "DELETE");
    expect((await agent("/api/state", "GET", undefined, bearer)).status).toBe(401);
  }, 60_000);
});
