// When each shot of a clip starts. A shot names the phrase of the narration
// it illustrates; it starts when that phrase is said, so proof shots stay on
// their claims through re-voicing, variants and edits. Shots whose phrase
// can't be found (or would leave a neighbour under MIN_SHOT) share the time
// around them by their planned seconds, as before.

export const MIN_SHOT = 1.5;

interface Word {
  text: string;
  start: number;
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function shotTimes(shots: { seconds: number; phrase?: string }[], words: Word[], duration: number): { start: number; len: number; bound: boolean }[] {
  const n = shots.length;
  if (!n) return [];
  // Match phrases on the words' text joined without spaces (character
  // offsets map back to words), so unspaced scripts (Chinese, Japanese,
  // Thai) bind too. A Latin phrase must start and end on word boundaries.
  let stream = "";
  const owner: number[] = [];
  const wordStart = new Set<number>();
  const wordEnd = new Set<number>();
  words.forEach((w, i) => {
    const t = norm(w.text).replace(/ /g, "");
    wordStart.add(stream.length);
    stream += t;
    wordEnd.add(stream.length);
    for (let k = 0; k < t.length; k++) owner.push(i);
  });
  const find = (phrase: string, from: number): { at: number; end: number } | undefined => {
    const p = norm(phrase).replace(/ /g, "");
    if (!p) return undefined;
    const boundary = /^[\p{Script=Latin}\p{N}]/u.test(p);
    // A Latin phrase must be whole words ("car" isn't inside "career").
    for (let at = stream.indexOf(p, from); at >= 0; at = stream.indexOf(p, at + 1)) if (!boundary || (wordStart.has(at) && wordEnd.has(at + p.length))) return { at, end: at + p.length };
    return undefined;
  };
  const anchor: (number | undefined)[] = new Array(n).fill(undefined);
  anchor[0] = 0;
  let cursor = 0;
  // Shot 1's own words come first: later phrases are searched for after them.
  const opening = shots[0].phrase ? find(shots[0].phrase, 0) : undefined;
  if (opening && owner[opening.at] === 0) cursor = opening.end;
  let last = 0;
  let lastIdx = 0;
  for (let i = 1; i < n; i++) {
    const phrase = shots[i].phrase;
    if (!phrase) continue;
    // The first occurrence that leaves every shot at least MIN_SHOT; an earlier one is skipped, a later one ends the search.
    for (let m = find(phrase, cursor); m; m = find(phrase, m.at + 1)) {
      const t = words[owner[m.at]].start;
      if (t < last + MIN_SHOT * (i - lastIdx)) continue;
      if (t <= duration - MIN_SHOT * (n - i)) {
        anchor[i] = t;
        [last, lastIdx, cursor] = [t, i, m.end];
      }
      break;
    }
  }
  // Between anchors, shots share the time by their planned seconds (each ≥ MIN_SHOT when there's room).
  const out: { start: number; len: number; bound: boolean }[] = [];
  const marks = [...anchor.map((a, i) => (a === undefined ? undefined : i)).filter((i): i is number => i !== undefined), n];
  for (let m = 0; m < marks.length - 1; m++) {
    const [ia, ib] = [marks[m], marks[m + 1]];
    const ta = anchor[ia]!;
    const tb = ib === n ? duration : anchor[ib]!;
    const lens = share(shots.slice(ia, ib).map((s) => Math.max(1, s.seconds)), tb - ta);
    let t = ta;
    // The first shot of a run is the anchored one (shot 0 always starts at 0); the rest are shared.
    lens.forEach((len, k) => {
      out.push({ start: t, len, bound: k === 0 });
      t += len;
    });
  }
  return out;
}

/** Split `total` by `weights`, giving each part at least MIN_SHOT when the total allows. */
function share(weights: number[], total: number): number[] {
  const floor = Math.min(MIN_SHOT, total / weights.length);
  const fixed = new Set<number>();
  for (;;) {
    const free = weights.reduce((n, w, i) => (fixed.has(i) ? n : n + w), 0);
    const left = total - fixed.size * floor;
    const lens = weights.map((w, i) => (fixed.has(i) ? floor : (left * w) / free));
    const short = lens.findIndex((l, i) => !fixed.has(i) && l < floor - 1e-9);
    if (short < 0) return lens;
    fixed.add(short);
  }
}
