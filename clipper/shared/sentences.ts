// Sentence splitting shared by the server (captions, CTA timing) and the
// rule checks. Full-width marks (。！？) end a sentence with no space after;
// a run of end marks ("！！", "?!", "。。。") and the closing quotes or
// brackets after it stay with the sentence they end.

const END = /[.!?。！？]/;
const FULL_WIDTH_END = /[。！？]/;
const CLOSE = /["'”’」』）)】\]]/;
/** Scripts written without spaces: an ASCII "!" or "?" right before one of these ends a sentence too. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}「『（“]/u;
/** Japanese quoting particles: 「…。」と言った continues the sentence. */
const QUOTING = /^(と|って)/;

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
    const next = chars[i + 1];
    const closed = CLOSE.test(chars[i]);
    if (closed && next && QUOTING.test(chars.slice(i + 1, i + 3).join(""))) continue;
    // ASCII marks end a sentence only before a space ("3.5" doesn't), or
    // straight before unspaced text ("车!快来").
    if (next === undefined || next === " " || fullWidth || (/[!?]/.test(chars[i]) && UNSPACED.test(next))) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
