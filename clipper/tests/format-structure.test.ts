import { describe, expect, it } from "vitest";
import { cleanBreakdown, formatForPlanner } from "../server/formats";
import type { ReferenceFormat } from "../shared/types";

// B8.3: a breakdown records what each beat is for and what runs through the
// video; the planner gets that structure as relationships, not seconds.
const RAW = {
  summary: "Reply-to-comment tier list: a viewer's comment sets up a ranking that the creator fills in live.",
  whyItWorks: ["The comment poses a question viewers want answered", "Each item landing is a small payoff"],
  hook: { text: "Ranking every car because @max said Octane is mid", style: "question", seconds: 2.5, visual: "Comment sticker over gameplay" },
  beats: [
    { start: 0, end: 2.5, purpose: "hook", job: "turns a stranger's claim into a challenge", anchor: "overlay", visual: "comment sticker", onScreenText: "octane is mid", narration: "Ranking every car" },
    { start: 2.5, end: 10, purpose: "ranking", job: "pays off one item at a time", anchor: "LINE", visual: "items drop into tiers", narration: "Octane, S tier" },
    { start: 10, end: 13, purpose: "twist", job: "keeps them watching", anchor: "sideways", visual: "surprise pick" },
    { start: 13, end: 15, purpose: "cta", visual: "logo" },
  ],
  systems: [{ name: "tier board", job: "shows progress so viewers stay for the end", how: "stays on screen, items fill in" }, { name: "", job: "nameless" }],
  pacing: { cuts: 9, avgShotSec: 1.6, notes: "fast" },
  captions: { style: "bold-pop", wordsPerCaption: 2, notes: "" },
  overlays: [{ kind: "comment", atSec: 0.2, description: "viewer comment", example: "octane is mid" }, { kind: "tier", atSec: 3, description: "tier items" }],
  voice: { type: "voiceover", tone: "fast, opinionated" },
  cta: { text: "Play now", atSec: 13 },
  lengthSec: 15,
  recipe: "1. Comment hook. 2. Rank. 3. Twist. 4. CTA.",
};

describe("format structure", () => {
  const b = cleanBreakdown(RAW, 15, { wordsPerSec: 3.1, unitsPerSec: 4.2 });

  it("records each beat's job and anchor, the systems that run through it, and the measured pace", () => {
    expect(b.beats.map((x) => [x.purpose, x.job, x.anchor])).toEqual([
      ["hook", "turns a stranger's claim into a challenge", "overlay"],
      ["ranking", "pays off one item at a time", "line"],
      ["twist", "keeps them watching", undefined], // not a known anchor
      ["cta", undefined, undefined],
    ]);
    expect(b.systems).toEqual([{ name: "tier board", job: "shows progress so viewers stay for the end", how: "stays on screen, items fill in" }]);
    expect(b.speech).toEqual({ wordsPerSec: 3.1, unitsPerSec: 4.2 });
    expect(b).toMatchSnapshot();
  });

  it("gives the planner order, shares and jobs instead of seconds, with lenses for missing elements", () => {
    const f = { id: "fmt_1", name: "Tier reply", durationSec: 15, breakdown: b } as ReferenceFormat;
    const p = formatForPlanner(f);
    expect(p.beats.map((x) => x.share)).toEqual([0.17, 0.5, 0.2, 0.13]);
    expect(p.beats.every((x) => !("start" in x) && !("end" in x))).toBe(true);
    expect(p.hook).toEqual({ style: "question", share: 0.17 });
    expect(p.overlays[1]).toMatchObject({ kind: "tier", at: 0.2 });
    expect(p.voice).toMatchObject({ syllablesPerSec: 4.2 });
    expect(p.lenses.join("\n")).toMatch(/tier board.*shows progress/);
    expect(JSON.stringify(p)).not.toMatch(/Octane, S tier|octane is mid"/); // the reference's own words stay out
    expect(p).toMatchSnapshot();
  });

  it("still reads breakdowns made before beats had jobs", () => {
    const old = cleanBreakdown({ ...RAW, beats: RAW.beats.map(({ job: _j, anchor: _a, ...x }) => x), systems: undefined }, 15);
    expect(old.systems).toEqual([]);
    expect(old.speech).toBeUndefined();
    const p = formatForPlanner({ id: "f", name: "x", breakdown: old } as ReferenceFormat);
    expect(p.lenses).toHaveLength(3);
  });
});
