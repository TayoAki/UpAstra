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

const count = (s: string) => tidy(s).split(" ").filter(Boolean).length;

interface Timed {
  text: string;
  start: number;
  end: number;
}

/**
 * The shown words, timed from the spoken words they stand for: a marked-up
 * display word takes the span of its spoken words; plain words take their
 * own. `said` are the spoken words in order (as aligned). Moments land at
 * the start of the next spoken word.
 */
export function displayTimed(pieces: Piece[], said: Timed[]): { words: Timed[]; moments: Record<string, number> } {
  const shown = tidy(pieces.map((p) => p.display).join("")).split(" ").filter(Boolean);
  const spokenCount = count(pieces.map((p) => p.spoken).join(""));
  const moments: Record<string, number> = {};
  // If the aligned words don't line up with the spoken tokens (a segmenter
  // split them differently), map by position instead.
  if (said.length !== spokenCount || !said.length) {
    const words = shown.map((text, i) => {
      const a = said[Math.floor((i / shown.length) * said.length)] ?? { start: 0, end: 0 };
      const b = said[Math.max(0, Math.ceil(((i + 1) / shown.length) * said.length) - 1)] ?? a;
      return { text, start: a.start, end: Math.max(a.start, b.end) };
    });
    let d = "";
    for (const p of pieces) {
      if (p.moment) moments[p.moment] = words[Math.min(count(d), words.length - 1)]?.start ?? 0;
      d += p.display;
    }
    return { words, moments };
  }
  // Walk the pieces, counting tokens on both sides so far: each marked-up
  // piece is one group (display tokens ↔ spoken tokens); plain text pairs 1:1.
  const words: Timed[] = [];
  let d = "";
  let s = "";
  for (const p of pieces) {
    const [d0, s0] = [count(d), count(s)];
    if (p.moment) moments[p.moment] = said[Math.min(s0, said.length - 1)].start;
    d += p.display;
    s += p.spoken;
    const [d1, s1] = [count(d), count(s)];
    // Punctuation glued onto the previous token doesn't add tokens.
    if (d1 === d0 && s1 === s0) continue;
    const plain = p.display === p.spoken && d1 - d0 === s1 - s0;
    const groups = plain ? Array.from({ length: d1 - d0 }, (_, k) => [d0 + k, d0 + k + 1, s0 + k, s0 + k + 1]) : [[d0, d1, s0, s1]];
    for (const [a0, a1, b0, b1] of groups) {
      const from = said[Math.min(b0, said.length - 1)].start;
      const to = b1 > b0 ? said[b1 - 1].end : from + 0.05;
      const texts = shown.slice(a0, a1);
      const total = texts.reduce((n, t) => n + t.length, 0) || 1;
      let t = from;
      texts.forEach((text, k) => {
        const dur = ((to - from) * text.length) / total;
        words[a0 + k] = { text, start: t, end: t + dur };
        t += dur;
      });
    }
  }
  // A token glued across a piece boundary keeps its last-known time; fill any gap in order.
  for (let i = 0; i < shown.length; i++) words[i] = { ...(words[i] ?? words[i - 1] ?? { start: 0, end: 0 }), text: shown[i] };
  return { words, moments };
}
