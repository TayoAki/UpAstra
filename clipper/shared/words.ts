// Joining caption words. Scripts written without spaces (Chinese, Japanese,
// Thai, …) get none between their words; everything else gets one. Deciding
// per pair of words, by script, handles mixed text ("今すぐCar Leagueで").

const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}　-〿＀-￯]/u;

/** The separator to put between two adjacent words. */
export const sepBetween = (a: string, b: string) => (UNSPACED.test(a.slice(-1)) || UNSPACED.test([...b][0] ?? "") ? "" : " ");

export function joinWords(words: string[]): string {
  let out = "";
  for (const [i, w] of words.entries()) out += (i ? sepBetween(words[i - 1], w) : "") + w;
  return out;
}
