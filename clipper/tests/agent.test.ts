import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { initAuth } from "../server/auth";
import { useMemoryBackend } from "../server/db";

// A scripted model: looks at the conversation and decides the next move.
type Content = string | null | { type: string; text: string; cache_control?: unknown }[];
const seen: { messages: { role: string; content: Content; tool_call_id?: string }[]; tools: { function: { name: string } }[] }[] = [];
const text = (c: Content) => (Array.isArray(c) ? c.map((p) => p.text).join("") : (c ?? ""));
let llm: http.Server;
let app: http.Server;
let base = "";

function reply(body: (typeof seen)[number]) {
  const msgs = body.messages;
  const last = msgs[msgs.length - 1];
  const call = (name: string, args: unknown) => ({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: `call_${msgs.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }], usage: { cost: 0.002 } });
  const say = (text: string) => ({ choices: [{ message: { role: "assistant", content: text } }], usage: { cost: 0.001 } });
  if (last.role === "user") return call("overview", {});
  if (last.role === "tool" && /declined/i.test(text(last.content))) return say("OK — I won't post it.");
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
    expect(text(seen[0].messages[0].content)).toContain("America/New_York");
    // Anthropic prompt caching: the system prompt and the newest message are marked.
    const later = seen[1].messages;
    expect(later[0].content).toEqual([expect.objectContaining({ cache_control: { type: "ephemeral" } })]);
    expect(later.at(-1)!.content).toEqual([expect.objectContaining({ cache_control: { type: "ephemeral" } })]);
    expect(later.slice(1, -1).every((m) => !Array.isArray(m.content))).toBe(true);

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
    expect(text(lastAsk.find((m) => m.tool_call_id === "call_sched")!.content)).toMatch(/declined/);

    // Every model call was metered against the workspace, in dollars.
    const usage = (await call("/api/usage")).body;
    const month = usage.months[0];
    expect(month.usage.ai.agent.calls).toBe(seen.length);
    expect(month.usage.ai.agent.usd).toBeCloseTo(done.cost, 6);
    expect(usage.today.usd).toBeCloseTo(done.cost, 6);
    expect(month.cost.total).toBeCloseTo(done.cost, 6);

    // Once today's dollar budget is spent, AI work is refused until tomorrow.
    process.env.AI_DAILY_BUDGET_USD = "0.001";
    const over = await call("/api/agent/runs", "POST", { message: "again" });
    delete process.env.AI_DAILY_BUDGET_USD;
    const blocked = over.status === 429 ? over.body.error : (await until(over.body.id, (r) => r.status !== "running" && !r.working)).error;
    expect(blocked).toMatch(/AI budget/);

    // Only operators see every workspace.
    expect((await call("/api/admin/usage")).status).toBe(403);
    process.env.ADMIN_EMAILS = "someone@else.dev, agent@test.dev";
    const all = (await call("/api/admin/usage")).body;
    delete process.env.ADMIN_EMAILS;
    expect(all.workspaces[0]).toMatchObject({ email: "agent@test.dev" });
    expect(all.total.ai).toBeCloseTo(done.cost, 6);

    // What the agent did through tools shows up as the agent's in Activity (nothing yet here besides reads),
    // and agent keys can't drive the in-app agent.
    const key = (await call("/api/workspace/agent-key", "POST", {})).body.key;
    expect((await call("/api/agent/runs", "POST", { message: "hi" }, { Authorization: `Bearer ${key}` })).status).toBe(403);
  }, 20_000);
});
