import { describe, expect, it } from "vitest";
import { computeEconomics } from "../shared/economics";

const policy = { minGrossMargin: 0.7, repairReservePct: 0.25 };

describe("computeEconomics", () => {
  it("prices a $10 still with a one-cent route like the video example", () => {
    const e = computeEconomics({ price: 10, channelFeePct: 0, steps: [{ modelId: "z-image-turbo", units: 2 }], policy: { ...policy, repairReservePct: 0 } });
    expect(e.productionEstimate).toBe(0.01);
    expect(e.expectedProfit).toBe(9.99);
    expect(e.meetsMinimum).toBe(true);
  });

  it("deducts marketplace channel fees and the repair reserve", () => {
    const e = computeEconomics({ price: 100, channelFeePct: 0.2, steps: [{ modelId: "kling-2.5-pro", units: 5 }], policy });
    expect(e.channelFee).toBe(20);
    expect(e.productionEstimate).toBe(0.7);
    expect(e.repairReserve).toBe(0.18);
    expect(e.expectedProfit).toBeCloseTo(100 - 20 - 0.875, 2);
  });

  it("uses actual spend once it exceeds the plan", () => {
    const e = computeEconomics({
      price: 10,
      channelFeePct: 0,
      steps: [{ modelId: "seedream-4", units: 1 }],
      generations: [{ status: "completed", estimatedCost: 0.03, actualCost: 4 }],
      policy,
    });
    expect(e.actualSpend).toBe(4);
    expect(e.expectedProfit).toBe(6);
    expect(e.meetsMinimum).toBe(false);
  });
});
