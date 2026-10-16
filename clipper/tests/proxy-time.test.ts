import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffmpegAvailable, proxyFilter } from "../server/media";

// B0.2: the time burned into each vision-proxy frame is the time of the
// picture in that frame. The fixture changes brightness every second
// (luma = 16 + 10·second) and has keyframes only every 5 s, the case where
// a keyframe-only decode followed by fps= re-stamped frames late.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-"));
const src = path.join(dir, "src.mp4");
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!ffmpegAvailable())("vision proxy timestamps", () => {
  beforeAll(() => {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=30:d=20", "-vf", "geq=lum='16+10*floor(T)':cb=128:cr=128", "-c:v", "libx264", "-g", "150", "-keyint_min", "150", "-sc_threshold", "0", "-pix_fmt", "yuv420p", src]);
  }, 60_000);

  it("labels every frame with its own picture's time, including the last keyframe", () => {
    // Tap the frames exactly where the label is drawn: showinfo logs the pts
    // that drawtext is about to print, beside the frame's mean luma.
    const vf = proxyFilter(20, 480).replace("drawtext=", "showinfo,drawtext=");
    const r = spawnSync("ffmpeg", ["-v", "info", "-skip_frame", "nokey", "-i", src, "-an", "-vf", vf, "-f", "null", "-"], { encoding: "utf8" });
    const frames = [...r.stderr.matchAll(/pts_time:([\d.]+).*?mean:\[(\d+)/g)].map((m) => ({ t: Number(m[1]), luma: Number(m[2]) }));
    expect(frames.length).toBeGreaterThanOrEqual(4);
    for (const f of frames) expect(Math.round((f.luma - 16) / 10)).toBe(Math.floor(f.t + 1e-6));
    expect(frames.map((f) => Math.round(f.t))).toEqual(expect.arrayContaining([0, 5, 10, 15]));
  }, 60_000);

  it("keeps the last keyframe in the proxy", () => {
    const out = path.join(dir, "proxy.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-skip_frame", "nokey", "-i", src, "-an", "-vf", proxyFilter(20, 480), "-c:v", "libx264", "-preset", "ultrafast", out]);
    const n = Number(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", out], { encoding: "utf8" }).trim());
    expect(n).toBeGreaterThanOrEqual(16);
  }, 60_000);
});
