import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cueInScript, sanitizeOverlays } from "../shared/overlays";
import type { Overlay } from "../shared/types";
import { buildAss, timeWords } from "../server/captions";
import { compose, ffmpegAvailable } from "../server/media";
import { fitText, notoName, overlayEvents, placeOverlays, roundedRect, stickerGraph } from "../server/overlays";

const script = "Ranking every car. The Octane is S tier, no question. The Dominus? C tier. The Octane again, still S tier.";
const words = timeWords(script, 10);
const layout = { width: 1080, height: 1920, bandTop: 560, bandHeight: 844, font: "Poppins Black", accent: "#E5484D" };

describe("overlays", () => {
  it("land on their cue words; repeated cues take later occurrences; tier items stay until the CTA", () => {
    const o = (x: Partial<Overlay>) => ({ id: Math.random().toString(36), kind: "emoji", emoji: "🔥", ...x }) as Overlay;
    const { placed, missed } = placeOverlays(
      [o({ cue: "no question" }), o({ kind: "tier", cue: "the octane", text: "Octane", tier: "S" }), o({ kind: "tier", cue: "The Octane", text: "Octane 2", tier: "S" }), o({ cue: "not said" }), o({ cue: "not said", at: 9 }), o({ kind: "text", text: "WOW", at: 20 })],
      words,
      12,
      8,
    );
    const find = (t: string) => words.findIndex((w, i) => w.text.toLowerCase().startsWith(t) && (t !== "octane" || i > 0));
    const fire = placed.find((p) => p.o.cue === "no question")!;
    expect(fire.start).toBeCloseTo(words[find("no")].start, 5);
    expect(fire.end - fire.start).toBeCloseTo(1.3, 5);
    const tiers = placed.filter((p) => p.o.kind === "tier");
    expect(tiers).toHaveLength(2);
    expect(tiers[1].start).toBeGreaterThan(tiers[0].start + 3); // the second "the Octane"
    expect(tiers[0].end).toBe(8);
    expect(tiers[1].end).toBeCloseTo(Math.max(8, tiers[1].start + 1), 5); // on screen at least a second
    expect(placed.some((p) => p.o.at === 9 && p.start === 9)).toBe(true); // fallback time
    expect(missed.map((m) => m.cue ?? m.text)).toEqual(["not said", "WOW"]); // no time / past the end
  });

  it("cleans overlays from a model or an edit", () => {
    const raw = [
      { kind: "emoji", cue: "no question", emoji: "🔥🔥🔥" },
      { kind: "emoji", cue: "no question", emoji: "lol" },
      { kind: "tier", cue: "Dominus", text: "Dominus", tier: "x" },
      { kind: "comment", cue: "Ranking every car", user: "@car fan!", text: "  rank the cars   pls " },
      { kind: "text", cue: "never said in the script", text: "NOPE" },
      { kind: "laser", cue: "car", text: "pew" },
      { kind: "text", text: "no cue or time" },
    ];
    const clean = sanitizeOverlays(raw, script, () => "id");
    expect(clean).toEqual([
      { id: "id", kind: "emoji", cue: "no question", emoji: "🔥" },
      { id: "id", kind: "tier", cue: "Dominus", text: "Dominus", tier: "C" },
      { id: "id", kind: "comment", cue: "Ranking every car", text: "rank the cars pls", user: "carfan" },
    ]);
    // Edits keep cues that aren't spoken yet (the UI warns), so people can fix the script after.
    expect(sanitizeOverlays(raw, undefined, () => "id")).toHaveLength(4);
    expect(cueInScript("S TIER, no", script)).toBe(true);
    expect(cueInScript("question no", script)).toBe(false);
    expect(cueInScript("oct", script)).toBe(false); // whole words only
  });

  it("draws comments, pop-up text and a tier board in the subtitle track", () => {
    const { placed } = placeOverlays(
      [
        { id: "a", kind: "tier", cue: "Octane", text: "Octane", tier: "S" },
        { id: "b", kind: "comment", cue: "Ranking", user: "fan", text: "do a tier list of every car please" },
        { id: "c", kind: "text", cue: "no question", text: "goat" },
      ],
      words,
      12,
      9,
    );
    const ev = overlayEvents(placed, layout);
    expect(ev.filter((l) => l.includes("OvTierLabel"))).toHaveLength(5); // S–D
    expect(ev.some((l) => l.includes("OvTierItem") && l.endsWith("Octane"))).toBe(true);
    expect(ev.some((l) => l.includes("Reply to @fan"))).toBe(true);
    expect(ev.some((l) => l.includes("OvPop") && l.endsWith("GOAT"))).toBe(true);
    const ass = buildAss({ hook: "Hook", captions: [], cta: "Play now", ctaFrom: 9, duration: 12, overlays: { placed, layout } });
    expect(ass).toContain("Style: OvTierItem,");
    expect(ass.indexOf("[Events]")).toBeGreaterThan(ass.indexOf("Style: OvPop,"));
    expect(roundedRect(100, 50, 10).startsWith("m 10 0 l 90 0 b")).toBe(true);
    expect(fitText("one two three four five six seven", { font: "Poppins Black", size: 40, minSize: 40, maxWidth: 160, maxLines: 2 }).lines).toEqual(["one two", "three four…"]);
  });

  it("names Noto emoji images and builds the sticker graph", () => {
    expect(notoName("🔥")).toBe("emoji_u1f525.png");
    expect(notoName("❤️")).toBe("emoji_u2764.png");
    expect(notoName("👍🏽")).toBe("emoji_u1f44d_1f3fd.png");
    expect(notoName("a")).toBeUndefined();
    const g = stickerGraph([{ png: "/x.png", start: 2, end: 3.3, x: 10, y: 20, size: 200 }], 2, "sub", "v");
    expect(g.inputs).toEqual(["-loop", "1", "-framerate", "30", "-t", "1.30", "-i", "/x.png"]);
    expect(g.graph).toContain("setpts=PTS+2.00/TB");
    expect(g.graph).toContain("[sub][st0]overlay=");
    expect(stickerGraph([], 2, "sub", "v").graph).toBe("[sub]null[v]");
  });

  it.skipIf(!ffmpegAvailable())("burns a sticker only inside its window", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ov-"));
    const video = path.join(dir, "bg.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=1080x1920:r=30:d=4", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", video]);
    const png = path.join(dir, "red.png");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=128x128", "-frames:v", "1", png]);
    const ass = path.join(dir, "s.ass");
    fs.writeFileSync(ass, buildAss({ hook: "", captions: [], cta: "", ctaFrom: 4, duration: 4 }));
    const out = path.join(dir, "out.mp4");
    await compose({ video, ass, duration: 4, out, workDir: dir, stickers: [{ png, start: 1.5, end: 2.8, x: 400, y: 800, size: 200 }] });
    const pixel = (t: number) => execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", out, "-frames:v", "1", "-vf", "crop=1:1:500:900,format=rgb24", "-f", "rawvideo", "-"]);
    const isRed = (b: Buffer) => b[0] > 150 && b[2] < 100;
    expect(isRed(pixel(0.5))).toBe(false);
    expect(isRed(pixel(2.2))).toBe(true);
    expect(isRed(pixel(3.5))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
