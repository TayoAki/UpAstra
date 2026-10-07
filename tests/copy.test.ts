import { beforeEach, describe, expect, it } from "vitest";
import { checkCopy, copyToMarkdown, copyUnits } from "../shared/copy";
import { routeStep } from "../shared/router";
import { GRANT_SECTIONS, getTemplate } from "../shared/templates";
import type { CopySpec } from "../shared/types";
import { setAstraSimulated, simulateIntake } from "../server/astra";
import { simulatedProvider } from "../server/higgsfield";
import { createJob, jobGenerations, resolveCheckpoint, settle, useProvider } from "../server/pipeline";
import { getDB, useMemoryDB } from "../server/store";

const emailSpec = getTemplate("cold-email-sequence").deliverables[0].copy!;
const base = { channel: "upwork" as const, price: 250, referenceAssets: [], clientNotes: "" };

describe("copy intake", () => {
  it("routes cold email, ad copy and grant briefs to copy templates", () => {
    expect(simulateIntake({ ...base, rawBrief: "Need a 5-email cold outreach sequence targeting CFOs at fintechs." }).templateId).toBe("cold-email-sequence");
    expect(simulateIntake({ ...base, rawBrief: "Write 8 Google ads headlines for our dog food." }).templateId).toBe("ad-copy-pack");
    expect(simulateIntake({ ...base, rawBrief: "Grant proposal for the Smith Family Foundation, requesting $50k." }).templateId).toBe("grant-proposal");
  });

  it("extracts sequence length, audience and CTA", () => {
    const a = simulateIntake({ ...base, rawBrief: "Need a 5-email cold outreach sequence for our scheduling software targeting HR managers at mid-size companies. CTA is book a demo. Due by Friday." });
    expect(a.deliverables[0]).toMatchObject({ kind: "text", quantity: 5 });
    expect(a.deliverables[0].copy).toMatchObject({ audience: "HR managers at mid-size companies", offer: "scheduling software", cta: "book a demo" });
    expect(a.missingInputs).not.toContain("Clean product reference photo (front-on, neutral light)");
  });

  it("uses platform character limits for ads", () => {
    const a = simulateIntake({ ...base, rawBrief: "10 Google ads headlines and descriptions for our accounting app, aimed at freelancers." });
    expect(a.deliverables[0].copy?.platform).toBe("Google Search");
    expect(a.deliverables[0].copy?.fields.find((f) => f.key === "headline")?.maxChars).toBe(30);
    expect(a.deliverables[0].quantity).toBe(10);
  });

  it("reads funder, ask and LOI format from a grant brief", () => {
    const a = simulateIntake({ ...base, rawBrief: "Letter of inquiry to the Riverbend Community Foundation requesting $25k for our food pantry. 1,800 children served in 2025." });
    const c = a.deliverables[0].copy!;
    expect(c).toMatchObject({ format: "grant-proposal", funder: "Riverbend Community Foundation", ask: "$25,000" });
    expect(c.fields).toHaveLength(GRANT_SECTIONS.loi.length);
  });
});

describe("checkCopy", () => {
  const good = [
    { subject: "Quick question, {{first_name}}", body: "Hi {{first_name}},\n\nMost HR leads lose hours every week rebuilding shift schedules by hand. We built a tool that does it in minutes, keeps every manager and employee notified automatically, and flags gaps before they turn into overtime.\n\nWorth a 15-minute chat next week?" },
    { subject: "How {{company}} could save Fridays", body: "Hi {{first_name}},\n\nFollowing up with one idea: teams like yours usually start by automating the weekly rota, which frees up the whole Friday afternoon for actual people work instead of chasing swaps over text.\n\nOpen to a quick call on Thursday?" },
  ];

  it("passes clean copy", () => {
    expect(checkCopy(good, emailSpec, { quantity: 2 }).verdict).toBe("ready");
  });

  it("asks for an edit on length, spam and broken merge tags", () => {
    const bad = structuredClone(good);
    bad[0].body = bad[0].body.replace("{{first_name}}", "{{firstname}}") + " Act now!!";
    const r = checkCopy(bad, emailSpec, { quantity: 2 });
    expect(r.verdict).toBe("edit");
    expect(r.fixes.join(" ")).toMatch(/merge tags/);
    expect(r.fixes.join(" ")).toMatch(/spam/i);
  });

  it("escalates unapproved claims to a human", () => {
    const bad = structuredClone(good);
    bad[1].body = bad[1].body.replace("Following up", "Customers see 43% fewer no-shows. Following up");
    expect(checkCopy(bad, emailSpec, { quantity: 2 }).verdict).toBe("human");
    expect(checkCopy(bad, emailSpec, { quantity: 2, approvedClaims: ["43% fewer no-shows"] }).verdict).toBe("ready");
  });

  it("regenerates when hooks repeat", () => {
    const dupes = [good[0], { ...good[0] }];
    expect(checkCopy(dupes, emailSpec, { quantity: 2 }).verdict).toBe("regenerate");
  });

  it("requires every grant statistic to come from the org's data", () => {
    const spec: CopySpec = { format: "grant-proposal", fields: [{ key: "need", label: "Need" }, { key: "objectives", label: "Objectives" }], funder: "Hartwell Foundation", ask: "$75,000" };
    const piece = { need: "Hartwell Foundation can help: we request $75,000. We served 240 students last year.", objectives: "By month 12, every student has a plan." };
    expect(checkCopy([piece], spec, { quantity: 1, sources: "We served 240 students. Requesting $75k." }).verdict).toBe("ready");
    const invented = { ...piece, need: `${piece.need} 78% of students improved.` };
    expect(checkCopy([invented], spec, { quantity: 1, sources: "We served 240 students." }).verdict).toBe("human");
  });

  it("exports markdown", () => {
    expect(copyToMarkdown("Job", "Email sequence", emailSpec, good)).toContain("### Email 2");
  });

  it("prices copy by tokens", () => {
    expect(copyUnits({ quantity: 5, copy: emailSpec })).toBeGreaterThan(1);
  });
});

describe("copy routing", () => {
  it("uses the pro writer for finals, the fast writer to explore and the editor to repair", () => {
    const open = { blockedFamilies: [], blockedOrigins: [] };
    const s = { kind: "text" as const, preserve: "words" as const, units: 2, label: "copy" };
    expect(routeStep({ ...s, lane: "copy", intent: "final" }, open).modelId).toBe("astra-writer-pro");
    expect(routeStep({ ...s, lane: "copy", intent: "explore" }, open).modelId).toBe("astra-writer-fast");
    expect(routeStep({ ...s, lane: "copy-edit", intent: "repair" }, open).modelId).toBe("astra-editor");
  });
});

describe("copy pipeline", () => {
  beforeEach(() => {
    useMemoryDB();
    setAstraSimulated(true);
    useProvider(simulatedProvider(0));
  });

  for (const brief of [
    "Need a 4-email cold outreach sequence for our payroll software targeting finance managers at restaurants. CTA is book a call. Due by Friday.",
    "Need 6 Meta ad copy variations for our barrier cream, aimed at people with sensitive skin. Within 2 days.",
    'Grant proposal requesting $50,000 from the Lakeside Community Foundation for our literacy program called "Read Up". We served 310 children last year across 4 libraries. Due by November 15th.',
  ]) {
    it(`writes, checks and delivers: ${brief.slice(0, 40)}…`, async () => {
      const job = await createJob({ ...base, rawBrief: brief, newClientName: "Org" });
      const accept = job.checkpoints.find((c) => c.kind === "accept-job")!;
      await resolveCheckpoint(job, accept.id, "approved");
      await settle(job);
      for (let i = 0; i < 4; i++) {
        const cp = job.checkpoints.find((c) => c.status === "open" && ["start-production", "qa-escalation"].includes(c.kind));
        if (!cp) break;
        await resolveCheckpoint(job, cp.id, "approved");
        await settle(job);
      }
      expect(job.stage).toBe("approval");
      const final = jobGenerations(job.id).filter((g) => g.deliverableId && g.copy);
      expect(final.length).toBeGreaterThan(0);
      expect(final[0].copy!.length).toBe(job.deliverables[0].copy!.format === "grant-proposal" ? 1 : job.deliverables[0].quantity);
      expect(getDB().generations.every((g) => g.jobId !== job.id || (g.actualCost ?? 0) < 0.2)).toBe(true);
    });
  }
});
