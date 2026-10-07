import { getModel, stepCost } from "../shared/catalog";
import { computeEconomics, fmtPct, fmtUSD, round2 } from "../shared/economics";
import { modelBlockReason, routeStep } from "../shared/router";
import { getTemplate } from "../shared/templates";
import type {
  Channel,
  Checkpoint,
  ClientMemory,
  ClientMessage,
  Deliverable,
  Economics,
  FirmStats,
  Generation,
  Job,
  RecipeStep,
} from "../shared/types";
import {
  analyzeBrief,
  buildPrompt,
  draftDeliveryMessage,
  draftQuestionsMessage,
  qaOutput,
  readClientMessage,
} from "./astra";
import { getProvider, type ProductionProvider } from "./higgsfield";
import { renderCopyProof, writeCopy } from "./writer";
import { copyUnits } from "../shared/copy";
import { HttpError, audit, currentActor, findClient, getDB, newId, now, save, touch } from "./store";

// The production engine: moves a job through intake → plan → production → QA
// → approval → delivery, enforcing the autonomy policy at every step and
// writing every decision, generation and cost to the audit log.

let providerOverride: ProductionProvider | null = null;
export const useProvider = (p: ProductionProvider | null) => (providerOverride = p);
const provider = () => providerOverride ?? getProvider();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Queries

export const jobGenerations = (jobId: string) => getDB().generations.filter((g) => g.jobId === jobId);

export function jobEconomics(job: Job): Economics {
  const policy = getDB().policy;
  return computeEconomics({
    price: job.price,
    channelFeePct: policy.channelFees[job.channel] ?? 0,
    steps: job.steps,
    generations: jobGenerations(job.id),
    policy,
  });
}

const spendOf = (gens: Generation[]) => gens.reduce((n, g) => n + (g.actualCost ?? (g.status === "completed" ? g.estimatedCost : 0)), 0);
const repairSpend = (job: Job) => spendOf(jobGenerations(job.id).filter((g) => g.purpose === "edit" || g.purpose === "regenerate"));
const spendCap = (job: Job) => job.productionBudget ?? getDB().policy.maxSpendPerJob;

export function firmStats(): FirmStats {
  const db = getDB();
  const active = db.jobs.filter((j) => !["delivered", "rejected"].includes(j.stage));
  return {
    activeJobs: active.length,
    pipelineValue: round2(active.reduce((n, j) => n + j.price, 0)),
    estimatedGrossProfit: round2(active.reduce((n, j) => n + jobEconomics(j).expectedProfit, 0)),
    needsAttention: db.jobs.filter((j) => j.checkpoints.some((c) => c.status === "open")).length,
    deliveredRevenue: round2(db.jobs.filter((j) => j.stage === "delivered").reduce((n, j) => n + j.price, 0)),
    spendToDate: round2(spendOf(db.generations)),
  };
}

// ---------------------------------------------------------------------------
// Checkpoints and messages

function openCheckpoint(job: Job, kind: Checkpoint["kind"], title: string, detail: string, payload?: Record<string, unknown>) {
  const unique = !["qa-escalation", "client-message", "scope-change"].includes(kind);
  if (unique) {
    const existing = job.checkpoints.find((c) => c.kind === kind && c.status === "open");
    if (existing) {
      Object.assign(existing, { title, detail, payload });
      return existing;
    }
  }
  const cp: Checkpoint = { id: newId("cp"), kind, title, detail, status: "open", createdAt: now(), payload };
  job.checkpoints.push(cp);
  audit({ jobId: job.id, actor: "system", type: "approval", message: `Human checkpoint opened: ${title}` });
  touch(job);
  return cp;
}

function addMessage(job: Job, m: Omit<ClientMessage, "id" | "at">) {
  const msg: ClientMessage = { id: newId("msg"), at: now(), ...m };
  job.messages.push(msg);
  touch(job);
  return msg;
}

function sendMessage(job: Job, msg: ClientMessage) {
  msg.status = "sent";
  msg.at = now();
  audit({ jobId: job.id, actor: "human", type: "message", message: `Message sent to client: "${msg.body.slice(0, 80)}${msg.body.length > 80 ? "…" : ""}"` });
}

// ---------------------------------------------------------------------------
// Intake

export interface NewJobInput {
  title?: string;
  channel: Channel;
  sourceUrl?: string;
  rawBrief: string;
  referenceAssets?: string[];
  clientNotes?: string;
  clientId?: string;
  newClientName?: string;
  price: number;
  productionBudget?: number;
}

export async function createJob(input: NewJobInput): Promise<Job> {
  const db = getDB();
  if (!input.rawBrief?.trim()) throw new HttpError(400, "A brief is required");
  if (!(input.price >= 0)) throw new HttpError(400, "Price must be a positive number");

  let client = input.clientId ? findClient(input.clientId) : undefined;
  if (!client) {
    client = {
      id: newId("cl"),
      name: input.newClientName?.trim() || "New client",
      contact: "",
      logo: "",
      colors: [],
      fonts: [],
      likes: [],
      rejectedStyles: [],
      approvedClaims: [],
      notes: "",
    };
    db.clients.push(client);
    audit({ actor: "system", type: "memory", message: `Client record created: ${client.name}` });
  }

  const job: Job = {
    id: newId("job"),
    title: input.title?.trim() || input.rawBrief.trim().split("\n")[0].slice(0, 60),
    clientId: client.id,
    channel: input.channel,
    sourceUrl: input.sourceUrl,
    rawBrief: input.rawBrief,
    referenceAssets: input.referenceAssets ?? [],
    clientNotes: input.clientNotes ?? "",
    templateId: "",
    stage: "intake",
    price: input.price,
    productionBudget: input.productionBudget || undefined,
    deliverables: [],
    steps: [],
    checkpoints: [],
    messages: [],
    revisionCount: 0,
    createdAt: now(),
    updatedAt: now(),
  };
  db.jobs.push(job);
  addMessage(job, { direction: "inbound", body: input.rawBrief, status: "received" });
  audit({ jobId: job.id, actor: "human", type: "intake", message: `Job created from ${input.channel}${input.sourceUrl ? ` (${input.sourceUrl})` : ""} at ${fmtUSD(job.price)}` });

  await analyzeJob(job, client);
  return job;
}

async function analyzeJob(job: Job, client: ClientMemory) {
  const policy = getDB().policy;
  const analysis = await analyzeBrief({
    rawBrief: job.rawBrief,
    channel: job.channel,
    price: job.price,
    referenceAssets: job.referenceAssets,
    clientNotes: job.clientNotes,
    client,
  });
  job.analysis = analysis;
  job.templateId = analysis.templateId;
  job.deadline = analysis.deadline;
  job.deliverables = analysis.deliverables.map((d) => ({ ...d, status: "pending", outputIds: [] }));
  job.stage = "review";
  audit({
    jobId: job.id,
    actor: "astra",
    type: "intake",
    message: `Brief analysed → ${getTemplate(analysis.templateId).name}; ${analysis.missingInputs.length} missing input(s), ${analysis.risks.length} risk(s). Recommends: ${analysis.recommendation.toUpperCase()}.`,
  });

  // Plan immediately so the economics are visible before anyone commits.
  planJob(job);

  if (analysis.clientQuestions.length) {
    const draft = addMessage(job, { direction: "outbound", body: draftQuestionsMessage(analysis.clientQuestions, client), status: "draft" });
    openCheckpoint(job, "client-questions", "Send clarifying questions", `${analysis.clientQuestions.length} question(s) drafted by Astra.`, { messageId: draft.id });
  }

  const econ = jobEconomics(job);
  if (analysis.recommendation !== "accept" || policy.requireApproval.acceptJob || !econ.meetsMinimum) {
    openCheckpoint(
      job,
      "accept-job",
      analysis.recommendation === "reject" ? "Astra recommends declining" : "Accept this job?",
      `${analysis.reasoning} Expected margin ${fmtPct(econ.expectedMargin)} (${fmtUSD(econ.expectedProfit)} profit).`,
    );
  } else {
    audit({ jobId: job.id, actor: "astra", type: "decision", message: "Auto-accepted under autonomy policy." });
    await acceptJob(job);
  }
  touch(job);
}

// ---------------------------------------------------------------------------
// Planning and routing (prompt 4)

function planJob(job: Job) {
  const template = getTemplate(job.templateId);
  const policy = getDB().policy;
  const used = new Set<string>();
  const steps: RecipeStep[] = [];

  for (const r of template.recipe) {
    let deliverable: Deliverable | undefined;
    if (r.deliverableId) {
      deliverable =
        job.deliverables.find((d) => d.id === r.deliverableId && !used.has(d.id)) ??
        job.deliverables.find((d) => d.kind === r.kind && !used.has(d.id));
      if (!deliverable) continue;
      used.add(deliverable.id);
    }
    const units = deliverable ? deliverableUnits(deliverable) : r.units;
    steps.push({ ...r, deliverableId: deliverable?.id, units, modelId: "", routedBy: "astra", rationale: "", attempts: 0, status: "pending" });
  }
  // Any deliverable the template didn't anticipate still gets a final step.
  for (const d of job.deliverables.filter((d) => !used.has(d.id))) {
    steps.push({
      id: `extra-${d.id}`,
      label: `Render ${d.label}`,
      deliverableId: d.id,
      kind: d.kind,
      intent: "final",
      preserve: "product",
      lane: d.kind === "video" ? "hero-video" : d.kind === "text" ? "copy" : "product",
      units: deliverableUnits(d),
      modelId: "",
      routedBy: "astra",
      rationale: "",
      attempts: 0,
      status: "pending",
    });
  }
  for (const s of steps) applyRoute(s, policy);
  job.steps = steps;
  const econ = jobEconomics(job);
  audit({
    jobId: job.id,
    actor: "astra",
    type: "route",
    message: `Production route proposed: ${steps.length} steps, est. ${fmtUSD(econ.productionEstimate)} (+${fmtUSD(econ.repairReserve)} repair reserve).`,
    cost: econ.productionEstimate,
  });
}

function deliverableUnits(d: Deliverable): number {
  if (d.kind === "text") return copyUnits(d);
  return d.kind === "video" ? d.quantity * (d.durationSec ?? 5) : d.quantity;
}

function applyRoute(step: RecipeStep, policy = getDB().policy) {
  const decision = routeStep(step, policy);
  step.modelId = decision.modelId ?? "";
  step.rationale = decision.rationale;
  step.routedBy = "astra";
  if (!decision.modelId) step.status = "blocked";
  else if (step.status === "blocked") step.status = "pending";
}

/** Re-route every pending, Astra-routed step (e.g. after the policy changes). */
export function rerouteOpenJobs() {
  for (const job of getDB().jobs) {
    if (!["review", "planned", "qa", "revision"].includes(job.stage)) continue;
    let changed = false;
    for (const s of job.steps) {
      if ((s.status === "pending" || s.status === "blocked") && s.routedBy === "astra") {
        const before = s.modelId;
        applyRoute(s);
        if (s.modelId !== before) changed = true;
      } else if (s.status === "pending" && s.routedBy === "human") {
        const m = getModel(s.modelId);
        if (m && modelBlockReason(m, getDB().policy)) {
          applyRoute(s);
          changed = true;
        }
      }
    }
    if (changed) {
      audit({ jobId: job.id, actor: "astra", type: "route", message: "Route updated after autonomy policy change." });
      touch(job);
    }
  }
}

export function overrideRoute(job: Job, stepId: string, modelId: string | null) {
  const step = job.steps.find((s) => s.id === stepId);
  if (!step) throw new HttpError(404, "Step not found");
  if (step.status !== "pending" && step.status !== "blocked") throw new HttpError(409, "Only pending steps can be re-routed");
  const before = jobEconomics(job);
  if (modelId === null) {
    applyRoute(step);
  } else {
    const model = getModel(modelId);
    if (!model) throw new HttpError(400, "Unknown model");
    if (model.kind !== step.kind && step.lane !== "finishing") throw new HttpError(400, `${model.name} produces ${model.kind}, step needs ${step.kind}`);
    const blocked = modelBlockReason(model, getDB().policy);
    if (blocked) throw new HttpError(400, `${model.name}: ${blocked}`);
    const suggested = routeStep(step, getDB().policy).modelId;
    step.modelId = model.id;
    step.routedBy = "human";
    step.status = "pending";
    step.rationale = `Operator override${suggested && suggested !== model.id ? ` (Astra suggested ${getModel(suggested)?.name})` : ""}. ${model.strengths} Watch out: ${model.watchOuts}`;
  }
  const after = jobEconomics(job);
  audit({
    jobId: job.id,
    actor: modelId ? "human" : "astra",
    type: "route",
    message: `${step.label} → ${getModel(step.modelId)?.name ?? "none"}. Estimate ${fmtUSD(before.productionEstimate)} → ${fmtUSD(after.productionEstimate)}, margin ${fmtPct(before.expectedMargin)} → ${fmtPct(after.expectedMargin)}.`,
  });
  touch(job);
}

// ---------------------------------------------------------------------------
// Accept → production gate

export async function acceptJob(job: Job) {
  if (!["review", "intake"].includes(job.stage)) throw new HttpError(409, `Job is ${job.stage}`);
  job.stage = "planned";
  for (const c of job.checkpoints) if (c.kind === "accept-job" && c.status === "open") Object.assign(c, { status: "approved", resolvedAt: now() });
  audit({ jobId: job.id, actor: "human", type: "decision", message: "Job accepted." });
  await gateProduction(job);
}

async function gateProduction(job: Job) {
  const policy = getDB().policy;
  const econ = jobEconomics(job);
  const reasons: string[] = [];
  if (job.steps.some((s) => s.status === "blocked")) reasons.push("a step has no allowed model");
  if (econ.productionEstimate > policy.autoStartBelowCost) reasons.push(`estimate ${fmtUSD(econ.productionEstimate)} is above the ${fmtUSD(policy.autoStartBelowCost)} auto-start limit`);
  if (econ.productionEstimate + econ.repairReserve > spendCap(job)) reasons.push(`estimate + reserve exceeds the ${fmtUSD(spendCap(job))} job cap`);
  if (!econ.meetsMinimum) reasons.push(`expected margin ${fmtPct(econ.expectedMargin)} is below the ${fmtPct(policy.minGrossMargin)} minimum`);
  if (reasons.length) {
    openCheckpoint(job, "start-production", "Approve production spend", `Needs a human because ${reasons.join("; ")}.`);
    touch(job);
    return;
  }
  audit({ jobId: job.id, actor: "astra", type: "decision", message: `Production auto-started (est. ${fmtUSD(econ.productionEstimate)}, margin ${fmtPct(econ.expectedMargin)}).` });
  await startProduction(job);
}

export async function startProduction(job: Job, opts: { await?: boolean } = {}) {
  if (job.running) return;
  if (job.steps.some((s) => s.status === "blocked")) throw new HttpError(409, "Resolve blocked steps first (unblock a model family or override the route)");
  job.stage = job.revisionCount > 0 && job.stage === "revision" ? "revision" : "production";
  job.running = true;
  touch(job);
  const run = runProduction(job).catch((err) => {
    job.running = false;
    audit({ jobId: job.id, actor: "system", type: "policy", message: `Production stopped: ${(err as Error).message}` });
    job.stage = "qa";
    touch(job);
  });
  if (opts.await) await run;
}

// ---------------------------------------------------------------------------
// Production (prompts 3 & 5)

async function runProduction(job: Job) {
  for (const step of job.steps) {
    if (step.status !== "pending" && step.status !== "failed") continue;
    const model = getModel(step.modelId);
    const blocked = model ? modelBlockReason(model, getDB().policy) : "no model routed";
    if (blocked) {
      step.status = "blocked";
      audit({ jobId: job.id, actor: "system", type: "policy", message: `${step.label} blocked: ${blocked}` });
      break;
    }
    const outcome = await runStep(job, step);
    if (outcome === "halt") break;
  }
  job.running = false;
  finalize(job);
}

async function runStep(job: Job, step: RecipeStep): Promise<"ok" | "halt"> {
  step.status = "running";
  touch(job);
  const d = job.deliverables.find((x) => x.id === step.deliverableId);
  if (!d) {
    const purpose = step.intent === "finish" ? "finish" : "generate";
    if (!withinBudget(job, step.modelId, step.units, step.label)) return halt(step);
    const g = await generate(job, step, { modelId: step.modelId, units: step.units, purpose, attempt: 1 });
    step.attempts = 1;
    step.status = g.status === "completed" ? "done" : "failed";
    touch(job);
    return "ok";
  }

  d.status = "generating";
  // A text deliverable is written in one pass (a sequence or a set of variants must hang together).
  const perItem = d.kind === "video" ? (d.durationSec ?? 5) : d.kind === "text" ? step.units : 1;
  const needed = itemsNeeded(d) - d.outputIds.length;
  for (let i = 0; i < needed; i++) {
    const r = await produceItem(job, step, d, perItem);
    if (r === "halt") return halt(step);
  }
  step.status = "done";
  step.feedback = undefined;
  d.status = d.outputIds.length >= itemsNeeded(d) ? "ready" : "needs-human";
  touch(job);
  return "ok";
}

/** Outputs a deliverable needs: one per image/video, one per text deliverable (pieces live inside it). */
export const itemsNeeded = (d: Pick<Deliverable, "kind" | "quantity">) => (d.kind === "text" ? 1 : d.quantity);

function halt(step: RecipeStep): "halt" {
  step.status = "pending";
  return "halt";
}

function withinBudget(job: Job, modelId: string, units: number, label: string): boolean {
  const model = getModel(modelId)!;
  const cost = stepCost(model, units);
  const spent = spendOf(jobGenerations(job.id));
  if (spent + cost <= spendCap(job)) return true;
  openCheckpoint(
    job,
    "budget-limit",
    "Spend limit reached",
    `"${label}" on ${model.name} would cost ${fmtUSD(cost)}; ${fmtUSD(spent)} already spent against a ${fmtUSD(spendCap(job))} cap.`,
    { needed: round2(spent + cost - spendCap(job)) },
  );
  audit({ jobId: job.id, actor: "system", type: "policy", message: `Spend cap hit before "${label}" — paused for a human.` });
  return false;
}

async function produceItem(job: Job, step: RecipeStep, d: Deliverable, units: number): Promise<"ok" | "halt"> {
  const policy = getDB().policy;
  const template = getTemplate(job.templateId);
  const client = findClient(job.clientId);
  let attempt = 1;
  let modelId = step.modelId;
  let purpose: Generation["purpose"] = "generate";
  let sourceUrl: string | undefined;
  let previous: Generation | undefined;

  for (;;) {
    if (!withinBudget(job, modelId, units, step.label)) return "halt";
    step.attempts = Math.max(step.attempts, attempt);
    const g = await generate(job, step, { modelId, units, purpose, attempt, sourceUrl, deliverable: d, previous });
    if (g.status === "failed") {
      if (attempt >= policy.maxAttemptsPerStep) return escalate(job, d, g, `Provider failed ${attempt}× (${g.error ?? "unknown error"}).`);
      attempt++;
      purpose = "regenerate";
      continue;
    }

    d.status = "qa";
    const qa = await qaOutput({ generation: g, job, template, client });
    g.qa = qa;
    audit({
      jobId: job.id,
      actor: "astra",
      type: "qa",
      message: `QA ${qa.verdict.toUpperCase()} (${qa.score}) on ${d.label} attempt ${attempt}: ${qa.summary}`,
    });
    touch(job);

    if (qa.verdict === "ready") {
      d.outputIds.push(g.id);
      return "ok";
    }
    if (qa.verdict === "human") return escalate(job, d, g, qa.summary);

    // Controlled repair.
    if (attempt >= policy.maxAttemptsPerStep) return escalate(job, d, g, `Still failing after ${attempt} attempts: ${qa.summary}`);
    let repairModel = step.modelId;
    if (qa.verdict === "edit" && (d.kind === "image" || d.kind === "text")) {
      const lane = d.kind === "text" ? "copy-edit" : "repair";
      const r = routeStep({ lane, kind: d.kind, intent: "repair", preserve: step.preserve, units, label: "repair" }, policy);
      if (r.modelId) repairModel = r.modelId;
    }
    const repairCost = stepCost(getModel(repairModel)!, units);
    if (repairCost > policy.maxRepairCostPerAttempt) return escalate(job, d, g, `Repair would cost ${fmtUSD(repairCost)}, above the ${fmtUSD(policy.maxRepairCostPerAttempt)} per-attempt limit.`);
    if (repairSpend(job) + repairCost > policy.maxRepairSpendPerJob) return escalate(job, d, g, `Repair budget for this job (${fmtUSD(policy.maxRepairSpendPerJob)}) would be exceeded.`);

    purpose = qa.verdict === "edit" && repairModel !== step.modelId ? "edit" : "regenerate";
    sourceUrl = purpose === "edit" ? g.outputUrl : undefined;
    previous = g;
    modelId = repairModel;
    attempt++;
    audit({
      jobId: job.id,
      actor: "astra",
      type: "repair",
      message: `${purpose === "edit" ? "Controlled edit" : "Regenerating"} ${d.label} with ${getModel(repairModel)?.name} (attempt ${attempt}, ${fmtUSD(repairCost)}).`,
    });
  }
}

function escalate(job: Job, d: Deliverable, g: Generation, reason: string): "ok" {
  d.status = "needs-human";
  openCheckpoint(job, "qa-escalation", `QA needs a decision: ${d.label}`, reason, { generationId: g.id, deliverableId: d.id });
  return "ok";
}

async function generate(
  job: Job,
  step: RecipeStep,
  o: { modelId: string; units: number; purpose: Generation["purpose"]; attempt: number; sourceUrl?: string; deliverable?: Deliverable; previous?: Generation },
): Promise<Generation> {
  if (step.kind === "text") return generateCopy(job, step, o);
  const p = provider();
  const model = getModel(o.modelId)!;
  const client = findClient(job.clientId);
  const g: Generation = {
    id: newId("gen"),
    jobId: job.id,
    stepId: step.id,
    deliverableId: o.deliverable?.id,
    modelId: o.modelId,
    prompt: buildPrompt(step, job, client, step.feedback),
    attempt: o.attempt,
    purpose: o.purpose,
    status: "queued",
    estimatedCost: round2(stepCost(model, o.units) * 1000) / 1000,
    createdAt: now(),
  };
  getDB().generations.push(g);
  touch(job);

  try {
    const { requestId } = await p.submit({
      modelId: o.modelId,
      prompt: g.prompt,
      units: o.units,
      aspect: o.deliverable?.aspect ?? (step.kind === "video" ? "9:16" : "1:1"),
      durationSec: o.deliverable?.durationSec,
      referenceUrls: job.referenceAssets.filter((a) => /^https?:/.test(a)),
      sourceUrl: o.sourceUrl,
      label: o.deliverable ? `${o.deliverable.label}${o.attempt > 1 ? ` · v${o.attempt}` : ""}` : step.label,
      palette: client?.colors ?? [],
      kind: step.kind,
    });
    g.providerRequestId = requestId;
    g.status = "running";
    touch(job);

    const deadline = Date.now() + 15 * 60_000;
    for (;;) {
      const r = await p.check(requestId);
      if (r.status === "completed" || r.status === "failed") {
        g.status = r.status;
        g.outputUrl = r.outputUrl;
        g.actualCost = r.cost ?? (r.status === "completed" ? g.estimatedCost : 0);
        g.error = r.error;
        break;
      }
      if (Date.now() > deadline) throw new Error("generation timed out");
      await sleep(p.mode === "simulated" ? 120 : 3000);
    }
  } catch (err) {
    g.status = "failed";
    g.error = (err as Error).message;
    g.actualCost = 0;
  }
  g.completedAt = now();
  audit({
    jobId: job.id,
    actor: "higgsfield",
    type: "generation",
    message: `${g.status === "completed" ? "Generated" : "Failed"}: ${o.deliverable?.label ?? step.label} on ${model.name}${g.error ? ` — ${g.error}` : ""}`,
    cost: g.actualCost,
  });
  touch(job);
  return g;
}

async function generateCopy(
  job: Job,
  step: RecipeStep,
  o: { modelId: string; units: number; purpose: Generation["purpose"]; attempt: number; deliverable?: Deliverable; previous?: Generation },
): Promise<Generation> {
  const model = getModel(o.modelId)!;
  const client = findClient(job.clientId);
  const g: Generation = {
    id: newId("gen"),
    jobId: job.id,
    stepId: step.id,
    deliverableId: o.deliverable?.id,
    modelId: o.modelId,
    prompt: buildPrompt(step, job, client, step.feedback),
    attempt: o.attempt,
    purpose: o.purpose,
    status: "running",
    estimatedCost: round2(stepCost(model, o.units) * 1000) / 1000,
    createdAt: now(),
  };
  getDB().generations.push(g);
  touch(job);
  try {
    const r = await writeCopy({
      catalogId: o.modelId,
      job,
      client,
      deliverable: o.deliverable,
      purpose: o.purpose === "finish" ? "generate" : o.purpose,
      attempt: o.attempt,
      previous: o.previous?.copy,
      fixes: o.previous?.qa?.fixes,
      feedback: step.feedback,
      seed: `${job.id}:${step.id}:${o.attempt}`,
    });
    g.copy = r.pieces;
    g.status = r.pieces.length ? "completed" : "failed";
    g.actualCost = r.cost;
    if (!r.pieces.length) g.error = "writer returned no copy";
    const first = r.pieces[0] ?? {};
    g.outputUrl = renderCopyProof(o.deliverable?.label ?? step.label, Object.values(first).flatMap((v) => v.split("\n")).filter(Boolean), client?.colors ?? []);
  } catch (err) {
    g.status = "failed";
    g.error = (err as Error).message;
    g.actualCost = 0;
  }
  g.completedAt = now();
  audit({
    jobId: job.id,
    actor: "astra",
    type: "generation",
    message: `${g.status === "completed" ? (o.purpose === "edit" ? "Edited" : "Wrote") : "Failed"}: ${o.deliverable?.label ?? step.label} with ${model.name}${g.copy ? ` (${g.copy.length} piece${g.copy.length === 1 ? "" : "s"})` : ""}${g.error ? ` — ${g.error}` : ""}`,
    cost: g.actualCost,
  });
  touch(job);
  return g;
}

function finalize(job: Job) {
  const needsHuman = job.deliverables.some((d) => d.status === "needs-human") || job.steps.some((s) => s.status === "blocked");
  const halted = job.steps.some((s) => s.status === "pending");
  const allReady = job.deliverables.length > 0 && job.deliverables.every((d) => d.outputIds.length >= itemsNeeded(d));
  if (allReady && !halted && !needsHuman) {
    job.stage = "approval";
    const client = findClient(job.clientId);
    const draft = addMessage(job, { direction: "outbound", body: draftDeliveryMessage(job, client), status: "draft" });
    const econ = jobEconomics(job);
    openCheckpoint(
      job,
      "final-delivery",
      "Approve final delivery",
      `All ${job.deliverables.length} deliverable(s) passed QA. Spent ${fmtUSD(econ.actualSpend)}; expected margin ${fmtPct(econ.expectedMargin)}.`,
      { messageId: draft.id },
    );
  } else {
    job.stage = "qa";
  }
  touch(job);
}

// ---------------------------------------------------------------------------
// Human decisions

/** Agents (MCP clients) may only resolve the checkpoint kinds the policy allows — never final delivery. */
export function assertAgentMay(kind: Checkpoint["kind"]) {
  if (currentActor() !== "agent") return;
  if (kind === "final-delivery" || !getDB().policy.agentMayResolve.includes(kind))
    throw new HttpError(403, `"${kind}" checkpoints are reserved for a human. Ask the operator to decide in the Studio Operator UI.`);
}

export async function resolveCheckpoint(job: Job, cpId: string, decision: "approved" | "rejected", note?: string) {
  const cp = job.checkpoints.find((c) => c.id === cpId);
  if (!cp) throw new HttpError(404, "Checkpoint not found");
  if (cp.status !== "open") throw new HttpError(409, "Checkpoint already resolved");
  assertAgentMay(cp.kind);
  cp.status = decision;
  cp.resolvedAt = now();
  audit({ jobId: job.id, actor: "human", type: "approval", message: `${decision === "approved" ? "Approved" : "Rejected"}: ${cp.title}${note ? ` — ${note}` : ""}` });
  const msg = (id: unknown) => job.messages.find((m) => m.id === id);

  switch (cp.kind) {
    case "accept-job":
      if (decision === "approved") await acceptJob(job);
      else {
        job.stage = "rejected";
        addMessage(job, {
          direction: "outbound",
          body: "Thanks for considering us — this one isn't a fit for our studio, but we'd love to help with a future project.",
          status: "draft",
        });
      }
      break;
    case "client-questions":
    case "client-message": {
      const m = msg(cp.payload?.messageId);
      if (m && decision === "approved") sendMessage(job, m);
      else if (m) job.messages = job.messages.filter((x) => x !== m);
      break;
    }
    case "start-production":
      if (decision === "approved") await startProduction(job);
      break;
    case "budget-limit":
      if (decision === "approved") {
        const needed = Number(cp.payload?.needed ?? 0);
        job.productionBudget = round2(spendCap(job) + Math.max(needed, 1));
        audit({ jobId: job.id, actor: "human", type: "policy", message: `Job spend cap raised to ${fmtUSD(job.productionBudget)}.` });
        await startProduction(job);
      } else job.stage = "qa";
      break;
    case "qa-escalation": {
      const d = job.deliverables.find((x) => x.id === cp.payload?.deliverableId);
      const step = job.steps.find((s) => s.deliverableId === d?.id);
      if (!d || !step) break;
      if (decision === "approved") {
        d.outputIds.push(String(cp.payload?.generationId));
        d.status = d.outputIds.length >= itemsNeeded(d) ? "ready" : "pending";
        if (d.outputIds.length < itemsNeeded(d)) step.status = "pending";
      } else {
        d.status = "pending";
        step.status = "pending";
        step.feedback = note || step.feedback;
      }
      const open = job.checkpoints.some((c) => c.kind === "qa-escalation" && c.status === "open");
      if (!open) {
        if (job.steps.some((s) => s.status === "pending")) await startProduction(job);
        else finalize(job);
      }
      break;
    }
    case "final-delivery":
      if (decision === "approved") deliver(job, msg(cp.payload?.messageId));
      else {
        job.stage = "qa";
        const m = msg(cp.payload?.messageId);
        if (m) job.messages = job.messages.filter((x) => x !== m);
      }
      break;
    case "scope-change": {
      const m = msg(cp.payload?.messageId);
      if (decision === "approved") {
        const delta = Number(cp.payload?.priceDelta ?? 0);
        job.price = round2(job.price + delta);
        audit({ jobId: job.id, actor: "human", type: "decision", message: `Scope change accepted; price +${fmtUSD(delta)} → ${fmtUSD(job.price)}.` });
        if (m) sendMessage(job, m);
        await reviseDeliverable(job, String(cp.payload?.targetDeliverableId ?? ""), String(cp.payload?.request ?? ""));
      } else if (m) {
        m.body = "Thanks for the note — that's outside what we scoped for this job, so we'll keep to the original deliverables for now. Happy to quote it separately.";
        sendMessage(job, m);
      }
      break;
    }
  }
  touch(job);
}

function deliver(job: Job, message?: ClientMessage) {
  job.stage = "delivered";
  for (const d of job.deliverables) {
    d.status = "approved";
    d.approvedOutputId = d.outputIds[d.outputIds.length - 1];
  }
  if (message) sendMessage(job, message);
  const econ = jobEconomics(job);
  audit({
    jobId: job.id,
    actor: "human",
    type: "delivery",
    message: `Delivered. Revenue ${fmtUSD(job.price)}, spend ${fmtUSD(econ.actualSpend)}, fees ${fmtUSD(econ.channelFee)}.`,
  });
  recordLessons(job);
}

/** The self-improvement loop: every delivered job leaves lessons behind. */
function recordLessons(job: Job) {
  const db = getDB();
  const template = getTemplate(job.templateId);
  const gens = jobGenerations(job.id);
  const add = (category: (typeof db.lessons)[number]["category"], text: string) =>
    db.lessons.push({ id: newId("les"), at: now(), jobId: job.id, clientId: job.clientId, category, text });

  for (const m of job.analysis?.missingInputs ?? []) add("missing-input", `${template.name} briefs from ${job.channel} arrived without: ${m}.`);
  const byModel = new Map<string, { outputs: number; repairs: number; rules: Set<string> }>();
  for (const g of gens.filter((g) => g.deliverableId)) {
    const step = job.steps.find((s) => s.id === g.stepId);
    const key = step?.modelId ?? g.modelId;
    const e = byModel.get(key) ?? { outputs: 0, repairs: 0, rules: new Set<string>() };
    if (g.purpose === "generate") e.outputs++;
    else e.repairs++;
    for (const c of g.qa?.checks ?? []) if (!c.pass) e.rules.add(c.rule);
    byModel.set(key, e);
  }
  for (const [modelId, e] of byModel) {
    const name = getModel(modelId)?.name ?? modelId;
    add(
      "model",
      e.repairs
        ? `${name} needed ${e.repairs} repair(s) across ${e.outputs} output(s) on ${template.name}${e.rules.size ? ` — failed: ${[...e.rules].join("; ")}` : ""}.`
        : `${name} passed QA first time on all ${e.outputs} output(s) for ${template.name}.`,
    );
  }
  const econ = jobEconomics(job);
  add("margin", `${template.name} at ${fmtUSD(job.price)} via ${job.channel}: realized margin ${fmtPct(econ.expectedMargin)} on ${fmtUSD(econ.actualSpend)} spend.`);
  if (job.revisionCount) add("revision", `${job.revisionCount} client revision(s) on "${job.title}".`);
  audit({ jobId: job.id, actor: "astra", type: "memory", message: "Lessons recorded to firm memory." });
  save();
}

export async function receiveClientMessage(job: Job, body: string) {
  if (!body.trim()) throw new HttpError(400, "Empty message");
  const policy = getDB().policy;
  const client = findClient(job.clientId);
  addMessage(job, { direction: "inbound", body, status: "received" });
  const read = await readClientMessage(body, job, client);
  const inbound = job.messages[job.messages.length - 1];
  inbound.classification = read.classification;
  audit({ jobId: job.id, actor: "astra", type: "message", message: `Client message classified as ${read.classification}: ${read.summary}` });

  const autoSend = policy.clientMessages === "auto-send-routine" && (read.classification === "routine" || read.classification === "approval");
  const reply = addMessage(job, { direction: "outbound", body: read.draftReply, status: "draft" });

  if (read.classification === "scope-change") {
    openCheckpoint(job, "scope-change", "Scope change requested", `${read.summary} Suggested price change: +${fmtUSD(read.priceDelta ?? 0)}.`, {
      messageId: reply.id,
      priceDelta: read.priceDelta ?? 0,
      targetDeliverableId: read.targetDeliverableId ?? job.deliverables[0]?.id,
      request: body,
    });
    return;
  }
  if (autoSend) sendMessage(job, reply);
  else openCheckpoint(job, "client-message", "Review reply to client", read.draftReply, { messageId: reply.id });

  if (read.classification === "routine" && read.targetDeliverableId) {
    await reviseDeliverable(job, read.targetDeliverableId, body);
  }
}

async function reviseDeliverable(job: Job, deliverableId: string, feedback: string) {
  const d = job.deliverables.find((x) => x.id === deliverableId) ?? job.deliverables[0];
  const step = job.steps.find((s) => s.deliverableId === d?.id);
  if (!d || !step) return;
  job.revisionCount++;
  for (const c of job.checkpoints) if (c.kind === "final-delivery" && c.status === "open") Object.assign(c, { status: "rejected", resolvedAt: now() });
  job.messages = job.messages.filter((m) => !(m.status === "draft" && m.body.startsWith("Hi") && m.body.includes("are ready")));
  d.outputIds = [];
  d.status = "pending";
  step.status = "pending";
  step.feedback = feedback;
  job.stage = "revision";
  audit({ jobId: job.id, actor: "astra", type: "repair", message: `Revision #${job.revisionCount} on ${d.label}: re-running "${step.label}" with client feedback.` });
  await startProduction(job);
}

/** Resolves once background production for the job has finished. */
export async function settle(job: Job, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (job.running && Date.now() < end) await sleep(20);
}

export function setPrice(job: Job, price: number) {
  if (!(price >= 0)) throw new HttpError(400, "Invalid price");
  const before = job.price;
  job.price = price;
  audit({ jobId: job.id, actor: "human", type: "decision", message: `Price changed ${fmtUSD(before)} → ${fmtUSD(price)}.` });
  touch(job);
}
