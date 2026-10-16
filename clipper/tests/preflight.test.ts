import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { initAuth } from "../server/auth";
import { useMemoryBackend } from "../server/db";
import { setAISimulated } from "../server/llm";
import { ffmpegAvailable } from "../server/media";
import { budgetRule, DEFAULT_COST } from "../server/preflight";

// B6.3: what a render will cost and what blocks it, before anything is charged.
describe.skipIf(!ffmpegAvailable())("render preflight", () => {
  let app: ReturnType<ReturnType<typeof createApp>["listen"]>;
  let base = "";
  let cookie = "";
  let clipId = "";
  const api = async (p: string, method = "GET", body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  beforeAll(async () => {
    useMemoryBackend();
    setAISimulated(true);
    initAuth();
    app = createApp().listen(0);
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    await api("/api/auth/signup", "POST", { email: "pre@test.dev", password: "password123" });
    const brief = `The name "Turbo Ball" must be spoken.\nEncourage viewers to play Turbo Ball now.\nCPM: $1\nVideos 10-20 seconds.`;
    const c = await api("/api/campaigns", "POST", { text: brief });
    const id = c.body.campaign.id;
    await api(`/api/campaigns/${id}`, "PUT", { brief: { ...c.body.campaign.brief, footage: [{ label: "Gameplay", url: "http://127.0.0.1:9/game.mp4" }] } });
    await api(`/api/campaigns/${id}/footage/refresh`, "POST", {});
    const planned = await api(`/api/campaigns/${id}/clips`, "POST", { count: 1 });
    clipId = planned.body.clips[0].id;
    await api(`/api/clips/${clipId}`, "PUT", { status: "approved", override: true });
  });
  afterAll(() => {
    app?.close();
    delete process.env.MAX_QUEUED_RENDERS;
  });

  it("a dry run reports costs and blockers and queues nothing", async () => {
    const before = (await api("/api/usage")).body;
    const r = await api(`/api/clips/${clipId}/render`, "POST", { voice: "ash", dryRun: true });
    expect(r.status).toBe(200);
    const p = r.body.preflight;
    expect(p.footage).toEqual([expect.objectContaining({ name: "Gameplay", cached: false, momentsPending: true })]);
    expect(p.voice).toEqual({ id: "ash", takeCached: false });
    // No history yet: the defaults, one voice call and one file to watch.
    expect(p.estimate).toMatchObject({ voiceUsd: DEFAULT_COST.voice, momentsUsd: DEFAULT_COST.moments, paidCalls: 2 });
    // No OpenRouter key here, so the AI voice is a blocker.
    expect(p.ok).toBe(false);
    expect(p.blockers[0].message).toMatch(/OPENROUTER_API_KEY/);
    const s = (await api("/api/state")).body;
    const clip = s.clips.find((c: { id: string }) => c.id === clipId);
    expect(clip.status).toBe("approved");
    expect(clip.render).toBeUndefined();
    expect((await api("/api/usage")).body).toEqual(before);
  });

  it("a blocked real render is refused before queuing, with nothing charged", async () => {
    process.env.MAX_QUEUED_RENDERS = "0";
    const r = await api(`/api/clips/${clipId}/render`, "POST", { voice: "none" });
    expect(r.status).toBe(429);
    expect(r.body.error).toMatch(/Nothing was charged/);
    const clip = (await api("/api/state")).body.clips.find((c: { id: string }) => c.id === clipId);
    expect(clip.status).toBe("approved");
    expect(clip.render).toBeUndefined();
    delete process.env.MAX_QUEUED_RENDERS;
  });

  it("checks several clips at once, and a brief before it's read", async () => {
    const r = await api("/api/preflight", "POST", { clipIds: [clipId], voice: "none" });
    expect(r.body).toMatchObject({ ok: true, totalUsd: DEFAULT_COST.moments });
    expect(r.body.clips[0].estimate.voiceUsd).toBe(0);
    const b = await api("/api/preflight/brief", "POST", { count: 2, voice: "none", render: true });
    expect(b.body.estimate.perClipRenderUsd).toBe(DEFAULT_COST.moments);
    expect(b.body.blockers[0].message).toMatch(/OPENROUTER_API_KEY/);
  });
});

describe("budget rule", () => {
  const base = { live: true, voiceCalls: 0, momentCalls: 1, totalUsd: 0.01, usdLeft: 0, callsLeft: 0 };
  it("lets a no-voice render go when the budget is spent, with a warning", () => {
    const r = budgetRule(base);
    expect(r.blockers).toEqual([]);
    expect(r.warnings[0]).toMatch(/cut evenly/);
  });
  it("blocks a voice that would be charged, not a reused take", () => {
    expect(budgetRule({ ...base, voiceCalls: 1 }).blockers.map((b) => b.status)).toEqual([429, 429]);
    expect(budgetRule({ ...base, voiceCalls: 0, momentCalls: 0 }).blockers).toEqual([]);
  });
  it("warns when the estimate is more than what's left", () => {
    expect(budgetRule({ ...base, voiceCalls: 1, usdLeft: 0.01, totalUsd: 0.03, callsLeft: 5 })).toMatchObject({ blockers: [], warnings: [expect.stringMatching(/more than/)] });
  });
});
