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

  it("keeps runs of end marks and closing quotes with their sentence", () => {
    expect(sentences("太棒了！！现在就玩吧！！")).toEqual(["太棒了！！", "现在就玩吧！！"]);
    expect(sentences("最高です。「今すぐ買って！」")).toEqual(["最高です。", "「今すぐ買って！」"]);
    expect(sentences("等等。。。现在下载！")).toEqual(["等等。。。", "现在下载！"]);
    expect(sentences("他说“真好！”我们走吧。")).toEqual(["他说“真好！”", "我们走吧。"]);
    expect(sentences("Wait?! Really. Version 3.5 is out.")).toEqual(["Wait?!", "Really.", "Version 3.5 is out."]);
    // A quoted "!" mid-sentence doesn't end it; one before a capital does.
    expect(sentences('He said "wow!" then left. Try it now.')).toEqual(['He said "wow!" then left.', "Try it now."]);
    expect(sentences('She yelled "Go!" Then we won.')).toEqual(['She yelled "Go!"', "Then we won."]);
    // ASCII marks with no space, inside unspaced text.
    expect(sentences("这是最好的车!快来下载吧?")).toEqual(["这是最好的车!", "快来下载吧?"]);
    expect(sentences("これは最高の車です。「本当にすごい！」今すぐ試してね。")).toEqual(["これは最高の車です。", "「本当にすごい！」", "今すぐ試してね。"]);
    // A quote followed by the quoting particle と continues the sentence.
    expect(sentences("彼は「最高。」と言った。今すぐ遊ぼう。")).toEqual(["彼は「最高。」と言った。", "今すぐ遊ぼう。"]);
  });

  it("anchors the CTA to the first word of the last sentence", () => {
    // Expected: the token holding the last sentence's first letter, found by
    // walking the tokens over the text, independently of how the code counts.
    const expectedIndex = (text: string, lang: string) => {
      const flat = text.replace(/\s+/g, "");
      const last = sentences(text).at(-1)!.replace(/\s+/g, "");
      const lead = last.search(/[\p{L}\p{N}]/u);
      const offset = flat.lastIndexOf(last) + lead;
      let pos = 0;
      for (const [i, t] of scriptWords(text, lang).entries()) {
        if (offset < pos + t.length) return i;
        pos += t.length;
      }
      return -1;
    };
    for (const [lang, text] of [
      ["ja", "このゲームは最高です。ロブロックスで今すぐ遊ぼう。"],
      ["zh", "这个游戏太好玩了。现在就在罗布乐思上玩吧。"],
      ["zh", "太棒了！！现在就玩吧！！"],
      ["ja", "最高です。「今すぐ買って！」"],
      ["ja", "最高です。「限定」セール中！"],
      ["zh", "等等。。。现在下载！"],
      ["zh", "他说“真好！”我们走吧。"],
      ["zh", "这是最好的车!快来下载吧?"],
      ["ja", "これは最高の車です。「本当にすごい！」今すぐ試してね。"],
      ["ja", "彼は「最高。」と言った。今すぐ遊ぼう。"],
    ] as const) {
      const tokens = scriptWords(text, lang);
      const timed = tokens.map((t, i) => ({ text: t, start: i, end: i + 0.9 }));
      const want = expectedIndex(text, lang);
      expect(want, text).toBeGreaterThan(0);
      expect(lastSentenceStart(text, timed, lang), text).toBe(want);
    }
    const en = "Car League is free. Play Car League on Roblox.";
    const timed = en.split(" ").map((t, i) => ({ text: t, start: i, end: i + 0.9 }));
    expect(lastSentenceStart(en, timed)).toBe(4);
    expect(lastSentenceStart(en, [])).toBeUndefined();
    // One sentence: there's no "last sentence" to anchor to, so the caller falls back.
    expect(lastSentenceStart("Play Turbo Ball now", timed.slice(0, 4))).toBeUndefined();
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
