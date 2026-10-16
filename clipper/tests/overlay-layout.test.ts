import { describe, expect, it } from "vitest";
import { FONT_WIDTHS } from "../server/font-metrics";
import { blockedBoxes, commentLayout, fitText, hiddenComments, layoutComments, overlayEvents, textWidth, tierLayout } from "../server/overlays";
import type { Overlay } from "../shared/types";
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
  it("draws at most 12 items in one tier, inside the row", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ text: `Car ${i}`, tier: "S" as Tier }));
    const t = tierLayout(items, L("Poppins Black"));
    const drawn = t.items.filter((x) => x.text);
    expect(drawn).toHaveLength(12);
    drawn.forEach((a, i) => drawn.forEach((b, j) => j > i && expect(overlap(a.box, b.box)).toBe(false)));
    for (const a of drawn) expect(a.box.y + a.box.h).toBeLessThanOrEqual(t.top + t.rowH + 0.5);
  });

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
    expect(shown).toHaveLength(2);
    for (const a of shown) expect(inside(a, above)).toBe(true);
    expect(overlap(shown[0], shown[1])).toBe(false);
  });

  it("reports the comments it had to leave out", () => {
    const placed = Array.from({ length: 6 }, (_, i) => ({ o: { id: `c${i}`, kind: "comment", user: `u${i}`, text: body } as Overlay, start: 1, end: 3 }));
    const hidden = hiddenComments(placed, L("Poppins Black"));
    expect(hidden.length).toBeGreaterThan(0);
    // Each card is drawn as an entry and an exit event; count cards by who they reply to.
    const drawn = [...new Set(overlayEvents(placed, L("Poppins Black")).flatMap((l) => l.match(/Reply to @(\w+)/)?.[1] ?? []))];
    expect(drawn.length + hidden.length).toBe(6);
    for (const h of hidden) expect(drawn).not.toContain(h.user);
  });

  it("keeps cards off the hook, pop-up words and emoji stickers", () => {
    const hookL = { ...L("Poppins Black"), hook: { text: "Ranking every single car in Car League", end: 3.2 } };
    const o = (x: Partial<Overlay>) => ({ id: Math.random().toString(36), ...x }) as Overlay;
    const placed = [
      { o: o({ kind: "tier", text: "Octane", tier: "S" }), start: 0.5, end: 9 },
      { o: o({ kind: "comment", user: "a", text: body }), start: 1, end: 3 },
      { o: o({ kind: "comment", user: "b", text: "second card" }), start: 1.2, end: 3 },
      { o: o({ kind: "text", text: "no way" }), start: 4, end: 5 },
      { o: o({ kind: "comment", user: "c", text: body }), start: 4.2, end: 6 },
      { o: o({ kind: "emoji", emoji: "🔥" }), start: 6.5, end: 8 },
      { o: o({ kind: "comment", user: "d", text: body }), start: 6.6, end: 8 },
    ];
    const blocked = blockedBoxes(placed, hookL);
    expect(blocked.map((b) => b.what).sort()).toEqual(["hook", "sticker", "text"]);
    for (const c of layoutComments(placed, hookL).filter((x) => x.shown))
      for (const b of blocked) if (c.start < b.end && b.start < c.end) expect(overlap(c, b), `@${c.user} × ${b.what}`).toBe(false);
  });
});
