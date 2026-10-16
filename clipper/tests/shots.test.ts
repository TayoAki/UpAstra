import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffmpegAvailable, sceneCutNear } from "../server/media";

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
  }, 60_000);
});
