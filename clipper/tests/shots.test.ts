import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffmpegAvailable, sceneCutNear } from "../server/media";
import { shotTimes } from "../server/shots";
import { scriptWords } from "../server/align";
import { PLANNER_PROMPT, toDraft } from "../server/scripts";

// B3.2': a shot starts on a scene cut when one is within 0.4 s of where it
// was going to start.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shots-"));
const video = path.join(dir, "bwb.mp4");
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!ffmpegAvailable())("snapping to cuts", () => {
  beforeAll(() => {
    execFileSync("ffmpeg", ["-v", "error", "-y", ...["black", "white", "black"].flatMap((c) => ["-f", "lavfi", "-i", `color=c=${c}:s=640x360:r=30:d=4`]), "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1[v]", "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
  }, 60_000);

  it("moves a start onto a nearby cut, and leaves it alone otherwise", async () => {
    expect(await sceneCutNear(video, 3.8)).toBeCloseTo(4, 1);
    expect(await sceneCutNear(video, 8.3)).toBeCloseTo(8, 1);
    expect(await sceneCutNear(video, 6)).toBe(6);
    expect(await sceneCutNear(video, 0.1)).toBe(0.1);
    // Only earlier cuts, for shots that must keep the beat after their moment.
    expect(await sceneCutNear(video, 3.8, 0.4, true)).toBe(3.8);
    expect(await sceneCutNear(video, 8.3, 0.4, true)).toBeCloseTo(8, 1);
  }, 60_000);
});

// B3.1: each shot starts when the narration reaches the phrase it shows.
describe("phrase-bound shots", () => {
  const narration = "Someone made Rocket League in Roblox. The Octane hits like a truck. Play Car League today.";
  const words = narration.split(" ").map((t, i) => ({ text: t, start: i * 0.5, end: i * 0.5 + 0.45 }));
  const at = (w: string) => words.find((x) => x.text.replace(/\W/g, "").toLowerCase() === w)!.start;

  it("starts each shot on its phrase, the first at 0, filling the clip exactly", () => {
    const shots = [
      { seconds: 4, phrase: "Someone made Rocket League" },
      { seconds: 3, phrase: "The Octane hits" },
      { seconds: 3, phrase: "Play Car League" },
    ];
    const t = shotTimes(shots, words, 12);
    expect(t.map((x) => x.start)).toEqual([0, at("the"), at("play")]);
    expect(t.every((x) => x.bound)).toBe(true);
    expect(t.reduce((n, x) => n + x.len, 0)).toBeCloseTo(12, 5);
    expect(t[2].start + t[2].len).toBeCloseTo(12, 5);
  });

  it("falls back to proportional sizing for a phrase it can't find, for that shot only", () => {
    const shots = [
      { seconds: 4, phrase: "Someone made" },
      { seconds: 2, phrase: "never said" },
      { seconds: 2, phrase: "hits like a truck" },
      { seconds: 4 },
    ];
    const t = shotTimes(shots, words, 12);
    expect(t.map((x) => x.bound)).toEqual([true, false, true, false]);
    expect(t[2].start).toBeCloseTo(at("hits"), 5);
    // The unbound shot shares the time before the next bound one with the first, by planned seconds.
    expect(t[1].start).toBeGreaterThan(0);
    expect(t[1].start + t[1].len).toBeCloseTo(t[2].start, 5);
    expect(t.reduce((n, x) => n + x.len, 0)).toBeCloseTo(12, 5);
    for (const x of t) expect(x.len).toBeGreaterThanOrEqual(1.5);
  });

  it("ignores a phrase that would make a shot shorter than 1.5 s", () => {
    const shots = [{ seconds: 3, phrase: "Someone" }, { seconds: 3, phrase: "made Rocket" }];
    const t = shotTimes(shots, words, 10);
    expect(t[1].bound).toBe(false); // "made" is 0.5 s in
    expect(t[0].len).toBeGreaterThanOrEqual(1.5);
  });
});

// B3.3: the planner binds shots to phrases and picks footage as evidence.
describe("planner shot rules", () => {
  it("asks for a phrase per shot and visual evidence, in a few words", () => {
    expect(PLANNER_PROMPT).toMatch(/"phrase"/);
    expect(PLANNER_PROMPT).toMatch(/evidence/i);
    // At most ~150 more prompt tokens than before (about 4 characters a token).
    expect(PLANNER_PROMPT.length).toBeLessThanOrEqual(2122 + 600); // 2122 before this change
  });

  it("keeps a shot's phrase only if the narration says it", () => {
    const camp = { footage: [{ id: "f1", name: "Gameplay", kind: "video" }], brief: { lengthSec: { min: 10, max: 30 }, cta: { text: "" } } } as never;
    const d = toDraft({ narration: "The Octane hits like a truck. Play Car League now.", shots: [{ footageName: "Gameplay", moment: "goal", seconds: 4, phrase: "The Octane hits" }, { footageName: "Gameplay", moment: "menu", seconds: 3, phrase: "free rewards forever" }] }, camp);
    expect(d.shots[0].phrase).toBe("The Octane hits");
    expect(d.shots[1].phrase).toBeUndefined();
  });
});

describe("phrase binding, harder cases", () => {
  const timedWords = (ws: string[]) => ws.map((t, i) => ({ text: t, start: i * 0.4, end: i * 0.4 + 0.35 }));

  it("finds the right occurrence of a repeated brand name", () => {
    const words = timedWords("the octane is the fastest car in the game the octane wins every single match play now".split(" "));
    const t = shotTimes([{ seconds: 3, phrase: "the octane is the fastest car" }, { seconds: 3, phrase: "the octane" }, { seconds: 2, phrase: "play now" }], words, 8);
    expect(t.map((x) => x.bound)).toEqual([true, true, true]);
    expect(t[1].start).toBeCloseTo(9 * 0.4, 5); // the second "the octane"
    expect(t[2].start).toBeCloseTo(15 * 0.4, 5); // "play" is word 15
  });

  it("binds phrases in Chinese and Japanese, where words aren't spaced", () => {
    const zh = shotTimes([{ seconds: 3, phrase: "这个游戏太好玩了" }, { seconds: 3, phrase: "现在就在罗布乐思上玩吧" }], timedWords(scriptWords("这个游戏太好玩了。现在就在罗布乐思上玩吧！", "zh")), 8);
    const zw = scriptWords("这个游戏太好玩了。现在就在罗布乐思上玩吧！", "zh");
    expect(zh[1].bound).toBe(true);
    expect(zh[1].start).toBeCloseTo(zw.findIndex((w) => w.startsWith("现在")) * 0.4, 5);
    const jw = scriptWords("このゲームは最高です。今すぐ遊ぼう。", "ja");
    const ja = shotTimes([{ seconds: 3 }, { seconds: 3, phrase: "今すぐ遊ぼう" }], timedWords(jw), 6);
    expect(ja[1].bound).toBe(true);
    expect(ja[1].start).toBeCloseTo(jw.findIndex((w) => w.startsWith("今")) * 0.4, 5);
  });
});
