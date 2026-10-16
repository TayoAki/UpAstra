import { describe, expect, it } from "vitest";
import { joinWords } from "../shared/words";
import { groupWords, resolveCaptionStyle } from "../shared/caption-styles";
import { buildAss } from "../server/captions";

// B2.1: caption words are spaced by script: no stray spaces inside Chinese,
// Japanese or Thai, normal spaces between Latin words.
describe("word spacing", () => {
  it("joins by script, not by language", () => {
    expect(joinWords(["Play", "Car", "League", "now"])).toBe("Play Car League now");
    expect(joinWords(["今日", "は", "最高", "です"])).toBe("今日は最高です");
    expect(joinWords(["这个", "游戏", "太", "好玩", "了"])).toBe("这个游戏太好玩了");
    expect(joinWords(["今すぐ", "Car", "League", "で", "遊ぼう"])).toBe("今すぐCar Leagueで遊ぼう");
    expect(joinWords(["สวัสดี", "ครับ"])).toBe("สวัสดีครับ");
    expect(joinWords([])).toBe("");
  });

  it("groups and burns captions without spaces between Japanese words", () => {
    const words = ["今日", "は", "最高", "です"].map((text, i) => ({ text, start: i * 0.5, end: i * 0.5 + 0.4 }));
    const g = groupWords(words, 4);
    expect(g[0].text).toBe("今日は最高です");
    const ass = buildAss({ hook: "", captions: g, cta: "", ctaFrom: 9, duration: 3, language: "ja" });
    expect(ass).toContain("今日は最高です");
    const karaoke = buildAss({ hook: "", captions: g, cta: "", ctaFrom: 9, duration: 3, language: "ja", style: resolveCaptionStyle(undefined, { style: "karaoke" }) });
    const lines = karaoke.split("\n").filter((l) => l.startsWith("Dialogue: 0,"));
    expect(lines).toHaveLength(4);
    // Each line is the whole caption with one word highlighted, and no spaces anywhere in it.
    for (const l of lines) expect(l.replace(/\{[^}]*\}/g, "").split(",").slice(9).join(",")).toBe("今日は最高です");
  });
});
