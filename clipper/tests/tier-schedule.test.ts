import { describe, expect, it } from "vitest";
import { overlayEvents, tierSchedule } from "../server/overlays";
import type { Overlay } from "../shared/types";

// B4.1/B4.2: each tier item reveals on its cue, holds at the board's centre,
// and glides into its cell before the next one is named; motion is fitted to
// how fast the items are named.
describe("tier schedule", () => {
  it("finishes each glide before the next item is named", () => {
    const s = tierSchedule([1, 2, 3], 9);
    for (let i = 0; i < s.length; i++) {
      expect(s[i].start).toBe([1, 2, 3][i]);
      expect(s[i].glideStart).toBeGreaterThan(s[i].start);
      expect(s[i].glideEnd).toBeGreaterThan(s[i].glideStart);
      if (i < s.length - 1) expect(s[i].glideEnd).toBeLessThanOrEqual(s[i + 1].start + 1e-9);
      expect(s[i].end).toBe(9);
    }
    expect(s[2].glideEnd).toBeLessThanOrEqual(3 + 2); // the last one takes at most 2 s
  });

  it("settles the last item well before the board goes", () => {
    const s = tierSchedule([1, 2, 2.8], 3.4);
    expect(s[2].glideEnd).toBeLessThanOrEqual(3.4 - 0.3 + 1e-9);
    expect(s[2].end - s[2].glideEnd).toBeGreaterThanOrEqual(0.3 - 1e-9);
  });

  it("compresses the motion into a short window", () => {
    const [a] = tierSchedule([1, 1.3], 9);
    expect(a.glideEnd).toBeLessThanOrEqual(1.3 + 1e-9);
    expect(a.glideStart - a.start).toBeLessThanOrEqual(0.3);
  });

  it("draws staged, gliding and settled events for each item", () => {
    const L = { width: 1080, height: 1920, bandTop: 560, bandHeight: 844, font: "Poppins Black", accent: "#E5484D" };
    const items = ["Octane", "Dominus", "Fennec"].map((text, i) => ({ o: { id: `t${i}`, kind: "tier", text, tier: "SAB"[i] } as Overlay, start: 1 + i, end: 9 }));
    const ev = overlayEvents(items, L).filter((l) => l.includes("OvTierItem"));
    expect(ev).toHaveLength(9);
    const octane = ev.filter((l) => l.endsWith("Octane"));
    expect(octane[0]).toMatch(/^Dialogue: \d+,0:00:01\.00,/); // staged from the cue
    expect(octane[1]).toMatch(/\\move\(/); // glides
    expect(octane[1]).toMatch(/\\t\(0,\d+,\\fs\d+\)/); // shrinking to its cell size
    expect(octane[2]).toMatch(/,0:00:09\.00,/); // settled until the board ends
  });
});
