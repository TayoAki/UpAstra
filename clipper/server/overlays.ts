import fs from "node:fs";
import path from "node:path";
import { TIERS, type Overlay, type Tier } from "../shared/types";
import { assColor, type Timed } from "./captions";
import { videoStore } from "./storage";

// Overlays timed to the voiceover: a viewer comment that pops up, an emoji that
// bounces in on a word, a big pop-up word, and a tier list whose items drop
// into place as they're named (and stay). Comments, text and the tier board
// are drawn in the ASS subtitle track; emoji are colour images laid over the
// video by ffmpeg (libass can't draw colour emoji).

export interface Placed {
  o: Overlay;
  start: number;
  end: number;
}

const DEFAULT_HOLD: Record<Overlay["kind"], number> = { comment: 2.8, emoji: 1.3, text: 1.1, tier: 0 };
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * When each overlay appears: at the first spoken occurrence of its cue words
 * (later overlays with the same cue take later occurrences), else at `at`
 * seconds. Tier items stay until the call to action. Overlays that can't be
 * placed are returned separately.
 */
export function placeOverlays(overlays: Overlay[], words: Timed[], duration: number, until: number): { placed: Placed[]; missed: Overlay[] } {
  const toks = words.map((w) => norm(w.text));
  const usedAt = new Map<string, number>();
  const placed: Placed[] = [];
  const missed: Overlay[] = [];
  for (const o of overlays) {
    let start: number | undefined;
    const cue = o.cue ? norm(o.cue).split(" ").filter(Boolean) : [];
    if (cue.length) {
      const key = cue.join(" ");
      for (let i = usedAt.get(key) ?? 0; i <= toks.length - cue.length; i++) {
        // Words can carry joined tokens ("car." → "car"), so compare token by token on their normalized text.
        if (cue.every((c, k) => toks[i + k] === c)) {
          start = words[i].start;
          usedAt.set(key, i + 1);
          break;
        }
      }
    }
    if (start === undefined && typeof o.at === "number" && o.at >= 0) start = o.at;
    if (start === undefined || start >= duration - 0.3) {
      missed.push(o);
      continue;
    }
    const end = o.kind === "tier" ? Math.max(start + 1, until) : start + (o.hold && o.hold > 0 ? Math.min(o.hold, 8) : DEFAULT_HOLD[o.kind]);
    placed.push({ o, start, end: Math.min(end, duration) });
  }
  return { placed: placed.sort((a, b) => a.start - b.start), missed };
}

// ---- ASS drawing ----------------------------------------------------------------

const ts = (s: number) => {
  const cs = Math.max(0, Math.round(s * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};
const esc = (s: string) => s.replace(/\\/g, "").replace(/[{}]/g, "").replace(/\n/g, " ");
const r1 = (n: number) => Math.round(n * 10) / 10;

/** A rounded rectangle as an ASS vector drawing, origin top-left. */
export function roundedRect(w: number, h: number, r: number): string {
  r = Math.min(r, w / 2, h / 2);
  const k = r * 0.4477; // control-point inset for a quarter circle
  return [
    `m ${r1(r)} 0`,
    `l ${r1(w - r)} 0`,
    `b ${r1(w - k)} 0 ${r1(w)} ${r1(k)} ${r1(w)} ${r1(r)}`,
    `l ${r1(w)} ${r1(h - r)}`,
    `b ${r1(w)} ${r1(h - k)} ${r1(w - k)} ${r1(h)} ${r1(w - r)} ${r1(h)}`,
    `l ${r1(r)} ${r1(h)}`,
    `b ${r1(k)} ${r1(h)} 0 ${r1(h - k)} 0 ${r1(h - r)}`,
    `l 0 ${r1(r)}`,
    `b 0 ${r1(k)} ${r1(k)} 0 ${r1(r)} 0`,
  ].join(" ");
}

/** Greedy word wrap by character count (ASS can't wrap text placed with \pos to a box). */
export function wrap(text: string, perLine: number, maxLines: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if ((line + " " + w).trim().length > perLine && line) {
      out.push(line);
      line = w;
    } else line = `${line} ${w}`.trim();
  }
  if (line) out.push(line);
  if (out.length > maxLines) {
    const kept = out.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1].replace(/[\s.,;:!?]+$/, "")}…`;
    return kept;
  }
  return out;
}

const TIER_COLORS: Record<Tier, string> = { S: "#FF7F7F", A: "#FFBF7F", B: "#FFDF7F", C: "#FFFF7F", D: "#BFFF7F" };

export interface OverlayLayout {
  /** Frame size and the footage band (overlays sit over the footage). */
  width: number;
  height: number;
  bandTop: number;
  bandHeight: number;
  font: string;
  accent: string;
  uppercase?: boolean;
}

/** Styles the overlay events use (appended to the [V4+ Styles] section). */
export function overlayStyles(L: OverlayLayout): string[] {
  const k = Math.min(L.width, L.height) / 1080;
  const px = (n: number) => Math.max(1, Math.round(n * k));
  const accent = assColor(L.accent);
  return [
    `Style: OvShape,Arial,${px(20)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H90000000,0,0,0,0,100,100,0,0,1,0,${px(4)},7,0,0,0,1`,
    `Style: OvUser,${L.font},${px(30)},&H00807872,&H00807872,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    `Style: OvBody,${L.font},${px(46)},&H00201C1A,&H00201C1A,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    `Style: OvPop,${L.font},${px(124)},&H00FFFFFF,&H00FFFFFF,${accent},&H64000000,0,0,0,0,100,100,0,0,1,${px(9)},${px(4)},5,0,0,0,1`,
    `Style: OvTierLabel,${L.font},${px(64)},&H00201C1A,&H00201C1A,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    `Style: OvTierItem,${L.font},${px(48)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,${px(5)},0,4,0,0,0,1`,
  ];
}

/** Dialogue lines for comments, pop-up text and the tier board. Emoji go through {@link emojiStickers}. */
export function overlayEvents(placed: Placed[], L: OverlayLayout): string[] {
  const k = Math.min(L.width, L.height) / 1080;
  const px = (n: number) => Math.round(n * k);
  const cx = L.width / 2;
  const lines: string[] = [];
  const shape = (start: number, end: number, x: number, y: number, color: string, drawing: string, layer = 5, extra = "") =>
    lines.push(`Dialogue: ${layer},${ts(start)},${ts(end)},OvShape,,0,0,0,,{\\an7\\pos(${Math.round(x)},${Math.round(y)})\\1c${assColor(color)}${extra}\\p1}${drawing}{\\p0}`);

  // While a tier board covers the footage, comments sit above the footage instead.
  const tierItems = placed.filter((x) => x.o.kind === "tier" && x.o.text?.trim());
  const board = tierItems.length ? { from: tierItems[0].start, to: Math.max(...tierItems.map((t) => t.end)) } : undefined;

  // Comment bubbles, stacked so two at once don't overlap.
  let lastBottom = 0;
  let lastEnd = -1;
  for (const p of placed.filter((x) => x.o.kind === "comment")) {
    const user = (p.o.user || "viewer").replace(/^@/, "").slice(0, 24);
    const body = wrap(esc(p.o.text ?? ""), 27, 3);
    if (!body.length) continue;
    const w = px(820);
    const h = px(118) + body.length * px(56);
    const x = cx - w / 2;
    const overBoard = board && p.start < board.to && p.end > board.from;
    const y = overBoard ? Math.max(px(20), L.bandTop - h - px(24)) : p.start < lastEnd ? lastBottom + px(16) : L.bandTop + px(40);
    lastBottom = y + h;
    lastEnd = p.end;
    // Slide up a little and fade, together.
    const mv = (x0: number, y0: number) => `\\move(${Math.round(x0)},${Math.round(y0 + px(28))},${Math.round(x0)},${Math.round(y0)},0,160)\\fad(140,180)`;
    lines.push(`Dialogue: 10,${ts(p.start)},${ts(p.end)},OvShape,,0,0,0,,{\\an7${mv(x, y)}\\1c&H00FFFFFF&\\p1}${roundedRect(w, h, px(34))}{\\p0}`);
    const av = px(68);
    lines.push(`Dialogue: 11,${ts(p.start)},${ts(p.end)},OvShape,,0,0,0,,{\\an7${mv(x + px(28), y + px(26))}\\1c${assColor(L.accent)}\\shad0\\p1}${roundedRect(av, av, av / 2)}{\\p0}`);
    lines.push(`Dialogue: 12,${ts(p.start)},${ts(p.end)},OvUser,,0,0,0,,{\\an5\\move(${Math.round(x + px(28) + av / 2)},${Math.round(y + px(26) + av / 2 + px(28))},${Math.round(x + px(28) + av / 2)},${Math.round(y + px(26) + av / 2)},0,160)\\fad(140,180)\\1c&H00FFFFFF&\\fs${px(34)}\\b1}${esc(user[0].toUpperCase())}`);
    lines.push(`Dialogue: 12,${ts(p.start)},${ts(p.end)},OvUser,,0,0,0,,{\\an7${mv(x + px(116), y + px(30))}}Reply to @${esc(user)}`);
    lines.push(`Dialogue: 12,${ts(p.start)},${ts(p.end)},OvBody,,0,0,0,,{\\an7${mv(x + px(116), y + px(74))}}${body.join("\\N")}`);
  }

  // Pop-up words in the middle of the footage, alternating tilt.
  placed
    .filter((x) => x.o.kind === "text" && x.o.text?.trim())
    .forEach((p, i) => {
      const text = esc(L.uppercase === false ? p.o.text!.trim() : p.o.text!.trim().toUpperCase()).slice(0, 40);
      const y = L.bandTop + L.bandHeight * 0.42;
      lines.push(
        `Dialogue: 8,${ts(p.start)},${ts(p.end)},OvPop,,0,0,0,,{\\an5\\pos(${Math.round(cx)},${Math.round(y)})\\frz${i % 2 ? -4 : 4}\\fscx40\\fscy40\\t(0,110,\\fscx112\\fscy112)\\t(110,190,\\fscx100\\fscy100)\\fad(0,160)}${text}`,
      );
    });

  // The tier board: rows S–D over the footage; items drop into their row and stay.
  const tiers = tierItems;
  if (tiers.length) {
    const from = tiers[0].start;
    const to = Math.max(...tiers.map((t) => t.end));
    const left = px(40);
    const width = L.width - 2 * left;
    const rowH = Math.min(px(124), Math.floor((L.bandHeight - px(40)) / TIERS.length));
    const top = L.bandTop + px(20);
    const labelW = px(130);
    shape(from, to, left - px(8), top - px(8), "#141414", roundedRect(width + px(16), rowH * TIERS.length + px(16), px(18)), 3, "\\1a&H30&\\fad(200,0)");
    TIERS.forEach((t, i) => {
      const y = top + i * rowH;
      shape(from, to, left, y + px(3), TIER_COLORS[t], roundedRect(labelW, rowH - px(6), px(10)), 4, "\\shad0\\fad(200,0)");
      lines.push(`Dialogue: 5,${ts(from)},${ts(to)},OvTierLabel,,0,0,0,,{\\an5\\pos(${Math.round(left + labelW / 2)},${Math.round(y + rowH / 2)})\\fad(200,0)}${t}`);
    });
    const perRow = new Map<Tier, number>();
    for (const p of tiers) {
      const t = (TIERS as readonly string[]).includes(p.o.tier ?? "") ? (p.o.tier as Tier) : "C";
      const idx = perRow.get(t) ?? 0;
      perRow.set(t, idx + 1);
      const name = esc(p.o.text!.trim()).slice(0, 22);
      const slots = 3;
      const slotW = (width - labelW - px(20)) / slots;
      const x = left + labelW + px(20) + (idx % slots) * slotW;
      const y = top + TIERS.indexOf(t) * rowH + rowH / 2 + (idx >= slots ? px(26) : 0);
      const fs = name.length > 12 ? px(38) : px(48);
      lines.push(`Dialogue: 6,${ts(p.start)},${ts(to)},OvTierItem,,0,0,0,,{\\an4\\move(${Math.round(x)},${Math.round(y - px(40))},${Math.round(x)},${Math.round(y)},0,180)\\fs${fs}\\fad(120,0)}${name}`);
    }
  }
  return lines;
}

// ---- Emoji -----------------------------------------------------------------------

/** Noto Emoji image name for an emoji ("🔥" → "emoji_u1f525.png"); variation selectors are dropped. */
export function notoName(emoji: string): string | undefined {
  const cps = [...emoji.trim()].map((c) => c.codePointAt(0)!).filter((cp) => cp !== 0xfe0f);
  if (!cps.length || cps.length > 8 || cps.every((cp) => cp < 0x2000)) return undefined;
  return `emoji_u${cps.map((cp) => cp.toString(16)).join("_")}.png`;
}

const NOTO = "https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@v2.047/png/128";

/** A local PNG of the emoji (Noto Emoji, Apache 2.0), cached in storage after the first download. */
export async function emojiPng(emoji: string, dir: string): Promise<string | undefined> {
  const name = notoName(emoji);
  if (!name) return undefined;
  const file = path.join(dir, name);
  if (fs.existsSync(file)) return file;
  const key = `_emoji/${name}`;
  const store = videoStore();
  try {
    if (await store.exists(key)) {
      const r = await fetch(await store.readUrl(key)).catch(() => undefined);
      if (r?.ok) return (fs.writeFileSync(file, Buffer.from(await r.arrayBuffer())), file);
      const local = await store.readUrl(key);
      if (!/^https?:/.test(local) && fs.existsSync(local)) return (fs.copyFileSync(local, file), file);
    }
    const r = await fetch(`${NOTO}/${name}`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok || !/image\/png/.test(r.headers.get("content-type") ?? "")) return undefined;
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    await store.put(key, file, "image/png").catch(() => undefined);
    return file;
  } catch {
    return undefined;
  }
}

export interface Sticker {
  png: string;
  start: number;
  end: number;
  x: number;
  y: number;
  size: number;
}

/** Where each emoji pops in: alternating corners of the footage, so consecutive ones don't stack. */
export async function emojiStickers(placed: Placed[], L: OverlayLayout, dir: string): Promise<{ stickers: Sticker[]; missing: string[] }> {
  const k = Math.min(L.width, L.height) / 1080;
  const size = Math.round(230 * k);
  const spots = [
    [L.width - size - Math.round(60 * k), L.bandTop + Math.round(40 * k)],
    [Math.round(60 * k), L.bandTop + L.bandHeight - size - Math.round(40 * k)],
    [L.width - size - Math.round(60 * k), L.bandTop + L.bandHeight - size - Math.round(40 * k)],
    [Math.round(60 * k), L.bandTop + Math.round(40 * k)],
  ];
  const stickers: Sticker[] = [];
  const missing: string[] = [];
  let i = 0;
  for (const p of placed.filter((x) => x.o.kind === "emoji" && x.o.emoji)) {
    const png = await emojiPng(p.o.emoji!, dir);
    if (!png) {
      missing.push(p.o.emoji!);
      continue;
    }
    const [x, y] = spots[i++ % spots.length];
    stickers.push({ png, start: p.start, end: p.end, x, y, size });
  }
  return { stickers, missing };
}

/**
 * ffmpeg inputs and filter graph for the stickers, chained after `[base]`:
 * each scales in place, bounces up into position and fades out.
 */
export function stickerGraph(stickers: Sticker[], firstInput: number, base: string, out: string): { inputs: string[]; graph: string } {
  if (!stickers.length) return { inputs: [], graph: `[${base}]null[${out}]` };
  const inputs: string[] = [];
  const parts: string[] = [];
  let prev = base;
  stickers.forEach((s, i) => {
    const dur = Math.max(0.3, s.end - s.start);
    // The still image is looped only for its own window and shifted to start there,
    // so nothing of it exists outside the window (no repeated last frame).
    inputs.push("-loop", "1", "-framerate", "30", "-t", dur.toFixed(2), "-i", s.png);
    const tag = `st${i}`;
    parts.push(
      `[${firstInput + i}:v]format=rgba,scale=${s.size}:${s.size},fade=t=in:st=0:d=0.12:alpha=1,fade=t=out:st=${Math.max(0, dur - 0.2).toFixed(2)}:d=0.2:alpha=1,setpts=PTS+${s.start.toFixed(2)}/TB[${tag}]`,
    );
    const next = i === stickers.length - 1 ? out : `ov${i}`;
    parts.push(
      `[${prev}][${tag}]overlay=x=${s.x}:y='${s.y}+${Math.round(s.size * 0.25)}*max(0\\,1-(t-${s.start.toFixed(2)})/0.18)':eof_action=pass:repeatlast=0:format=rgb[${next}]`,
    );
    prev = next;
  });
  return { inputs, graph: parts.join(";") };
}
