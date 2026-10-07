import { describe, expect, it } from "vitest";
import { routeStep } from "../shared/router";

const open = { blockedFamilies: [], blockedOrigins: [] };
const step = (o: Partial<Parameters<typeof routeStep>[0]>) => ({ label: "step", kind: "image" as const, intent: "final" as const, preserve: "product" as const, lane: "product" as const, units: 1, ...o });

describe("routeStep", () => {
  it("picks the cheapest model when exploring", () => {
    expect(routeStep(step({ lane: "explore-image", intent: "explore", units: 10 }), open).modelId).toBe("z-image-turbo");
  });

  it("picks the strongest model for a hero shot and explains why", () => {
    const r = routeStep(step({ kind: "video", lane: "hero-video", units: 5 }), open);
    expect(r.modelId).toBe("kling-2.5-pro");
    expect(r.rationale).toMatch(/hero shot/);
  });

  it("routes words-and-layout work to a typography model", () => {
    expect(routeStep(step({ lane: "typography", preserve: "words" }), open).modelId).toBe("ideogram-v3");
  });

  it("falls back to another lane when policy blocks the lane's models", () => {
    const r = routeStep(step({ kind: "video", lane: "hero-video", units: 5 }), { blockedFamilies: [], blockedOrigins: ["CN"] });
    expect(r.modelId).toBeNull();
    const img = routeStep(step({ lane: "product" }), { blockedFamilies: ["seedream"], blockedOrigins: [] });
    expect(img.modelId).toBe("flux-kontext-pro");
    const repair = routeStep(step({ lane: "repair", intent: "repair" }), { blockedFamilies: ["qwen"], blockedOrigins: [] });
    expect(repair.modelId).not.toBe("qwen-image-edit");
    expect(repair.rationale).toMatch(/Fallback lane/);
  });

  it("never lists a model twice", () => {
    const ids = routeStep(step({ kind: "video", lane: "hero-video", units: 5 }), open).options.map((o) => o.modelId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("orders finishing tools by fit, not quality", () => {
    expect(routeStep(step({ kind: "video", lane: "finishing", intent: "finish", preserve: "words" }), open).modelId).toBe("captions-export");
    expect(routeStep(step({ kind: "video", lane: "finishing", intent: "finish", preserve: "person" }), open).modelId).toBe("lipsync-studio");
  });
});
