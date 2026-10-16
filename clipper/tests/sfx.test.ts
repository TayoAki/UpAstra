import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compose, ffmpegAvailable, mixFilter } from "../server/media";
import { sfxEvents } from "../server/sfx";
import type { Overlay } from "../shared/types";

// B4.4: opt-in sound design: a pop when an overlay appears, a whoosh when a
// tier item glides into place, and game audio ducked under the voice.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sfx-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const L = { width: 1080, height: 1920, bandTop: 560, bandHeight: 844, font: "Poppins Black", accent: "#E5484D" };

describe("sound design", () => {
  it("leaves the audio mix exactly as it was when it's off", () => {
    expect(mixFilter({ voice: true })).toBe("[0:a]volume=0.22[g];[1:a]volume=1.6,apad[v];[g][v]amix=inputs=2:duration=first:dropout_transition=0,volume=2,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=44100[a]");
    expect(mixFilter({ voice: false })).toBe("[0:a]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=44100[a]");
  });

  it("times effects from the overlays", () => {
    const o = (x: Partial<Overlay>) => ({ id: Math.random().toString(36), ...x }) as Overlay;
    const ev = sfxEvents([
      { o: o({ kind: "comment", text: "hi", user: "a" }), start: 1, end: 3 },
      { o: o({ kind: "tier", text: "Octane", tier: "S" }), start: 4, end: 9 },
      { o: o({ kind: "tier", text: "Fennec", tier: "A" }), start: 5, end: 9 },
      { o: o({ kind: "emoji", emoji: "🔥" }), start: 6, end: 7 },
    ], L, [{ start: 6 }]);
    expect(ev.filter((e) => e.kind === "pop").map((e) => e.at)).toEqual([1, 4, 5, 6]);
    const whooshes = ev.filter((e) => e.kind === "whoosh");
    expect(whooshes).toHaveLength(2);
    expect(whooshes[0].at).toBeGreaterThan(4);
    expect(whooshes[0].at).toBeLessThan(5); // the first item glides before the second is named
  });

  it("plays effects only for what's drawn, when it's drawn", () => {
    const o = (x: Partial<Overlay>) => ({ id: Math.random().toString(36), ...x }) as Overlay;
    const body = "this is a really long comment that needs three lines to fit in the card";
    const placed = [
      ...Array.from({ length: 6 }, (_, i) => ({ o: o({ kind: "comment", user: `u${i}`, text: body }), start: 1, end: 3 })),
      { o: o({ kind: "emoji", emoji: "🔥" }), start: 4, end: 5 },
    ];
    const ev = sfxEvents(placed, L, [] /* no sticker image for the emoji */);
    const pops = ev.filter((e) => e.kind === "pop");
    expect(pops.length).toBeLessThan(6); // hidden cards make no sound
    expect(pops.every((p) => p.at !== 4)).toBe(true); // nor does an emoji with no image
  });

  it.skipIf(!ffmpegAvailable())("puts a pop exactly on its overlay and keeps the mix at -14 LUFS", async () => {
    // Silent game footage and a voiceover tone, with a pop at 1.0 s before the voice starts.
    const video = path.join(dir, "v.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=1080x1920:r=30:d=6", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "6", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", video]);
    const voice = path.join(dir, "vo-in.wav"); // not voice.wav: compose writes that in its work dir
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=3", "-af", "adelay=2000|2000,apad=whole_dur=6", voice]);
    const ass = path.join(dir, "s.ass");
    fs.writeFileSync(ass, "[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n");
    const out = path.join(dir, "out.mp4");
    await compose({ video, ass, voice, duration: 6, out, workDir: dir, sound: { events: [{ at: 1, kind: "pop" }] } });
    const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", out, "-ac", "1", "-ar", "44100", "-f", "s16le", "-"], { maxBuffer: 1e8 });
    let onset = -1;
    for (let i = 0; i < pcm.length / 2; i++) if (Math.abs(pcm.readInt16LE(i * 2)) > 2000) { onset = i / 44100; break; }
    expect(onset).toBeGreaterThan(0.99);
    expect(onset).toBeLessThan(1.02);
    const r = spawnSync("ffmpeg", ["-v", "info", "-i", out, "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8" });
    const lufs = Number(r.stderr.match(/Integrated loudness:\s*\n\s*I:\s+(-?[\d.]+)/)?.[1]);
    expect(lufs).toBeGreaterThan(-15);
    expect(lufs).toBeLessThan(-13);

    // A dense schedule (a fast tier list: 10 effects in 2 s) still lands at -14 ±1 LUFS.
    const dense = path.join(dir, "dense.mp4");
    const events = Array.from({ length: 5 }, (_, i) => [{ at: 1.4 + i * 0.35, kind: "pop" as const }, { at: 1.6 + i * 0.35, kind: "whoosh" as const }]).flat();
    await compose({ video, ass, voice, duration: 6, out: dense, workDir: dir, sound: { events } });
    const r2 = spawnSync("ffmpeg", ["-v", "info", "-i", dense, "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" });
    const lufs2 = Number(r2.stderr.match(/Integrated loudness:\s*\n\s*I:\s+(-?[\d.]+)/)?.[1]);
    expect(lufs2).toBeGreaterThan(-15);
    expect(lufs2).toBeLessThan(-13);
    // True peak of the final (AAC) file, not just the mix, stays under -1.5 dBTP.
    const peak = Number(r2.stderr.match(/True peak:\s*\n\s*Peak:\s+(-?[\d.]+)/)?.[1]);
    expect(peak).toBeLessThanOrEqual(-1.5);
  }, 60_000);
});
