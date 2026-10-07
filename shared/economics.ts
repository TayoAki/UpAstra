import { getModel, stepCost } from "./catalog";
import type { AutonomyPolicy, Economics, Generation, RecipeStep } from "./types";

// Price and margin math is plain code, never model judgment.

export const round2 = (n: number) => Math.round(n * 100) / 100;

export function estimateSteps(steps: Pick<RecipeStep, "modelId" | "units">[]): number {
  let total = 0;
  for (const s of steps) {
    const m = getModel(s.modelId);
    if (m) total += stepCost(m, s.units);
  }
  return total;
}

export function computeEconomics(input: {
  price: number;
  channelFeePct: number;
  steps: Pick<RecipeStep, "modelId" | "units">[];
  generations?: Pick<Generation, "actualCost" | "estimatedCost" | "status">[];
  policy: Pick<AutonomyPolicy, "minGrossMargin" | "repairReservePct">;
}): Economics {
  const { price, channelFeePct, steps, generations = [], policy } = input;
  const productionEstimate = estimateSteps(steps);
  const repairReserve = productionEstimate * policy.repairReservePct;
  const actualSpend = generations.reduce(
    (sum, g) => sum + (g.status === "completed" || g.status === "failed" ? (g.actualCost ?? g.estimatedCost) : 0),
    0,
  );
  const channelFee = price * channelFeePct;
  // Once money has been spent, use whichever is larger: what we planned or what we spent.
  const expectedCost = Math.max(productionEstimate + repairReserve, actualSpend);
  const expectedProfit = price - channelFee - expectedCost;
  const expectedMargin = price > 0 ? expectedProfit / price : 0;
  return {
    price: round2(price),
    channelFeePct,
    channelFee: round2(channelFee),
    productionEstimate: round2(productionEstimate),
    repairReserve: round2(repairReserve),
    actualSpend: round2(actualSpend),
    expectedProfit: round2(expectedProfit),
    expectedMargin,
    meetsMinimum: expectedMargin >= policy.minGrossMargin,
  };
}

export const fmtUSD = (n: number) =>
  n < 1 && n > 0
    ? `$${n.toFixed(n < 0.1 ? 3 : 2)}`
    : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n >= 1000 ? 0 : 2 });

export const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;
