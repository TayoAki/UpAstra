import { describe, expect, it } from "vitest";
import { alignScript } from "../server/align";
import { wordsFrom, type Word } from "../server/transcribe";

const spoken = (s: string, start = 0, step = 0.4): Word[] => s.split(" ").map((text, i) => ({ text, start: start + i * step, end: start + (i + 1) * step - 0.05 }));

describe("script alignment", () => {
  it("keeps the script's spelling and takes timing from the speech", () => {
    const al = alignScript("Play Car League on Roblox today.", spoken("play carleague on roblox today", 1));
    expect(al.words.map((w) => w.text)).toEqual(["Play", "Car", "League", "on", "Roblox", "today."]);
    expect(al.words[0].start).toBeCloseTo(1);
    expect(al.words[3].start).toBeCloseTo(1.8); // "on" is the 3rd spoken word
    // "Car" and "League" share the time of "carleague", in order.
    expect(al.words[1].start).toBeLessThan(al.words[2].start);
    expect(al.words[2].end).toBeLessThanOrEqual(al.words[3].start + 1e-9);
    expect(al.extra).toEqual({ before: 0, after: 0, inside: 0 });
  });

  it("tolerates near-miss recognition", () => {
    const al = alignScript("Head to a Duel Pad to join", spoken("head to a dual pad to join"));
    expect(al.matched).toBe(1);
    expect(al.words[3].text).toBe("Duel");
    expect(al.words[3].start).toBeCloseTo(1.2);
  });

  it("finds chatter around the read and where the read really is", () => {
    const al = alignScript("¿Puedes marcar desde la pared? Juega hoy.", spoken("claro vamos con la frase puedes marcar desde la pared juega hoy ahora no voy a decir nada", 0, 0.5));
    expect(al.extra.before).toBe(5);
    expect(al.extra.after).toBe(6);
    expect(al.span.start).toBeCloseTo(2.5);
    expect(al.span.end).toBeCloseTo(5.95);
    expect(al.words[0]).toMatchObject({ text: "¿Puedes", start: 2.5 });
  });

  it("counts words inserted inside the script", () => {
    const al = alignScript("one two three four five six", spoken("one two banana split three four five six"));
    expect(al.extra.inside).toBe(2);
    expect(al.matched).toBe(1);
  });

  it("interpolates script words the speech skipped", () => {
    const al = alignScript("a quick brown fox jumps", spoken("a fox jumps", 0, 1));
    const t = al.words.map((w) => w.start);
    expect(t).toEqual([...t].sort((x, y) => x - y));
    expect(al.words[1].start).toBeGreaterThanOrEqual(al.words[0].end - 1e-9);
    expect(al.words[3].start).toBeCloseTo(1);
  });
});

describe("languages without spaces", () => {
  it("splits a Chinese script into words and aligns it", () => {
    const al = alignScript("你好世界。欢迎来到汽车联盟。", spoken("你好 世界 欢迎 来到 汽车 联盟"), "zh");
    expect(al.words.length).toBeGreaterThanOrEqual(5);
    expect(al.words.map((w) => w.text).join("")).toBe("你好世界。欢迎来到汽车联盟。");
    expect(al.matched).toBeGreaterThan(0.6);
  });
});

describe("whisper.cpp output", () => {
  it("turns one-word segments into words, gluing punctuation and dropping non-speech", () => {
    const seg = (text: string, from: number, to: number) => ({ text, offsets: { from, to } });
    const w = wordsFrom([seg("", 0, 30), seg(" Hello", 30, 400), seg(",", 400, 450), seg(" [Music]", 450, 900), seg(" world.", 900, 1300)]);
    expect(w).toEqual([
      { text: "Hello,", start: 0.03, end: 0.45 },
      { text: "world.", start: 0.9, end: 1.3 },
    ]);
    const zh = wordsFrom([seg("你好", 0, 300), seg("世界", 300, 600)], "zh");
    expect(zh.map((x) => x.text)).toEqual(["你好", "世界"]);
  });
});

// B5.2: words the recogniser merged or split ("website" / "web site",
// "CarLeague") are matched as groups, and their times split by length.
describe("M:N alignment", () => {
  it("matches a script word the recogniser split in two", () => {
    const al = alignScript("Visit our website today", spoken("visit our web site today"));
    expect(al.matched).toBe(1);
    expect(al.extra.inside).toBe(0);
    expect(al.words[2]).toMatchObject({ text: "website", start: 0.8 });
    expect(al.words[2].end).toBeCloseTo(1.55); // the end of "site"
    expect(al.words[3].start).toBeCloseTo(1.6);
  });

  it("splits a merged spoken word between the script words by length", () => {
    const al = alignScript("Play Car League now", spoken("play carleague now"));
    expect(al.matched).toBe(1);
    const [, car, league] = al.words;
    expect(car.start).toBeCloseTo(0.4);
    expect(league.end).toBeCloseTo(0.75);
    // "Car" gets 3/9 of the time, "League" 6/9.
    expect((car.end - car.start) / (league.end - league.start)).toBeCloseTo(3 / 6, 1);
  });

  it("keeps times in order when the recogniser's windows overlap or nest", () => {
    const words: Word[] = [
      { text: "one", start: 0.1, end: 0.5 },
      { text: "two", start: 0.4, end: 0.8 },
      { text: "three", start: 0.3, end: 1.2 },
      { text: "four", start: 1.1, end: 1.5 },
    ];
    const al = alignScript("one big two three four", words);
    for (let i = 1; i < al.words.length; i++) expect(al.words[i].start).toBeGreaterThanOrEqual(al.words[i - 1].start);
    for (const w of al.words) expect(w.end).toBeGreaterThan(w.start);
  });
});

// B5.4: the recogniser's confidence weighs mismatches, and unmatched words at
// the edges stay inside the speech.
describe("confidence and speech bounds", () => {
  it("takes a misheard word's timing when the recogniser wasn't sure of it", () => {
    const words = (p: number): Word[] => ["one", "banana", "three", "four"].map((text, i) => ({ text, start: i * 0.5, end: i * 0.5 + 0.4, p: text === "banana" ? p : 0.95 }));
    expect(alignScript("one two three four", words(0.1)).matched).toBe(1);
    expect(alignScript("one two three four", words(0.95)).matched).toBe(0.75);
  });

  it("keeps unmatched trailing words inside the speech", () => {
    const al = alignScript("play car league now on roblox today friends", spoken("play car league", 0, 0.3));
    const speechEnd = 0.3 * 3 - 0.05;
    for (const w of al.words) expect(w.end).toBeLessThanOrEqual(speechEnd + 0.4 + 1e-9);
  });

  it("reads token confidence from whisper's full JSON", () => {
    const w = wordsFrom([
      { text: " Hello", offsets: { from: 0, to: 400 }, tokens: [{ text: " Hello", p: 0.9 }] },
      { text: " wrld", offsets: { from: 400, to: 800 }, tokens: [{ text: " w", p: 0.3 }, { text: "rld", p: 0.5 }, { text: "[_TT_40]", p: 0.99 }] },
    ] as never);
    expect(w[0].p).toBeCloseTo(0.9);
    expect(w[1].p).toBeCloseTo(0.4);
  });
});
