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
