import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BT709, burnFilter, compose, ffmpegAvailable, yuvMatrix } from "../server/media";

// B0.3: captions, stickers and footage keep their colours through the final
// encode when a player decodes it as BT.709 (what phones do for HD video),
// and the file says so.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "color-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** One pixel of the output, decoded as BT.709 limited range to RGB. */
function pixel(file: string, x: number, y: number, at = 0.5): number[] {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-ss", String(at), "-i", file, "-frames:v", "1", "-vf", `scale=in_color_matrix=bt709:in_range=tv,format=rgb24,crop=1:1:${x}:${y}`, "-f", "rawvideo", "-"]);
  return [...raw.subarray(0, 3)];
}
const near = (a: number[], b: number[]) => a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThanOrEqual(4));

describe.skipIf(!ffmpegAvailable())("colour", () => {
  it("keeps caption, sticker and footage colours under BT.709", async () => {
    // Footage: solid #3366CC, encoded as BT.709 the way phones and cameras do.
    const video = path.join(dir, "v.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x3366CC:s=1080x1920:r=30:d=1", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "1", "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-c:v", "libx264", "-crf", "1", "-c:a", "aac", video]);
    // A caption-style box (ASS colours are &HBBGGRR) and a sticker, both #E5484D.
    const ass = path.join(dir, "s.ass");
    fs.writeFileSync(ass, ["[Script Info]", "ScriptType: v4.00+", "PlayResX: 1080", "PlayResY: 1920", "", "[V4+ Styles]", "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding", "Style: D,Arial,40,&H004D48E5,&H004D48E5,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1", "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text", "Dialogue: 0,0:00:00.00,0:00:05.00,D,,0,0,0,,{\\pos(100,100)\\p1}m 0 0 l 200 0 200 200 0 200{\\p0}", ""].join("\n"));
    const png = path.join(dir, "st.png");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0xE5484D:s=64x64", "-frames:v", "1", png]);
    const out = path.join(dir, "out.mp4");
    await compose({ video, ass, duration: 1, out, workDir: dir, stickers: [{ png, start: 0, end: 1, size: 200, x: 600, y: 1200 } as never] });

    near(pixel(out, 200, 200), [0xe5, 0x48, 0x4d]); // caption box
    near(pixel(out, 700, 1300), [0xe5, 0x48, 0x4d]); // sticker
    near(pixel(out, 540, 900), pixel(video, 540, 900)); // footage, unchanged from the source
    const tags = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=color_space,color_primaries,color_transfer,color_range", "-of", "csv=p=0", out], { encoding: "utf8" }).trim();
    expect(tags).toBe("tv,bt709,bt709,bt709");
  }, 60_000);

  it("burns captions onto any upload without shifting its colours (caption jobs)", () => {
    for (const [name, matrix, size] of [["hd", "bt709", "1280x720"], ["sd", "bt601", "640x480"]] as const) {
      const src = path.join(dir, `${name}.mp4`);
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x3366CC:s=${size}:r=30:d=1`, "-vf", `scale=out_color_matrix=${matrix}:out_range=tv,format=yuv420p`, ...(matrix === "bt709" ? ["-colorspace", "bt709"] : []), "-c:v", "libx264", "-crf", "1", src]);
      const ass = path.join(dir, `${name}.ass`);
      fs.writeFileSync(ass, fs.readFileSync(path.join(dir, "s.ass"), "utf8").replace("PlayResX: 1080", `PlayResX: ${size.split("x")[0]}`).replace("PlayResY: 1920", `PlayResY: ${size.split("x")[1]}`));
      const out = path.join(dir, `${name}-out.mp4`);
      execFileSync("ffmpeg", ["-v", "error", "-y", "-i", src, "-vf", burnFilter(ass, undefined, yuvMatrix(matrix === "bt709" ? "bt709" : undefined, matrix === "bt709" ? 720 : 480)), ...BT709, "-c:v", "libx264", "-crf", "1", out]);
      // Footage (decoded with its own matrix) is unchanged; the caption box is #E5484D.
      const srcPx = execFileSync("ffmpeg", ["-v", "error", "-i", src, "-frames:v", "1", "-vf", `scale=in_color_matrix=${matrix}:in_range=tv,format=rgb24,crop=1:1:600:400`, "-f", "rawvideo", "-"]);
      const sx = Number(size.split("x")[0]);
      near(pixel(out, Math.min(600, sx - 1), 400, 0), [...srcPx.subarray(0, 3)]);
      near(pixel(out, 150, 150, 0), [0xe5, 0x48, 0x4d]);
    }
    expect(yuvMatrix("smpte170m", 1080)).toBe("bt601");
    expect(yuvMatrix("bt709", 480)).toBe("bt709");
    expect(yuvMatrix(undefined, 1080)).toBe("bt709");
    expect(yuvMatrix(undefined, 480)).toBe("bt601");
  }, 60_000);
});
