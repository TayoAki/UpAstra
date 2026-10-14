import { H, VIDEO_H, VIDEO_TOP, W } from "./media";

// Captions as an ASS subtitle file burned in by ffmpeg: the hook across the
// top, the voiceover in 2–3 word punches under the footage, and a call to
// action card at the end.

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

/** Split a script into sentences, keeping punctuation. */
export const sentences = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

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

/** Group words into short caption punches (break after punctuation). */
export function chunk(words: Timed[], max = 3): Timed[] {
  const out: Timed[] = [];
  let cur: Timed[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ text: cur.map((w) => w.text).join(" "), start: cur[0].start, end: cur[cur.length - 1].end });
    cur = [];
  };
  for (const w of words) {
    cur.push(w);
    if (cur.length >= max || /[.!?,;:—]$/.test(w.text)) flush();
  }
  flush();
  // Close tiny gaps so captions don't flicker.
  for (let i = 0; i < out.length - 1; i++) if (out[i + 1].start - out[i].end < 0.25) out[i].end = out[i + 1].start;
  return out;
}

export function buildAss(o: { hook: string; captions: Timed[]; cta: string; ctaFrom: number; duration: number; accent?: string; font?: string }): string {
  const font = o.font ?? "DejaVu Sans";
  // ASS colours are &HAABBGGRR.
  const hex = (o.accent ?? "#E5484D").replace("#", "");
  const accent = `&H00${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}`;
  const hookEnd = Math.min(3.2, o.duration);
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Hook,${font},76,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,7,2,8,70,70,${VIDEO_TOP - 330},1`,
    `Style: Cap,${font},92,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,8,3,8,60,60,${VIDEO_TOP + VIDEO_H + 70},1`,
    `Style: Cta,${font},72,&H00FFFFFF,&H00FFFFFF,${accent},${accent},-1,0,0,0,100,100,0,0,3,26,0,5,90,90,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    `Dialogue: 1,${ts(0)},${ts(hookEnd)},Hook,,0,0,0,,{\\fad(120,200)}${esc(o.hook)}`,
  ];
  for (const c of o.captions) {
    if (c.start >= o.duration) break;
    // A quick pop-in on every punch.
    lines.push(`Dialogue: 0,${ts(c.start)},${ts(Math.min(c.end, o.duration))},Cap,,0,0,0,,{\\fscx86\\fscy86\\t(0,90,\\fscx100\\fscy100)}${esc(c.text.toUpperCase())}`);
  }
  if (o.cta) lines.push(`Dialogue: 2,${ts(o.ctaFrom)},${ts(o.duration)},Cta,,0,0,0,,{\\fad(150,0)}${esc(o.cta)}`);
  return lines.join("\n") + "\n";
}
