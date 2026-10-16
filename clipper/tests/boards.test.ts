import { describe, expect, it } from "vitest";
import { FONT_WIDTHS } from "../server/font-metrics";
import { overlayEvents, placeOverlays, podiumLayout, quizLayout, rankLayout, textWidth, tierSchedule } from "../server/overlays";
import { sfxEvents } from "../server/sfx";
import { sanitizeOverlays } from "../shared/overlays";
import type { Overlay } from "../shared/types";

// B8.1/B8.2: Top-N column, podium and quiz strip fit the frame, never overlap,
// and reveal on the tier board's schedule.
type Box = { x: number; y: number; w: number; h: number };
const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a: Box, o: Box) => a.x >= o.x - 0.5 && a.y >= o.y - 0.5 && a.x + a.w <= o.x + o.w + 0.5 && a.y + a.h <= o.y + o.h + 0.5;
const FONTS = Object.keys(FONT_WIDTHS);
const L = (font: string) => ({ width: 1080, height: 1920, bandTop: 560, bandHeight: 844, font, accent: "#E5484D" });
const band = { x: 0, y: 560, w: 1080, h: 844 };
const NAMES = ["Octane", "Dominus GT Special Edition", "WWWWWWWWWWWWWWWWWWWWWW", "Breakout Type-S", "Fennec", "MERC", "Twin Mill III", "Batmobile (2016)", "Takumi RX-T", "Road Hog XL"];

describe("Top-N column", () => {
  it("fits every name in its numbered slot, inside the footage, without overlaps", () => {
    for (const font of FONTS)
      for (const n of [3, 5, 10]) {
        const g = rankLayout(NAMES.slice(0, n).map((text, i) => ({ text, rank: i + 1 })), L(font));
        expect(g.n).toBe(n);
        const area = g.width - g.labelW - 20 - 12;
        g.slots.forEach((s, i) => {
          expect(inside(s.box, band)).toBe(true);
          expect(textWidth(s.text, s.size, font)).toBeLessThanOrEqual(area);
          for (const t of g.slots.slice(i + 1)) expect(overlap(s.box, t.box)).toBe(false);
        });
      }
  });

  it("lists #1 at the top, skips a second item for a taken place, and counts down in order", () => {
    const g = rankLayout([{ text: "Fifth", rank: 5 }, { text: "First", rank: 1 }, { text: "Also first", rank: 1 }], L("Poppins Black"));
    expect(g.slots[1].cy).toBeLessThan(g.slots[0].cy);
    expect(g.slots[2].text).toBe("");
    // A countdown 5 → 1 named a second apart: each item has landed before the next is named.
    const plan = tierSchedule([1, 2, 3, 4, 5], 9);
    plan.slice(0, -1).forEach((s, i) => expect(s.glideEnd).toBeLessThanOrEqual(plan[i + 1].start + 1e-9));
  });
});

describe("podium", () => {
  it("puts 1st in the middle on the tallest block, names above their blocks, in frame", () => {
    for (const font of FONTS) {
      const g = podiumLayout([{ text: NAMES[1], rank: 1 }, { text: NAMES[2], rank: 2 }, { text: NAMES[0], rank: 3 }], L(font));
      const [second, first, third] = g.blocks;
      expect([second.place, first.place, third.place]).toEqual([2, 1, 3]);
      expect(first.y).toBeLessThan(second.y);
      expect(second.y).toBeLessThan(third.y);
      g.slots.forEach((s, i) => {
        const b = g.blocks.find((x) => x.place === [1, 2, 3][i])!;
        expect(inside(s.box, band)).toBe(true);
        expect(s.box.y + s.box.h).toBeLessThanOrEqual(b.y);
        expect(s.box.x).toBeGreaterThanOrEqual(b.x - 0.5);
        expect(s.box.x + s.box.w).toBeLessThanOrEqual(b.x + b.w + 0.5);
      });
    }
  });
});

describe("quiz strip", () => {
  it("keeps 2–4 answers in frame, each fitted to its chip", () => {
    for (const font of FONTS)
      for (const n of [2, 3, 4]) {
        const o: Overlay = { id: "q", kind: "quiz", cue: "x", text: "Which car wins the most ranked games?", answers: ["Octane", "Dominus GT Special Edition", "WWWWWWWWWWWWWWWWWWWWWWWWWWWWWW", "Fennec"].slice(0, n), correct: 1 };
        const q = quizLayout(o, L(font));
        expect(q.chips).toHaveLength(n);
        expect(inside(q.box, band)).toBe(true);
        q.chips.forEach((c, i) => {
          expect(inside(c, band)).toBe(true);
          expect(c.lines.length).toBeLessThanOrEqual(2);
          expect(c.textW).toBeLessThanOrEqual(c.w - 44 - 40);
          for (const line of c.lines) expect(textWidth(line, c.size, font)).toBeLessThanOrEqual(c.textW);
          for (const d of q.chips.slice(i + 1)) expect(overlap(c, d)).toBe(false);
        });
      }
  });
});

describe("drawing and validation", () => {
  const words = "number five octane four fennec three merc two dominus one breakout".split(" ").map((text, i) => ({ text, start: i * 0.6, end: i * 0.6 + 0.5 }));
  const ranks: Overlay[] = [["octane", 5], ["fennec", 4], ["merc", 3], ["dominus", 2], ["breakout", 1]].map(([cue, rank], i) => ({ id: `r${i}`, kind: "rank", cue: String(cue), text: String(cue).toUpperCase(), rank: Number(rank) }));

  it("draws the Top-N board (snapshot) and keeps it until the call to action", () => {
    const { placed } = placeOverlays(ranks, words, 12, 9);
    expect(placed.every((p) => p.end === 9)).toBe(true);
    expect(overlayEvents(placed, L("Poppins Black")).join("\n")).toMatchSnapshot();
  });

  it("draws the podium and a quiz strip (snapshot)", () => {
    const pod: Overlay[] = [{ id: "p3", kind: "podium", cue: "three", text: "MERC", rank: 3 }, { id: "p2", kind: "podium", cue: "two", text: "DOMINUS", rank: 2 }, { id: "p1", kind: "podium", cue: "one", text: "BREAKOUT", rank: 1 }];
    const quiz: Overlay = { id: "q", kind: "quiz", cue: "number", text: "Which is #1?", answers: ["Octane", "Breakout", "Merc"], correct: 1, hold: 3 };
    const { placed } = placeOverlays([...pod, quiz], words, 12, 9);
    const ass = overlayEvents(placed, L("Poppins Black")).join("\n");
    expect(ass).toMatchSnapshot();
    // The right answer lights up for the last 40% of the strip's time.
    const q = placed.find((p) => p.o.kind === "quiz")!;
    expect(sfxEvents(placed, L("Poppins Black")).filter((e) => Math.abs(e.at - (q.start + 0.6 * (q.end - q.start))) < 1e-6)).toHaveLength(1);
  });

  it("keeps places in range, one board kind a clip, and quizzes with 2–4 answers", () => {
    const out = sanitizeOverlays([
      { kind: "rank", cue: "a", text: "A", rank: 11 },
      { kind: "rank", cue: "a", text: "A", rank: 2 },
      { kind: "tier", cue: "b", text: "B", tier: "S" },
      { kind: "podium", cue: "c", text: "C", rank: 4 },
      { kind: "quiz", cue: "d", answers: ["only one"] },
      { kind: "quiz", cue: "d", answers: ["x", "y", "z", "w", "v"], correct: 4 },
    ]);
    expect(out.map((o) => o.kind)).toEqual(["rank", "quiz"]);
    expect(out[0].rank).toBe(2);
    expect(out[1].answers).toEqual(["x", "y", "z", "w"]);
    expect(out[1].correct).toBeUndefined();
  });
});
