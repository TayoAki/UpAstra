import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildStoryboard, contactSheets, frameCount, frameTimes, grabFrames, phraseWindow, sceneCutsIn, SHEET, storyboardPlan } from "../server/frames";
import { ffmpegAvailable } from "../server/media";

describe("frame sampling", () => {
  it("takes 1.5 frames a second, 4 to 9", () => {
    expect(frameCount(6)).toBe(9);
    expect(frameCount(1)).toBe(4);
    expect(frameCount(4)).toBe(6);
    expect(frameCount(30)).toBe(9);
    expect(frameTimes(0, 6)).toHaveLength(9);
    expect(frameTimes(2, 4, 4)).toEqual([2.25, 2.75, 3.25, 3.75]);
  });

  it("finds a phrase's window in the timed words, by occurrence", () => {
    const words = "play car league now and play car league later".split(" ").map((text, i) => ({ text, start: i, end: i + 0.8 }));
    expect(phraseWindow(words, "Car League")).toEqual({ start: 0.5, end: 3.3 });
    expect(phraseWindow(words, "car league", 2)).toEqual({ start: 5.5, end: 8.3 });
    expect(phraseWindow(words, "car league", 3)).toBeUndefined();
    expect(phraseWindow(words, "car lea")).toBeUndefined(); // whole words only
    const zh = ["现在", "就在", "罗布", "乐思", "上玩"].map((text, i) => ({ text, start: i, end: i + 0.9 }));
    expect(phraseWindow(zh, "罗布乐思", 1, 0)).toEqual({ start: 2, end: 3.9 });
  });
});

describe("storyboard layout", () => {
  it("never has more than 360 tiles, whatever the length", () => {
    expect(storyboardPlan(6)).toMatchObject({ interval: 1, count: 6, cols: 6, rows: 1 });
    for (const d of [1, 59, 360, 361, 400, 3599, 7200, 36_000]) {
      const p = storyboardPlan(d);
      expect(p.count).toBeLessThanOrEqual(360);
      expect(p.count * p.interval).toBeGreaterThanOrEqual(d - 1e-6); // covers the whole file
    }
    expect(storyboardPlan(7200)).toMatchObject({ interval: 20, count: 360, cols: 20, rows: 18 });
  });
});

describe.skipIf(!ffmpegAvailable())("frames from a video", () => {
  let dir = "";
  let src = "";
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "frames-test-"));
    src = path.join(dir, "v.mp4");
    // 3 s red, then 3 s blue: one scene cut at 3 s. 9:16 at 30 fps.
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=270x480:r=30:d=3", "-f", "lavfi", "-i", "color=c=blue:s=270x480:r=30:d=3", "-filter_complex", "[0][1]concat=n=2:v=1[v]", "-map", "[v]", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", src]);
  }, 60_000);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("grabs frames at their real decoded times", async () => {
    const frames = await grabFrames(src, [1, 4.01], 120, dir);
    expect(frames).toHaveLength(2);
    expect(frames[0].t).toBeCloseTo(1, 1);
    // 30 fps: the frame shown at 4.01 s starts at 4.0 or 4.033 s.
    expect(Math.abs(frames[1].t - 4.01)).toBeLessThan(0.04);
    const px = execFileSync("ffmpeg", ["-v", "error", "-i", frames[1].file, "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    expect(px[2]).toBeGreaterThan(px[0]); // blue, the second scene
  }, 60_000);

  it("lays out a 1440 px contact sheet with labels under the pictures", async () => {
    const { pages, frames } = await contactSheets(src, frameTimes(0, 6), dir);
    expect(frames).toHaveLength(9);
    expect(pages).toHaveLength(1);
    const size = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", pages[0]]).toString().trim();
    const [w, h] = size.split(",").map(Number);
    expect(w).toBe(SHEET.cols * SHEET.cell);
    // 3 rows of 480×853 pictures plus a 44 px label strip each.
    expect(h).toBe(3 * (854 + 44));
  }, 120_000);

  it("reports times from the file's start when its timestamps don't start at 0", async () => {
    const off = path.join(dir, "offset.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", src, "-c", "copy", "-output_ts_offset", "2", off]);
    const frames = await grabFrames(off, [1, 4.01], 120, dir);
    expect(frames[0].t).toBeCloseTo(1, 1);
    expect(Math.abs(frames[1].t - 4.01)).toBeLessThan(0.04);
    const px = execFileSync("ffmpeg", ["-v", "error", "-i", frames[0].file, "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    expect(px[0]).toBeGreaterThan(px[2]); // still red: 1 s into the file, not 3 s
    expect((await sceneCutsIn(off, 0, 6))[0]).toBeCloseTo(3, 1); // the same timeline as the frames
  }, 60_000);

  it("draws a 15-minute file as one 360-tile atlas from keyframes", async () => {
    const long = path.join(dir, "long.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=128x72:rate=2:duration=900", "-c:v", "libx264", "-preset", "ultrafast", "-g", "4", long]);
    const out = path.join(dir, "board.jpg");
    const p = await buildStoryboard(long, 900, out);
    expect(p).toMatchObject({ count: 360, cols: 20, rows: 18, interval: 2.5 });
    const size = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", out]).toString().trim();
    expect(size).toBe(`${20 * 160},${18 * 90}`);
  }, 120_000);

  it("finds the scene cut", async () => {
    const cuts = await sceneCutsIn(src, 0, 6);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toBeCloseTo(3, 1);
  }, 60_000);
});
