import { describe, expect, it } from "vitest";
import { FONT_WIDTHS } from "../server/font-metrics";
import { commentLayout, fitText, textWidth, tierLayout } from "../server/overlays";
import { TIERS, type Tier } from "../shared/types";

// B0.5: tier items and comments never overlap each other and never leave
// their area, for any bundled font and any reasonable number of items.
type Box = { x: number; y: number; w: number; h: number };
const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a: Box, o: Box) => a.x >= o.x - 0.5 && a.y >= o.y - 0.5 && a.x + a.w <= o.x + o.w + 0.5 && a.y + a.h <= o.y + o.h + 0.5;
const FONTS = Object.keys(FONT_WIDTHS);
const NAMES = ["Octane", "Dominus GT Special Edition", "WWWWWWWWWWWWWWWWWWWWWW", "Breakout Type-S", "Fennec", "MERC", "Twin Mill III", "Batmobile (2016)", "Takumi RX-T", "Road Hog XL", "Scarab", "Zippy"];
const L = (font: string) => ({ width: 1080, height: 1920, bandTop: 560, bandHeight: 844, font, accent: "#E5484D" });

describe("text fitting", () => {
  it("measures with the bundled fonts' metrics and falls back safely", () => {
    expect(textWidth("Octane Dominus", 80, "Poppins Black")).toBeCloseTo(398, -1);
    expect(textWidth("Octane", 80, "Some Brand Font")).toBeGreaterThanOrEqual(textWidth("Octane", 80, "Archivo Black"));
    expect(textWidth("车联赛", 100, "Poppins Black")).toBeGreaterThan(150);
  });

  it("wraps by measured width, shrinks, then ellipsizes", () => {
    const f = fitText("THE BEST CAR IN THE WHOLE ENTIRE GAME RIGHT NOW", { font: "Poppins Black", size: 124, minSize: 64, maxWidth: 1000, maxLines: 2 });
    expect(f.lines.length).toBeLessThanOrEqual(2);
    for (const l of f.lines) expect(textWidth(l, f.size, "Poppins Black")).toBeLessThanOrEqual(1000);
    const g = fitText("W".repeat(80), { font: "Archivo Black", size: 48, minSize: 24, maxWidth: 280, maxLines: 1 });
    expect(g.lines).toHaveLength(1);
    expect(g.lines[0].endsWith("…")).toBe(true);
    expect(textWidth(g.lines[0], g.size, "Archivo Black")).toBeLessThanOrEqual(280);
    expect(fitText("short", { font: "Anton", size: 48, minSize: 24, maxWidth: 280, maxLines: 1 })).toMatchObject({ lines: ["short"], size: 48 });
  });
});

describe("tier board layout", () => {
  it("never overlaps or overflows, for 1–12 items in every font", () => {
    for (const font of FONTS)
      for (let n = 1; n <= 12; n++)
        for (const spread of [true, false]) {
          const items = NAMES.slice(0, n).map((text, i) => ({ text, tier: (spread ? TIERS[i % 5] : "S") as Tier }));
          const t = tierLayout(items, L(font));
          expect(t.items).toHaveLength(n);
          t.items.forEach((a, i) => {
            const row = { x: t.left + t.labelW, y: t.top + TIERS.indexOf(items[i].tier) * t.rowH, w: t.width - t.labelW, h: t.rowH };
            expect(inside(a.box, row), `${font} n=${n} "${a.text}" outside its row`).toBe(true);
            t.items.forEach((b, j) => j > i && expect(overlap(a.box, b.box), `${font} n=${n}: "${a.text}" × "${b.text}"`).toBe(false));
          });
        }
  });
});

describe("comment layout", () => {
  const body = "this is a really long comment that needs three lines to fit in the card";
  it("places each comment against every comment still on screen", () => {
    for (const font of FONTS) {
      // A stays up the whole time; B ends before C starts; C must not land on A.
      const c = commentLayout(
        [
          { start: 0, end: 8, text: body, user: "a" },
          { start: 1, end: 3, text: body, user: "b" },
          { start: 4, end: 6, text: body, user: "c" },
          { start: 4.5, end: 7, text: "short", user: "d" },
          { start: 5, end: 7.5, text: body, user: "e" },
        ],
        L(font),
      );
      const band = { x: 0, y: 560, w: 1080, h: 844 };
      const shown = c.filter((x) => x.shown);
      expect(shown.length).toBeGreaterThanOrEqual(3);
      shown.forEach((a, i) => {
        expect(inside(a, band), `${font} ${a.user} outside the band`).toBe(true);
        expect(a.start).toBeLessThan(a.end);
        shown.forEach((b, j) => {
          if (j > i && a.start < b.end && b.start < a.end) expect(overlap(a, b), `${font} ${a.user} × ${b.user}`).toBe(false);
        });
      });
    }
  });

  it("puts comments above the footage while a tier board covers it, without stacking them", () => {
    const c = commentLayout(
      [
        { start: 1, end: 4, text: body, user: "a" },
        { start: 2, end: 5, text: "second", user: "b" },
      ],
      L("Poppins Black"),
      { from: 0, to: 10 },
    );
    const above = { x: 0, y: 0, w: 1080, h: 560 };
    const shown = c.filter((x) => x.shown);
    for (const a of shown) expect(inside(a, above)).toBe(true);
    if (shown.length === 2) expect(overlap(shown[0], shown[1])).toBe(false);
  });
});
