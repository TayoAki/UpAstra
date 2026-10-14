import fs from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { initAuth } from "../server/auth";
import { useMemoryBackend } from "../server/db";
import { setAISimulated } from "../server/llm";

const brief = fs.readFileSync(new URL("./fixtures/car-league-brief.txt", import.meta.url), "utf8").replace(/\(https:\/\/drive[^)]+\)/g, "");
let base = "";
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;

function client() {
  let cookie = "";
  return async (path: string, method = "GET", body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return { status: r.status, body: await r.json() };
  };
}

beforeAll(async () => {
  useMemoryBackend();
  setAISimulated(true);
  initAuth();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("api", () => {
  it("runs the whole loop: sign up → brief → clips → post → earnings, isolated per user", async () => {
    const a = client();
    expect((await a("/api/state")).status).toBe(401);
    const s = await a("/api/auth/signup", "POST", { email: "a@test.dev", password: "password123", name: "Ann" });
    expect(s.status).toBe(201);

    const c = await a("/api/campaigns", "POST", { text: brief });
    expect(c.status).toBe(201);
    const id = c.body.campaign.id;
    expect(c.body.campaign.brief.payout.cpm).toBe(0.9);

    const planned = await a(`/api/campaigns/${id}/clips`, "POST", { count: 3 });
    expect(planned.status).toBe(201);
    const clips = planned.body.clips;
    expect(clips).toHaveLength(3);
    for (const clip of clips) {
      expect(clip.narration.toLowerCase()).toContain("car league");
      expect(clip.qa.checks.find((x: { rule: string }) => x.rule === '"Car League" is spoken').pass).toBe(true);
    }

    const approved = await a(`/api/clips/${clips[0].id}`, "PUT", { status: "approved", override: true });
    expect(approved.status).toBe(200);
    const posted = await a("/api/posts", "POST", { campaignId: id, clipId: clips[0].id, platform: "tiktok", account: "carclips", url: "https://www.tiktok.com/@carclips/video/1", metrics: { views: 120000, likes: 6000 } });
    expect(posted.status).toBe(201);
    const camp = posted.body.campaigns.find((x: { id: string }) => x.id === id);
    expect(camp.stats.estimatedEarnings).toBe(108);
    expect(posted.body.clips.find((x: { id: string }) => x.id === clips[0].id).status).toBe("posted");

    // Editing the brief re-checks unposted plans.
    const edited = await a(`/api/campaigns/${id}`, "PUT", { brief: { ...camp.brief, requiredPhrases: ["Car League", "Duel Pad"] } });
    const reChecked = edited.body.clips.find((x: { id: string }) => x.id === clips[1].id);
    expect(reChecked.qa.checks.some((x: { rule: string }) => x.rule === '"Duel Pad" is spoken')).toBe(true);

    // Another user sees none of it.
    const b = client();
    await b("/api/auth/signup", "POST", { email: "b@test.dev", password: "password123" });
    const other = await b("/api/state");
    expect(other.body.campaigns).toEqual([]);
    expect((await b(`/api/campaigns/${id}`, "PUT", { name: "hijack" })).status).toBe(404);

    // Delete account removes everything.
    expect((await a("/api/auth/account", "DELETE", { password: "nope-nope" })).status).toBe(401);
    expect((await a("/api/auth/account", "DELETE", { password: "password123" })).status).toBe(200);
    expect((await a("/api/state")).status).toBe(401);
    expect((await a("/api/auth/login", "POST", { email: "a@test.dev", password: "password123" })).status).toBe(401);
  });

  it("refuses to read private-network links", async () => {
    const a = client();
    await a("/api/auth/signup", "POST", { email: "c@test.dev", password: "password123" });
    const r = await a("/api/campaigns", "POST", { url: "http://127.0.0.1:22/brief" });
    expect(r.status).toBe(400);
  });
});
