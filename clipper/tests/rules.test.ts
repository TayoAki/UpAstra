import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { campaignStats, checkClip, postEarnings } from "../shared/rules";
import type { Post } from "../shared/types";
import { extractWithRules } from "../server/extract";

const brief = extractWithRules(fs.readFileSync(new URL("./fixtures/car-league-brief.txt", import.meta.url), "utf8"));
const post = (views: number, extra: Partial<Post> = {}): Post => ({ id: "p", campaignId: "c", platform: "tiktok", account: "a", url: "", postedAt: "", status: "live", metrics: { views, likes: views / 20, comments: 0, shares: 0 }, notes: "", ...extra });

describe("earnings", () => {
  it("pays CPM, capped per post", () => {
    expect(postEarnings(post(100_000), brief.payout)).toBe(90);
    expect(postEarnings(post(1_000_000), brief.payout)).toBe(300);
    expect(postEarnings(post(100_000, { status: "rejected" }), brief.payout)).toBe(0);
    expect(postEarnings(post(100_000, { paidAmount: 75 }), brief.payout)).toBe(75);
    expect(postEarnings(post(500), { ...brief.payout, minViews: 1000 })).toBe(0);
  });
  it("sums a campaign", () => {
    const s = campaignStats(brief, [], [post(100_000), post(1_000_000, { status: "paid" })]);
    expect(s.estimatedEarnings).toBe(390);
    expect(s.paid).toBe(300);
    expect(s.views).toBe(1_100_000);
    expect(s.engagementRate).toBeCloseTo(0.05);
  });
});

describe("clip rule check", () => {
  const good = {
    hook: "Someone made Rocket League inside Roblox",
    narration: "Someone made Rocket League inside Roblox. It's called Car League. You drive, boost and smash the ball into the goal. Play Car League on Roblox today.",
    cta: "Play Car League on Roblox",
    lengthSec: 20,
    onScreenText: [],
    shots: [{ footageId: "f1", moment: "goal", seconds: 5 }],
  };
  it("passes a plan that follows the brief", () => {
    const r = checkClip(good, brief);
    expect(r.checks.filter((c) => !c.pass)).toEqual([]);
  });
  it("catches a missing spoken phrase, a missing CTA and banned claims", () => {
    const r = checkClip({ ...good, narration: "This is the official Rocket League collab on Roblox. Use code FREE for rewards." }, brief);
    const failed = r.checks.filter((c) => !c.pass).map((c) => c.rule);
    expect(failed).toContain('"Car League" is spoken');
    expect(failed).toContain("Call to action in the last lines");
    expect(failed).toContain("No banned claims");
  });
  it("catches a voiceover too long for the clip", () => {
    const r = checkClip({ ...good, lengthSec: 15, narration: `${good.narration} ${"word ".repeat(80)}` }, brief);
    expect(r.checks.find((c) => c.rule === "Voiceover fits the clip")?.pass).toBe(false);
  });
});

describe("voiceover length after a render", () => {
  it("uses the measured spoken length once a voiced render exists", async () => {
    const { checkClip } = await import("../shared/rules");
    const brief = { requiredPhrases: [], cta: { text: "", placement: "end" }, lengthSec: { min: 15, max: 60 }, bannedClaims: [] } as never;
    const narration = Array.from({ length: 30 }, () => "information").join(" "); // 120 syllables, ~33s estimated
    const base = { hook: "x", narration, cta: "", lengthSec: 21, onScreenText: [], shots: [] };
    const fit = (c: object) => checkClip(c as never, brief).checks.find((x) => x.rule === "Voiceover fits the clip")!;
    expect(fit(base).pass).toBe(false);
    const rendered = { ...base, render: { status: "done", voice: "ash", spokenSec: 20.2 } };
    expect(fit(rendered)).toMatchObject({ pass: true, note: "20s spoken" });
  });
});
