import { describe, expect, it } from "vitest";
import { joinWords } from "../shared/words";
import { groupWords, resolveCaptionStyle } from "../shared/caption-styles";
import { buildAss } from "../server/captions";
import { textWidth } from "../server/overlays";

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

// B2.2: no caption line runs off the screen. Groups are measured with libass
// metrics, broken onto 2 balanced lines, split in time when that's not
// enough, and only a single word too wide on its own is shrunk.
describe("caption line budget", () => {
  const timed = (text: string) => text.split(" ").map((t, i) => ({ text: t, start: i * 0.4, end: i * 0.4 + 0.35 }));
  const events = (ass: string) => ass.split("\n").filter((l) => l.startsWith("Dialogue: 0,"));
  const visible = (l: string) => l.split(",").slice(9).join(",").replace(/\{[^}]*\}/g, "");
  const sizeOf = (l: string, base: number) => Number(l.match(/\\fs(\d+)/)?.[1] ?? base);

  for (const styleId of ["bold-pop", "karaoke", "hormozi", "boxed", "minimal", "subtitle"]) {
    it(`keeps every line inside the frame (${styleId})`, () => {
      const style = resolveCaptionStyle(undefined, { style: styleId });
      const text = "Donaudampfschifffahrtsgesellschaftskapitän drives the Turbo Ball Supercharged Edition into the goal again tonight";
      const ws = timed(text);
      const ass = buildAss({ hook: "", captions: groupWords(ws, style.wordsPerCaption), cta: "", ctaFrom: 99, duration: 99, style });
      const safe = 1080 - 2 * 70;
      const shown: string[] = [];
      let lastText = "";
      for (const e of events(ass)) {
        const lines = visible(e).split("\\N");
        expect(lines.length, e).toBeLessThanOrEqual(2);
        const fs = sizeOf(e, style.size);
        for (const line of lines) expect(textWidth(style.uppercase ? line.toUpperCase() : line, fs, style.font) + 2 * style.outlineWidth, `${styleId}: ${line}`).toBeLessThanOrEqual(safe + 1);
        const t = lines.join(" ");
        if (t !== lastText) shown.push(t); // karaoke repeats the line once per word
        lastText = t;
      }
      // Every word is shown, once, in order.
      const all = shown.join(" ").split(" ");
      expect(all.map((w) => w.toLowerCase())).toEqual(text.split(" ").map((w) => w.toLowerCase()));
    });
  }

  it("leaves a short caption on one line at full size", () => {
    const style = resolveCaptionStyle(undefined, { style: "bold-pop" });
    const ass = buildAss({ hook: "", captions: groupWords(timed("Play it now"), 3), cta: "", ctaFrom: 99, duration: 99, style });
    const [e] = events(ass);
    expect(visible(e)).toBe("PLAY IT NOW");
    expect(e).not.toMatch(/\\fs\d/);
  });
});

// B2.3: bottom-anchored captions (a second line grows upward), outline and
// shadow that scale with size, and a highlight that rests during real pauses.
describe("caption placement and pauses", () => {
  const caps = (ass: string) => ass.split("\n").filter((l) => l.startsWith("Dialogue: 0,"));
  it("anchors at the bottom, with a single line exactly where it was", () => {
    const style = resolveCaptionStyle(undefined, { style: "bold-pop" });
    const ass = buildAss({ hook: "", captions: [{ text: "PLAY NOW", start: 0, end: 1 }], cta: "", ctaFrom: 9, duration: 2, style });
    const y = Math.round(style.position * 1920 + style.size / 2);
    expect(caps(ass)[0]).toContain(`\\an2\\pos(540,${y})`);
  });

  it("scales outline and shadow with a size override", () => {
    const base = resolveCaptionStyle(undefined, { style: "minimal" });
    const big = resolveCaptionStyle(undefined, { style: "minimal", size: base.size * 2 });
    expect(big.outlineWidth).toBe(base.outlineWidth * 2);
    expect(big.shadow).toBe(base.shadow * 2);
  });

  it("rests the karaoke highlight during a pause longer than 0.35 s", () => {
    const style = resolveCaptionStyle(undefined, { style: "karaoke" });
    const words = [
      { text: "one", start: 0, end: 0.4 },
      { text: "two", start: 0.45, end: 0.8 },
      { text: "three", start: 2.0, end: 2.4 }, // a 1.2 s pause before "three"
    ];
    const ev = caps(buildAss({ hook: "", captions: [{ text: "one two three", start: 0, end: 2.4, words }], cta: "", ctaFrom: 9, duration: 3, style }));
    const at = (t: number) => ev.find((l) => { const [s, e] = l.split(",").slice(1, 3).map((x) => { const [h, m, sec] = x.split(":"); return +h * 3600 + +m * 60 + +sec; }); return s <= t && t < e; })!;
    expect(at(0.6)).toMatch(/\\c&H[0-9A-F]+&?}TWO/); // "two" lit while it's said
    expect(at(1.5)).not.toMatch(/\\c&H[0-9A-F]+&?}(ONE|TWO|THREE)/); // nothing lit in the pause
    expect(at(2.1)).toMatch(/\\c&H[0-9A-F]+&?}THREE/);
    // No gap: the line stays on screen through the pause.
    for (let t = 0; t < 2.4; t += 0.05) expect(at(t), `t=${t}`).toBeDefined();
  });
});

// B2.4: four new presets drawn natively in ASS, and a spring pop.
describe("caption presets", () => {
  const words = [
    { text: "one", start: 0, end: 0.3 },
    { text: "two", start: 0.35, end: 0.7 },
    { text: "three", start: 0.75, end: 1.1 },
  ];
  const caps = (id: string) =>
    buildAss({ hook: "", captions: [{ text: "one two three", start: 0, end: 1.1, words }], cta: "", ctaFrom: 9, duration: 2, style: resolveCaptionStyle(undefined, { style: id }) })
      .split("\n")
      .filter((l) => l.startsWith("Dialogue: 0,") || l.startsWith("Style: Cap,"));

  it("box highlight: the spoken word sits on a thick accent outline", () => {
    const ev = caps("box-highlight").filter((l) => l.startsWith("Dialogue"));
    expect(ev).toHaveLength(3);
    expect(ev[1]).toMatch(/\{\\3c&H[0-9A-F]+\\bord\d+\\shad0\}TWO\{\\r\}/);
  });

  it("underline: the spoken word is underlined", () => {
    const ev = caps("underline").filter((l) => l.startsWith("Dialogue"));
    expect(ev[2]).toMatch(/\{\\c&H[0-9A-F]+\\u1\}THREE\{\\r\}/);
  });

  it("fill sweep: one event per caption, each word filling over its own time", () => {
    const lines = caps("fill-sweep");
    const ev = lines.filter((l) => l.startsWith("Dialogue"));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toContain("{\\kf35}ONE {\\kf40}TWO {\\kf35}THREE");
    // \kf fills from the secondary colour to the primary: primary is the highlight.
    const [, , , primary, secondary] = lines[0].split(",");
    expect(primary).not.toBe(secondary);
  });

  it("accumulate: words appear as they're said, without moving the line", () => {
    const ev = caps("accumulate").filter((l) => l.startsWith("Dialogue"));
    expect(ev).toHaveLength(3);
    expect(ev[0]).toMatch(/one\{\\alpha&HFF&\} two three/);
    expect(ev[2]).not.toContain("\\alpha&HFF&");
  });

  it("pops with a spring: 72% → 105% → 100%", () => {
    const [e] = caps("bold-pop").filter((l) => l.startsWith("Dialogue"));
    expect(e).toContain("\\fscx72\\fscy72\\t(0,90,\\fscx105\\fscy105)\\t(90,170,\\fscx100\\fscy100)");
  });
});
