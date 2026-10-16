import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { initAuth } from "../server/auth";
import { useMemoryBackend } from "../server/db";
import { setAISimulated } from "../server/llm";

// B7.2: plan edits carry the revision they were made from.
const brief = `The name "Turbo Ball" must be spoken.\nEncourage viewers to play Turbo Ball now.\nCPM: $1\nVideos 10-20 seconds.`;
let app: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base = "";
let cookie = "";
const api = async (p: string, method = "GET", body?: unknown) => {
  const r = await fetch(base + p, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const clipOf = async (id: string) => (await api("/api/state")).body.clips.find((c: { id: string }) => c.id === id);

beforeAll(async () => {
  useMemoryBackend();
  setAISimulated(true);
  initAuth();
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  await api("/api/auth/signup", "POST", { email: "rev@test.dev", password: "password123" });
});
afterAll(() => app?.close());

describe("revisioned plan edits", () => {
  it("refuses a stale edit, so neither writer loses work silently", async () => {
    const c = await api("/api/campaigns", "POST", { text: brief });
    const clip = (await api(`/api/campaigns/${c.body.campaign.id}/clips`, "POST", { count: 1 })).body.clips[0];
    const rev = clip.revision ?? 0;
    // An agent and a person both start from the same revision.
    const [a, b] = await Promise.all([api(`/api/clips/${clip.id}`, "PUT", { baseRevision: rev, caption: "agent caption" }), api(`/api/clips/${clip.id}`, "PUT", { baseRevision: rev, title: "human title" })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const now = await clipOf(clip.id);
    expect(now.revision).toBe(rev + 1);
    const winner = a.status === 200 ? { caption: "agent caption" } : { title: "human title" };
    expect(now).toMatchObject(winner);
    expect((a.status === 409 ? a : b).body.error).toMatch(/changed since you opened it/);
    // Edits without a baseRevision still work (older clients).
    expect((await api(`/api/clips/${clip.id}`, "PUT", { caption: "x" })).status).toBe(200);
  });

  it("won't let an edit break a plan that follows the brief, unless asked", async () => {
    const c = await api("/api/campaigns", "POST", { text: brief });
    await api(`/api/campaigns/${c.body.campaign.id}`, "PUT", { brief: { ...c.body.campaign.brief, footage: [{ label: "Gameplay", url: "http://127.0.0.1:9/game.mp4" }] } });
    await api(`/api/campaigns/${c.body.campaign.id}/footage/refresh`, "POST", {});
    const clip = (await api(`/api/campaigns/${c.body.campaign.id}/clips`, "POST", { count: 1 })).body.clips[0];
    // Make it pass first (simulated plans may not).
    const good = "Turbo Ball is soccer with rocket cars and it's wild. Play Turbo Ball now.";
    await api(`/api/clips/${clip.id}`, "PUT", { narration: good, allowFailing: true });
    const ok = await clipOf(clip.id);
    expect(ok.qa.checks.filter((x: { pass: boolean }) => !x.pass)).toEqual([]);
    const bad = await api(`/api/clips/${clip.id}`, "PUT", { baseRevision: ok.revision, narration: "Soccer with cars. Download it." });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toMatch(/breaks a brief rule.*nothing was saved/i);
    expect(await clipOf(clip.id)).toMatchObject({ narration: good, revision: ok.revision });
    const forced = await api(`/api/clips/${clip.id}`, "PUT", { baseRevision: ok.revision, narration: "Soccer with cars. Download it.", allowFailing: true });
    expect(forced.status).toBe(200);
    expect((await clipOf(clip.id)).qa.pass).toBe(false);
  });
});
