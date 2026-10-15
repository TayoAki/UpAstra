import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { initAuth } from "../server/auth";
import { useMemoryBackend } from "../server/db";

// A scripted model: looks at the conversation and decides the next move.
const seen: { messages: { role: string; content: string | null; tool_call_id?: string }[]; tools: { function: { name: string } }[] }[] = [];
let llm: http.Server;
let app: http.Server;
let base = "";

function reply(body: (typeof seen)[number]) {
  const msgs = body.messages;
  const last = msgs[msgs.length - 1];
  const call = (name: string, args: unknown) => ({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: `call_${msgs.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }], usage: { cost: 0.002 } });
  const say = (text: string) => ({ choices: [{ message: { role: "assistant", content: text } }], usage: { cost: 0.001 } });
  if (last.role === "user") return call("overview", {});
  if (last.role === "tool" && /declined/i.test(last.content ?? "")) return say("OK — I won't post it.");
  if (last.role === "tool") return { choices: [{ message: { role: "assistant", content: "Scheduling it for tonight.", tool_calls: [{ id: "call_sched", type: "function", function: { name: "schedule_clip", arguments: JSON.stringify({ clipId: "clip_x", accountIds: ["acct_x"] }) } }] } }], usage: { cost: 0.002 } };
  return say("Done.");
}

beforeAll(async () => {
  llm = http
    .createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw);
        seen.push(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ model: body.model, ...reply(body) }));
      });
    })
    .listen(0);
  process.env.OPENROUTER_API_KEY = "test";
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}`;
  useMemoryBackend();
  initAuth();
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(() => {
  app?.close();
  llm?.close();
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_BASE_URL;
});

describe("Clipping Agent", () => {
  it("works through the MCP tools as the user, and waits for approval before publishing", async () => {
    const su = await fetch(`${base}/api/auth/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "agent@test.dev", password: "password123" }) });
    const cookie = su.headers.get("set-cookie")!.split(";")[0];
    const call = async (p: string, method = "GET", body?: unknown, headers: Record<string, string> = { cookie }) => {
      const r = await fetch(base + p, { method, headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json() };
    };
    const until = async (id: string, ok: (r: { status: string; working: boolean }) => boolean) => {
      for (let i = 0; i < 100; i++) {
        const r = (await call(`/api/agent/runs/${id}`)).body;
        if (ok(r)) return r;
        await new Promise((res) => setTimeout(res, 50));
      }
      throw new Error("timed out");
    };

    const start = await call("/api/agent/runs", "POST", { message: "Post my best clip tonight", timezone: "America/New_York" });
    expect(start.status).toBe(202);
    const run = await until(start.body.id, (r) => r.status === "waiting");

    // It called overview through MCP (the real API, as this user) and got data back.
    const overview = run.steps.find((s: { tool?: string }) => s.tool === "overview");
    expect(overview.error).toBe(false);
    expect(overview.result).toContain("campaigns");
    // The tool list it was given is the MCP tool set, and the system prompt has the user's time zone.
    expect(seen[0].tools.map((t) => t.function.name)).toEqual(expect.arrayContaining(["brief_to_shorts", "schedule_clip", "caption_video", "whats_working"]));
    expect(seen[0].messages[0].content).toContain("America/New_York");

    // Publishing waits for the user.
    expect(run.pending).toMatchObject({ tool: "schedule_clip", args: { clipId: "clip_x" } });
    expect((await call("/api/agent/runs", "POST", { message: "and another", runId: run.id })).status).toBe(409);
    const st = (await call("/api/state")).body;
    expect(st.agentRuns[0]).toMatchObject({ id: run.id, status: "waiting", pending: true });

    // Declined: the model is told, and wraps up.
    await call(`/api/agent/runs/${run.id}/approve`, "POST", { approve: false });
    const done = await until(run.id, (r) => r.status === "done" && !r.working);
    expect(done.steps.at(-1)).toMatchObject({ kind: "assistant", text: "OK — I won't post it." });
    expect(done.steps.find((s: { tool?: string }) => s.tool === "schedule_clip").result).toBe("Declined by the user.");
    expect(done.cost).toBeGreaterThan(0);
    const lastAsk = seen[seen.length - 1].messages;
    expect(lastAsk.find((m) => m.tool_call_id === "call_sched")?.content).toMatch(/declined/);

    // What the agent did through tools shows up as the agent's in Activity (nothing yet here besides reads),
    // and agent keys can't drive the in-app agent.
    const key = (await call("/api/workspace/agent-key", "POST", {})).body.key;
    expect((await call("/api/agent/runs", "POST", { message: "hi" }, { Authorization: `Bearer ${key}` })).status).toBe(403);
  }, 20_000);
});
