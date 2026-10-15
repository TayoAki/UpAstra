import { NO_SPACES, type Word } from "./transcribe";

// Word-perfect captions for a known script: the script supplies the words
// (exact spelling, brand names, punctuation), the transcript supplies when each
// was spoken. The two are aligned like a diff; script words the recognizer
// missed or merged ("Car League" heard as "CarLeague") get times interpolated
// from their neighbours. Speech that isn't in the script — a voice model
// chatting before or after the read — is reported so it can be cut.

export interface Alignment {
  /** Every script word, with times. */
  words: Word[];
  /** Share of script words matched to a spoken word (0–1). */
  matched: number;
  /** Where the script is actually spoken (seconds into the audio). */
  span: { start: number; end: number };
  /** Spoken words outside the script: before it, after it, and inserted inside it. */
  extra: { before: number; after: number; inside: number };
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, "");

/** 0 for identical, 1 for nothing in common (character edit distance, normalized). */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a || !b) return 1;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n] / Math.max(m, n);
}

/**
 * A script's words. Languages written without spaces (Chinese, Japanese, Thai…)
 * are split with the runtime's word segmenter, keeping punctuation attached.
 */
export function scriptWords(script: string, language?: string): string[] {
  const text = script.replace(/\s+/g, " ").trim();
  if (!language || !NO_SPACES.has(language) || typeof Intl.Segmenter !== "function") return text.split(" ").filter(Boolean);
  const out: string[] = [];
  for (const s of new Intl.Segmenter(language, { granularity: "word" }).segment(text)) {
    if (!s.segment.trim()) continue;
    if (!s.isWordLike && out.length) out[out.length - 1] += s.segment.trim();
    else out.push(s.segment.trim());
  }
  return out;
}

export function alignScript(script: string, spoken: Word[], language?: string): Alignment {
  const sw = scriptWords(script, language);
  const a = sw.map(norm);
  const b = spoken.map((w) => norm(w.text));
  const n = a.length;
  const m = b.length;
  // Edit-distance alignment; a near-miss ("dual"/"duel") is a cheap substitution.
  // A script word missing from the speech costs more than an extra spoken
  // word: voices add words far more often than they drop them.
  const SKIP_SCRIPT = 1.5;
  const EXTRA_SPOKEN = 1;
  const cost = (i: number, j: number) => {
    const d = distance(a[i], b[j]);
    return d === 0 ? 0 : d <= 0.34 ? 0.5 : d <= 0.6 ? 1.2 : 2.5;
  };
  const D: Float64Array[] = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = 1; i <= n; i++) D[i][0] = i * SKIP_SCRIPT;
  // Spoken words before the script start are free to skip (leading chatter).
  for (let j = 1; j <= m; j++) D[0][j] = 0;
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) D[i][j] = Math.min(D[i - 1][j - 1] + cost(i - 1, j - 1), D[i - 1][j] + SKIP_SCRIPT, D[i][j - 1] + EXTRA_SPOKEN);
  // ...and so are spoken words after it (trailing chatter): end anywhere on the last row.
  let jEnd = 0;
  for (let j = 1; j <= m; j++) if (D[n][j] < D[n][jEnd]) jEnd = j;

  const pair: (number | undefined)[] = new Array(n).fill(undefined);
  let inserted = 0;
  let i = n;
  let j = jEnd;
  while (i > 0 && j > 0) {
    if (D[i][j] === D[i - 1][j - 1] + cost(i - 1, j - 1)) {
      if (cost(i - 1, j - 1) < 2.5) pair[i - 1] = j - 1;
      i--;
      j--;
    } else if (D[i][j] === D[i - 1][j] + SKIP_SCRIPT) i--;
    else {
      inserted++;
      j--;
    }
  }
  const jStart = j; // spoken words [0, jStart) came before the script

  // Times: paired words take their spoken word's time; the rest are spread
  // between the nearest paired neighbours by length.
  const words: Word[] = sw.map((text) => ({ text, start: NaN, end: NaN }));
  pair.forEach((p, k) => {
    if (p !== undefined) Object.assign(words[k], { start: spoken[p].start, end: spoken[p].end });
  });
  const matchedCount = pair.filter((p) => p !== undefined).length;
  const total = spoken.length ? spoken[spoken.length - 1].end : 0;
  let k = 0;
  while (k < n) {
    if (!Number.isNaN(words[k].start)) {
      k++;
      continue;
    }
    let e = k;
    while (e < n && Number.isNaN(words[e].start)) e++;
    let from = k > 0 ? words[k - 1].end : spoken[jStart]?.start ?? 0;
    const to = e < n ? words[e].start : Math.max(from + 0.3 * (e - k), jEnd > 0 ? spoken[jEnd - 1].end : total);
    // No room (e.g. "Car League" heard as one word): share the previous word's time.
    if (to - from < 0.1 * (e - k) && k > 0) {
      from = (words[k - 1].start + words[k - 1].end) / 2;
      words[k - 1].end = from;
    }
    const lo = Math.min(from, to);
    const hi = Math.max(to, lo + 0.05 * (e - k));
    const weights = words.slice(k, e).map((w) => w.text.length + 1);
    const sum = weights.reduce((x, y) => x + y, 0);
    let t = lo;
    for (let q = k; q < e; q++) {
      const d = ((hi - lo) * weights[q - k]) / sum;
      words[q].start = t;
      words[q].end = t + d;
      t += d;
    }
    k = e;
  }
  // Keep times monotonic.
  for (let q = 1; q < n; q++) if (words[q].start < words[q - 1].start) words[q].start = words[q - 1].start;
  for (const w of words) w.end = Math.max(w.end, w.start + 0.05);

  const firstPaired = pair.find((p) => p !== undefined);
  const lastPaired = [...pair].reverse().find((p) => p !== undefined);
  return {
    words,
    matched: n ? matchedCount / n : 0,
    span: {
      start: firstPaired !== undefined ? spoken[firstPaired].start : 0,
      end: lastPaired !== undefined ? spoken[lastPaired].end : total,
    },
    extra: { before: jStart, after: m - jEnd, inside: inserted },
  };
}
