import { joinWords } from "./words";
// Caption styles: presets, the workspace brand kit layered on top, and a
// campaign's own choice on top of that. The same resolved style drives the
// server's burned-in captions (ASS / libass) and the editor's caption track.

export type CaptionAnimation = "pop" | "karaoke" | "fade" | "none";

export interface CaptionStyle {
  id: string;
  name: string;
  description: string;
  /** Font face name as libass and the browser know it (bundled fonts, brand uploads, or system fonts). */
  font: string;
  /** Size in px on a 1080×1920 frame. */
  size: number;
  /** Text colour, #RRGGBB. */
  color: string;
  /** The word being spoken, in karaoke-style animations. */
  highlight: string;
  outline: string;
  outlineWidth: number;
  shadow: number;
  /** A box behind the text instead of an outline, #RRGGBB or #RRGGBBAA. */
  box?: string;
  uppercase: boolean;
  wordsPerCaption: number;
  /** Vertical centre of the caption line, 0 (top) – 1 (bottom). */
  position: number;
  animation: CaptionAnimation;
  /** Soft glow around the text (blur on the outline). */
  glow?: boolean;
}

/** Fonts bundled with UGCMediaClips (SIL Open Font License, see /fonts). */
export const BUNDLED_FONTS: { family: string; file: string }[] = [
  { family: "Poppins Black", file: "Poppins-Black.ttf" },
  { family: "Poppins ExtraBold", file: "Poppins-ExtraBold.ttf" },
  { family: "Poppins Bold", file: "Poppins-Bold.ttf" },
  { family: "Anton", file: "Anton-Regular.ttf" },
  { family: "Bebas Neue", file: "BebasNeue-Regular.ttf" },
  { family: "Archivo Black", file: "ArchivoBlack-Regular.ttf" },
];

export const CAPTION_STYLES: CaptionStyle[] = [
  { id: "bold-pop", name: "Bold pop", description: "Big white uppercase punches, three words at a time.", font: "Poppins Black", size: 92, color: "#FFFFFF", highlight: "#FFD60A", outline: "#000000", outlineWidth: 8, shadow: 3, uppercase: true, wordsPerCaption: 3, position: 0.79, animation: "pop" },
  { id: "karaoke", name: "Karaoke", description: "The spoken word lights up as it's said.", font: "Poppins ExtraBold", size: 84, color: "#FFFFFF", highlight: "#FFD60A", outline: "#000000", outlineWidth: 7, shadow: 2, uppercase: true, wordsPerCaption: 4, position: 0.79, animation: "karaoke" },
  { id: "hormozi", name: "Hormozi", description: "Tall condensed type, active word in green.", font: "Anton", size: 112, color: "#FFFFFF", highlight: "#39E75F", outline: "#000000", outlineWidth: 9, shadow: 4, uppercase: true, wordsPerCaption: 3, position: 0.78, animation: "karaoke" },
  { id: "one-word", name: "One word", description: "One huge word at a time, fast and punchy.", font: "Bebas Neue", size: 160, color: "#FFFFFF", highlight: "#FFFFFF", outline: "#000000", outlineWidth: 9, shadow: 4, uppercase: true, wordsPerCaption: 1, position: 0.78, animation: "pop" },
  { id: "boxed", name: "Boxed", description: "White text on a dark box, easy to read on busy footage.", font: "Archivo Black", size: 70, color: "#FFFFFF", highlight: "#FFD60A", outline: "#000000", outlineWidth: 18, shadow: 0, box: "#000000CC", uppercase: false, wordsPerCaption: 4, position: 0.8, animation: "fade" },
  { id: "neon", name: "Neon", description: "Glowing cyan outline for gaming clips.", font: "Poppins ExtraBold", size: 86, color: "#FFFFFF", highlight: "#FF4FD8", outline: "#22D3EE", outlineWidth: 5, shadow: 0, uppercase: true, wordsPerCaption: 3, position: 0.79, animation: "karaoke", glow: true },
  { id: "minimal", name: "Minimal", description: "Clean sentence case, a few words at a time.", font: "Poppins Bold", size: 62, color: "#FFFFFF", highlight: "#FFFFFF", outline: "#000000", outlineWidth: 3, shadow: 2, uppercase: false, wordsPerCaption: 6, position: 0.82, animation: "fade" },
  { id: "subtitle", name: "Subtitle", description: "Classic two-line subtitles on a soft box.", font: "Poppins Bold", size: 54, color: "#FFFFFF", highlight: "#FFFFFF", outline: "#000000", outlineWidth: 14, shadow: 0, box: "#00000099", uppercase: false, wordsPerCaption: 9, position: 0.84, animation: "none" },
];

export const DEFAULT_CAPTION_STYLE = "bold-pop";

/** A workspace's brand kit: fonts and colours applied to whichever style is used. */
export interface BrandKit {
  /** Default caption style for new renders. */
  captionStyle?: string;
  /** Use this font for captions, hook and call to action (a brand upload or a bundled font). */
  font?: string;
  colors?: { text?: string; highlight?: string; outline?: string; accent?: string };
  /** Force uppercase on or off regardless of style. */
  uppercase?: boolean;
  fonts?: { id: string; family: string; key: string; file: string }[];
}

/** Per-campaign or per-job choices, applied last. */
export interface CaptionOverrides {
  style?: string;
  wordsPerCaption?: number;
  position?: number;
  size?: number;
}

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

/** Preset ← brand kit ← overrides. Unknown or malformed values fall back to the layer below. */
export function resolveCaptionStyle(brand: BrandKit | undefined, overrides: CaptionOverrides = {}): CaptionStyle {
  const id = overrides.style ?? brand?.captionStyle ?? DEFAULT_CAPTION_STYLE;
  const base = CAPTION_STYLES.find((s) => s.id === id) ?? CAPTION_STYLES[0];
  const c = brand?.colors ?? {};
  const pick = (v: string | undefined, fallback: string) => (v && HEX.test(v) ? v : fallback);
  const clamp = (v: number | undefined, lo: number, hi: number, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
  const size = Math.round(clamp(overrides.size, 24, 220, base.size));
  return {
    ...base,
    font: brand?.font?.trim() || base.font,
    color: pick(c.text, base.color),
    highlight: pick(c.highlight, base.highlight),
    outline: pick(c.outline, base.outline),
    uppercase: brand?.uppercase ?? base.uppercase,
    wordsPerCaption: Math.round(clamp(overrides.wordsPerCaption, 1, 12, base.wordsPerCaption)),
    position: clamp(overrides.position, 0.05, 0.95, base.position),
    size,
    // Outline and shadow keep their proportion to the text when the size changes.
    outlineWidth: Math.round(base.outlineWidth * (size / base.size) * 10) / 10,
    shadow: Math.round(base.shadow * (size / base.size) * 10) / 10,
  };
}

/** The accent used for the call-to-action card. */
export const accentOf = (brand: BrandKit | undefined) => (brand?.colors?.accent && HEX.test(brand.colors.accent) ? brand.colors.accent : "#E5484D");

/**
 * Group timed words into captions of up to `max` words, breaking after
 * punctuation; `first` is each group's index into `words` (for editing).
 */
export function groupWords<T extends { text: string; start: number; end: number }>(words: T[], max = 3): { text: string; start: number; end: number; words: T[]; first: number }[] {
  const out: { text: string; start: number; end: number; words: T[]; first: number }[] = [];
  let cur: T[] = [];
  let first = 0;
  words.forEach((w, i) => {
    if (!cur.length) first = i;
    cur.push(w);
    if (cur.length >= max || /[.!?,;:—。！？、，]$/.test(w.text)) {
      out.push({ text: joinWords(cur.map((x) => x.text)), start: cur[0].start, end: cur[cur.length - 1].end, words: cur, first });
      cur = [];
    }
  });
  if (cur.length) out.push({ text: joinWords(cur.map((x) => x.text)), start: cur[0].start, end: cur[cur.length - 1].end, words: cur, first });
  // Close tiny gaps so captions don't flicker.
  for (let i = 0; i < out.length - 1; i++) if (out[i + 1].start - out[i].end < 0.25) out[i].end = out[i + 1].start;
  return out;
}
