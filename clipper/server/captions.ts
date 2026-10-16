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
/** The shortest time a caption stays on screen when a long one is split. */
const MIN_CAPTION = 0.3;
/** Styles drawn as one event per spoken word. */
const PER_WORD = new Set(["karaoke", "box", "underline", "accumulate"]);

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
export function fitCaptions(groups: CaptionGroup[], o: { size: number; outline: number; font: string; widths?: Record<string, number>; maxWidth: number; cased: (t: string) => string }): FittedCaption[] {
  const textW = (ws: Timed[], size = o.size) => textWidth(o.cased(joinWords(ws.map((w) => w.text))), size, o.font, o.widths);
  const width = (ws: Timed[]) => textW(ws) + 2 * o.outline;
  const fits = (ws: Timed[]) => width(ws) <= o.maxWidth;
  const room = o.maxWidth - 2 * o.outline;
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
      // One word too wide: draw it smaller (to half size); a word still too
      // wide (a long URL in a huge style) is broken across two lines.
      const size = Math.floor((o.size * room) / textW(ws));
      if (size >= o.size * 0.5) return [{ start, end, lines: [ws], size }];
      const chars = [...ws[0].text];
      let cut = 1;
      while (cut < chars.length - 1 && textW([{ ...ws[0], text: chars.slice(0, cut + 1).join("") }]) <= textW([{ ...ws[0], text: chars.slice(cut + 1).join("") }])) cut++;
      const halves = [chars.slice(0, cut).join(""), chars.slice(cut).join("")].map((text) => ({ ...ws[0], text }));
      const wider = Math.max(...halves.map((h) => textW([h])));
      return [{ start, end, lines: halves.map((h) => [h]), size: Math.min(o.size, Math.floor((o.size * room) / wider)) }];
    }
    const b = bestBreak(ws);
    if (fits(ws.slice(0, b)) && fits(ws.slice(b))) return [{ start, end, lines: [ws.slice(0, b), ws.slice(b)] }];
    // Too long for two lines: show it as two captions, one after the other,
    // switching when the second half's first word is said, or (when the
    // words' times collapse) sharing the time by length; each gets ≥ 0.3 s.
    const share = start + ((end - start) * textW(ws.slice(0, b))) / textW(ws);
    const said = ws[b].start;
    const t = said - start >= MIN_CAPTION && end - said >= MIN_CAPTION ? said : end - start >= 2 * MIN_CAPTION ? Math.min(end - MIN_CAPTION, Math.max(start + MIN_CAPTION, share)) : share;
    return [...fit(ws.slice(0, b), start, t), ...fit(ws.slice(b), t, end)];
  };
  return groups.flatMap((g) => fit(g.words?.length ? g.words : spreadWords(g), g.start, g.end));
}

/** Words for a caption given only as text: split by spaces, sharing its time by length. */
function spreadWords(g: Timed): Timed[] {
  const parts = g.text.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return [g];
  const total = parts.reduce((n, p) => n + p.length, 0);
  let t = g.start;
  return parts.map((text) => {
    const d = ((g.end - g.start) * text.length) / total;
    const w = { text, start: t, end: t + d };
    t += d;
    return w;
  });
}

/**
 * The captions as they'll be burned in for a style on a frame (lines joined
 * with "\n"), for the editor's timeline.
 */
export function fitCaptionsFor(groups: CaptionGroup[], st: CaptionStyle, frame = { width: W, height: H }, language?: string) {
  const k = Math.min(frame.width, frame.height) / 1080;
  const px = (n: number) => Math.max(1, Math.round(n * k));
  const cased = (t: string) => (st.uppercase ? t.toLocaleUpperCase(language || undefined) : t);
  return fitCaptions(groups, { size: px(st.size), outline: px(st.outlineWidth), font: st.font, widths: st.fontWidths, maxWidth: frame.width - 2 * px(70), cased }).map((f) => ({
    text: f.lines.map((l) => joinWords(l.map((w) => w.text))).join("\n"),
    start: f.start,
    end: f.end,
    words: f.lines.flat(),
  }));
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
    // A fill sweep (\kf) goes from the secondary colour to the primary: the highlight.
    `Style: Cap,${font},${px(st.size)},${st.animation === "sweep" ? hl : white},${white},${boxed ? back : assColor(st.outline)},${back},${bold},0,0,0,100,100,0,0,${boxed ? 3 : 1},${px(st.outlineWidth)},${px(st.shadow)},5,${px(70)},${px(70)},0,1`,
    `Style: Cta,${font},${px(72)},&H00FFFFFF,&H00FFFFFF,${accent},${accent},${bold},0,0,0,100,100,0,0,3,${px(26)},0,5,${px(90)},${px(90)},0,1`,
    ...(o.overlays?.placed.length ? overlayStyles(o.overlays.layout, new Set(o.overlays.placed.map((p) => p.o.kind))) : []),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  if (o.hook) lines.push(`Dialogue: 1,${ts(0)},${ts(hookEnd)},Hook,,0,0,0,,{\\fad(120,200)}${esc(o.hook)}`);
  // Bottom-anchored: a single line sits centred on `position` as before, and
  // a second line grows upward, away from the platform's buttons and text.
  const y = Math.round(st.position * FH + px(st.size) / 2);
  const place = `\\an2\\pos(${Math.round(FW / 2)},${y})${st.glow ? "\\blur4" : ""}`;
  // A spring: in small, overshoot a little, settle.
  const pop = "\\fscx72\\fscy72\\t(0,90,\\fscx105\\fscy105)\\t(90,170,\\fscx100\\fscy100)";
  const cased = (t: string) => (st.uppercase ? t.toLocaleUpperCase(o.language || undefined) : t);
  const fitted = fitCaptions(o.captions, { size: px(st.size), outline: px(st.outlineWidth), font, widths: st.fontWidths, maxWidth: FW - 2 * px(70), cased });
  for (const g of fitted) {
    if (g.start >= o.duration) break;
    const end = Math.min(g.end, o.duration);
    const words = g.lines.flat();
    const size = g.size ? `\\fs${g.size}` : "";
    // Words spaced by script, lines broken with \N; the spoken word (index
    // `active`) drawn in the style's per-word treatment.
    const render = (active?: number) => {
      let i = 0;
      return g.lines
        .map((line) =>
          line
            .map((x, q) => {
              const k = i++;
              const sep = q ? sepBetween(line[q - 1].text, x.text) : "";
              const t = esc(cased(x.text));
              if (st.animation === "sweep") return `${sep}{\\kf${sweepCs(k)}}${t}${sweepGap(k) ? `{\\k${sweepGap(k)}}` : ""}`;
              if (st.animation === "accumulate") return active !== undefined && k === active + 1 ? `{\\alpha&HFF&}${sep}${t}` : `${sep}${t}`;
              // A word broken across two lines is two pieces said together: light both.
              const lit = active !== undefined && (k === active || (x.start === words[active].start && x.end === words[active].end));
              if (!lit) return `${sep}${t}`;
              // Close with the style's own values (not \r, which would also cancel the pop on later words).
              if (st.animation === "box") return `${sep}{\\3c${hl}\\bord${Math.max(4, Math.round(px(st.size) * 0.16))}\\shad0}${t}{\\3c${boxed ? back : assColor(st.outline)}\\bord${px(st.outlineWidth)}\\shad${px(st.shadow)}}`;
              if (st.animation === "underline") return `${sep}{\\c${hl}\\u1}${t}{\\c${white}\\u0}`;
              return `${sep}{\\c${hl}}${t}{\\c${white}}`;
            })
            .join(""),
        )
        .join("\\N");
    };
    // How long each word takes to fill (centiseconds): until the next word,
    // or, before a pause, until it's said and then a wait (an empty \k).
    const pauseAfter = (k: number) => (k < words.length - 1 && words[k + 1].start - words[k].end > PAUSE ? words[k + 1].start - words[k].end : 0);
    const sweepCs = (k: number) => Math.max(1, Math.round(((k < words.length - 1 && !pauseAfter(k) ? words[k + 1].start : Math.min(words[k].end, end)) - Math.max(words[k].start, g.start)) * 100));
    const sweepGap = (k: number) => Math.round(pauseAfter(k) * 100);
    if (st.animation === "sweep") {
      const lead = Math.max(0, Math.round((words[0].start - g.start) * 100));
      lines.push(`Dialogue: 0,${ts(g.start)},${ts(end)},Cap,,0,0,0,,{${place}${size}${pop}}${lead ? `{\\k${lead}}` : ""}${render()}`);
      continue;
    }
    if (PER_WORD.has(st.animation)) {
      // One event per word: the whole caption, with the spoken word in the
      // highlight colour. In a pause longer than PAUSE the highlight rests
      // (the line stays, nothing lit) until the next word is said.
      // Word times are clamped to this caption's own window (a split caption
      // can start after its words were said); words with no time of their
      // own just aren't lit, and the line itself always covers the window.
      let first = true;
      let shownUntil = g.start;
      words.forEach((w, k) => {
        const from = Math.max(g.start, k === 0 ? g.start : w.start, shownUntil);
        const to = Math.min(Math.max(from, k < words.length - 1 ? words[k + 1].start : end), end, o.duration);
        if (to - from < 0.01 || from >= o.duration) return;
        // A lit word stays lit at least 0.2 s, even when its own time was shorter.
        const rest = Math.max(from + 0.2, w.end + 0.05);
        const lit = to - w.end > PAUSE && rest < to ? rest : to;
        lines.push(`Dialogue: 0,${ts(from)},${ts(lit)},Cap,,0,0,0,,{${place}${size}${first ? pop : ""}}${render(k)}`);
        // Resting: nothing lit, but "build up" keeps hiding the words not said yet.
        if (lit < to) lines.push(`Dialogue: 0,${ts(lit)},${ts(to)},Cap,,0,0,0,,{${place}${size}}${render(st.animation === "accumulate" ? k : undefined)}`);
        first = false;
        shownUntil = to;
      });
      if (shownUntil < Math.min(end, o.duration)) lines.push(`Dialogue: 0,${ts(shownUntil)},${ts(Math.min(end, o.duration))},Cap,,0,0,0,,{${place}${size}${first ? pop : ""}}${render(st.animation === "accumulate" ? words.length - 1 : undefined)}`);
      continue;
    }
    const anim = st.animation === "fade" ? "\\fad(70,70)" : st.animation === "none" ? "" : pop;
    lines.push(`Dialogue: 0,${ts(g.start)},${ts(end)},Cap,,0,0,0,,{${place}${size}${anim}}${render()}`);
  }
  if (o.overlays?.placed.length) lines.push(...overlayEvents(o.overlays.placed, o.overlays.layout));
  if (o.cta) lines.push(`Dialogue: 9,${ts(o.ctaFrom)},${ts(o.duration)},Cta,,0,0,0,,{\\fad(150,0)}${esc(o.cta)}`);
  return lines.join("\n") + "\n";
}
