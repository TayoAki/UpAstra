import { SERVICE_TEMPLATES, getTemplate } from "../shared/templates";
import { getModel } from "../shared/catalog";
import type {
  Channel,
  ClientMemory,
  DeliverableSpec,
  Generation,
  IntakeAnalysis,
  Job,
  QAResult,
  QAVerdict,
  RecipeStep,
  ServiceTemplate,
} from "../shared/types";
import { hash } from "./higgsfield";

// Astra is the orchestrator: it handles judgment (reading briefs, writing
// prompts, inspecting outputs, interpreting feedback). Prices, margins and
// limits are computed in plain code elsewhere.
//
// With OPENAI_API_KEY set, judgment calls go to the configured model through an
// OpenAI-compatible chat completions endpoint. Without it, a deterministic
// rules engine stands in so the whole firm can be exercised for free.

let forceSimulated = false;
/** Seeding and tests never spend real tokens. */
export const setAstraSimulated = (on: boolean) => (forceSimulated = on);

export function astraMode(): "live" | "simulated" {
  return !forceSimulated && process.env.OPENAI_API_KEY ? "live" : "simulated";
}
export const astraModel = () => process.env.ASTRA_MODEL ?? "astra";

async function askJSON<T>(system: string, user: unknown, images: string[] = []): Promise<T> {
  const content: unknown[] = [{ type: "text", text: typeof user === "string" ? user : JSON.stringify(user, null, 1) }];
  for (const url of images) if (/^https?:/.test(url)) content.push({ type: "image_url", image_url: { url } });
  const res = await fetch(`${process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: astraModel(),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Astra ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content) as T;
}

// ---------------------------------------------------------------------------
// Prompt 2 — turn messy demand into a job

const INTAKE_SYSTEM = `You are Astra, intake lead at an AI-native creative service firm.
Read an unstructured marketplace brief and return JSON with keys:
summary (1-2 sentences), templateId (one of the provided template ids),
deliverables (array of {id,label,kind:"image"|"video"|"audio",format,aspect,durationSec?,quantity,exactCopy?}),
exactCopy (strings that must appear verbatim), deadline (string or null), suppliedAssets, missingInputs,
risks (rights, likeness, claims, timing, budget), revisionRisks (what is likely to cause revisions),
clientQuestions (the SMALLEST useful set, max 3, only questions whose answers change the output),
recommendation ("accept"|"review"|"reject") and reasoning.
Do not compute prices or margins. Prefer the template whose deliverables best match the brief.`;

export async function analyzeBrief(input: {
  rawBrief: string;
  channel: Channel;
  price: number;
  referenceAssets: string[];
  clientNotes: string;
  client?: ClientMemory;
}): Promise<IntakeAnalysis> {
  if (astraMode() === "live") {
    try {
      const out = await askJSON<Omit<IntakeAnalysis, "source">>(INTAKE_SYSTEM, {
        templates: SERVICE_TEMPLATES.map((t) => ({ id: t.id, name: t.name, deliverables: t.deliverables, basePrice: t.basePrice })),
        ...input,
      });
      return normalizeAnalysis({ ...out, source: "astra" });
    } catch (err) {
      console.warn("[astra] intake fell back to rules engine:", (err as Error).message);
    }
  }
  return simulateIntake(input);
}

function normalizeAnalysis(a: IntakeAnalysis): IntakeAnalysis {
  const t = getTemplate(a.templateId);
  return {
    ...a,
    templateId: t.id,
    deliverables: a.deliverables?.length ? a.deliverables : t.deliverables,
    exactCopy: a.exactCopy ?? [],
    suppliedAssets: a.suppliedAssets ?? [],
    missingInputs: a.missingInputs ?? [],
    risks: a.risks ?? [],
    revisionRisks: a.revisionRisks ?? [],
    clientQuestions: (a.clientQuestions ?? []).slice(0, 3),
  };
}

const has = (s: string, re: RegExp) => re.test(s);

export function pickTemplate(text: string): ServiceTemplate {
  const s = text.toLowerCase();
  if (has(s, /franchise|locations?\b|per[- ]store|local versions/)) return getTemplate("franchise-localization");
  if (has(s, /spec sheet|manufactur|industrial|trade ?show|distributor|cad\b/)) return getTemplate("industrial-sku-pack");
  if (has(s, /weekly|every (week|friday)|ad pack|ad creatives|creatives for (meta|facebook|tiktok)|hooks/)) return getTemplate("always-on-ads");
  if (has(s, /video|reel|spot|clip|motion|animation|tiktok|\bmp4\b|seconds?\b|\d+\s?s\b/)) return getTemplate("launch-video");
  return getTemplate("product-still-pack");
}

export function simulateIntake(input: {
  rawBrief: string;
  channel: Channel;
  price: number;
  referenceAssets: string[];
  clientNotes: string;
  client?: ClientMemory;
}): IntakeAnalysis {
  const text = `${input.rawBrief}\n${input.clientNotes}`;
  const s = text.toLowerCase();
  const template = pickTemplate(text);

  const exactCopy = [...text.matchAll(/["“]([^"”]{2,80})["”]/g)].map((m) => m[1]);
  const aspect = text.match(/\b(\d{1,2})\s?[:x×]\s?(\d{1,2})\b/);
  const duration = s.match(/(\d{1,3})\s?(?:-?\s?)(?:s\b|sec|second)/);
  // "3 lifestyle images" is a count; "5 second vertical video" is a duration.
  const qty = s.match(/(?<![:x×\d])\b(\d{1,2})\s+(?:(?!(?:s|secs?|seconds?)\b)[\w-]+\s){0,3}(images?|photos?|pictures?|stills?|videos?|clips?|ads?|graphics?|posters?|versions?)\b/);
  const formats = [...new Set([...s.matchAll(/\b(png|jpe?g|mp4|mov|webp|gif)\b/g)].map((m) => m[1]))];
  const deadlineMatch = text.match(
    /\b(by|before|within|due)\s+((?:next\s)?(?:mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|end of (?:day|week)|\d+\s+(?:hours?|days?)|[A-Z][a-z]+ \d{1,2}(?:st|nd|rd|th)?)/i,
  );

  // Single-asset templates: only include the secondary deliverable if the brief asks for it.
  const wantsSecondary = (d: DeliverableSpec) =>
    d.kind === "image" && template.id === "launch-video" ? /thumbnail|still|key ?frame|cover/.test(s) : !qty;
  const specs =
    template.id === "product-still-pack" || template.id === "launch-video"
      ? template.deliverables.filter((d, i) => i === 0 || wantsSecondary(d))
      : template.deliverables;
  const deliverables: DeliverableSpec[] = specs.map((d, i) => {
    const spec: DeliverableSpec = { ...d };
    if (i === 0) {
      if (aspect) spec.aspect = `${aspect[1]}:${aspect[2]}`;
      const qtyKind = qty && (/video|clip/.test(qty[2]) ? "video" : /ad|version/.test(qty[2]) ? spec.kind : "image");
      if (qty && qtyKind === spec.kind) spec.quantity = Math.min(Number(qty[1]), 12);
      if (exactCopy[0]) spec.exactCopy = exactCopy[0];
      const f = formats.find((f) => (spec.kind === "video" ? /mp4|mov|gif/.test(f) : /png|jpe?g|webp/.test(f)));
      if (f) spec.format = f === "jpeg" ? "jpg" : f;
    }
    if (spec.kind === "video" && duration) spec.durationSec = Math.min(Number(duration[1]), 30);
    return spec;
  });

  const suppliedAssets = [
    ...input.referenceAssets,
    ...(has(s, /attached|i have (?:a |the )?(?:photo|image|picture)|product (?:photo|shot)s? (?:attached|included|provided)/) ? ["Product photography (mentioned in brief)"] : []),
    ...(has(s, /logo (?:attached|included|provided)|our logo/) ? ["Logo (mentioned in brief)"] : []),
  ];

  const memory = input.client;
  const missingInputs: string[] = [];
  if (!suppliedAssets.length) missingInputs.push("Clean product reference photo (front-on, neutral light)");
  if (!aspect) missingInputs.push("Placements / aspect ratio for each asset");
  if (!memory?.colors?.length && !has(s, /#[0-9a-f]{6}|pantone|brand colou?rs?/)) missingInputs.push("Brand colors and fonts");
  if (has(s, /text|headline|tagline|copy|slogan|caption/) && !exactCopy.length) missingInputs.push("Exact on-asset copy (verbatim)");
  if (template.deliverables.some((d) => d.kind === "video") && !duration) missingInputs.push("Video length");
  if (!deadlineMatch) missingInputs.push("Deadline");

  const risks: string[] = [];
  const revisionRisks: string[] = [];
  let reject = false;
  if (has(s, /celebrity|look(s)? like (?:[A-Z]|taylor|beyonce|drake)|famous person|real person's likeness/)) {
    risks.push("Likeness rights — brief asks for a real or famous person's look");
    reject = true;
  }
  if (has(s, /disney|marvel|pokemon|nike swoosh|copyrighted character/)) {
    risks.push("Third-party IP in the brief");
    reject = true;
  }
  if (has(s, /cures?|clinically proven|guaranteed results|fda|lose \d+ ?(?:lbs|pounds|kg)/)) risks.push("Regulated or unverifiable product claims — need approved claims list");
  if (has(s, /asap|urgent|24 ?h|today|tonight/)) risks.push("Rush timeline");
  if (input.price < template.basePrice * 0.05) risks.push(`Budget ($${input.price}) is far below the ${template.name} list price`);
  if (has(s, /unlimited revisions?/)) revisionRisks.push("Client expects unlimited revisions — cap revisions in the offer");
  if (has(s, /something (?:cool|nice|creative)|surprise me|you decide|not sure/)) revisionRisks.push("Vague creative direction — expect taste-driven revisions");
  if (has(s, /label|packag|bottle|can\b|box\b/)) revisionRisks.push("Packaging/label fidelity — the most common rejection for product scenes");
  if (exactCopy.length) revisionRisks.push("Exact copy must render verbatim — typography lane + QA required");
  if (memory?.rejectedStyles?.length) revisionRisks.push(`Client previously rejected: ${memory.rejectedStyles.join(", ")}`);

  const questionFor: Record<string, string> = {
    "Clean product reference photo (front-on, neutral light)": "Could you share one clean, front-on photo of the product (neutral light, label readable)?",
    "Placements / aspect ratio for each asset": "Where will these run — feed (4:5), stories/reels (9:16), or product page (1:1)?",
    "Brand colors and fonts": "Do you have brand colors (hex) or a style guide we should match?",
    "Exact on-asset copy (verbatim)": "What exact text should appear on the asset, word for word?",
    "Video length": "How long should the video be (e.g. 5s, 15s)?",
  };
  const clientQuestions = missingInputs.map((m) => questionFor[m]).filter(Boolean).slice(0, 3);

  const recommendation: IntakeAnalysis["recommendation"] = reject
    ? "reject"
    : missingInputs.filter((m) => m !== "Deadline").length >= 2 || risks.length
      ? "review"
      : "accept";

  const total = deliverables.reduce((n, d) => n + d.quantity, 0);
  return {
    summary: `${input.channel === "direct" ? "Direct lead" : `${input.channel[0].toUpperCase()}${input.channel.slice(1)} job`} for ${total} asset${total === 1 ? "" : "s"} — best fit: ${template.name}.`,
    templateId: template.id,
    deliverables,
    exactCopy,
    deadline: deadlineMatch?.[0],
    suppliedAssets,
    missingInputs,
    risks,
    revisionRisks,
    clientQuestions,
    recommendation,
    reasoning:
      recommendation === "reject"
        ? "Rights risk the firm cannot clear — decline politely."
        : recommendation === "review"
          ? `Doable, but ${missingInputs.length} input(s) are missing${risks.length ? ` and ${risks.length} risk(s) need a human call` : ""}. Ask the questions before spending.`
          : "Clear deliverables and enough inputs to produce without guessing.",
    source: "simulated",
  };
}

// ---------------------------------------------------------------------------
// Generation prompts (written by Astra per step, using client memory)

export function buildPrompt(step: RecipeStep, job: Job, client?: ClientMemory, feedback?: string): string {
  const d = job.deliverables.find((x) => x.id === step.deliverableId);
  const parts = [
    `${step.label} for ${client?.name ?? "the client"}.`,
    job.analysis?.summary ?? "",
    d ? `Deliverable: ${d.label}, ${d.aspect} ${d.format}${d.durationSec ? `, ${d.durationSec}s` : ""}.` : "",
    d?.exactCopy ? `Render this copy exactly: "${d.exactCopy}".` : "",
    client?.colors.length ? `Palette: ${client.colors.join(", ")}.` : "",
    client?.likes.length ? `Client likes: ${client.likes.join("; ")}.` : "",
    client?.rejectedStyles.length ? `Avoid: ${client.rejectedStyles.join("; ")}.` : "",
    step.preserve !== "none" ? `Preserve the ${step.preserve} exactly as in the reference.` : "",
    feedback ? `Revision feedback: ${feedback}` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Prompt 5 — quality assurance against the approved brief

const QA_SYSTEM = `You are Astra, QA lead. Check one generated asset against the approved brief, the template rulebook and client memory.
Return JSON {verdict:"ready"|"edit"|"regenerate"|"human", score:0-100, checks:[{rule,pass,note}], summary}.
"edit" = a controlled local fix (label, one object, headline) keeps everything else.
"regenerate" = composition, motion or concept is wrong.
"human" = subjective, legal or claim question a person must decide.`;

export async function qaOutput(args: {
  generation: Generation;
  job: Job;
  template: ServiceTemplate;
  client?: ClientMemory;
}): Promise<QAResult> {
  const { generation, job, template, client } = args;
  if (astraMode() === "live") {
    try {
      const d = job.deliverables.find((x) => x.id === generation.deliverableId);
      const out = await askJSON<Omit<QAResult, "source">>(
        QA_SYSTEM,
        { deliverable: d, rulebook: template.rulebook, exactCopy: job.analysis?.exactCopy, client, prompt: generation.prompt },
        generation.outputUrl ? [generation.outputUrl] : [],
      );
      return { ...out, source: "astra" };
    } catch (err) {
      console.warn("[astra] QA fell back to rules engine:", (err as Error).message);
    }
  }
  return simulateQA(generation, job, template);
}

export function simulateQA(generation: Generation, job: Job, template: ServiceTemplate): QAResult {
  const d = job.deliverables.find((x) => x.id === generation.deliverableId);
  const model = getModel(generation.modelId);
  const roll = hash(`${generation.id}:${generation.attempt}`) % 100;
  // First attempts fail sometimes; repairs almost always land. Lower-quality
  // models fail more often — that's what the router is protecting against.
  const failChance = generation.attempt === 1 ? 20 + (5 - (model?.quality ?? 4)) * 12 : 8;
  const fail = roll < failChance;
  const checks = template.rulebook.map((rule) => ({ rule, pass: true }) as { rule: string; pass: boolean; note?: string });
  let verdict: QAVerdict = "ready";
  if (fail) {
    const idx = roll % checks.length;
    const rule = checks[idx].rule;
    checks[idx].pass = false;
    if (/claim|disclaimer|safety/i.test(rule) && roll % 3 === 0) {
      verdict = "human";
      checks[idx].note = "Wording is close to the approved claim but not verbatim — needs a person to sign off.";
    } else if (d?.kind === "image" && /label|copy|text|color|colou?r|address|price|headline|claim/i.test(rule)) {
      verdict = "edit";
      checks[idx].note = "Local defect — fix in place and keep the composition.";
    } else {
      verdict = "regenerate";
      checks[idx].note = "Structural miss — re-render rather than patch.";
    }
  }
  if (d) {
    checks.push({ rule: `Format ${d.format}, aspect ${d.aspect}${d.durationSec ? `, ${d.durationSec}s` : ""}`, pass: true });
  }
  const score = fail ? 55 + (roll % 20) : 86 + (roll % 13);
  return {
    verdict,
    score,
    checks,
    summary:
      verdict === "ready"
        ? "Matches the brief and rulebook. Ready for human review."
        : `${checks.find((c) => !c.pass)?.rule} — ${verdict === "edit" ? "controlled edit" : verdict === "regenerate" ? "regenerate" : "escalate to a human"}.`,
    source: "simulated",
  };
}

// ---------------------------------------------------------------------------
// Prompt 6 — client communication

export interface MessageRead {
  classification: "routine" | "scope-change" | "question" | "approval";
  summary: string;
  draftReply: string;
  targetDeliverableId?: string;
  priceDelta?: number;
}

const MESSAGE_SYSTEM = `You are Astra, account lead. Classify the client's message about an in-flight job.
Return JSON {classification:"routine"|"scope-change"|"question"|"approval", summary, draftReply, targetDeliverableId?, priceDelta?}.
routine = small revision within the agreed deliverables. scope-change = new deliverables, formats, languages, or durations — suggest priceDelta in USD.
Replies are short, warm and specific. Never promise dates or prices the operator has not approved.`;

export async function readClientMessage(body: string, job: Job, client?: ClientMemory): Promise<MessageRead> {
  if (astraMode() === "live") {
    try {
      return await askJSON<MessageRead>(MESSAGE_SYSTEM, { message: body, deliverables: job.deliverables, price: job.price, client });
    } catch (err) {
      console.warn("[astra] message read fell back to rules engine:", (err as Error).message);
    }
  }
  const s = body.toLowerCase();
  const name = client?.contact?.split(" ")[0] ?? "there";
  const target = job.deliverables.find((d) => s.includes(d.label.toLowerCase().split(" ")[0])) ?? job.deliverables[0];
  if (/\b(also|additional|another|extra|add (?:a|an|some)|more (?:versions|videos|images)|in (?:spanish|french|german)|translate|longer|30 ?s)\b/.test(s)) {
    return {
      classification: "scope-change",
      summary: "Client is asking for work outside the agreed deliverables.",
      draftReply: `Hi ${name} — happy to add that. It's outside the original scope, so I'll send a quick quote for the extra work before we start.`,
      priceDelta: Math.round(job.price * 0.5),
    };
  }
  const asksForChange = /\b(but|could you|can you|please|change|make it|more|less|warmer|cooler|brighter|darker|slower|faster|swap|remove|fix|tweak)\b/.test(s);
  if (/\b(love|looks great|perfect|approved?|ship it)\b/.test(s) && !asksForChange) {
    return { classification: "approval", summary: "Client approves.", draftReply: `Thanks ${name}! Sending the final files now.` };
  }
  if (/\?\s*$/.test(body.trim()) && !/\b(can you|could you|please)\b/.test(s)) {
    return { classification: "question", summary: "Client has a question.", draftReply: `Hi ${name} — good question. Let me check and come right back to you.` };
  }
  return {
    classification: "routine",
    summary: `Routine revision on ${target?.label ?? "the deliverable"}.`,
    draftReply: `Hi ${name} — got it. We'll make that change to the ${target?.label.toLowerCase() ?? "asset"} and send an updated version shortly.`,
    targetDeliverableId: target?.id,
  };
}

export function draftDeliveryMessage(job: Job, client?: ClientMemory): string {
  const name = client?.contact?.split(" ")[0] ?? "there";
  const list = job.deliverables.map((d) => `• ${d.quantity}× ${d.label} (${d.aspect} ${d.format}${d.durationSec ? `, ${d.durationSec}s` : ""})`).join("\n");
  return `Hi ${name},\n\nYour files for "${job.title}" are ready:\n${list}\n\nEverything was checked against your brief. Reply with any tweaks and we'll take care of them.\n\nThanks!`;
}

export function draftQuestionsMessage(questions: string[], client?: ClientMemory): string {
  const name = client?.contact?.split(" ")[0] ?? "there";
  return `Hi ${name}, thanks for the brief! A few quick questions so we get it right the first time:\n\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`;
}
