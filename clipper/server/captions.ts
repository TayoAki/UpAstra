import { groupWords, resolveCaptionStyle, type CaptionStyle } from "../shared/caption-styles";
import { sentences } from "../shared/sentences";
import { joinWords, sepBetween } from "../shared/words";
import { scriptWords } from "./align";
import { H, VIDEO_TOP, W } from "./media";
import { overlayEvents, overlayStyles, textWidth, type OverlayLayout, type Placed } from "./overlays";

// Captions as an ASS subtitle file burned in by ffmpeg: the hook across the
// top, the voiceover in 2–3 word punches under the footage, and a call to
// action card at the end.

/** A gap between words longer than this (seconds) is a pause: the karaoke highlight rests. */
const PAUSE = 0.35;

/** How long the hook stays on screen. */
export const HOOK_SECONDS = 3.2;

export interface Timed {
  text: string;
  start: number;
  end: number;
}

const ts = (s: number) => {
  const cs = Math.max(0, Math.round(s * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};
const esc = (s: string) => s.replace(/\\/g, "").replace(/[{}]/g, "").replace(/\n/g, " ");

export { sentences };

/**
 * When the last sentence starts, from word timings that follow the script's
 * own segmentation (one per `scriptWords` token, as `alignScript` returns).
 */
export function lastSentenceStart(script: string, timed: { start: number }[], language?: string): number | undefined {
  const sents = sentences(script);
  if (sents.length < 2 || !timed.length) return undefined;
  // Count the words before the last sentence, segmented in context (a
  // sentence segmented on its own can split differently at its edges).
  const text = script.replace(/\s+/g, " ").trim();
  const before = scriptWords(text.slice(0, text.lastIndexOf(sents[sents.length - 1])), language).length;
  return before < timed.length ? timed[before].start : undefined;
}

/**
 * Word-level timing. With speech spans from the voiceover (one per pause),
 * sentences are matched to spans when the counts line up; otherwise the whole
 * script is spread over the time by character length. Words inside a sentence
 * share its time by length, so long words stay on screen longer.
 */
export function timeWords(script: string, total: number, spans?: { start: number; end: number }[]): Timed[] {
  const sents = sentences(script);
  let windows: { start: number; end: number }[];
  if (spans && spans.length === sents.length) windows = spans;
  else {
    const lens = sents.map((s) => s.length + 8);
    const sum = lens.reduce((a, b) => a + b, 0) || 1;
    const from = spans?.[0]?.start ?? 0;
    const to = spans?.length ? spans[spans.length - 1].end : total;
    let t = from;
    windows = lens.map((l) => {
      const w = { start: t, end: t + ((to - from) * l) / sum };
      t = w.end;
      return w;
    });
  }
  const out: Timed[] = [];
  sents.forEach((s, i) => {
    const words = s.split(" ");
    const weights = words.map((w) => w.length + 2);
    const sum = weights.reduce((a, b) => a + b, 0);
    let t = windows[i].start;
    words.forEach((w, k) => {
      const d = ((windows[i].end - windows[i].start) * weights[k]) / sum;
      out.push({ text: w, start: t, end: t + d });
      t += d;
    });
  });
  return out;
}

/** Group words into short caption punches (break after punctuation), keeping each group's words. */
export const groups = (words: Timed[], max = 3): (Timed & { words: Timed[] })[] => groupWords(words, max);

/** Caption punches as plain timed text. */
export const chunk = (words: Timed[], max = 3): Timed[] => groups(words, max).map(({ text, start, end }) => ({ text, start, end }));

/** #RRGGBB or #RRGGBBAA → ASS &HAABBGGRR (ASS alpha is inverted: 00 is opaque). */
export function assColor(hex: string): string {
  const h = hex.replace("#", "");
  const a = h.length === 8 ? 255 - parseInt(h.slice(6, 8), 16) : 0;
  const pad = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
  return `&H${pad(a)}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

export type CaptionGroup = Timed & { words?: Timed[] };

/** A caption as drawn: 1–2 lines of words, and a smaller size only for a single word too wide alone. */
interface FittedCaption {
  start: number;
  end: number;
  lines: Timed[][];
  size?: number;
}

/**
 * Fit caption groups to the frame width. A group too wide for one line is
 * broken into two balanced lines; one too wide for two is split in time at
 * its best word boundary (each half keeps its words' own times), and so on.
 * Only a single word too wide on its own is drawn smaller.
 */
export function fitCaptions(groups: CaptionGroup[], o: { size: number; outline: number; font: string; maxWidth: number; cased: (t: string) => string }): FittedCaption[] {
  const width = (ws: Timed[]) => textWidth(o.cased(joinWords(ws.map((w) => w.text))), o.size, o.font) + 2 * o.outline;
  const fits = (ws: Timed[]) => width(ws) <= o.maxWidth;
  // Where to break a run of words so its widest part is as narrow as possible.
  const bestBreak = (ws: Timed[]) => {
    let best = 1;
    let bestW = Infinity;
    for (let b = 1; b < ws.length; b++) {
      const w = Math.max(width(ws.slice(0, b)), width(ws.slice(b)));
      if (w < bestW) [best, bestW] = [b, w];
    }
    return best;
  };
  const fit = (ws: Timed[], start: number, end: number): FittedCaption[] => {
    if (fits(ws)) return [{ start, end, lines: [ws] }];
    if (ws.length === 1) {
      // The outline doesn't shrink with the text, so size the text to the room left inside it.
      const text = width(ws) - 2 * o.outline;
      return [{ start, end, lines: [ws], size: Math.max(Math.round(o.size * 0.5), Math.floor((o.size * (o.maxWidth - 2 * o.outline)) / text)) }];
    }
    const b = bestBreak(ws);
    if (fits(ws.slice(0, b)) && fits(ws.slice(b))) return [{ start, end, lines: [ws.slice(0, b), ws.slice(b)] }];
    // Too long for two lines: show it as two captions, one after the other.
    return [...fit(ws.slice(0, b), start, ws[b].start), ...fit(ws.slice(b), ws[b].start, end)];
  };
  return groups.flatMap((g) => fit(g.words?.length ? g.words : [g], g.start, g.end));
}

/**
 * The full caption track: hook across the top, captions in the chosen style,
 * and the call-to-action card at the end. Words are spaced by script
 * (none inside Chinese, Japanese or Thai).
 */
export function buildAss(o: {
  hook: string;
  captions: CaptionGroup[];
  cta: string;
  ctaFrom: number;
  duration: number;
  style?: CaptionStyle;
  accent?: string;
  language?: string;
  /** Frame size; defaults to UGCMediaClips's 1080×1920. Style sizes scale with the short side. */
  frame?: { width: number; height: number };
  /** Comments, pop-up text and tier boards timed to the voiceover. */
  overlays?: { placed: Placed[]; layout: OverlayLayout };
}): string {
  const FW = o.frame?.width ?? W;
  const FH = o.frame?.height ?? H;
  const k = Math.min(FW, FH) / 1080;
  const px = (n: number) => Math.max(1, Math.round(n * k));
  const st = o.style ?? resolveCaptionStyle(undefined);
  const font = st.font;
  const bold = /^DejaVu/i.test(font) ? -1 : 0;
  const accent = assColor(o.accent ?? "#E5484D");
  const white = assColor(st.color);
  const hl = assColor(st.highlight);
  const hookEnd = Math.min(HOOK_SECONDS, o.duration);
  const boxed = !!st.box;
  const back = st.box ? assColor(st.box) : "&H64000000";
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${FW}`,
    `PlayResY: ${FH}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Hook,${font},${px(76)},${white},${white},&H00000000,&H64000000,${bold},0,0,0,100,100,0,0,1,${px(7)},${px(2)},8,${px(70)},${px(70)},${Math.round(((VIDEO_TOP - 330) / H) * FH)},1`,
    `Style: Cap,${font},${px(st.size)},${white},${white},${boxed ? back : assColor(st.outline)},${back},${bold},0,0,0,100,100,0,0,${boxed ? 3 : 1},${px(st.outlineWidth)},${px(st.shadow)},5,${px(70)},${px(70)},0,1`,
    `Style: Cta,${font},${px(72)},&H00FFFFFF,&H00FFFFFF,${accent},${accent},${bold},0,0,0,100,100,0,0,3,${px(26)},0,5,${px(90)},${px(90)},0,1`,
    ...(o.overlays?.placed.length ? overlayStyles(o.overlays.layout) : []),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  if (o.hook) lines.push(`Dialogue: 1,${ts(0)},${ts(hookEnd)},Hook,,0,0,0,,{\\fad(120,200)}${esc(o.hook)}`);
  // Bottom-anchored: a single line sits centred on `position` as before, and
  // a second line grows upward, away from the platform's buttons and text.
  const y = Math.round(st.position * FH + px(st.size) / 2);
  const place = `\\an2\\pos(${Math.round(FW / 2)},${y})${st.glow ? "\\blur4" : ""}`;
  const pop = "\\fscx86\\fscy86\\t(0,90,\\fscx100\\fscy100)";
  const cased = (t: string) => (st.uppercase ? t.toLocaleUpperCase(o.language || undefined) : t);
  const fitted = fitCaptions(o.captions, { size: px(st.size), outline: px(st.outlineWidth), font, maxWidth: FW - 2 * px(70), cased });
  for (const g of fitted) {
    if (g.start >= o.duration) break;
    const end = Math.min(g.end, o.duration);
    const words = g.lines.flat();
    const size = g.size ? `\\fs${g.size}` : "";
    // Words (one optionally highlighted), spaced by script, lines broken with \N.
    const render = (active?: number) => {
      let i = 0;
      return g.lines
        .map((line) => line.map((x, q) => (q ? sepBetween(line[q - 1].text, x.text) : "") + (i++ === active ? `{\\c${hl}}${esc(cased(x.text))}{\\c${white}}` : esc(cased(x.text)))).join(""))
        .join("\\N");
    };
    if (st.animation === "karaoke" && words.length > 1) {
      // One event per word: the whole caption, with the spoken word in the
      // highlight colour. In a pause longer than PAUSE the highlight rests
      // (the line stays, nothing lit) until the next word is said.
      words.forEach((w, k) => {
        const from = k === 0 ? g.start : w.start;
        const to = Math.min(k < words.length - 1 ? words[k + 1].start : end, o.duration);
        if (to <= from || from >= o.duration) return;
        const lit = to - w.end > PAUSE ? Math.max(from + 0.05, w.end + 0.05) : to;
        lines.push(`Dialogue: 0,${ts(from)},${ts(lit)},Cap,,0,0,0,,{${place}${size}${k === 0 ? pop : ""}}${render(k)}`);
        if (lit < to) lines.push(`Dialogue: 0,${ts(lit)},${ts(to)},Cap,,0,0,0,,{${place}${size}}${render()}`);
      });
      continue;
    }
    const anim = st.animation === "pop" || st.animation === "karaoke" ? pop : st.animation === "fade" ? "\\fad(70,70)" : "";
    lines.push(`Dialogue: 0,${ts(g.start)},${ts(end)},Cap,,0,0,0,,{${place}${size}${anim}}${render()}`);
  }
  if (o.overlays?.placed.length) lines.push(...overlayEvents(o.overlays.placed, o.overlays.layout));
  if (o.cta) lines.push(`Dialogue: 9,${ts(o.ctaFrom)},${ts(o.duration)},Cta,,0,0,0,,{\\fad(150,0)}${esc(o.cta)}`);
  return lines.join("\n") + "\n";
}
