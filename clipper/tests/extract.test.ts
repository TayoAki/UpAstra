import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { extractWithRules, normalizeBrief } from "../server/extract";

const brief = fs.readFileSync(new URL("./fixtures/car-league-brief.txt", import.meta.url), "utf8");

describe("rules extractor (Car League brief)", () => {
  const b = extractWithRules(brief, [{ label: "Backup", url: "https://drive.google.com/drive/folders/1r4cwaWtrAPVTp8mu0GdN2r4_E8_ZXMJ3?usp=sharing" }]);

  it("reads the payout terms", () => {
    expect(b.payout).toMatchObject({ budget: 1500, cpm: 0.9, maxPerSubmission: 300 });
    expect(b.minEngagementRate).toBeCloseTo(0.01);
  });

  it("finds the spoken phrase, CTA and banned claims", () => {
    expect(b.requiredPhrases).toEqual(["Car League"]);
    expect(b.cta).toEqual({ text: "Play Car League on Roblox", placement: "end" });
    expect(b.bannedClaims.join(" ")).toMatch(/official Rocket League/);
    expect(b.accountRequirements).toEqual(["Only Roblox-focused accounts may upload."]);
  });

  it("collects hooks, facts, platforms and links", () => {
    expect(b.hookExamples).toHaveLength(6);
    expect(b.keyFacts.some((f) => /Duel Pad/.test(f))).toBe(true);
    expect(b.platforms).toEqual(["tiktok", "instagram", "youtube"]);
    expect(b.footage.map((l) => l.url).every((u) => u.includes("drive.google.com"))).toBe(true);
    expect(b.footage).toHaveLength(3);
    expect(b.productUrl).toMatch(/roblox\.com\/games/);
  });
});

describe("normalizeBrief", () => {
  it("coerces messy model output and keeps fallback values for gaps", () => {
    const fallback = extractWithRules(brief);
    const b = normalizeBrief({ title: "Car League", platforms: ["TikTok", "YouTube Shorts", "twitter", "myspace"], payout: { cpm: "$1.20" }, minEngagementRate: 2, requiredPhrases: "Car League", footage: ["not a url"] }, fallback);
    expect(b.platforms).toEqual(["tiktok", "youtube", "x"]);
    expect(b.payout.cpm).toBe(1.2);
    expect(b.payout.maxPerSubmission).toBe(300);
    expect(b.minEngagementRate).toBe(0.02);
    expect(b.requiredPhrases).toEqual(["Car League"]);
    expect(b.footage.length).toBe(fallback.footage.length);
  });
});
