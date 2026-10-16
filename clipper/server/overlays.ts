import fs from "node:fs";
import path from "node:path";
import { UNSPACED } from "../shared/overlays";
import { BOARD_KINDS, TIERS, type Overlay, type Tier } from "../shared/types";
import { assColor, type Timed } from "./captions";
import { FONT_WIDTHS, WIDE_EM } from "./font-metrics";
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

const DEFAULT_HOLD: Record<Overlay["kind"], number> = { comment: 2.8, emoji: 1.3, text: 1.1, tier: 0, rank: 0, podium: 0, quiz: 3.5 };
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * When each overlay appears: at the first spoken occurrence of its cue words
 * (later overlays with the same cue take later occurrences), else at `at`
 * seconds. Tier items stay until the call to action. Overlays that can't be
 * placed are returned separately.
 */
export function placeOverlays(overlays: Overlay[], words: Timed[], duration: number, until: number, moments: Record<string, number> = {}): { placed: Placed[]; missed: Overlay[] } {
  const toks = words.map((w) => norm(w.text));
  const usedAt = new Map<string, number>();
  const placed: Placed[] = [];
  const missed: Overlay[] = [];
  for (const o of overlays) {
    let start: number | undefined;
    // "@name" lands on a moment marked in the narration.
    if (o.cue?.trim().startsWith("@")) start = moments[o.cue.trim().slice(1)];
    const cue = o.cue && start === undefined ? norm(o.cue).split(" ").filter(Boolean) : [];
    if (cue.length) {
      const key = cue.join(" ");
      for (let i = usedAt.get(key) ?? 0; i <= toks.length - cue.length; i++) {
        // Words can carry joined tokens ("car." → "car"), so compare token by token on their normalized text.
        if (cue.every((c, k) => toks[i + k] === c)) {
          start = words[i].start;
          usedAt.set(key, i + 1);
          break;
        }
      }      // Unspaced scripts: the cue can start and end inside segmenter words; match on the joined text.
      if (start === undefined && UNSPACED.test(key)) {
        const stream = toks.map((t) => t.replace(/ /g, ""));
        const owner = stream.flatMap((t, i) => Array.from(t, () => i));
        const from = stream.slice(0, usedAt.get(key) ?? 0).join("").length;
        const at = stream.join("").indexOf(key.replace(/ /g, ""), from);
        if (at >= 0) {
          start = words[owner[at]].start;
          usedAt.set(key, owner[at] + 1);
        }
      }
    }
    if (start === undefined && typeof o.at === "number" && o.at >= 0) start = o.at;
    if (start === undefined || start >= duration - 0.3) {
      missed.push(o);
      continue;
    }
    // The board stays until the call to action (a last item named just before it gets 0.6 s to land).
    let end = BOARD_KINDS.includes(o.kind) ? Math.max(start + 0.6, until) : start + (o.hold && o.hold > 0 ? Math.min(o.hold, 8) : DEFAULT_HOLD[o.kind]);
    // A quiz (and its answer reveal) is over before the call to action comes up.
    if (o.kind === "quiz" && start < until) end = Math.max(start + 1, Math.min(end, until));
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

// ---- Text fitting -----------------------------------------------------------------
// ASS can't wrap text placed with \pos into a box, so overlays wrap and size
// their own text from libass advance widths measured for the bundled fonts
// (scripts/measure-fonts.mjs, within ~3% of a real render, never under).

const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;
const EMOJI = /\p{Extended_Pictographic}/u;
/**
 * For brand uploads (and whatever fontconfig substitutes when one fails to
 * load) we have no metrics: each character's widest bundled width plus 30%,
 * an upper bound for common faces (the widest measured, DejaVu Sans Bold,
 * came within 1% of it).
 */
const FALLBACK_WIDTHS: Record<string, number> = {};
for (const m of Object.values(FONT_WIDTHS)) for (const [ch, w] of Object.entries(m)) FALLBACK_WIDTHS[ch] = Math.max(FALLBACK_WIDTHS[ch] ?? 0, w * 1.3);

/** Rendered width of a single line of text at an ASS font size. */
export function textWidth(text: string, size: number, font: string, measured?: Record<string, number>): number {
  const m = measured ?? FONT_WIDTHS[font] ?? FALLBACK_WIDTHS;
  let w = 0;
  for (const ch of text) {
    if (m[ch] !== undefined) w += m[ch];
    else if (WIDE.test(ch)) w += WIDE_EM;
    else if (EMOJI.test(ch)) w += 0.8;
    else w += m[ch.normalize("NFD")[0]] ?? 0.62;
  }
  return w * size;
}

export interface FitOptions {
  font: string;
  /** Measured widths for a brand font. */
  widths?: Record<string, number>;
  size: number;
  minSize: number;
  maxWidth: number;
  maxLines: number;
}

function wrapToWidth(words: string[], size: number, o: FitOptions): string[] {
  const fits = (t: string) => textWidth(t, size, o.font, o.widths) <= o.maxWidth;
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    const joined = line ? `${line} ${w}` : w;
    if (fits(joined)) {
      line = joined;
      continue;
    }
    if (line) out.push(line);
    // A word too wide for a line of its own (or an unspaced CJK run) breaks by character.
    let piece = "";
    for (const ch of w) {
      if (!piece || fits(piece + ch)) piece += ch;
      else {
        out.push(piece);
        piece = ch;
      }
    }
    line = piece;
  }
  if (line) out.push(line);
  return out;
}

/**
 * Wrap text to a box: at the largest size from `size` down to `minSize` that
 * fits in `maxLines`, and only at `minSize` cut the last line with an ellipsis.
 */
export function fitText(text: string, o: FitOptions): { lines: string[]; size: number } {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { lines: [], size: o.size };
  const step = Math.max(1, Math.round(o.size * 0.06));
  for (let size = o.size; ; size = Math.max(o.minSize, size - step)) {
    const lines = wrapToWidth(words, size, o);
    if (lines.length <= o.maxLines) return { lines, size };
    if (size <= o.minSize) {
      const kept = lines.slice(0, o.maxLines);
      let last = kept[kept.length - 1];
      const ell = (t: string) => `${t.replace(/[\s.,;:!?…]+$/u, "")}…`;
      while (last && textWidth(ell(last), size, o.font, o.widths) > o.maxWidth) last = [...last].slice(0, -1).join("");
      kept[kept.length - 1] = ell(last);
      return { lines: kept, size };
    }
  }
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
  /** Measured widths of the font, when it's a brand upload. */
  fontWidths?: Record<string, number>;
  /** The hook across the top, so cards placed above the footage keep clear of it. */
  hook?: { text: string; end: number };
}

// ---- Layout -------------------------------------------------------------------------

const scaleOf = (L: OverlayLayout) => {
  const k = Math.min(L.width, L.height) / 1080;
  return (n: number) => Math.round(n * k);
};
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The tier board as a grid: each tier's row holds up to three items across,
 * and more items wrap onto extra lines inside the row with a smaller font.
 * Names are fitted to their cell (shrunk, then cut with "…"), so nothing
 * overlaps or runs off the frame.
 */
const MAX_PER_TIER = 12;

/**
 * When each tier item reveals, glides and settles. Its window runs from its
 * cue to the next item's cue (at most 2 s): the pop takes up to a quarter of
 * it (≤ 0.18 s), the glide up to a third (≤ 0.35 s), the hold the rest, so a
 * fast-talking ranking compresses the motion instead of overlapping it.
 */
export function tierSchedule(starts: number[], boardEnd: number) {
  return starts.map((start, i) => {
    // Every item, the last one included, is settled at least 0.3 s before the board goes.
    const next = i < starts.length - 1 ? Math.max(start, starts[i + 1]) : start + 2;
    const w = Math.max(0.05, Math.min(next, boardEnd - 0.3) - start);
    const glide = Math.min(0.35, w * 0.35);
    const glideEnd = start + w;
    return { start, glideStart: glideEnd - glide, glideEnd, end: Math.max(glideEnd, boardEnd) };
  });
}

export function tierLayout(items: { text: string; tier: Tier }[], L: OverlayLayout) {
  const px = scaleOf(L);
  const left = px(40);
  const width = L.width - 2 * left;
  const rowH = Math.min(px(124), Math.floor((L.bandHeight - px(40)) / TIERS.length));
  const top = L.bandTop + px(20);
  const labelW = px(130);
  const gap = px(20);
  const outline = px(5);
  const area = width - labelW - gap;
  const count = new Map<Tier, number>();
  for (const it of items) count.set(it.tier, (count.get(it.tier) ?? 0) + 1);
  const seen = new Map<Tier, number>();
  const placed = items.map((it) => {
    // At most 4 lines of 3 per tier (plans carry at most 12 overlays); any more aren't drawn.
    const n = Math.min(count.get(it.tier)!, MAX_PER_TIER);
    const j = seen.get(it.tier) ?? 0;
    seen.set(it.tier, j + 1);
    if (j >= MAX_PER_TIER) return { text: "", size: 0, x: 0, cy: 0, box: { x: 0, y: 0, w: 0, h: 0 } };
    const cols = Math.min(3, n);
    const lineH = (rowH - px(6)) / Math.ceil(n / cols);
    const slotW = area / cols;
    const size = Math.max(px(14), Math.min(px(48), Math.floor(lineH - 2 * outline)));
    const fit = fitText(it.text, { font: L.font, widths: L.fontWidths, size, minSize: Math.max(px(12), Math.floor(size * 0.6)), maxWidth: slotW - px(12) - 2 * outline, maxLines: 1 });
    const text = fit.lines[0] ?? "";
    const x = left + labelW + gap + (j % cols) * slotW + outline;
    const cy = top + TIERS.indexOf(it.tier) * rowH + px(3) + lineH * (Math.floor(j / cols) + 0.5);
    const w = textWidth(text, fit.size, L.font, L.fontWidths);
    const box: Box = { x: x - outline, y: cy - fit.size / 2 - outline, w: w + 2 * outline, h: fit.size + 2 * outline };
    return { text, size: fit.size, x, cy, box };
  });
  return { left, top, width, labelW, rowH, items: placed };
}

/** A board item fitted into its place: centred at (cx, cy). */
export interface Slot {
  text: string;
  size: number;
  cx: number;
  cy: number;
  box: Box;
}
const emptySlot: Slot = { text: "", size: 0, cx: 0, cy: 0, box: { x: 0, y: 0, w: 0, h: 0 } };

/**
 * A Top-N list: a numbered column of `n` slots down the footage, #1 at the
 * top. Each item is fitted to its slot (shrunk, then cut with "…"); a second
 * item for a taken place isn't drawn.
 */
export function rankLayout(items: { text: string; rank: number }[], L: OverlayLayout) {
  const px = scaleOf(L);
  const n = Math.min(10, Math.max(3, ...items.map((i) => i.rank)));
  const left = px(40);
  const width = L.width - 2 * left;
  const slotH = Math.min(px(120), Math.floor((L.bandHeight - px(40)) / n));
  const top = L.bandTop + Math.round((L.bandHeight - slotH * n) / 2);
  const labelW = Math.min(px(130), slotH + px(20));
  const gap = px(20);
  const outline = px(5);
  const area = width - labelW - gap - px(12);
  const taken = new Set<number>();
  const slots = items.map((it): Slot => {
    if (taken.has(it.rank)) return emptySlot;
    taken.add(it.rank);
    const size = Math.max(px(16), Math.min(px(58), Math.floor(slotH - px(14) - 2 * outline)));
    const fit = fitText(it.text, { font: L.font, widths: L.fontWidths, size, minSize: Math.max(px(14), Math.floor(size * 0.6)), maxWidth: area - 2 * outline, maxLines: 1 });
    const text = fit.lines[0] ?? "";
    const w = textWidth(text, fit.size, L.font, L.fontWidths);
    const x = left + labelW + gap + outline;
    const cy = top + (it.rank - 1) * slotH + slotH / 2;
    return { text, size: fit.size, cx: x + w / 2, cy, box: { x: x - outline, y: cy - fit.size / 2 - outline, w: w + 2 * outline, h: fit.size + 2 * outline } };
  });
  return { n, left, top, width, slotH, labelW, slots };
}

/** Podium blocks, left to right: 2nd, 1st (tallest), 3rd. */
const PODIUM_ORDER = [2, 1, 3];
const PODIUM_HEIGHT: Record<number, number> = { 1: 300, 2: 220, 3: 160 };
const PODIUM_COLORS: Record<number, string> = { 1: "#F5C542", 2: "#C9CED6", 3: "#D08A4E" };

/** A podium at the foot of the footage; each item's name sits above its block. */
export function podiumLayout(items: { text: string; rank: number }[], L: OverlayLayout) {
  const px = scaleOf(L);
  const side = px(60);
  const gap = px(18);
  const blockW = Math.floor((L.width - 2 * side - 2 * gap) / 3);
  const bottom = L.bandTop + L.bandHeight - px(24);
  const blocks = PODIUM_ORDER.map((place, i) => {
    const h = px(PODIUM_HEIGHT[place]);
    return { place, x: side + i * (blockW + gap), y: bottom - h, w: blockW, h };
  });
  const outline = px(5);
  const taken = new Set<number>();
  const slots = items.map((it): Slot => {
    if (taken.has(it.rank)) return emptySlot;
    taken.add(it.rank);
    const b = blocks.find((x) => x.place === it.rank)!;
    const fit = fitText(it.text, { font: L.font, widths: L.fontWidths, size: px(52), minSize: px(26), maxWidth: b.w - 2 * outline, maxLines: 1 });
    const text = fit.lines[0] ?? "";
    const w = textWidth(text, fit.size, L.font, L.fontWidths);
    const cx = b.x + b.w / 2;
    const cy = b.y - px(16) - fit.size / 2;
    return { text, size: fit.size, cx, cy, box: { x: cx - w / 2 - outline, y: cy - fit.size / 2 - outline, w: w + 2 * outline, h: fit.size + 2 * outline } };
  });
  return { blocks, slots };
}

/**
 * A quiz strip: 2–4 answer chips across the bottom of the footage, each
 * lettered and fitted (shrunk, wrapped onto two lines, then cut), with the
 * question above them when there is one.
 */
export function quizLayout(o: Overlay, L: OverlayLayout, above = false) {
  const px = scaleOf(L);
  const answers = (o.answers ?? []).slice(0, 4);
  const side = px(40);
  const gap = px(16);
  const n = Math.max(1, answers.length);
  const chipW = Math.floor((L.width - 2 * side - (n - 1) * gap) / n);
  const chipH = px(132);
  // Over the bottom of the footage; or just above it while a board covers the footage.
  const y = above ? L.bandTop - px(24) - chipH : L.bandTop + L.bandHeight - px(36) - chipH;
  const badge = px(44);
  const chips = answers.map((a, i) => {
    const x = side + i * (chipW + gap);
    // The text sits right of the letter badge: 14 px in, the badge, 12 px, then the text, 14 px clear of the edge.
    const textW = chipW - px(14) - badge - px(12) - px(14);
    const fit = fitText(esc(a), { font: L.font, widths: L.fontWidths, size: px(40), minSize: px(20), maxWidth: textW, maxLines: 2 });
    return { x, y, w: chipW, h: chipH, letter: "ABCD"[i], lines: fit.lines, size: fit.size, textW };
  });
  const q = o.text?.trim() ? fitText(esc(o.text.trim()), { font: L.font, widths: L.fontWidths, size: px(52), minSize: px(30), maxWidth: L.width - 2 * side, maxLines: 2 }) : undefined;
  const qBox = q ? { x: side, y: y - px(20) - q.lines.length * q.size * 1.15, w: L.width - 2 * side, h: q.lines.length * q.size * 1.15 } : undefined;
  return { chips, badge, question: q && qBox ? { ...q, box: qBox } : undefined, box: { x: side, y: qBox?.y ?? y, w: L.width - 2 * side, h: y + chipH - (qBox?.y ?? y) } };
}

/** Whether a quiz shares the screen with a board (tier, Top-N, podium), so it goes above the footage. */
function quizAbove(q: Placed, placed: Placed[]) {
  const board = placed.filter((x) => BOARD_KINDS.includes(x.o.kind) && x.o.text?.trim());
  if (!board.length) return false;
  const from = Math.min(...board.map((b) => b.start));
  const to = Math.max(...board.map((b) => b.end));
  return q.start < to && q.end > from;
}

/** Something else on screen for a while that comment cards must keep clear of. */
export interface Blocked extends Box {
  start: number;
  end: number;
  what: "hook" | "text" | "sticker";
}

/** A pop-up word: fitted to the frame with room for its 112% pop and outline, centred in the footage. */
function popLayout(p: Placed, L: OverlayLayout) {
  const px = scaleOf(L);
  const text = esc(L.uppercase === false ? p.o.text!.trim() : p.o.text!.trim().toUpperCase()).slice(0, 80);
  const fit = fitText(text, { font: L.font, widths: L.fontWidths, size: px(124), minSize: px(64), maxWidth: (L.width - px(80)) / 1.12 - 2 * px(9), maxLines: 2 });
  const cy = L.bandTop + L.bandHeight * 0.42;
  const w = Math.max(...fit.lines.map((l) => textWidth(l, fit.size, L.font, L.fontWidths))) * 1.12 + 2 * px(9);
  const h = fit.lines.length * fit.size * 1.12 + 2 * px(9);
  return { fit, cx: L.width / 2, cy, box: { x: L.width / 2 - w / 2, y: cy - h / 2, w, h } };
}

/** Where emoji stickers go: alternating corners of the footage. */
export function stickerSpots(L: OverlayLayout) {
  const px = scaleOf(L);
  const size = px(230);
  const spots = [
    [L.width - size - px(60), L.bandTop + px(40)],
    [px(60), L.bandTop + L.bandHeight - size - px(40)],
    [L.width - size - px(60), L.bandTop + L.bandHeight - size - px(40)],
    [px(60), L.bandTop + px(40)],
  ];
  return { size, spots };
}

/** The hook, pop-up words and stickers, as boxes in time that comment cards avoid. */
export function blockedBoxes(placed: Placed[], L: OverlayLayout): Blocked[] {
  const px = scaleOf(L);
  const out: Blocked[] = [];
  if (L.hook?.text.trim()) {
    // Top-centred at y = bandTop − 330 with 70 px side margins (see the Hook style in captions.ts).
    const fs = px(76);
    const lines = fitText(esc(L.hook.text), { font: L.font, widths: L.fontWidths, size: fs, minSize: fs, maxWidth: L.width - 2 * px(70), maxLines: 6 }).lines.length;
    out.push({ what: "hook", start: 0, end: L.hook.end, x: px(70) - px(7), y: L.bandTop - px(330) - px(7), w: L.width - 2 * px(70) + 2 * px(7), h: lines * fs * 1.15 + 2 * px(7) });
  }
  for (const p of placed.filter((x) => x.o.kind === "text" && x.o.text?.trim())) out.push({ what: "text", start: p.start, end: p.end, ...popLayout(p, L).box });
  for (const p of placed.filter((x) => x.o.kind === "quiz" && (x.o.answers?.length ?? 0) >= 2)) out.push({ what: "text", start: p.start, end: p.end, ...quizLayout(p.o, L, quizAbove(p, placed)).box });
  const { size, spots } = stickerSpots(L);
  placed
    .filter((x) => x.o.kind === "emoji" && x.o.emoji)
    .forEach((p, i) => {
      const [x, y] = spots[i % spots.length];
      // Stickers bounce in from a quarter of their size below.
      out.push({ what: "sticker", start: p.start, end: p.end, x, y, w: size, h: size * 1.25 });
    });
  return out;
}

export interface CommentIn {
  start: number;
  end: number;
  text: string;
  user: string;
}

/**
 * Where each comment card goes. A card is checked against every card still
 * on screen when it appears, not just the previous one. If there's no room
 * it gets fewer body lines, then waits for a card to leave, and is only left
 * out if it would have under 0.6 s on screen. While a tier board covers the
 * footage, cards sit in the space above the footage instead.
 */
export function commentLayout(comments: CommentIn[], L: OverlayLayout, board?: { from: number; to: number }, blocked: Blocked[] = []) {
  const px = scaleOf(L);
  const w = px(820);
  const x = L.width / 2 - w / 2;
  const gap = px(16);
  const out: (Box & CommentIn & { body: string[]; bodySize: number; shown: boolean })[] = [];
  for (const c0 of [...comments].sort((a, b) => a.start - b.start)) {
    let c = { ...c0 };
    let done = false;
    for (let attempt = 0; attempt < comments.length + 1 && !done; attempt++) {
      const overBoard = !!board && c.start < board.to && c.end > board.from;
      // The band over the footage, or the space above it during a tier board.
      const region = overBoard ? { top: px(20), bottom: L.bandTop - px(24) } : { top: L.bandTop + px(40), bottom: L.bandTop + L.bandHeight - px(20) };
      // Everything on screen at the same time: other cards, and the hook, pop-up words and stickers.
      const live: Box[] = [...out.filter((p) => p.shown), ...blocked].filter((p) => p.start < c.end && c.start < p.end);
      for (const maxLines of [3, 2, 1]) {
        const fit = fitText(c.text, { font: L.font, widths: L.fontWidths, size: px(46), minSize: px(38), maxWidth: c.user ? w - px(152) : w - px(80), maxLines });
        if (!fit.lines.length) break;
        // A card with no "Reply to @…" header is shorter.
        const h = (c.user ? px(118) : px(80)) + fit.lines.length * Math.round(fit.size * (56 / 46));
        // Top-down in the band; bottom-up (nearest the footage) above it.
        const tries = overBoard ? [region.bottom - h, ...live.map((p) => p.y - gap - h)].sort((a, b) => b - a) : [region.top, ...live.map((p) => p.y + p.h + gap)].sort((a, b) => a - b);
        const clear = (y: number) => live.every((p) => x + w + gap <= p.x || p.x + p.w + gap <= x || y + h + gap <= p.y || p.y + p.h + gap <= y);
        const y = tries.find((y) => y >= region.top && y + h <= region.bottom && clear(y));
        if (y !== undefined) {
          out.push({ ...c, x, y, w, h, body: fit.lines, bodySize: fit.size, shown: true });
          done = true;
          break;
        }
      }
      if (done) break;
      // No room now: wait until the first card on screen leaves.
      const next = Math.min(...[...out.filter((p) => p.shown), ...blocked].filter((p) => p.start < c.end && c.start < p.end).map((p) => p.end).filter((e) => e > c.start));
      if (!Number.isFinite(next) || next > c.end - 0.6) break;
      c = { ...c, start: next };
    }
    if (!done) out.push({ ...c0, x, y: 0, w, h: 0, body: [], bodySize: 0, shown: false });
  }
  return out;
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
    `Style: OvRankLabel,${L.font},${px(64)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    `Style: OvQuizQ,${L.font},${px(52)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,${px(6)},${px(2)},2,0,0,0,1`,
    `Style: OvQuizLetter,${L.font},${px(30)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    `Style: OvQuizText,${L.font},${px(40)},&H00201C1A,&H00201C1A,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,4,0,0,0,1`,
  ];
}

/** The comment cards of a render, laid out (while a tier board covers the footage, they sit above it). */
export function layoutComments(placed: Placed[], L: OverlayLayout) {
  const tiers = placed.filter((x) => BOARD_KINDS.includes(x.o.kind) && x.o.text?.trim());
  const board = tiers.length ? { from: tiers[0].start, to: Math.max(...tiers.map((t) => t.end)) } : undefined;
  const comments = placed
    .filter((x) => x.o.kind === "comment" && x.o.text?.trim())
    .map((p) => ({ start: p.start, end: p.end, text: esc(p.o.text!), user: (p.o.user ?? "").replace(/^@/, "").trim().slice(0, 24) }));
  return commentLayout(comments, L, board, blockedBoxes(placed, L));
}

/** Comments that didn't fit anywhere while they were due, so the render can say so. */
export const hiddenComments = (placed: Placed[], L: OverlayLayout) => layoutComments(placed, L).filter((c) => !c.shown);

/** Dialogue lines for comments, pop-up text and the tier board. Emoji go through {@link emojiStickers}. */
export function overlayEvents(placed: Placed[], L: OverlayLayout): string[] {
  const k = Math.min(L.width, L.height) / 1080;
  const px = (n: number) => Math.round(n * k);
  const cx = L.width / 2;
  const lines: string[] = [];
  const shape = (start: number, end: number, x: number, y: number, color: string, drawing: string, layer = 5, extra = "") =>
    lines.push(`Dialogue: ${layer},${ts(start)},${ts(end)},OvShape,,0,0,0,,{\\an7\\pos(${Math.round(x)},${Math.round(y)})\\1c${assColor(color)}${extra}\\p1}${drawing}{\\p0}`);

  const tierItems = placed.filter((x) => x.o.kind === "tier" && x.o.text?.trim());
  const ms = (a: number, b: number) => Math.max(1, Math.round((b - a) * 1000));
  /** Board items: each pops in large at the stage on its cue, then glides into its slot and stays. */
  const reveal = (items: Placed[], slots: { text: string; size: number; cx: number; cy: number }[], to: number, stage: { x: number; y: number; width: number }) => {
    const plan = tierSchedule(items.map((p) => p.start), to);
    items.forEach((_, i) => {
      const it = slots[i];
      if (!it?.text) return;
      const s = plan[i];
      const big = fitText(it.text, { font: L.font, widths: L.fontWidths, size: px(96), minSize: it.size, maxWidth: stage.width - px(60), maxLines: 1 }).size;
      const [cellX, cellY, sx, sy] = [Math.round(it.cx), Math.round(it.cy), Math.round(stage.x), Math.round(stage.y)];
      const popMs = Math.round(Math.min(180, (s.glideStart - s.start) * 1000 * 0.5));
      lines.push(`Dialogue: 7,${ts(s.start)},${ts(s.glideStart)},OvTierItem,,0,0,0,,{\\an5\\pos(${sx},${sy})\\fs${big}\\fscx40\\fscy40\\t(0,${popMs},\\fscx100\\fscy100)\\fad(${Math.min(100, popMs)},0)}${it.text}`);
      lines.push(`Dialogue: 7,${ts(s.glideStart)},${ts(s.glideEnd)},OvTierItem,,0,0,0,,{\\an5\\move(${sx},${sy},${cellX},${cellY},0,${ms(s.glideStart, s.glideEnd)})\\fs${big}\\t(0,${ms(s.glideStart, s.glideEnd)},\\fs${it.size})}${it.text}`);
      lines.push(`Dialogue: 6,${ts(s.glideEnd)},${ts(s.end)},OvTierItem,,0,0,0,,{\\an5\\pos(${cellX},${cellY})\\fs${it.size}}${it.text}`);
    });
  };

  // Comment cards, laid out so cards on screen together never overlap.
  for (const p of layoutComments(placed, L)) {
    if (!p.shown) continue;
    const { x, y, w, h, user } = p;
    // A card tilted 2.5°: every piece rotates around the card's centre, unwinds
    // from 4.5° (so it can't swing into a settled neighbour) as it slides up and fades in, and fades up on the way out.
    const org = `\\org(${Math.round(x + w / 2)},${Math.round(y + h / 2)})`;
    const exit = Math.min(0.2, (p.end - p.start) * 0.25);
    const piece = (layer: number, style: string, px0: number, py0: number, tags: string, text: string, an = 7) => {
      const [x0, y0] = [Math.round(px0), Math.round(py0)];
      lines.push(`Dialogue: ${layer},${ts(p.start)},${ts(p.end - exit)},${style},,0,0,0,,{\\an${an}${org}\\move(${x0},${y0 + px(28)},${x0},${y0},0,180)\\frz4.5\\t(0,220,\\frz2.5)\\fad(140,0)${tags}}${text}`);
      lines.push(`Dialogue: ${layer},${ts(p.end - exit)},${ts(p.end)},${style},,0,0,0,,{\\an${an}${org}\\move(${x0},${y0},${x0},${y0 - px(24)},0,${Math.round(exit * 1000)})\\frz2.5\\fad(0,${Math.round(exit * 1000)})${tags}}${text}`);
    };
    piece(10, "OvShape", x, y, "\\1c&H00FFFFFF&\\p1", `${roundedRect(w, h, px(34))}{\\p0}`);
    const av = px(68);
    // Who's being replied to only when the plan said so; a nameless card has no avatar or header.
    if (user) {
      piece(11, "OvShape", x + px(28), y + px(26), `\\1c${assColor(L.accent)}\\shad0\\p1`, `${roundedRect(av, av, av / 2)}{\\p0}`);
      piece(12, "OvUser", x + px(28) + av / 2, y + px(26) + av / 2, `\\1c&H00FFFFFF&\\fs${px(34)}\\b1`, esc(user[0].toUpperCase()), 5);
      piece(12, "OvUser", x + px(116), y + px(30), "", `Reply to @${esc(user)}`);
    }
    piece(12, "OvBody", x + (user ? px(116) : px(40)), y + (user ? px(74) : px(36)), p.bodySize !== px(46) ? `\\fs${p.bodySize}` : "", p.body.join("\\N"));
  }

  // Pop-up words in the middle of the footage, alternating tilt.
  placed
    .filter((x) => x.o.kind === "text" && x.o.text?.trim())
    .forEach((p, i) => {
      const { fit, cy: y } = popLayout(p, L);
      lines.push(
        `Dialogue: 8,${ts(p.start)},${ts(p.end)},OvPop,,0,0,0,,{\\an5\\pos(${Math.round(cx)},${Math.round(y)})${fit.size !== px(124) ? `\\fs${fit.size}` : ""}\\frz${i % 2 ? -4 : 4}\\fscx40\\fscy40\\t(0,110,\\fscx112\\fscy112)\\t(110,190,\\fscx100\\fscy100)\\fad(0,160)}${fit.lines.join("\\N")}`,
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
    const grid = tierLayout(
      tiers.map((p) => ({ text: esc(p.o.text!.trim()), tier: (TIERS as readonly string[]).includes(p.o.tier ?? "") ? (p.o.tier as Tier) : "C" })),
      L,
    );
    // Each item pops in large at the board's centre on its cue, holds while it's
    // talked about, then glides and shrinks into its cell before the next one.
    reveal(
      tiers,
      grid.items.map((it) => ({ text: it.text, size: it.size, cx: it.x + textWidth(it.text, it.size, L.font, L.fontWidths) / 2, cy: it.cy })),
      to,
      { x: left + width / 2, y: top + (rowH * TIERS.length) / 2, width },
    );
  }

  // A Top-N list: numbered slots down the footage; items land in their place and stay.
  const ranks = placed.filter((x) => x.o.kind === "rank" && x.o.text?.trim() && x.o.rank);
  if (ranks.length) {
    const from = ranks[0].start;
    const to = Math.max(...ranks.map((t) => t.end));
    const g = rankLayout(ranks.map((p) => ({ text: esc(p.o.text!.trim()), rank: p.o.rank! })), L);
    shape(from, to, g.left - px(8), g.top - px(8), "#141414", roundedRect(g.width + px(16), g.slotH * g.n + px(16), px(18)), 3, "\\1a&H30&\\fad(200,0)");
    for (let k = 0; k < g.n; k++) {
      const y = g.top + k * g.slotH;
      shape(from, to, g.left, y + px(4), k === 0 ? L.accent : "#2A2A2A", roundedRect(g.labelW, g.slotH - px(8), px(10)), 4, "\\shad0\\fad(200,0)");
      lines.push(`Dialogue: 5,${ts(from)},${ts(to)},OvRankLabel,,0,0,0,,{\\an5\\pos(${Math.round(g.left + g.labelW / 2)},${Math.round(y + g.slotH / 2)})\\fs${Math.min(px(64), Math.round(g.slotH * 0.55))}\\fad(200,0)}#${k + 1}`);
    }
    reveal(ranks, g.slots, to, { x: g.left + g.width / 2, y: g.top + (g.slotH * g.n) / 2, width: g.width });
  }

  // A podium: 2nd, 1st, 3rd; each name lands above its block and stays.
  const podium = placed.filter((x) => x.o.kind === "podium" && x.o.text?.trim() && x.o.rank);
  if (podium.length) {
    const from = podium[0].start;
    const to = Math.max(...podium.map((t) => t.end));
    const g = podiumLayout(podium.map((p) => ({ text: esc(p.o.text!.trim()), rank: p.o.rank! })), L);
    for (const b of g.blocks) {
      // Blocks rise from the floor as the podium appears.
      shape(from, to, b.x, b.y, PODIUM_COLORS[b.place], roundedRect(b.w, b.h, px(14)), 4, `\\clip(${b.x},${b.y + b.h},${b.x + b.w},${b.y + b.h})\\t(0,260,\\clip(${b.x},${b.y},${b.x + b.w},${b.y + b.h}))`);
      lines.push(`Dialogue: 5,${ts(from)},${ts(to)},OvRankLabel,,0,0,0,,{\\an5\\pos(${Math.round(b.x + b.w / 2)},${Math.round(b.y + Math.min(b.h / 2, px(70)))})\\1c&H00201C1A&\\fs${px(72)}\\fad(260,0)}${b.place}`);
    }
    const top = Math.min(...g.blocks.map((b) => b.y));
    reveal(podium, g.slots, to, { x: L.width / 2, y: L.bandTop + (top - L.bandTop) / 2, width: L.width - px(120) });
  }

  // Quiz strips: answer chips pop in one after another; the right one lights up for the last 40%.
  for (const p of placed.filter((x) => x.o.kind === "quiz" && (x.o.answers?.length ?? 0) >= 2)) {
    const q = quizLayout(p.o, L, quizAbove(p, placed));
    const reveal = p.o.correct !== undefined ? p.start + (p.end - p.start) * 0.6 : undefined;
    if (q.question)
      lines.push(`Dialogue: 8,${ts(p.start)},${ts(p.end)},OvQuizQ,,0,0,0,,{\\an2\\pos(${Math.round(L.width / 2)},${Math.round(q.question.box.y + q.question.box.h)})${q.question.size !== px(52) ? `\\fs${q.question.size}` : ""}\\fad(120,160)}${q.question.lines.join("\\N")}`);
    q.chips.forEach((c, i) => {
      const t0 = p.start + i * 0.08;
      const pop = `\\fad(100,160)\\fscx70\\fscy70\\t(0,140,\\fscx100\\fscy100)\\org(${Math.round(c.x + c.w / 2)},${Math.round(c.y + c.h / 2)})`;
      const right = reveal !== undefined && i === p.o.correct;
      shape(t0, reveal ?? p.end, c.x, c.y, "#FFFFFF", roundedRect(c.w, c.h, px(22)), 8, pop);
      if (reveal !== undefined) shape(reveal, p.end, c.x, c.y, right ? L.accent : "#FFFFFF", roundedRect(c.w, c.h, px(22)), 8, right ? "\\fad(0,160)\\fscx106\\fscy106\\t(0,120,\\fscx100\\fscy100)" : "\\1a&H80&\\fad(0,160)");
      shape(t0, p.end, c.x + px(14), c.y + (c.h - q.badge) / 2, "#201C1A", roundedRect(q.badge, q.badge, q.badge / 2), 9, `\\shad0${pop}`);
      lines.push(`Dialogue: 10,${ts(t0)},${ts(p.end)},OvQuizLetter,,0,0,0,,{\\an5\\pos(${Math.round(c.x + px(14) + q.badge / 2)},${Math.round(c.y + c.h / 2)})\\fad(100,160)}${c.letter}`);
      const tx = c.x + px(14) + q.badge + px(12);
      lines.push(`Dialogue: 10,${ts(t0)},${ts(p.end)},OvQuizText,,0,0,0,,{\\an4\\pos(${Math.round(tx)},${Math.round(c.y + c.h / 2)})${c.size !== px(40) ? `\\fs${c.size}` : ""}\\fad(100,160)}${c.lines.join("\\N")}`);
    });
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
  const { size, spots } = stickerSpots(L);
  const stickers: Sticker[] = [];
  const missing: string[] = [];
  // The spot follows the emoji's order (as blockedBoxes assumes), even if an earlier one had no image.
  for (const [i, p] of placed.filter((x) => x.o.kind === "emoji" && x.o.emoji).entries()) {
    const png = await emojiPng(p.o.emoji!, dir);
    if (!png) {
      missing.push(p.o.emoji!);
      continue;
    }
    const [x, y] = spots[i % spots.length];
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
