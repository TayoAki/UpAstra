import { beforeEach, describe, expect, it } from "vitest";
import { setAstraSimulated, simulateIntake } from "../server/astra";
import { newSearch, runSearch, scoreLead } from "../server/radar";
import { getDB, useMemoryDB } from "../server/store";
import type { Lead } from "../shared/types";

const lead = (title: string, description: string, extra: Partial<Lead> = {}): Lead => ({
  id: title,
  searchId: "s",
  source: "upwork",
  externalId: title,
  title,
  description,
  budget: { type: "fixed", min: 400, max: 400, currency: "USD" },
  client: { paymentVerified: true, totalSpent: 20000, hireRate: 90, rating: 4.9 },
  proposalsCount: 5,
  postedAt: new Date().toISOString(),
  skills: [],
  status: "new",
  scrapedAt: new Date().toISOString(),
  ...extra,
});

beforeEach(() => {
  useMemoryDB();
  setAstraSimulated(true);
});

describe("radar scoring", () => {
  it("routes emails to the brand's own list to the campaign template, not cold email", () => {
    expect(simulateIntake({ channel: "upwork", price: 300, referenceAssets: [], clientNotes: "", rawBrief: "Email copywriter for our DTC brand: 4 promo emails and a nurture series for our list." }).templateId).toBe("email-campaign");
    expect(simulateIntake({ channel: "upwork", price: 300, referenceAssets: [], clientNotes: "", rawBrief: "Need a 4-email cold outreach sequence to marketing agencies." }).templateId).toBe("cold-email-sequence");
  });

  it("rates a clean deliverable project as a good fit", async () => {
    const fit = await scoreLead(lead("Email copywriter for promo campaign", "Write 4 promo emails for our Black Friday sale to our customer list. Audience: past buyers of our coffee. Feature 20% off bundles. CTA: shop the sale."), getDB().policy);
    expect(fit.templateId).toBe("email-campaign");
    expect(fit.verdict).toBe("good");
  });

  it("never calls an ongoing role or ops-heavy job a good fit, and says why", async () => {
    const role = await scoreLead(lead("In-house email specialist", "This is an in-house, full-time role. Write our cold email copy and join the team."), getDB().policy);
    expect(role.verdict).not.toBe("good");
    expect(role.redFlags.join(" ")).toMatch(/ongoing role/);
    const ops = await scoreLead(lead("Cold email expert", "Write a 3-step cold email sequence, set up Instantly, fix deliverability (SPF, DKIM) and send a weekly report."), getDB().policy);
    expect(ops.verdict).not.toBe("good");
    expect(ops.redFlags.join(" ")).toMatch(/hands-on work the tool doesn't do/);
  });

  it("skips clients who don't want AI work, with a reason", async () => {
    const fit = await scoreLead(lead("Product photos", "Lifestyle product images for our candle shop. No AI please."), getDB().policy);
    expect(fit.verdict).toBe("skip");
    expect(fit.redFlags).toContain("The client doesn't want AI-made work");
  });

  it("doesn't mistake writing or design it doesn't sell for a fit", async () => {
    const blog = await scoreLead(lead("Writer to rewrite blog posts for our SaaS", "Edit and rewrite 10 blog posts for clarity and SEO."), getDB().policy);
    expect(blog.verdict).toBe("skip");
    expect(blog.redFlags.join(" ")).toMatch(/Not a service the firm offers/);
  });

  it("gives every skipped lead a reason", async () => {
    for (const l of [lead("Thesis chair", "University professor needed for a thesis defense."), lead("Telegram wallet", "Fix my wallet, contact me on telegram")]) {
      const fit = await scoreLead(l, getDB().policy);
      if (fit.verdict === "skip") expect(fit.redFlags.length).toBeGreaterThan(0);
    }
  });

  it("doesn't store the same job twice when overlapping searches run at once", async () => {
    const a = newSearch({ name: "a", query: "cold email", maxItems: 10 });
    const b = newSearch({ name: "b", query: "cold email", maxItems: 10 });
    getDB().radar.searches.push(a, b);
    await Promise.all([runSearch(a), runSearch(b)]);
    const keys = getDB().radar.leads.map((l) => `${l.source}:${l.externalId}`);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("email campaign jobs", () => {
  it("writes campaign emails with subject, preview and body that pass copy QA", async () => {
    const { createJob, jobGenerations, settle, resolveCheckpoint, useProvider } = await import("../server/pipeline");
    const { simulatedProvider } = await import("../server/higgsfield");
    useProvider(simulatedProvider(0));
    const job = await createJob({ channel: "upwork", price: 300, newClientName: "Ember", rawBrief: "Write 3 promo emails to our customer list for the Black Friday coffee bundle sale. Audience: past buyers. CTA: shop the sale." });
    expect(job.templateId).toBe("email-campaign");
    for (const kind of ["accept-job", "start-production", "qa-escalation", "qa-escalation"]) {
      const cp = job.checkpoints.find((c) => c.kind === kind && c.status === "open");
      if (cp) await resolveCheckpoint(job, cp.id, "approved");
      await settle(job);
    }
    const final = jobGenerations(job.id).filter((g) => g.copy).at(-1)!;
    expect(final.copy).toHaveLength(3);
    for (const p of final.copy!) expect(Object.keys(p)).toEqual(expect.arrayContaining(["subject", "preview", "body"]));
    expect(final.qa?.checks.find((c) => /within limits/.test(c.rule))?.pass).toBe(true);
  });
});
