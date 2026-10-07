import { getModel } from "../shared/catalog";
import { SPAM_PHRASES, words } from "../shared/copy";
import type { ClientMemory, CopyPiece, CopySpec, Deliverable, Job } from "../shared/types";
import { astraMode } from "./astra";
import { chatJSON, modelFor, type LLMRole } from "./llm";
import { hash } from "./higgsfield";

// Text production. Copy is written by language models through the same
// OpenAI-compatible endpoint Astra uses (not Higgsfield). Each catalog tier
// maps to a configurable model ID. Without a key, a deterministic writer
// produces realistic drafts — including the kinds of defects real drafts have,
// so QA and repair are exercised.

const TIER_ROLE: Record<string, LLMRole> = {
  "astra-writer-fast": "copy-fast",
  "astra-writer-pro": "copy-pro",
  "astra-editor": "copy-edit",
};

/** The real model behind a catalog tier (configurable per role in server/llm.ts). */
export function writerModelId(catalogId: string): string {
  return modelFor(TIER_ROLE[catalogId] ?? "copy-pro");
}

export interface WriteRequest {
  catalogId: string;
  job: Job;
  client?: ClientMemory;
  deliverable?: Deliverable; // absent for exploration steps
  purpose: "generate" | "edit" | "regenerate";
  attempt: number;
  previous?: CopyPiece[];
  fixes?: string[];
  feedback?: string;
  seed: string;
}

export interface WriteResult {
  pieces: CopyPiece[];
  tokens: number;
  cost: number;
}

/** ktok × list price, to a hundredth of a cent. */
const priceFor = (catalogId: string, ktok: number) => Math.round((getModel(catalogId)?.price ?? 0) * ktok * 10000) / 10000;

function brief(job: Job, client?: ClientMemory) {
  const spec = job.deliverables.find((d) => d.copy)?.copy;
  return {
    company: client?.name ?? "the client",
    audience: spec?.audience ?? extractAudience(job.rawBrief) ?? "your target buyers",
    offer: spec?.offer ?? extractOffer(job.rawBrief, client) ?? "what you sell",
    cta: spec?.cta,
    claims: client?.approvedClaims ?? [],
    funder: spec?.funder,
    ask: spec?.ask,
    facts: extractFacts(`${job.rawBrief}\n${job.clientNotes}\n${(client?.approvedClaims ?? []).join(". ")}`),
    program: extractProgram(job.rawBrief),
  };
}

/** Sentences from the org's own material that carry numbers — the only stats a proposal may use. */
export function extractFacts(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/(?<=[.!?])\s+|\n+/)
        .map((x) => x.trim().replace(/^[-•*]\s*/, ""))
        .filter((x) => /\d/.test(x) && x.length > 12 && !/\b(due|deadline|by (?:mon|tue|wed|thu|fri|sat|sun)|seeking|requesting|apply(?:ing)? for|grant from|\d+[- ](?:e-?mail|ads?|variations?|headlines?))/i.test(x)),
    ),
  ].slice(0, 6);
}

function extractProgram(text: string): string | undefined {
  return text.match(/\b(?:program|project|initiative)\s+(?:called\s+)?["“]([^"”]+)["”]/i)?.[1] ?? text.match(/["“]([^"”]{3,50})["”]\s+(?:program|project|initiative)/i)?.[1];
}

export function extractAudience(text: string): string | undefined {
  const re = /\b(targeting|aimed at|aimed towards|reaching|sell(?:ing)? to|for)\s+((?:[A-Za-z][\w&/-]*\s?){1,6}?)(?=[.,;:!?\n]| who | in | with | that |$)/gi;
  const found = [...text.matchAll(re)]
    .map((m) => ({ verb: m[1].toLowerCase(), a: m[2].trim() }))
    .filter(({ a }) => !/^(our|my|a|an|the|your|this|instagram|facebook|meta|google|linkedin|tiktok)\b/i.test(a) && !/\b(ads?|copy|emails?|grant|proposal|program)$/i.test(a));
  // Prefer explicit targeting language over a generic "for".
  return (found.find((f) => f.verb !== "for") ?? found[0])?.a;
}

export function extractOffer(text: string, client?: ClientMemory): string | undefined {
  const m = text.match(/\b(?:for|promoting|about|selling)\s+(?:our|my|a|an|the)\s+((?:[\w-]+\s?){1,5}?)(?=[.,;:!?\n]| targeting| aimed| to | for |$)/i);
  return m?.[1]?.trim() ?? (client?.notes ? undefined : undefined);
}

// ---------------------------------------------------------------------------
// Live writer

const WRITE_SYSTEM = `You are a senior direct-response copywriter at an AI-native service firm.
Write exactly what the brief asks for and return JSON: {"pieces":[{...fields}]}.
Each piece has exactly the requested field keys. Respect every character / word limit.
Cold emails: plain text, peer-to-peer, one CTA (usually a soft question), use only the allowed merge tags, no spam phrases, no links unless asked.
Ad copy: each variant gets a distinct hook taken from customer language; include a call to action.
Never invent statistics, percentages, rankings or guarantees — use only the approved claims provided.`;

const EDIT_SYSTEM = `You are a copy editor. Apply ONLY the listed fixes to the copy and keep everything else word-for-word.
Return JSON {"pieces":[...]} with the same number of pieces and the same field keys.`;

async function liveWrite(req: WriteRequest): Promise<WriteResult> {
  const d = req.deliverable;
  const spec = d?.copy;
  const isEdit = req.purpose === "edit";
  const user = isEdit
    ? { fixes: req.fixes, fields: spec?.fields, mergeTags: spec?.mergeTags, copy: req.previous }
    : d && spec
      ? {
          task:
            spec.format === "grant-proposal"
              ? "One grant proposal narrative: a single piece whose keys are the section keys. Use ONLY statistics found in `facts` or `brief`; if a number is needed but missing, write [DATA NEEDED] instead of inventing it. Name the funder and state the requested amount."
              : `${d.quantity} ${spec.format === "cold-email" ? "emails in one coherent sequence" : `${spec.platform ?? "Meta"} ad variants`}`,
          funder: spec.funder,
          ask: spec.ask,
          fields: spec.fields,
          tone: spec.tone,
          audience: spec.audience,
          offer: spec.offer,
          cta: spec.cta,
          mergeTags: spec.mergeTags,
          brief: req.job.rawBrief,
          clientNotes: req.job.clientNotes,
          client: req.client && { name: req.client.name, likes: req.client.likes, avoid: req.client.rejectedStyles, approvedClaims: req.client.approvedClaims, voice: req.client.notes },
          revisionFeedback: req.feedback,
          previousAttemptProblems: req.purpose === "regenerate" ? req.fixes : undefined,
        }
      : { task: "List 10 distinct angles/hooks for this brief as pieces [{angle, why}]. Short.", brief: req.job.rawBrief, client: req.client?.name };

  const role = (TIER_ROLE[req.catalogId] ?? "copy-pro") as LLMRole;
  const r = await chatJSON<{ pieces?: CopyPiece[] }>({ role, system: isEdit ? EDIT_SYSTEM : WRITE_SYSTEM, user, maxTokens: 6000 });
  const pieces = r.json.pieces ?? [];
  const tokens = r.tokens || 1500;
  // Prefer the provider's reported charge; fall back to the catalog list price.
  if (r.cost !== undefined) return { pieces, tokens, cost: Math.round(r.cost * 10000) / 10000 };
  return { pieces, tokens, cost: priceFor(req.catalogId, tokens / 1000) };
}

// ---------------------------------------------------------------------------
// Simulated writer

const EMAIL_ANGLES: { subject: (b: B) => string; body: (b: B, cta: string) => string }[] = [
  {
    subject: () => `Quick question, {{first_name}}`,
    body: (b: B, cta: string) =>
      `Hi {{first_name}},\n\nMost ${b.audience} I talk to say the hard part isn't finding tools — it's the hours lost stitching them together every week.\n\nAt ${b.company} we built ${b.offer} to take that busywork off the plate, so the team at {{company}} spends time on the work that actually moves numbers.\n\n${cta}`,
  },
  {
    subject: () => `How teams like {{company}} handle this`,
    body: (b: B, cta: string) =>
      `Hi {{first_name}},\n\nFollowing up with something concrete${b.claims[0] ? `: ${b.claims[0]}` : ""}. That's what teams switching to ${b.offer} tell us matters most.\n\nOne customer told us the biggest change was simply not having to chase updates anymore. Happy to share how they rolled it out in a week.\n\n${cta}`,
  },
  {
    subject: () => `Not the right time?`,
    body: (b: B, cta: string) =>
      `Hi {{first_name}},\n\nA common reason ${b.audience} hold off: switching feels like a project in itself. Fair concern.\n\nWe handle setup and migration for you, and most teams are running on ${b.offer} without disrupting their week. If timing is the blocker, I can send a two-minute walkthrough instead.\n\n${cta}`,
  },
  {
    subject: () => `Should I close the loop?`,
    body: (b: B, cta: string) =>
      `Hi {{first_name}},\n\nI haven't heard back, so I'll assume this isn't a priority for {{company}} right now — totally fine.\n\nIf it becomes one, ${b.company} will be here. Before I go: is someone else on your team the better person to talk to about ${b.offer}?\n\n${cta}`,
  },
  {
    subject: () => `An idea for {{company}}`,
    body: (b: B, cta: string) =>
      `Hi {{first_name}},\n\nI was looking at how {{company}} works and had a quick idea: ${b.audience} usually get the quickest win from automating the weekly reporting first.\n\nThat's exactly where ${b.offer} starts. No big rollout, just one workflow off your plate this month.\n\n${cta}`,
  },
];

const AD_HOOKS: { headline: (b: B) => string[]; text: (b: B) => string[]; desc: string[] }[] = [
  {
    headline: (b) => [`Stop wasting time on ${b.offer}`, ...(words(b.offer) <= 2 ? [`Skip the hassle with ${b.offer}`] : []), "Skip the hassle"],
    text: (b) => [`Tired of the same old routine? ${cap(b.offer)} gives ${b.audience} their time back. Try it today.`, `${cap(b.offer)} that gives you time back. Try it today.`],
    desc: ["Try it today"],
  },
  {
    headline: (b) => [`${cap(b.offer)}, finally done right`, ...(words(b.offer) <= 2 ? [`${cap(b.offer)}, done right`] : []), "Finally, done right"],
    text: (b) => [`${b.claims[0] ?? "Made for real life"}. See why ${b.audience} are switching to ${b.company}. Shop now.`, `${b.claims[0] ?? "Made for real life"}. See why people are switching. Shop now.`],
    desc: ["Shop the collection", "Shop now"],
  },
  {
    headline: () => ["What our customers keep saying", "Customers keep saying this", "Loved by customers"],
    text: (b) => [`"I wish I'd found this sooner." Join ${b.audience} who made the switch to ${b.company}.`, `"I wish I'd found this sooner." Join the people who switched. Read the reviews.`],
    desc: ["Read the reviews"],
  },
  {
    headline: () => ["The small change that adds up", "Small change, big difference"],
    text: (b) => [`One swap, every day. ${cap(b.offer)} that fits how ${b.audience} already live. Get yours.`, `One small swap, every day. Get yours.`],
    desc: ["Get yours now", "Get yours"],
  },
  {
    headline: () => ["Worried it won't work for you?", "Not sure it's for you?"],
    text: (b) => [`Easy 30-day returns, so you can try ${b.offer} at home. Love it or send it back.`, "Easy 30-day returns. Try it at home and love it or send it back."],
    desc: ["Try it at home"],
  },
  {
    headline: (b) => [`${b.company}: made for ${b.audience}`, ...(words(b.audience) <= 3 ? [`Made for ${b.audience}`] : []), "Made for you"],
    text: (b) => [`Built around what ${b.audience} told us they needed. ${b.claims[1] ?? "Thoughtfully made"}. Shop now.`, `Built around what customers asked for. Shop now.`],
    desc: ["Shop now"],
  },
  {
    headline: () => ["Gift-worthy, and they'll use it", "A gift they'll actually use"],
    text: (b) => [`Looking for something they'll actually use? ${cap(b.offer)} from ${b.company}. Order today.`, "A gift they'll actually use. Order today."],
    desc: ["Order today"],
  },
  {
    headline: () => ["Before vs. after your first week", "Your first week, better"],
    text: (b) => [`Week one with ${b.offer}: less hassle, more of what you love. Learn more at ${b.company}.`, "Less hassle, more of what you love. Learn more."],
    desc: ["Learn more"],
  },
];

type B = ReturnType<typeof brief>;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type Defect = "length" | "spam" | "tag" | "cta" | "claim" | "dupe" | null;

function pickDefect(seed: string, attempt: number, format: CopySpec["format"]): Defect {
  if (attempt > 1) return null;
  const roll = hash(seed) % 100;
  const options: Defect[] = format === "cold-email" ? ["length", "spam", "tag", "cta"] : ["length", "spam", "cta", "dupe"];
  if (roll < 12) return "claim";
  if (roll < 55) return options[roll % options.length];
  return null;
}

function simulateWrite(req: WriteRequest): WriteResult {
  const b = brief(req.job, req.client);
  const d = req.deliverable;
  const spec = d?.copy;
  let pieces: CopyPiece[];

  if (!d || !spec) {
    const hooks = ["Pain: time lost every week", "Outcome: evenings back", "Proof: what peers say", "Objection: switching cost", "Curiosity: the one change", "Comparison: before vs after", "Identity: built for you", "Risk reversal: easy returns"];
    pieces = hooks.map((angle) => ({ angle, why: `Fits ${b.audience}; ties to ${b.offer}.` }));
  } else if (req.purpose === "edit" && req.previous) {
    pieces = simulateEdit(req.previous, spec);
  } else {
    const defect = pickDefect(req.seed, req.attempt, spec.format);
    if (spec.format === "grant-proposal") {
      pieces = [writeGrant(b, spec, req.feedback)];
      injectGrantDefect(pieces[0], spec, req.attempt === 1 ? hash(req.seed) % 100 : 100);
    } else {
      pieces = spec.format === "cold-email" ? writeEmails(b, d.quantity, spec, req.feedback) : writeAds(b, d.quantity, spec, req.feedback);
      injectDefect(pieces, spec, defect, b);
    }
  }
  const outWords = pieces.reduce((n, p) => n + words(Object.values(p).join(" ")), 0);
  const tokens = Math.round(outWords * 1.4 + 900);
  return { pieces, tokens, cost: priceFor(req.catalogId, tokens / 1000) };
}

function writeEmails(b: B, n: number, spec: CopySpec, feedback?: string): CopyPiece[] {
  const ctas = [b.cta ? `${cap(b.cta.replace(/[.?!]+$/, ""))} — just reply with a time that works.` : "Worth a 15-minute chat next week?", "Open to a quick call on Thursday?", "Would a short walkthrough help?", "Who's the right person to ask?"];
  return Array.from({ length: n }, (_, i) => {
    const a = EMAIL_ANGLES[i % EMAIL_ANGLES.length];
    let body = a.body(b, ctas[i % ctas.length]);
    if (feedback && i === 0) body = body.replace("Most ", "Quick one — most ");
    return { subject: a.subject(b).slice(0, spec.fields[0]?.maxChars ?? 60), body };
  });
}

function writeAds(b: B, n: number, spec: CopySpec, feedback?: string): CopyPiece[] {
  return Array.from({ length: n }, (_, i) => {
    const h = AD_HOOKS[i % AD_HOOKS.length];
    const piece: CopyPiece = {};
    const hasPrimary = spec.fields.some((f) => f.key === "primaryText");
    for (const f of spec.fields) {
      // Google Search has no primary text, so its description carries the body copy.
      const options = f.key === "headline" ? h.headline(b) : f.key === "description" && hasPrimary ? h.desc : h.text(b);
      piece[f.key] = options.find((o) => !f.maxChars || o.length <= f.maxChars) ?? fit(options[options.length - 1], f.maxChars);
    }
    if (feedback && i === 0 && piece.primaryText) piece.primaryText = fit(`${piece.primaryText}`, spec.fields.find((f) => f.key === "primaryText")?.maxChars);
    return piece;
  });
}

function writeGrant(b: B, spec: CopySpec, feedback?: string): CopyPiece {
  const org = b.company;
  const funder = b.funder ?? "the Foundation";
  const program = b.program ?? `${org}'s ${b.offer === "what you sell" ? "core program" : b.offer}`;
  const population = b.facts.join(" ").match(/\b(students|youth|young people|families|children|seniors|veterans|women|girls|boys|patients|residents|survivors|immigrants|refugees|participants)\b/i)?.[1];
  const who = b.audience !== "your target buyers" ? b.audience : population ? `the ${population.toLowerCase()} we serve` : "the families we serve";
  const ask = b.ask ?? "the requested amount";
  const facts = b.facts.length ? b.facts : [];
  const factLine = (i: number, fallback: string) => facts[i] ?? fallback;
  const sections: Record<string, string> = {
    summary: `${org} respectfully requests ${ask} from ${funder} to support ${program}. The program serves ${who} and directly advances ${funder}'s commitment to strengthening communities through measurable, locally led work. ${factLine(0, `${org} has delivered this work in our community for several years.`)} With this investment, we will expand the program's reach, deepen the quality of support each participant receives, and build the evidence base needed to sustain the work beyond the grant period. This proposal outlines the need, our approach, how we will measure success, and how the program will continue after the grant ends.`,
    need: `${who.charAt(0).toUpperCase() + who.slice(1)} in our community face barriers that existing services do not fully address. ${factLine(1, "Local providers report waiting lists and gaps in follow-up support.")} ${factLine(2, "")} These gaps compound over time: when support is fragmented, participants disengage, and the community loses the long-term benefits of early intervention. Families have told us directly that they need consistent, culturally responsive support close to home, delivered by people they trust. ${org} is positioned to close this gap because we already have relationships, staff and partners in place, and because participants already know and trust our team. Without additional support, demand will continue to outpace what we can offer, and the people who would benefit most will be the ones left waiting. ${funder}'s priorities align closely with this need, and this request focuses on the specific barriers that a modest, well-targeted investment can remove.`,
    program: `${program} combines direct services, mentoring and partner referrals in a single, coordinated pathway. Participants are welcomed through an intake conversation that identifies goals and barriers, then matched with a trained staff member who meets with them regularly. Each participant receives a personal plan, access to group sessions, and warm referrals to partner organizations for needs outside our scope. Staff document progress at every session so that support can be adjusted quickly when a participant struggles. Program activities run year-round, with additional sessions during high-need periods. Partners contribute space, specialized expertise and referral pathways, which keeps costs low and allows grant funds to go directly to staffing and participant support. The program is designed with input from past participants, who serve on an advisory group that reviews materials and recommends improvements each quarter. This approach reflects ${funder}'s emphasis on community voice and practical, measurable results. Grant funds allow us to add staff capacity, reduce waiting times and extend support to participants who currently fall through the cracks between services.`,
    objectives: `Goal: increase stability and long-term outcomes for ${who}. Objective 1: by month 12, every enrolled participant will have a written personal plan reviewed at least 4 times. Objective 2: by month 6, launch 2 new partner referral pathways. Objective 3: by month 12, collect pre- and post-program surveys from participants to measure change in confidence and access to services.`,
    evaluation: `${org} will track enrollment, attendance, plan completion and referral follow-through in our case management system. Pre- and post-program surveys measure change in participants' confidence, skills and access to services. Staff review data monthly and the advisory group reviews it quarterly, so the program can adjust in real time. We will share a mid-year and final report with ${funder}, including both outcome data and participant stories.`,
    organization: `${org} has the leadership, systems and community trust to deliver this program. ${factLine(3, "Our staff and volunteers reflect the communities we serve.")} Our board provides financial oversight, and we maintain clean audits and established partnerships with local agencies. This program builds on work we already do well, led by experienced staff who know the community and are supported by a board that reviews program outcomes alongside finances. We have managed restricted grants before and have the reporting systems in place to track spending and outcomes accurately.`,
    budget: `The requested ${ask} will fund program staff time, participant support costs, training and evaluation. Partner organizations contribute in-kind space and expertise, and ${org} covers administrative costs from unrestricted funds, so the grant supports direct program delivery. Staffing is the largest share of the request because consistent relationships are what drive results for participants. A detailed line-item budget is attached, and we are glad to provide any additional financial information ${funder} requires.`,
    sustainability: `${org} is diversifying funding through individual donors, local businesses and public contracts. Evidence gathered during this grant will strengthen future applications and partnerships, allowing the program to continue and grow after the grant period. Partners have committed to continuing in-kind support, and our board has made program sustainability a standing priority in its annual plan.`,
    intro: `${org} requests ${ask} from ${funder} to support ${program}, which serves ${who}. This work closely matches ${funder}'s priorities, and we would welcome the opportunity to submit a full proposal.`,
  };
  if (feedback) sections.summary = `${sections.summary} (Revised per feedback: ${feedback.slice(0, 80)})`;
  const piece: CopyPiece = {};
  for (const f of spec.fields) piece[f.key] = sections[f.key] ?? sections.program;
  if (spec.fields.length === GRANT_LOI_FIELDS) {
    // LOI sections are shorter: keep the first sentences.
    for (const f of spec.fields) piece[f.key] = trimWords(piece[f.key], f.maxWords ?? 200);
  }
  return piece;
}

const GRANT_LOI_FIELDS = 4;

function trimWords(text: string, max: number): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  let out = "";
  for (const sentence of sentences) {
    if (words(`${out} ${sentence}`) > max) break;
    out = `${out} ${sentence}`.trim();
  }
  return out || text.split(/\s+/).slice(0, max).join(" ");
}

function injectGrantDefect(p: CopyPiece, spec: CopySpec, roll: number) {
  if (roll >= 60) return;
  const first = spec.fields[0].key;
  if (roll < 12) p.need = `${p.need ?? ""} Studies show 78% of participants double their outcomes.`;
  else if (roll < 24 && spec.funder) for (const k of Object.keys(p)) p[k] = p[k].split(spec.funder).join("the Foundation");
  else if (roll < 36) p.program = `${p.program ?? ""} This program will guarantee lasting change for every family.`;
  else if (roll < 48 && p.objectives) p.objectives = `Goal: improve outcomes for participants. We will support participants and track how they are doing over the course of the grant.`;
  else p[first] = `${p[first]} ${p[first]} ${p[first]}`;
}

function editGrant(previous: CopyPiece, spec: CopySpec): CopyPiece {
  const p = { ...previous };
  const text = () => Object.values(p).join(" ");
  const first = spec.fields[0].key;
  for (const k of Object.keys(p)) p[k] = p[k].replace(/\s*This program will guarantee[^.]*\./g, " Our goal is lasting, measurable change for participants.").replace(/\bguarantee[sd]?\b/gi, "aim to secure");
  if (spec.funder && !text().toLowerCase().includes(spec.funder.toLowerCase()))
    p[first] = p[first].replace(/the Foundation/g, spec.funder);
  if (spec.ask && !text().replace(/,/g, "").includes(spec.ask.replace(/,/g, ""))) p[first] = `${p[first]} We are requesting ${spec.ask}.`;
  if (p.objectives && !/\d/.test(p.objectives))
    p.objectives = "Goal: improve outcomes for participants. Objective 1: by month 12, every enrolled participant will have a written personal plan reviewed at least 4 times. Objective 2: by month 6, launch 2 new partner referral pathways.";
  for (const f of spec.fields) if (f.maxWords && p[f.key] && words(p[f.key]) > f.maxWords) p[f.key] = trimWords(p[f.key], f.maxWords);
  return p;
}

function fit(s: string, max?: number): string {
  if (!max || s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const at = cut.lastIndexOf(" ");
  return (at > max * 0.5 ? cut.slice(0, at) : s.slice(0, max)).replace(/[,;:\s-]+$/, "");
}

function injectDefect(pieces: CopyPiece[], spec: CopySpec, defect: Defect, b: B) {
  const i = Math.min(1, pieces.length - 1);
  const p = pieces[i];
  if (!p || !defect) return;
  const mainKey = spec.format === "cold-email" ? "body" : spec.fields.find((f) => f.key === "primaryText")?.key ?? spec.fields[0].key;
  switch (defect) {
    case "length":
      if (spec.format === "cold-email")
        p.body = p.body.replace(/\n\n([^\n]+)$/, `\n\nWe've also put a lot of thought into onboarding, reporting, integrations with the tools you already use, and a support team that answers within the hour, because we know how much ${b.audience} juggle every single day and how little time there is to evaluate yet another vendor properly.\n\n$1`);
      else p.headline = `${p.headline} — ${"and everything else you need ".repeat(4).trim()}`;
      break;
    case "spam":
      p[mainKey] = `${p[mainKey]} Act now!!`.trim();
      break;
    case "tag":
      p.body = p.body.replace("{{first_name}}", "{{firstname}}");
      break;
    case "cta":
      p[mainKey] = p[mainKey]
        .split("\n")
        .filter((l) => !/\?\s*$/.test(l))
        .join("\n")
        .replace(/\b(Shop now|Get yours|Order today|Learn more[^.]*|Try it today)\.?/gi, "")
        .trim();
      for (const f of spec.fields) if (f.key !== mainKey && p[f.key]) p[f.key] = p[f.key].replace(/\b(shop|get|order|learn|try|read)\b/gi, "See");
      break;
    case "claim":
      p[mainKey] = `${p[mainKey]} Teams see 43% faster results.`;
      break;
    case "dupe":
      if (pieces[0]) p[spec.fields[0].key] = pieces[0][spec.fields[0].key];
      if (pieces[0] && mainKey !== spec.fields[0].key) p[mainKey] = pieces[0][mainKey];
      break;
  }
}

function simulateEdit(previous: CopyPiece[], spec: CopySpec): CopyPiece[] {
  if (spec.format === "grant-proposal") return previous.map((p) => editGrant(p, spec));
  return previous.map((orig) => {
    const p = { ...orig };
    for (const f of spec.fields) {
      let v = p[f.key] ?? "";
      for (const s of SPAM_PHRASES) v = v.replace(new RegExp(`\\s*${s.replace(/[$]/g, "\\$")}[!.]*`, "gi"), "");
      v = v.replace(/!{2,}/g, ".").replace(/\{\{\s*first_?name\s*\}\}/gi, "{{first_name}}").replace(/\{\{\s*company\s*\}\}/gi, "{{company}}");
      if (f.maxWords && words(v) > f.maxWords) {
        // Drop the longest paragraph that isn't the greeting or the CTA.
        const paras = v.split("\n\n");
        if (paras.length > 2) {
          const mid = paras.slice(1, -1);
          const longest = mid.reduce((a, c) => (c.length > a.length ? c : a), "");
          v = paras.filter((x) => x !== longest).join("\n\n");
        }
      }
      if (f.maxChars && v.length > f.maxChars && v.includes(" — ")) v = v.split(" — ")[0];
      v = fit(v, f.maxChars);
      p[f.key] = v.trim();
    }
    const text = Object.values(p).join("\n");
    if (!/\?\s*$/m.test(text) && !/\b(reply|book|shop|get|order|try|learn|call|chat|demo|see how|join)\b/i.test(text)) {
      if (spec.format === "cold-email") p.body = `${p.body}\n\n${spec.cta ?? "Worth a quick chat next week?"}`;
      else {
        const k = spec.fields.find((f) => f.key === "description") ?? spec.fields[spec.fields.length - 1];
        p[k.key] = fit(spec.cta ?? "Shop now", k.maxChars);
      }
    }
    // Claims and duplicate hooks are not the editor's job — QA escalates or regenerates those.
    return p;
  });
}

export async function writeCopy(req: WriteRequest): Promise<WriteResult> {
  if (astraMode() === "live") return liveWrite(req);
  return simulateWrite(req);
}

/** A small card image so text jobs have a thumbnail in lists. */
export function renderCopyProof(title: string, lines: string[], palette: string[]): string {
  const bg = palette[2] ?? "#f8fafc";
  const ink = palette[0] ?? "#1f2937";
  const accent = palette[1] ?? "#6366f1";
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const rows = lines
    .slice(0, 5)
    .map((l, i) => `<text x="24" y="${92 + i * 26}" font-family="Inter,Helvetica,Arial,sans-serif" font-size="14" fill="${ink}" opacity="${i ? 0.75 : 1}">${esc(l.slice(0, 50))}${l.length > 50 ? "…" : ""}</text>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270"><rect width="480" height="270" fill="${bg}"/><rect width="6" height="270" fill="${accent}"/><text x="24" y="50" font-family="Inter,Helvetica,Arial,sans-serif" font-size="18" font-weight="700" fill="${ink}">${esc(title.slice(0, 40))}</text>${rows}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
