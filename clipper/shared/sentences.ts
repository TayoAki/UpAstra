// Sentence splitting shared by the server (captions, CTA timing) and the
// rule checks. Full-width marks (。！？) end a sentence with no space after;
// a run of end marks ("！！", "?!", "。。。") and the closing quotes or
// brackets after it stay with the sentence they end.

const END = /[.!?。！？]/;
const FULL_WIDTH_END = /[。！？]/;
const CLOSE = /["'”’」』）)】\]]/;

/** Split a script into sentences, keeping punctuation. */
export function sentences(text: string): string[] {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < chars.length; i++) {
    cur += chars[i];
    if (!END.test(chars[i])) continue;
    let fullWidth = FULL_WIDTH_END.test(chars[i]);
    while (i + 1 < chars.length && (END.test(chars[i + 1]) || CLOSE.test(chars[i + 1]))) {
      fullWidth ||= FULL_WIDTH_END.test(chars[i + 1]);
      cur += chars[++i];
    }
    // ASCII marks end a sentence only before a space ("3.5" doesn't).
    if (i + 1 >= chars.length || chars[i + 1] === " " || fullWidth) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
