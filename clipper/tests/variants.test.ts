import fs from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Clip } from "../shared/types";
import { createApp } from "../server/app";
import { initAuth } from "../server/auth";
import { useMemoryBackend } from "../server/db";
import { setAISimulated } from "../server/llm";
import { applyVariant } from "../server/variants";

const brief = fs.readFileSync(new URL("./fixtures/car-league-brief.txt", import.meta.url), "utf8").replace(/\(https:\/\/drive[^)]+\)/g, "");
let base = "";
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let cookie = "";
const a = async (path: string, method = "GET", body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  return { status: r.status, body: await r.json() };
};

beforeAll(() => {
  useMemoryBackend();
  setAISimulated(true);
  initAuth();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  setAISimulated(false);
});

describe("A/B variants", () => {
  it("swaps the opening sentence and keeps the rest of the clip", () => {
    const base = {
      hook: "Soccer, but everyone is driving a car",
      narration: "Soccer, but everyone is driving a car. This is Car League on Roblox. Play Car League on Roblox.",
      onScreenText: ["Soccer, but everyone is driving a car", "Play Car League"],
      caption: "Soccer, but everyone is driving a car #roblox",
      overlays: [
        { id: "o1", kind: "emoji", cue: "driving a car", emoji: "🚗" },
        { id: "o2", kind: "text", cue: "Car League", text: "CAR LEAGUE" },
      ],
      shots: [{ moment: "goal", seconds: 5 }],
    } as unknown as Clip;
    const v = applyVariant(base, { hook: "Can you score from the wall?", ctaLine: "Go play Car League on Roblox now" });
    expect(v.narration).toBe("Can you score from the wall? This is Car League on Roblox. Go play Car League on Roblox now.");
    expect(v.onScreenText).toEqual(["Can you score from the wall?", "Play Car League"]);
    expect(v.caption).toBe("Can you score from the wall? #roblox");
    expect(v.shots).toBe(base.shots);
    // An overlay cued on the old hook's words is dropped; the others stay.
    expect(v.overlays?.map((o) => o.id)).toEqual(["o2"]);
  });

  it("writes variants as a group, labelled A, B, C…, each checked against the brief", async () => {
    await a("/api/auth/signup", "POST", { email: "ab@test.dev", password: "password123" });
    const camp = (await a("/api/campaigns", "POST", { text: brief })).body.campaign;
    const plans = (await a(`/api/campaigns/${camp.id}/clips`, "POST", { count: 1 })).body;
    const original = plans.clips[0];
    const r = await a(`/api/clips/${original.id}/variants`, "POST", { count: 3 });
    expect(r.status).toBe(201);
    const group = r.body.clips.filter((x: Clip) => x.variantGroup === original.id);
    expect(group.map((x: Clip) => x.variantLabel).sort()).toEqual(["A", "B", "C", "D"]);
    const hooks = group.map((x: Clip) => x.hook);
    expect(new Set(hooks).size).toBe(4);
    for (const x of group) {
      expect(x.qa.checks.length).toBeGreaterThan(0);
      expect(x.shots).toEqual(original.shots);
      expect(x.status).toBe("draft");
    }
    // More variants continue the lettering, without repeating an opening.
    const more = (await a(`/api/clips/${group[2].id}/variants`, "POST", { count: 1 })).body;
    const g2 = more.clips.filter((x: Clip) => x.variantGroup === original.id);
    expect(g2.map((x: Clip) => x.variantLabel).sort()).toEqual(["A", "B", "C", "D", "E"]);
    expect(new Set(g2.map((x: Clip) => x.hook)).size).toBe(5);
  });
});
