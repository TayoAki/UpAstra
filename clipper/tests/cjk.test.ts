import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { checkClip, words } from "../shared/rules";
import { lastSentenceStart, sentences } from "../server/captions";
import { scriptWords } from "../server/align";
import { extractWithRules } from "../server/extract";

// B0.4: scripts written without spaces (Chinese, Japanese, Thai) are split
// into sentences, timed for the CTA and length-checked like any other.
describe("CJK scripts", () => {
  it("splits sentences on full-width punctuation", () => {
    expect(sentences("今日は晴れです。明日は雨です！本当？")).toEqual(["今日は晴れです。", "明日は雨です！", "本当？"]);
    expect(sentences("Car League is free. Play it now!  Really?")).toEqual(["Car League is free.", "Play it now!", "Really?"]);
    expect(sentences("Mixed 中文。Then English.")).toEqual(["Mixed 中文。", "Then English."]);
  });

  it("anchors the CTA to the first word of the last sentence", () => {
    for (const [lang, text] of [["ja", "このゲームは最高です。ロブロックスで今すぐ遊ぼう。"], ["zh", "这个游戏太好玩了。现在就在罗布乐思上玩吧。"]] as const) {
      const tokens = scriptWords(text, lang);
      const timed = tokens.map((t, i) => ({ text: t, start: i, end: i + 0.9 }));
      const last = scriptWords(sentences(text).at(-1)!, lang).length;
      expect(last).toBeGreaterThan(1);
      expect(lastSentenceStart(text, timed, lang)).toBe(tokens.length - last);
    }
    const en = "Car League is free. Play Car League on Roblox.";
    const timed = en.split(" ").map((t, i) => ({ text: t, start: i, end: i + 0.9 }));
    expect(lastSentenceStart(en, timed)).toBe(4);
    expect(lastSentenceStart(en, [])).toBeUndefined();
  });

  it("counts unspaced scripts by characters", () => {
    expect(words("hello world")).toBe(2);
    expect(words("这个游戏太好玩了")).toBe(4);
    expect(words("Play 车联赛 now")).toBe(4);
    expect(words("กขคง")).toBe(2);
  });

  it("fails the voiceover check for a Chinese script far too long for the clip", () => {
    const brief = extractWithRules(fs.readFileSync(new URL("./fixtures/car-league-brief.txt", import.meta.url), "utf8"));
    const narration = "这个游戏太好玩了。".repeat(34); // ~300 characters
    const fit = checkClip({ hook: "这个游戏太好玩了", narration, cta: "", lengthSec: 15, onScreenText: [], shots: [] } as never, brief).checks.find((x) => x.rule === "Voiceover fits the clip")!;
    expect(fit.pass).toBe(false);
  });
});
