// Narration markup: what the voice says vs. what the captions show, and named
// moments overlays can cue on. Plain narration is unaffected.
//
//   <display|spoken>   "<$5|five dollars>": captions show "$5", the voice says "five dollars"
//   @{name}            a moment at the next word; overlays cue on it with "@name"

const MARK = /<([^|<>]*)\|([^<>]*)>|@\{([\w-]{1,40})\}/g;

export interface Piece {
  display: string;
  spoken: string;
  moment?: string;
}

export function parseNarration(narration: string): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  for (const m of narration.matchAll(MARK)) {
    if (m.index! > last) out.push({ display: narration.slice(last, m.index), spoken: narration.slice(last, m.index) });
    out.push(m[3] ? { display: "", spoken: "", moment: m[3] } : { display: m[1].trim(), spoken: m[2].trim() });
    last = m.index! + m[0].length;
  }
  if (last < narration.length) out.push({ display: narration.slice(last), spoken: narration.slice(last) });
  return out;
}

const tidy = (s: string) => s.replace(/\s+/g, " ").trim();
export const spokenText = (narration: string) => tidy(parseNarration(narration).map((p) => p.spoken).join(""));
export const displayText = (narration: string) => tidy(parseNarration(narration).map((p) => p.display).join(""));
export const momentNames = (narration: string) => parseNarration(narration).flatMap((p) => (p.moment ? [p.moment] : []));
export const hasMarkup = (narration: string) => /<[^|<>]*\|[^<>]*>|@\{[\w-]+\}/.test(narration);

/** How text splits into words: on spaces, unless a segmenter is given (Chinese, Japanese…). */
export type Splitter = (text: string) => string[];
const bySpaces: Splitter = (s) => tidy(s).split(" ").filter(Boolean);

interface Timed {
  text: string;
  start: number;
  end: number;
}

/**
 * The shown words, timed from the spoken words they stand for, by character:
 * plain text is the same characters on both sides; a marked-up piece spreads
 * its shown characters over its spoken ones. Each shown word takes the time
 * of the spoken characters it covers. `said` are the spoken words (or
 * phrases, when estimated) in order, with times; `split` splits the shown
 * text into words the way the captions do (a word segmenter for unspaced
 * languages). Moments land at the start of the next spoken character.
 */
export function displayTimed(pieces: Piece[], said: Timed[], split: Splitter = bySpaces): { words: Timed[]; moments: Record<string, number> } {
  const ink = (t: string) => t.replace(/\s+/g, "");
  // Spoken character positions (whitespace ignored) → time, through `said`.
  const at: number[] = [];
  let pos = 0;
  for (const w of said) {
    at.push(pos);
    pos += Math.max(1, ink(w.text).length);
  }
  const saidChars = pos;
  const spokenChars = ink(pieces.map((p) => p.spoken).join("")).length;
  // If the aligned words don't spell the spoken text exactly, scale positions.
  const scale = spokenChars ? saidChars / spokenChars : 0;
  const time = (p: number, end: boolean): number => {
    if (!said.length) return 0;
    const q = Math.min(Math.max(0, p * scale), saidChars);
    let i = 0;
    while (i + 1 < said.length && (end ? at[i + 1] < q : at[i + 1] <= q)) i++;
    const w = said[i];
    const len = (i + 1 < said.length ? at[i + 1] : saidChars) - at[i];
    return w.start + ((w.end - w.start) * Math.min(len, Math.max(0, q - at[i]))) / len;
  };
  // Each shown character's spoken span [from, to), in spoken character positions.
  const from: number[] = [];
  const to: number[] = [];
  const moments: Record<string, number> = {};
  let sp = 0;
  for (const p of pieces) {
    if (p.moment) {
      moments[p.moment] = time(Math.min(sp, Math.max(0, spokenChars - 1)), false);
      continue;
    }
    const d = ink(p.display).length;
    const n = ink(p.spoken).length;
    const plain = p.display === p.spoken;
    for (let k = 0; k < d; k++) {
      from.push(plain ? sp + k : sp + (n * k) / d);
      to.push(plain ? sp + k + 1 : sp + (n * (k + 1)) / d);
    }
    sp += n;
  }
  const words: Timed[] = [];
  let c = 0;
  for (const text of split(pieces.map((p) => p.display).join(""))) {
    const len = ink(text).length;
    if (!len || c >= from.length) {
      const prev = words[words.length - 1];
      words.push({ text, start: prev?.end ?? 0, end: prev?.end ?? 0 });
      continue;
    }
    const last = Math.min(c + len, from.length) - 1;
    const start = time(from[c], false);
    // A shown word with no spoken characters (<🔥|>) still shows briefly.
    const end = to[last] > from[c] ? time(to[last], true) : start + 0.05;
    words.push({ text, start, end: Math.max(start, end) });
    c += len;
  }
  return { words, moments };
}
