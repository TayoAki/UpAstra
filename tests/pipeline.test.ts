import { beforeEach, describe, expect, it } from "vitest";
import { setAstraSimulated } from "../server/astra";
import { simulatedProvider } from "../server/higgsfield";
import { createJob, jobEconomics, jobGenerations, overrideRoute, receiveClientMessage, resolveCheckpoint, settle, useProvider } from "../server/pipeline";
import { getDB, useMemoryDB } from "../server/store";
import type { Job } from "../shared/types";

const brief = 'Need 2 lifestyle images 1:1 png. Product photo attached. Label must say "ACME". Brand colours #112233. Within 2 days.';

async function approve(job: Job, kind: string) {
  const cp = job.checkpoints.find((c) => c.kind === kind && c.status === "open");
  if (!cp) throw new Error(`no open ${kind}`);
  await resolveCheckpoint(job, cp.id, "approved");
  await settle(job);
}

beforeEach(() => {
  useMemoryDB();
  setAstraSimulated(true);
  useProvider(simulatedProvider(0));
});

describe("pipeline", () => {
  it("runs a job from intake to delivery and records lessons", async () => {
    const job = await createJob({ channel: "upwork", rawBrief: brief, price: 100, newClientName: "Acme", referenceAssets: ["a.png"] });
    expect(job.stage).toBe("review");
    expect(job.steps.length).toBeGreaterThan(0);

    await approve(job, "accept-job");
    for (let i = 0; i < 5 && job.checkpoints.some((c) => c.kind === "qa-escalation" && c.status === "open"); i++) await approve(job, "qa-escalation");
    expect(job.stage).toBe("approval");
    expect(job.deliverables.every((d) => d.outputIds.length >= d.quantity)).toBe(true);

    await approve(job, "final-delivery");
    expect(job.stage).toBe("delivered");
    expect(getDB().lessons.some((l) => l.jobId === job.id)).toBe(true);
    expect(jobEconomics(job).actualSpend).toBeGreaterThan(0);
    expect(getDB().audit.some((a) => a.jobId === job.id && a.type === "generation")).toBe(true);
  });

  it("gates production above the auto-start limit and on the margin floor", async () => {
    const job = await createJob({ channel: "fiverr", rawBrief: brief, price: 0.2, newClientName: "Cheap" });
    await approve(job, "accept-job");
    expect(job.stage).toBe("planned");
    expect(job.checkpoints.find((c) => c.kind === "start-production")?.detail).toMatch(/margin/);
  });

  it("re-prices instantly when the operator overrides a route", async () => {
    const job = await createJob({ channel: "direct", rawBrief: brief, price: 100, newClientName: "X" });
    const step = job.steps.find((s) => s.lane === "product")!;
    const before = jobEconomics(job).productionEstimate;
    overrideRoute(job, step.id, "flux-kontext-pro");
    expect(step.routedBy).toBe("human");
    expect(jobEconomics(job).productionEstimate).toBeGreaterThan(before);
    expect(() => overrideRoute(job, step.id, "kling-2.5-pro")).toThrow(/produces video/);
  });

  it("stops at the spend cap and asks a human", async () => {
    getDB().policy.autoStartBelowCost = 100;
    getDB().policy.requireApproval.acceptJob = false;
    const job = await createJob({ channel: "direct", rawBrief: brief, price: 100, newClientName: "Y", productionBudget: 0.02, referenceAssets: ["a.png"] });
    await approve(job, "start-production").catch(() => undefined);
    await settle(job);
    expect(job.checkpoints.some((c) => c.kind === "budget-limit" && c.status === "open")).toBe(true);
    expect(jobGenerations(job.id).reduce((n, g) => n + (g.actualCost ?? 0), 0)).toBeLessThanOrEqual(0.02);
  });

  it("turns routine client feedback into a revision run, and scope changes into a checkpoint", async () => {
    const job = await createJob({ channel: "direct", rawBrief: brief, price: 100, newClientName: "Z", referenceAssets: ["a.png"] });
    await approve(job, "accept-job");
    for (let i = 0; i < 5 && job.checkpoints.some((c) => c.kind === "qa-escalation" && c.status === "open"); i++) await approve(job, "qa-escalation");
    const gensBefore = jobGenerations(job.id).length;
    await receiveClientMessage(job, "Could you make the background warmer?");
    await settle(job);
    expect(job.revisionCount).toBe(1);
    expect(jobGenerations(job.id).length).toBeGreaterThan(gensBefore);

    await receiveClientMessage(job, "Can we also get 3 more versions in Spanish?");
    expect(job.checkpoints.some((c) => c.kind === "scope-change" && c.status === "open")).toBe(true);
  });
});
