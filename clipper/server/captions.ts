import { groupWords, resolveCaptionStyle, type CaptionStyle } from "../shared/caption-styles";
import { sentences } from "../shared/sentences";
import { scriptWords } from "./align";
import { H, VIDEO_TOP, W } from "./media";
import { overlayEvents, overlayStyles, type OverlayLayout, type Placed } from "./overlays";

// Captions as an ASS subtitle file burned in by ffmpeg: the hook across the
// top, the voiceover in 2–3 word punches under the footage, and a call to
// action card at the end.

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
  if (!sents.length || !timed.length) return undefined;
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

/**
 * The full caption track: hook across the top, captions in the chosen style,
 * and the call-to-action card at the end. `joiner` is "" for languages written
 * without spaces.
 */
export function buildAss(o: {
  hook: string;
  captions: CaptionGroup[];
  cta: string;
  ctaFrom: number;
  duration: number;
  style?: CaptionStyle;
  accent?: string;
  joiner?: string;
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
  const joiner = o.joiner ?? " ";
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
  const y = Math.round(st.position * FH);
  const place = `\\an5\\pos(${Math.round(FW / 2)},${y})${st.glow ? "\\blur4" : ""}`;
  const pop = "\\fscx86\\fscy86\\t(0,90,\\fscx100\\fscy100)";
  const cased = (t: string) => (st.uppercase ? t.toLocaleUpperCase(o.language || undefined) : t);
  for (const g of o.captions) {
    if (g.start >= o.duration) break;
    const end = Math.min(g.end, o.duration);
    const words = g.words?.length ? g.words : [g];
    if (st.animation === "karaoke" && words.length > 1) {
      // One event per word: the whole line, with the spoken word in the highlight colour.
      words.forEach((w, k) => {
        const from = k === 0 ? g.start : w.start;
        const to = k < words.length - 1 ? words[k + 1].start : end;
        if (to <= from || from >= o.duration) return;
        const text = words.map((x, q) => (q === k ? `{\\c${hl}}${esc(cased(x.text))}{\\c${white}}` : esc(cased(x.text)))).join(joiner);
        lines.push(`Dialogue: 0,${ts(from)},${ts(Math.min(to, o.duration))},Cap,,0,0,0,,{${place}${k === 0 ? pop : ""}}${text}`);
      });
      continue;
    }
    const anim = st.animation === "pop" || st.animation === "karaoke" ? pop : st.animation === "fade" ? "\\fad(70,70)" : "";
    const text = words.map((x) => esc(cased(x.text))).join(joiner);
    lines.push(`Dialogue: 0,${ts(g.start)},${ts(end)},Cap,,0,0,0,,{${place}${anim}}${text}`);
  }
  if (o.overlays?.placed.length) lines.push(...overlayEvents(o.overlays.placed, o.overlays.layout));
  if (o.cta) lines.push(`Dialogue: 9,${ts(o.ctaFrom)},${ts(o.duration)},Cta,,0,0,0,,{\\fad(150,0)}${esc(o.cta)}`);
  return lines.join("\n") + "\n";
}
