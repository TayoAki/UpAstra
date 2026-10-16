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
  const toks = words.map((w) => norm(w.text));
  // Each phrase, searched for after the previous one (so repeated words resolve in order).
  let from = 0;
  const anchor: (number | undefined)[] = shots.map((s, i) => {
    if (i === 0) return 0;
    const cue = s.phrase ? norm(s.phrase).split(" ").filter(Boolean) : [];
    if (!cue.length) return undefined;
    for (let k = from; k <= toks.length - cue.length; k++)
      if (cue.every((c, q) => toks[k + q] === c)) {
        from = k + 1;
        return words[k].start;
      }
    return undefined;
  });
  // Keep only anchors that leave every shot at least MIN_SHOT.
  let last = 0;
  let lastIdx = 0;
  for (let i = 1; i < n; i++) {
    const a = anchor[i];
    if (a === undefined) continue;
    if (a < last + MIN_SHOT * (i - lastIdx) || a > duration - MIN_SHOT * (n - i)) anchor[i] = undefined;
    else [last, lastIdx] = [a, i];
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
