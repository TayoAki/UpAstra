import { describe, expect, it } from "vitest";
import { overlayEvents } from "../server/overlays";
import type { Overlay } from "../shared/types";

// B4.5: comment cards tilt, unwind into place, and fade up on the way out;
// "Reply to @…" only when the plan named who commented (never invented).
const L = { width: 1080, height: 1920, bandTop: 560, bandHeight: 844, font: "Poppins Black", accent: "#E5484D" };
const card = (o: Partial<Overlay>) => overlayEvents([{ o: { id: "c", kind: "comment", text: "rank every car please", ...o } as Overlay, start: 1, end: 4 }], L);

describe("comment card", () => {
  it("tilts around one origin, unwinds on entry and fades up on exit", () => {
    const ev = card({ user: "carfan" });
    const orgs = new Set(ev.map((l) => l.match(/\\org\(([\d,]+)\)/)?.[1]));
    expect(orgs.size).toBe(1); // every piece rotates around the same point
    expect([...orgs][0]).toBeDefined();
    const entry = ev.filter((l) => l.includes(",0:00:01.00,"));
    for (const e of entry) expect(e).toMatch(/\\frz8\\t\(0,\d+,\\frz2\.5\)/);
    const exit = ev.filter((l) => /^Dialogue: \d+,0:00:03\.\d\d,0:00:04\.00,/.test(l));
    expect(exit.length).toBe(entry.length);
    for (const e of exit) expect(e).toMatch(/\\fad\(0,\d+\)/);
    expect(ev.some((l) => l.includes("Reply to @carfan"))).toBe(true);
  });

  it("doesn't invent who commented", () => {
    const ev = card({ user: undefined });
    expect(ev.some((l) => l.includes("Reply to"))).toBe(false);
    expect(ev.some((l) => /\}viewer|\}V$/.test(l))).toBe(false);
  });
});
