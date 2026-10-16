import fs from "node:fs";
import path from "node:path";
import { tierSchedule, type OverlayLayout, type Placed } from "./overlays";

// Opt-in sound design (brief.soundDesign): a short pop when an overlay
// appears and a whoosh when a tier item glides into its cell, timed from the
// same schedule the overlays are drawn with. The sounds are synthesised here,
// so there are no sample files to license.

export type SfxKind = "pop" | "whoosh";
export interface SfxEvent {
  at: number;
  kind: SfxKind;
}

/** How loud each effect sits under the voice (linear gain). */
export const SFX_GAIN: Record<SfxKind, number> = { pop: 0.5, whoosh: 0.35 };

/** When each effect plays: a pop on every overlay's entrance, a whoosh on every tier glide. */
export function sfxEvents(placed: Placed[], L: OverlayLayout): SfxEvent[] {
  const out: SfxEvent[] = [];
  const tiers = placed.filter((p) => p.o.kind === "tier" && p.o.text?.trim());
  if (tiers.length) {
    const to = Math.max(...tiers.map((t) => t.end));
    for (const s of tierSchedule(tiers.map((t) => t.start), to)) out.push({ at: s.start, kind: "pop" }, { at: s.glideStart, kind: "whoosh" });
  }
  for (const p of placed) if (p.o.kind !== "tier" && (p.o.kind !== "text" || p.o.text?.trim()) && (p.o.kind !== "comment" || p.o.text?.trim())) out.push({ at: p.start, kind: "pop" });
  void L; // the layout doesn't change timing today; kept so effects can follow placement later
  return out.sort((a, b) => a.at - b.at || a.kind.localeCompare(b.kind));
}

const RATE = 44100;

/** A short falling blip: a sine sweeping 1400 → 500 Hz with a fast decay. */
function pop(): Float32Array {
  const n = Math.round(RATE * 0.09);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    phase += (2 * Math.PI * (1400 - 900 * t)) / RATE;
    out[i] = Math.sin(phase) * Math.exp(-6 * t) * Math.min(1, i / 40);
  }
  return out;
}

/** Air moving past: noise through a low-pass whose cutoff sweeps up and back down. */
function whoosh(): Float32Array {
  const n = Math.round(RATE * 0.3);
  const out = new Float32Array(n);
  let seed = 12345;
  let y = 0;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff; // deterministic noise
    const noise = seed / 0x3fffffff - 1;
    const t = i / n;
    const cutoff = 300 + 2700 * Math.sin(Math.PI * t);
    const a = 1 - Math.exp((-2 * Math.PI * cutoff) / RATE);
    y += a * (noise - y);
    out[i] = y * Math.sin(Math.PI * t) * 1.6;
  }
  return out;
}

/** Write a mono sound as a 44.1 kHz stereo 16-bit WAV. */
function writeWav(file: string, s: Float32Array) {
  const data = Buffer.alloc(s.length * 4);
  s.forEach((v, i) => {
    const x = Math.round(Math.max(-1, Math.min(1, v)) * 32767);
    data.writeInt16LE(x, i * 4);
    data.writeInt16LE(x, i * 4 + 2);
  });
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

/** The effect files in `dir`, written on first use. */
export function sfxFiles(dir: string): Record<SfxKind, string> {
  const files = { pop: path.join(dir, "sfx-pop.wav"), whoosh: path.join(dir, "sfx-whoosh.wav") };
  if (!fs.existsSync(files.pop)) writeWav(files.pop, pop());
  if (!fs.existsSync(files.whoosh)) writeWav(files.whoosh, whoosh());
  return files;
}
