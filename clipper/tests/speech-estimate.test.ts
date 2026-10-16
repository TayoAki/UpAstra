import { describe, expect, it } from "vitest";
import { calibrate, speechSeconds, speechUnits, UNITS_PER_SECOND } from "../shared/rules";

// B5.3: how long a script takes to say: syllables (numbers spelled out) or
// CJK characters/morae, at a rate learned per voice.
describe("speech estimate", () => {
  it("counts syllables, spelling out numbers", () => {
    expect(speechUnits("hello")).toBe(2);
    expect(speechUnits("Play Car League today")).toBe(5);
    expect(speechUnits("1,250")).toBe(speechUnits("one thousand two hundred fifty"));
    expect(speechUnits("$5 off")).toBe(speechUnits("five dollars off"));
    expect(speechUnits("2026")).toBe(speechUnits("twenty twenty six"));
  });

  it("counts Chinese characters and Japanese morae", () => {
    expect(speechUnits("这个游戏太好玩了")).toBe(8);
    expect(speechUnits("ゲーム")).toBe(3);
    expect(speechUnits("Play 车联赛")).toBe(1 + 3);
  });

  it("keeps typical English near the old 2.6 words per second", () => {
    const s = "Someone made Rocket League inside Roblox. It's called Car League. You drive, boost and smash the ball into the goal. Play Car League on Roblox today.";
    const words = s.split(/\s+/).length;
    expect(speechSeconds(s)).toBeGreaterThan((words / 2.6) * 0.8);
    expect(speechSeconds(s)).toBeLessThan((words / 2.6) * 1.2);
    expect(UNITS_PER_SECOND).toBeGreaterThan(0);
  });

  it("learns a voice's pace from measured renders", () => {
    // A slow voice: 3 syllables a second.
    const scripts = ["Turbo Ball is the best soccer game on Roblox right now", "Score a goal from midfield and watch the crowd go wild", "Download it today and play with your friends for free", "The new update adds three cars and a desert arena map", "Every match is five minutes of nonstop rocket powered action", "Rank up fast by saving shots in the final ten seconds"];
    let rate: { unitsPerSec: number; n: number } | undefined;
    for (const s of scripts.slice(0, 5)) rate = calibrate(rate, speechUnits(s), speechUnits(s) / 3);
    const held = scripts[5];
    const truth = speechUnits(held) / 3;
    expect(Math.abs(speechSeconds(held, rate!.unitsPerSec) - truth) / truth).toBeLessThan(0.1);
  });
});
