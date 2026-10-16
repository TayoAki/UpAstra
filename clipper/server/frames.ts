import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundledFontsDir } from "./fonts";
import { netArgs, run } from "./media";

// Seeing a video without watching it: frames at chosen times, contact sheets
// with each frame's real time under it, and scene cuts. For agents checking a
// render or picking footage.

/** Contact sheets: 3 columns of 480 px cells, 3 rows a page (1440 px wide). */
export const SHEET = { cols: 3, cell: 480, rows: 3 };
/** Frames for a window: 1.5 a second, 4 to 9. */
export const frameCount = (seconds: number) => Math.min(9, Math.max(4, Math.round(1.5 * seconds)));
/** Longest window one call looks at. */
export const MAX_WINDOW = 60;

/** Evenly spaced sample times: the middle of each of `n` equal slots. */
export function frameTimes(start: number, end: number, n = frameCount(end - start)): number[] {
  const len = Math.max(0, end - start);
  return Array.from({ length: n }, (_, i) => Math.round((start + ((i + 0.5) * len) / n) * 1000) / 1000);
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * The span of the `occurrence`-th (1-based) time `phrase` is said, padded by
 * `pad` seconds each side. Matches whole words, or the joined text for
 * scripts written without spaces.
 */
export function phraseWindow(words: { text: string; start: number; end: number }[], phrase: string, occurrence = 1, pad = 0.5): { start: number; end: number } | undefined {
  const p = norm(phrase).replace(/ /g, "");
  if (!p) return undefined;
  const toks = words.map((w) => norm(w.text).replace(/ /g, ""));
  const stream = toks.join("");
  const owner = toks.flatMap((t, i) => Array.from(t, () => i));
  const starts = new Set<number>();
  const ends = new Set<number>();
  let at = 0;
  for (const t of toks) {
    starts.add(at);
    at += t.length;
    ends.add(at);
  }
  const latin = /^[\p{Script=Latin}\p{N}]/u.test(p);
  let seen = 0;
  for (let i = stream.indexOf(p); i >= 0; i = stream.indexOf(p, i + 1)) {
    if (latin && !(starts.has(i) && ends.has(i + p.length))) continue;
    if (++seen < occurrence) continue;
    const a = words[owner[i]];
    const b = words[owner[i + p.length - 1]];
    return { start: Math.max(0, a.start - pad), end: b.end + pad };
  }
  return undefined;
}

export interface Frame {
  /** When the decoded frame really is (seconds), not just the time asked for. */
  t: number;
  file: string;
}

/** How long one look (all its ffmpeg runs together) may take. */
export const LOOK_DEADLINE_MS = 90_000;
const left = (deadline: number) => {
  const ms = deadline - Date.now();
  if (ms < 1000) throw new Error("Looking took too long; try a shorter window or fewer frames");
  return ms;
};

/** One frame per time, `width` px wide, with its decoded time. */
export async function grabFrames(src: string, times: number[], width: number, dir: string, deadline = Date.now() + LOOK_DEADLINE_MS): Promise<Frame[]> {
  const out: Frame[] = [];
  for (const [i, t] of times.entries()) {
    const file = path.join(dir, `f${String(i + 1).padStart(2, "0")}.jpg`);
    // After an accurate seek, showinfo's pts is the frame's time past the seek
    // point, on the same timeline -ss and the cutter use (the file's start = 0).
    const { stderr } = await run("ffmpeg", [...netArgs(src), "-v", "info", "-y", "-ss", t.toFixed(3), "-i", src, "-an", "-frames:v", "1", "-vf", `showinfo,scale=${width}:-2`, "-q:v", "4", file], Math.min(60_000, left(deadline)));
    if (!fs.existsSync(file)) continue;
    const m = stderr.match(/pts_time:\s*(-?[\d.]+)/);
    out.push({ t: Math.round((t + (m ? Math.max(0, Number(m[1])) : 0)) * 1000) / 1000, file });
  }
  return out;
}

const label = (t: number) => `${Math.floor(t / 60)}\\:${(t % 60).toFixed(2).padStart(5, "0")}`;

/**
 * Contact sheets of `frames`: each cell the frame with its time underneath,
 * 3 across, 3 rows a page. Returns the page files (1440 px wide).
 */
export async function contactSheets(src: string, times: number[], dir: string, deadline = Date.now() + LOOK_DEADLINE_MS): Promise<{ pages: string[]; frames: Frame[] }> {
  const frames = await grabFrames(src, times, SHEET.cell, dir, deadline);
  const font = path.join(bundledFontsDir(), "Poppins-Bold.ttf");
  const labelled: string[] = [];
  for (const [i, f] of frames.entries()) {
    const file = path.join(dir, `l${String(i + 1).padStart(2, "0")}.png`);
    // The label sits under the picture (never over it), on a 44 px strip.
    await run("ffmpeg", ["-v", "error", "-y", "-i", f.file, "-vf", `pad=iw:ih+44:0:0:color=0x111111,drawtext=fontfile='${font}':text='${label(f.t)}':fontcolor=white:fontsize=26:x=(w-tw)/2:y=h-36`, file], Math.min(60_000, left(deadline)));
    labelled.push(file);
  }
  const perPage = SHEET.cols * SHEET.rows;
  const pages: string[] = [];
  for (let p = 0; p * perPage < labelled.length; p++) {
    const chunk = labelled.slice(p * perPage, (p + 1) * perPage);
    const list = chunk.map((f, k) => {
      const link = path.join(dir, `p${p}_${String(k).padStart(2, "0")}.png`);
      fs.copyFileSync(f, link);
      return link;
    });
    const rows = Math.ceil(list.length / SHEET.cols);
    const page = path.join(dir, `sheet${p + 1}.jpg`);
    await run("ffmpeg", ["-v", "error", "-y", "-framerate", "1", "-start_number", "0", "-i", path.join(dir, `p${p}_%02d.png`), "-vf", `tile=${SHEET.cols}x${rows}:color=0x111111`, "-frames:v", "1", "-q:v", "4", page], Math.min(60_000, left(deadline)));
    pages.push(page);
  }
  return { pages, frames };
}

/** Longest window scene_cuts looks at in one call (seconds). */
export const MAX_CUTS_WINDOW = 300;

/** Scene cuts (seconds) between `start` and `end`, from ffmpeg's scene-change score on a small decode. */
export async function sceneCutsIn(src: string, start: number, end: number, o: { threshold?: number; crop?: { y: number; h: number } } = {}): Promise<number[]> {
  const crop = o.crop ? `crop=iw:${o.crop.h}:0:${o.crop.y},` : "";
  const { stderr } = await run("ffmpeg", [...netArgs(src), "-v", "info", "-ss", start.toFixed(3), "-t", Math.max(0.1, end - start).toFixed(3), "-i", src, "-an", "-vf", `${crop}scale=160:-2,select='gt(scene,${o.threshold ?? 0.3})',showinfo`, "-f", "null", "-"], 3 * 60_000);
  return [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Math.round((start + Number(m[1])) * 1000) / 1000).filter((t) => t > start && t < end);
}

export const workDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "frames-"));
