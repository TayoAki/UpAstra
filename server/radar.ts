import { getModel, stepCost } from "../shared/catalog";
import { SPAM_PHRASES, copyUnits, words } from "../shared/copy";
import { fmtUSD, round2 } from "../shared/economics";
import { routeStep } from "../shared/router";
import { getTemplate } from "../shared/templates";
import type { AutonomyPolicy, Channel, DeliverableSpec, FirmProfile, IntakeAnalysis, Lead, LeadFit, LeadSource, ProposalDraft, QACheck, SavedSearch } from "../shared/types";
import { analyzeBrief, astraMode, pickTemplate } from "./astra";
import { apifyConfigured, buildInput, defaultActor, normalizeItem, runActor, simulatedItems } from "./apify";
import { chatJSON, modelFor } from "./llm";
import { createJob } from "./pipeline";
import { HttpError, audit, currentWorkspaceId, ensureTenant, getDB, isSimulatedContext, newId, now, runWith, save } from "./store";
import { getBackend } from "./persist";

// Job Radar: scrape marketplace jobs (Apify), score how well each fits the
// firm (service match, budget vs margin, client quality, clarity, competition),
// and draft a proposal for the good ones. Proposals are drafts for a person to
// send — the radar never applies on anyone's behalf.

// ---------------------------------------------------------------------------
// Economics for a job that doesn't exist yet

export function estimateCost(templateId: string, deliverables: DeliverableSpec[], policy: AutonomyPolicy): number {
  const t = getTemplate(templateId);
  const used = new Set<string>();
  let total = 0;
  for (const r of t.recipe) {
    let units = r.units;
    if (r.deliverableId) {
      const d = deliverables.find((x) => x.id === r.deliverableId && !used.has(x.id)) ?? deliverables.find((x) => x.kind === r.kind && !used.has(x.id));
      if (!d) continue;
      used.add(d.id);
      units = d.kind === "text" ? copyUnits(d) : d.kind === "video" ? d.quantity * (d.durationSec ?? 5) : d.quantity;
    }
    const route = routeStep({ ...r, units }, policy);
    const m = route.modelId ? getModel(route.modelId) : undefined;
    if (m) total += stepCost(m, units);
  }
  return round2(total * (1 + policy.repairReservePct) * 1000) / 1000;
}

const SERVICE_SIGNAL = /\b(images?|photos?|photography|pictures?|lifestyle|product shots?|renders?|mockups?|videos?|reels?|ugc|ads?|ad copy|headlines?|copy(?:writ\w*)?|e-?mails?|outreach|sequence|grants?|proposal|loi|letter of (?:inquiry|intent)|funder|posters?|graphics?|creatives?|localiz\w*|franchise|spec sheet|trade ?show)\b/i;
const SCAM = /\b(free (?:test|sample|trial work)|unpaid (?:test|sample)|whats ?app|telegram|contact me (?:on|via) (?:email|skype|whatsapp|telegram)|pay (?:you )?after|crypto payment)\b/i;

function suggestedPrice(lead: Lead, base: number): number {
  const b = lead.budget;
  if (!b) return base;
  if (b.type === "hourly") {
    const rate = b.max ?? b.min ?? 0;
    // Price productized work as a package: assume ~6 billable hours.
    return Math.max(rate * 6, 0);
  }
  return b.max ?? b.min ?? base;
}

const sourceChannel = (s: LeadSource): Channel => (s === "upwork" || s === "fiverr" || s === "contra" ? s : "direct");

export async function scoreLead(lead: Lead, policy: AutonomyPolicy): Promise<LeadFit> {
  const text = `${lead.title}\n${lead.description}`;
  const channel = sourceChannel(lead.source);
  const template = pickTemplate(text);
  const price0 = suggestedPrice(lead, template.basePrice);
  const analysis: IntakeAnalysis = await analyzeBrief({ rawBrief: text, channel, price: price0, referenceAssets: [], clientNotes: "" });
  const t = getTemplate(analysis.templateId);
  const price = suggestedPrice(lead, t.basePrice);
  const cost = estimateCost(t.id, analysis.deliverables, policy);
  const fee = price * (policy.channelFees[channel] ?? 0);
  const margin = price > 0 ? (price - fee - cost) / price : 0;

  const reasons: string[] = [];
  const redFlags: string[] = [];
  const breakdown: LeadFit["breakdown"] = [];
  const add = (label: string, points: number, max: number) => breakdown.push({ label, points: Math.round(Math.max(0, Math.min(points, max))), max });

  // 1. Service fit (30)
  const matchesService = SERVICE_SIGNAL.test(text);
  if (matchesService) {
    add("Service fit", 30, 30);
    reasons.push(`Matches your ${t.name} service`);
  } else {
    add("Service fit", 0, 30);
    redFlags.push("Not a service the firm offers");
  }

  // 2. Budget & margin (25)
  if (!lead.budget) {
    add("Budget & margin", 12, 25);
    reasons.push(`No budget listed — quote ${fmtUSD(t.basePrice)} (your list price)`);
  } else {
    const ratio = price / t.basePrice;
    const pts = margin < policy.minGrossMargin ? 3 : ratio >= 0.5 ? 25 : ratio >= 0.25 ? 15 : ratio >= 0.1 ? 8 : 3;
    add("Budget & margin", pts, 25);
    if (ratio >= 0.5) reasons.push(`Budget ${fmtUSD(price)} supports a ${Math.round(margin * 100)}% margin`);
    else redFlags.push(`Budget ${fmtUSD(price)} is well under your ${fmtUSD(t.basePrice)} list price`);
  }

  // 3. Client quality (20)
  const c = lead.client ?? {};
  const known = [c.paymentVerified, c.totalSpent, c.hireRate, c.rating].some((v) => v !== undefined);
  if (!known) add("Client quality", 10, 20);
  else {
    let pts = 0;
    if (c.paymentVerified) pts += 8;
    else if (c.paymentVerified === false) redFlags.push("Payment method not verified");
    if ((c.totalSpent ?? 0) >= 1000) pts += 6;
    else if ((c.totalSpent ?? 0) > 0) pts += 3;
    if ((c.hireRate ?? 0) >= 50) pts += 3;
    if ((c.rating ?? 0) >= 4.5) pts += 3;
    add("Client quality", pts, 20);
    if (pts >= 14) reasons.push(`Strong client: ${c.paymentVerified ? "verified payment" : ""}${c.totalSpent ? `, ${fmtUSD(c.totalSpent)} spent` : ""}${c.rating ? `, ${c.rating}★` : ""}`.replace(/^: , /, ": "));
  }

  // 4. Clarity (15)
  const missing = analysis.missingInputs.filter((m) => m !== "Deadline").length;
  add("Brief clarity", 15 - missing * 4, 15);
  if (missing === 0) reasons.push("Clear brief — enough to start without guessing");

  // 5. Competition & freshness (10)
  let comp = 0;
  const n = lead.proposalsCount;
  if (n === undefined) comp += 3;
  else if (n < 10) comp += 5;
  else if (n < 20) comp += 3;
  else if (n >= 50) redFlags.push(`${n}+ proposals already`);
  const age = lead.postedAt ? (Date.now() - new Date(lead.postedAt).getTime()) / 3600_000 : undefined;
  if (age === undefined) comp += 2;
  else if (age < 24) comp += 5;
  else if (age < 72) comp += 3;
  add("Competition & freshness", comp, 10);
  if (n !== undefined && n < 10) reasons.push(`Low competition (${n} proposals)`);

  // Hard flags
  for (const r of analysis.risks) if (!/Rush timeline/.test(r)) redFlags.push(r);
  if (/unlimited revisions?/i.test(text)) redFlags.push("Unlimited revisions");
  const scam = SCAM.test(text);
  if (scam) redFlags.push("Off-platform contact or unpaid test work — common scam pattern");
  if (lead.budget && price < 15) redFlags.push("Budget under $15");

  const score = breakdown.reduce((s, b) => s + b.points, 0);
  const blocking = scam || analysis.recommendation === "reject" || !matchesService;
  const verdict: LeadFit["verdict"] = blocking ? "skip" : score >= 70 ? "good" : score >= 45 ? "maybe" : "skip";
  return {
    score,
    verdict,
    templateId: t.id,
    templateName: t.name,
    suggestedPrice: round2(Math.max(price, 0)),
    estimatedCost: cost,
    expectedMargin: margin,
    reasons,
    redFlags: [...new Set(redFlags)],
    breakdown,
    source: analysis.source,
  };
}

// ---------------------------------------------------------------------------
// Proposals

const PROPOSAL_SYSTEM = `You write marketplace proposals (Upwork/Fiverr cover letters) for a small AI-native creative studio.
Write like a sharp human freelancer: open with the client's specific problem in their words, then a concrete plan for THIS job,
one or two proof points (only from the firm profile — never invent clients, numbers or reviews), deliverables + timeline + price,
and end with one smart question. 120–220 words. No "Dear Sir/Madam", no buzzwords, no guarantees, no mention of AI unless the client asks.
Return JSON {"text": "..."}.`;

export function checkProposal(text: string, lead: Lead, fit: LeadFit): QACheck[] {
  const w = words(text);
  const lower = text.toLowerCase();
  const keywords = `${lead.title}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((k) => k.length > 3 && !["need", "with", "looking", "want", "from", "your", "this", "that", "then"].includes(k));
  const spam = SPAM_PHRASES.filter((s) => lower.includes(s));
  return [
    { rule: "120–220 words", pass: w >= 100 && w <= 240, note: `${w} words` },
    { rule: "References the client's actual job", pass: keywords.some((k) => lower.includes(k)), note: keywords.slice(0, 4).join(", ") },
    { rule: "States deliverables, timeline or price", pass: /\$\s?\d|\bdays?\b|\bdeliver/i.test(text) },
    { rule: "Ends with a question", pass: /\?\s*(?:\n.*)?$/.test(text.trim().split("\n").filter(Boolean).slice(-2).join("\n")) || /\?[^?]*$/.test(text.slice(-200)) },
    { rule: "No spam phrases or guarantees", pass: !spam.length && !/\bguarantee/i.test(text), note: spam.join(", ") || undefined },
    { rule: "No generic greeting", pass: !/dear (sir|madam|hiring manager)|to whom it may concern/i.test(text) },
    { rule: `Priced at or above cost (${fmtUSD(fit.estimatedCost)})`, pass: fit.suggestedPrice > fit.estimatedCost },
  ];
}

const OPENERS: Record<string, string> = {
  "cold-email-sequence": "Outbound only works when every email reads like it was written for one person, and each one earns the next.",
  "ad-copy-pack": "Ads fatigue fast; what keeps them working is a steady supply of genuinely different hooks that stay inside platform limits and your approved claims.",
  "grant-proposal": "Funders read stacks of proposals; the ones that get funded tie every number to real program data and speak directly to the funder's priorities.",
  "product-still-pack": "Product images sell when the product looks exactly like the real thing (label, color, shape) in a scene buyers want to be in.",
  "launch-video": "A short product video has about a second to earn attention, so the hook and the product shot have to be planned before anything is rendered.",
  "franchise-localization": "Localizing a campaign is detail work: every address, price and disclaimer has to be right for every location, every time.",
  "always-on-ads": "Creative fatigue is a volume problem: you need new angles every week without the product or claims drifting.",
  "industrial-sku-pack": "Industrial buyers want to see the product working and trust every spec, so accuracy matters as much as the visuals.",
};

function simulatedProposal(lead: Lead, fit: LeadFit, profile: FirmProfile): string {
  const t = getTemplate(fit.templateId);
  const firm = profile.firmName || "our studio";
  const title = lead.title.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s*[—–]\s*/g, ", ").trim();
  const steps = t.recipe.map((r) => r.label.toLowerCase());
  // Only cite proof that relates to this kind of work.
  const topic = `${t.name} ${t.buyer} ${t.deliverables.map((d) => d.label).join(" ")}`.toLowerCase();
  const proof = profile.proofPoints.find((p) => p.toLowerCase().split(/\W+/).some((w) => w.length > 4 && topic.includes(w)));
  const days = t.turnaroundDays;
  return [
    `Hi there,`,
    ``,
    `Your post ("${title}") caught my eye. ${OPENERS[t.id] ?? "Getting the details right matters as much as the look."}`,
    ``,
    `Here's how I'd approach it: ${steps.join(", then ")}. Before you see anything, every piece is checked against your brief (${t.rulebook
      .slice(0, 2)
      .map((r) => r.charAt(0).toLowerCase() + r.slice(1))
      .join("; ")}), so you're reviewing finished work, not rough drafts.${proof ? ` ${proof}.` : ""}`,
    ``,
    `I can deliver everything in your post within ${days} day${days === 1 ? "" : "s"} for ${fmtUSD(fit.suggestedPrice)}, with one round of revisions included.`,
    ``,
    `One question so I can start right away: ${quickQuestion(fit.templateId)}`,
    ``,
    profile.signature || `— ${firm}`,
  ].join("\n");
}

function quickQuestion(templateId: string): string {
  return (
    {
      "cold-email-sequence": "who's the best-fit customer you've closed recently, and what made them say yes?",
      "ad-copy-pack": "which ad is performing best right now, so I can beat it rather than repeat it?",
      "grant-proposal": "could you share the funder's guidelines and your most recent program outcomes?",
      "launch-video": "is there a reference video whose pacing you love?",
      "product-still-pack": "do you have a clean, front-on product photo I can work from?",
      "franchise-localization": "could you share the location sheet so I can confirm every address and price up front?",
    } as Record<string, string>
  )[templateId] ?? "what does a great result look like for you?";
}

export async function draftProposal(lead: Lead): Promise<ProposalDraft> {
  const db = getDB();
  const fit = lead.fit ?? (await scoreLead(lead, db.policy));
  lead.fit = fit;
  let text: string;
  let cost = 0;
  let source: ProposalDraft["source"] = "simulated";
  let model = "simulated";
  if (astraMode() === "live") {
    const t = getTemplate(fit.templateId);
    const r = await chatJSON<{ text: string }>({
      role: "proposal",
      system: PROPOSAL_SYSTEM,
      user: {
        job: { title: lead.title, description: lead.description, budget: lead.budget, skills: lead.skills },
        firm: db.profile,
        service: { name: t.name, deliverables: t.deliverables.map((d) => d.label), turnaroundDays: t.turnaroundDays, howWeWork: t.recipe.map((s) => s.label), qualityRules: t.rulebook },
        price: fit.suggestedPrice,
        mustAsk: quickQuestion(t.id),
      },
    });
    text = r.json.text;
    cost = r.cost ?? 0;
    model = r.model;
    source = "astra";
  } else {
    text = simulatedProposal(lead, fit, db.profile);
    model = modelFor("proposal");
  }
  const draft: ProposalDraft = { text, status: "draft", generatedAt: now(), model, cost, checks: checkProposal(text, lead, fit), source };
  lead.proposal = draft;
  audit({ actor: "astra", type: "message", message: `Proposal drafted for "${lead.title}" (${draft.checks.filter((c) => c.pass).length}/${draft.checks.length} checks pass).`, cost });
  save();
  return draft;
}

// ---------------------------------------------------------------------------
// Searches

const runsToday = new Map<string, { day: string; n: number }>();
const maxRunsPerDay = () => Number(process.env.RADAR_MAX_RUNS_PER_DAY ?? 24);

export async function runSearch(search: SavedSearch): Promise<{ added: number; scanned: number; good: number }> {
  const db = getDB();
  const wsKey = currentWorkspaceId() ?? "test";
  const day = new Date().toISOString().slice(0, 10);
  const counter = runsToday.get(wsKey);
  const n = counter?.day === day ? counter.n : 0;
  if (n >= maxRunsPerDay()) throw new HttpError(429, `Daily radar limit reached (${maxRunsPerDay()} runs).`);
  runsToday.set(wsKey, { day, n: n + 1 });

  const live = apifyConfigured() && !isSimulatedContext();
  const actor = search.actorId || defaultActor(search.source);
  let items: Record<string, unknown>[];
  try {
    if (live) {
      if (!actor) throw new HttpError(400, `No Apify actor set for ${search.source}. Add one to the search or set APIFY_ACTOR_${search.source.toUpperCase()}.`);
      items = await runActor(actor, buildInput(search), search.maxItems);
    } else items = simulatedItems(search);
  } catch (err) {
    search.lastRunAt = now();
    search.lastRunStatus = `Failed: ${(err as Error).message}`;
    save();
    throw err;
  }

  const known = new Set(db.radar.leads.map((l) => `${l.source}:${l.externalId}`));
  const fresh: Lead[] = [];
  for (const raw of items) {
    const lead = normalizeItem(raw, search.source, search.id);
    if (!lead || known.has(`${lead.source}:${lead.externalId}`)) continue;
    known.add(`${lead.source}:${lead.externalId}`);
    lead.fit = await scoreLead(lead, db.policy);
    fresh.push(lead);
  }
  db.radar.leads.unshift(...fresh);
  // Keep the newest 500, but never drop leads someone acted on.
  if (db.radar.leads.length > 500) {
    const keep = db.radar.leads.filter((l, i) => i < 500 || ["shortlisted", "applied", "won"].includes(l.status));
    db.radar.leads = keep;
  }
  let drafted = 0;
  if (search.autoDraft) {
    for (const l of fresh.filter((x) => x.fit?.verdict === "good")) {
      await draftProposal(l);
      drafted++;
    }
  }
  const good = fresh.filter((l) => l.fit?.verdict === "good").length;
  search.lastRunAt = now();
  search.lastRunStatus = `${live ? "Apify" : "Simulated"}: ${items.length} scanned, ${fresh.length} new, ${good} good fit${good === 1 ? "" : "s"}${drafted ? `, ${drafted} proposal${drafted === 1 ? "" : "s"} drafted` : ""}`;
  audit({ actor: "system", type: "intake", message: `Radar "${search.name}" — ${search.lastRunStatus}` });
  save();
  return { added: fresh.length, scanned: items.length, good };
}

export function newSearch(input: Partial<SavedSearch>): SavedSearch {
  const source = (["upwork", "fiverr", "contra", "linkedin", "custom"].includes(String(input.source)) ? input.source : "upwork") as LeadSource;
  return {
    id: newId("srch"),
    name: input.name?.trim() || `${source} — ${input.query ?? "search"}`,
    source,
    actorId: input.actorId?.trim() ?? "",
    input: input.input && typeof input.input === "object" ? input.input : {},
    query: input.query?.trim() ?? "",
    schedule: (["manual", "6h", "12h", "daily"].includes(String(input.schedule)) ? input.schedule : "daily") as SavedSearch["schedule"],
    minScore: Number.isFinite(Number(input.minScore)) ? Math.max(0, Math.min(100, Number(input.minScore))) : 45,
    autoDraft: input.autoDraft !== false,
    maxItems: Math.max(1, Math.min(200, Number(input.maxItems ?? 30))),
    createdAt: now(),
  };
}

export async function convertLeadToJob(lead: Lead) {
  if (lead.jobId) throw new HttpError(409, "Lead already converted");
  const fit = lead.fit ?? (await scoreLead(lead, getDB().policy));
  const job = await createJob({
    title: lead.title.slice(0, 80),
    channel: sourceChannel(lead.source),
    sourceUrl: lead.url,
    rawBrief: lead.description,
    newClientName: `${lead.source[0].toUpperCase()}${lead.source.slice(1)} client — ${lead.title.slice(0, 30)}`,
    price: fit.suggestedPrice,
  });
  lead.jobId = job.id;
  lead.status = "won";
  save();
  return job;
}

// ---------------------------------------------------------------------------
// Scheduler: every few minutes, run due searches in every workspace.

const INTERVAL: Record<SavedSearch["schedule"], number> = { manual: Infinity, "6h": 6 * 3600e3, "12h": 12 * 3600e3, daily: 24 * 3600e3 };

export function startRadarScheduler(everyMs = 5 * 60_000) {
  if (process.env.RADAR_SCHEDULER === "0") return;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const id of await getBackend().listAllWorkspaceIds()) {
        await ensureTenant(id);
        await runWith({ workspaceId: id, actor: "human" }, async () => {
          for (const s of getDB().radar.searches) {
            const due = !s.lastRunAt || Date.now() - new Date(s.lastRunAt).getTime() >= INTERVAL[s.schedule];
            if (!due || s.schedule === "manual") continue;
            await runSearch(s).catch((err) => console.warn(`[radar] ${id}/${s.name}:`, (err as Error).message));
          }
        });
      }
    } finally {
      busy = false;
    }
  };
  setInterval(() => void tick(), everyMs).unref();
}
