import { describe, expect, it } from "vitest";
import { simulateIntake } from "../server/astra";

const base = { channel: "upwork" as const, price: 150, referenceAssets: [], clientNotes: "" };

describe("simulated intake", () => {
  it("extracts formats, aspect, exact copy and deadline", () => {
    const a = simulateIntake({
      ...base,
      rawBrief: 'Need 3 lifestyle images 1:1 png for Amazon. Product photos attached. Label must say "MORO — HOUSE BLEND". Within 3 days.',
    });
    expect(a.templateId).toBe("product-still-pack");
    expect(a.deliverables[0]).toMatchObject({ aspect: "1:1", format: "png", quantity: 3, exactCopy: "MORO — HOUSE BLEND" });
    expect(a.deadline).toMatch(/3 days/);
    expect(a.missingInputs).not.toContain("Clean product reference photo (front-on, neutral light)");
  });

  it("detects video jobs and duration", () => {
    const a = simulateIntake({ ...base, rawBrief: "A 6 second 9:16 mp4 of our perfume bottle. Photo attached. By Friday." });
    expect(a.templateId).toBe("launch-video");
    expect(a.deliverables.find((d) => d.kind === "video")?.durationSec).toBe(6);
  });

  it("does not mistake a duration for a quantity, and only adds a key still when asked", () => {
    const a = simulateIntake({ ...base, rawBrief: "A 5 second vertical video 9:16 mp4, slow pour over ice. Photo attached." });
    expect(a.deliverables).toHaveLength(1);
    expect(a.deliverables[0]).toMatchObject({ kind: "video", quantity: 1, durationSec: 5 });
    const b = simulateIntake({ ...base, rawBrief: "A 5 second video plus a thumbnail. Photo attached." });
    expect(b.deliverables).toHaveLength(2);
  });

  it("does not read an aspect ratio as a count", () => {
    const a = simulateIntake({ ...base, rawBrief: "Need a 15 second 16:9 product demo video of our combi oven for a trade show. Spec sheet attached." });
    expect(a.templateId).toBe("industrial-sku-pack");
    expect(a.deliverables[0]).toMatchObject({ kind: "video", quantity: 1, durationSec: 15, aspect: "16:9" });
  });

  it("only produces what a single-image brief asks for", () => {
    const a = simulateIntake({ ...base, rawBrief: "Need 1 scroll-stopping product image, 3:4 png. Bottle photo attached." });
    expect(a.deliverables).toHaveLength(1);
    expect(a.deliverables[0]).toMatchObject({ quantity: 1, aspect: "3:4" });
  });

  it("asks at most three questions for a vague brief and recommends review", () => {
    const a = simulateIntake({ ...base, rawBrief: "need some cool images for our brand, you decide, unlimited revisions" });
    expect(a.clientQuestions.length).toBeGreaterThan(0);
    expect(a.clientQuestions.length).toBeLessThanOrEqual(3);
    expect(a.recommendation).toBe("review");
    expect(a.revisionRisks.join(" ")).toMatch(/unlimited revisions/);
  });

  it("recommends rejecting likeness-rights work", () => {
    const a = simulateIntake({ ...base, rawBrief: "10 second video where a guy who looks like Drake drinks our energy drink. 9:16." });
    expect(a.recommendation).toBe("reject");
  });
});
