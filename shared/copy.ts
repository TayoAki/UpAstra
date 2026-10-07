import type { CopyPiece, CopySpec, DeliverableSpec, QACheck, QAVerdict } from "./types";

// Copy has a concrete definition of "correct" that plain code can check:
// lengths, CTAs, spam phrases, merge tags, claims and distinct hooks. These
// checks run on every text output, live or simulated; Astra adds judgment
// (voice, persuasiveness) on top when it is connected.

export const SPAM_PHRASES = [
  "act now",
  "100% free",
  "risk-free",
  "risk free",
  "guaranteed",
  "guarantee",
  "click here",
  "limited time",
  "no obligation",
  "winner",
  "cash bonus",
  "urgent",
  "buy now",
  "$$$",
  "once in a lifetime",
  "double your",
];

const CTA_PATTERNS = [
  /\?\s*$/m, // cold emails usually end on a question
  /\b(reply|book|schedule|grab|shop|buy|order|try|get|start|join|claim|learn more|learn|see how|see why|sign up|download|watch|read|discover|explore|open to|worth a|interested|call|chat|demo)\b/i,
];

const CLAIM_PATTERN = /(\d+(?:\.\d+)?\s?%|\b\d+x\b|#1\b|\bnumber one\b|\bbest[- ]in[- ]class\b|\bfastest\b|\bcheapest\b|\bclinically\b|\bproven\b)/gi;

const ACRONYMS = new Set(["SAAS", "CRM", "ROI", "B2B", "B2C", "SEO", "API", "USA", "CEO", "CFO", "CTO", "VP", "HR", "DTC", "SKU", "FAQ", "AI"]);

export const words = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

/** Rough token estimate (in thousands) to price a text deliverable before writing it. */
export function copyUnits(d: Pick<DeliverableSpec, "quantity" | "copy">): number {
  const perPiece = (d.copy?.fields ?? []).reduce((n, f) => n + (f.maxWords ?? Math.ceil((f.maxChars ?? 200) / 5)), 0);
  const outputTokens = d.quantity * (perPiece * 1.4 + 40);
  const promptTokens = 900; // brief, client memory, rulebook
  return Math.round(((outputTokens + promptTokens) / 1000) * 100) / 100;
}

/** The piece's "lead" — used to check that hooks differ across pieces. */
function lead(p: CopyPiece, spec: CopySpec): string {
  const key = spec.format === "cold-email" ? "body" : (spec.fields[0]?.key ?? "headline");
  return (p[key] ?? "")
    .replace(/\{\{[^}]+\}\}/g, "")
    .replace(/^(hi|hey|hello)\b[^\n,]*,?\s*/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join(" ");
}

export interface CopyQA {
  verdict: QAVerdict;
  score: number;
  checks: QACheck[];
  /** Specific, actionable fixes for the editor model. */
  fixes: string[];
}

export function checkCopy(
  pieces: CopyPiece[],
  spec: CopySpec,
  /** sources: the brief, client notes and verified facts — every grant statistic must appear there. */
  opts: { quantity: number; approvedClaims?: string[]; sources?: string },
): CopyQA {
  const checks: QACheck[] = [];
  const fixes: string[] = [];
  const severity: QAVerdict[] = [];
  const fail = (rule: string, note: string, verdict: QAVerdict, fix?: string) => {
    checks.push({ rule, pass: false, note });
    severity.push(verdict);
    if (fix) fixes.push(fix);
  };
  const pass = (rule: string) => checks.push({ rule, pass: true });
  const label = (i: number) => (spec.format === "cold-email" ? `Email ${i + 1}` : spec.format === "grant-proposal" ? "Proposal" : `Variant ${i + 1}`);
  const grant = spec.format === "grant-proposal";

  // 1. Count
  if (pieces.length !== opts.quantity) fail(`${opts.quantity} pieces delivered`, `Got ${pieces.length}.`, "regenerate");
  else pass(`${opts.quantity} pieces delivered`);

  // 2. Lengths per field
  const lengthIssues: string[] = [];
  pieces.forEach((p, i) => {
    for (const f of spec.fields) {
      const v = p[f.key] ?? "";
      if (!v.trim()) lengthIssues.push(`${label(i)} is missing a ${f.label.toLowerCase()}`);
      else if (f.maxChars && v.length > f.maxChars) lengthIssues.push(`${label(i)} ${f.label.toLowerCase()} is ${v.length}/${f.maxChars} chars`);
      else if (f.maxWords && words(v) > f.maxWords) lengthIssues.push(`${label(i)} ${f.label.toLowerCase()} is ${words(v)}/${f.maxWords} words`);
      else if (f.minWords && words(v) < f.minWords) lengthIssues.push(`${label(i)} ${f.label.toLowerCase()} is only ${words(v)} words (min ${f.minWords})`);
    }
  });
  const lengthRule = `Every field within limits (${spec.fields.map((f) => `${f.label} ${f.maxChars ? `≤${f.maxChars} chars` : f.maxWords ? `≤${f.maxWords} words` : ""}`).join(", ")})`;
  if (lengthIssues.length) fail(lengthRule, lengthIssues.join("; "), "edit", `Fix lengths: ${lengthIssues.join("; ")}.`);
  else pass(lengthRule);

  // 3. CTA in every piece (sales copy only)
  const noCta = pieces
    .map((p, i) => ({ i, text: Object.values(p).join("\n") }))
    .filter(({ text }) => !grant && !CTA_PATTERNS.some((re) => re.test(text)))
    .map(({ i }) => label(i));
  if (grant) {
    // handled by grant checks below
  } else if (noCta.length) fail("Clear call to action in every piece", `No CTA in ${noCta.join(", ")}.`, "edit", `Add one clear call to action to ${noCta.join(", ")}${spec.cta ? ` (use: ${spec.cta})` : ""}.`);
  else pass("Clear call to action in every piece");

  // 4. Spam phrases, shouting, exclamation marks
  const spam: string[] = [];
  if (!grant) pieces.forEach((p, i) => {
    const text = Object.values(p).join(" ");
    const lower = text.toLowerCase();
    for (const s of SPAM_PHRASES) if (lower.includes(s)) spam.push(`${label(i)}: "${s}"`);
    const caps = (text.match(/\b[A-Z]{4,}\b/g) ?? []).filter((w) => !ACRONYMS.has(w));
    if (caps.length) spam.push(`${label(i)}: ALL CAPS "${caps[0]}"`);
    if ((text.match(/!/g) ?? []).length > 1) spam.push(`${label(i)}: multiple "!"`);
  });
  if (grant) {
    // no spam rule for proposals
  } else if (spam.length) fail("No spam-trigger phrases, ALL CAPS or stacked !", spam.join("; "), "edit", `Remove spam triggers: ${spam.join("; ")}.`);
  else pass("No spam-trigger phrases, ALL CAPS or stacked !");

  // 4b. Grant-specific definition of correct
  if (grant) {
    const text = pieces.map((p) => Object.values(p).join("\n")).join("\n");
    if (spec.funder) {
      if (!text.toLowerCase().includes(spec.funder.toLowerCase())) fail("Funder named and addressed", `${spec.funder} is never named.`, "edit", `Name ${spec.funder} and tie the program to its stated priorities in the summary and need sections.`);
      else pass("Funder named and addressed");
    }
    if (spec.ask) {
      const digits = spec.ask.replace(/[^\d]/g, "");
      const asks = (text.match(/\$\s?[\d,]+(?:\.\d+)?\s?[kKmM]?/g) ?? []).map((a) => a.replace(/[^\d]/g, ""));
      if (!asks.includes(digits)) fail("Requested amount stated and consistent", `The request of ${spec.ask} does not appear.`, "edit", `State the request of ${spec.ask} in the summary and budget narrative.`);
      else pass("Requested amount stated and consistent");
    }
    const objectives = pieces[0]?.objectives ?? pieces[0]?.program ?? "";
    if (!/\d|\bby (?:the end of|month|year|q[1-4]|january|february|march|april|may|june|july|august|september|october|november|december)/i.test(objectives))
      fail("Measurable objectives", "Objectives have no numbers or timeframes.", "edit", "Rewrite objectives as SMART: a number, a population and a date for each.");
    else pass("Measurable objectives");
    const promises = (text.match(/\b(guarantee[sd]?|will eliminate|will end|100% of|ensure that every|never again)\b/gi) ?? []);
    if (promises.length) fail("No unsupported promises", `Overpromising: "${promises[0]}".`, "edit", `Replace absolute promises (${[...new Set(promises)].join(", ")}) with realistic, evidence-based language.`);
    else pass("No unsupported promises");
  }

  // 5. Merge tags
  if (spec.mergeTags?.length) {
    const bad = pieces.flatMap((p, i) =>
      Object.values(p)
        .flatMap((v) => v.match(/\{\{?[^{}]*\}?\}|\[[A-Z_ ]+\]/g) ?? [])
        .filter((t) => !spec.mergeTags!.includes(t))
        .map((t) => `${label(i)}: ${t}`),
    );
    const rule = `Merge tags valid (${spec.mergeTags.join(", ")})`;
    if (bad.length) fail(rule, `Broken or unknown tags — ${bad.join("; ")}`, "edit", `Replace broken merge tags (${bad.join("; ")}) with ${spec.mergeTags.join(", ")}.`);
    else pass(rule);
  }

  // 6. Claims must be approved — a person decides anything new
  if (grant) {
    const raw = `${opts.sources ?? ""} ${(opts.approvedClaims ?? []).join(" ")} ${spec.ask ?? ""}`.replace(/,/g, "");
    // "$75k" in the brief supports "$75000" in the proposal.
    const expanded = raw.replace(/(\d+(?:\.\d+)?)\s?([kKmM])\b/g, (_, n: string, u: string) => `${n}${u} ${Math.round(parseFloat(n) * (u.toLowerCase() === "k" ? 1e3 : 1e6))}`);
    const sources = expanded;
    const nums = [
      ...new Set(
        pieces
          .flatMap((p) => Object.values(p).flatMap((v) => v.match(/\$?\d[\d,]*(?:\.\d+)?%?/g) ?? []))
          .map((n) => n.replace(/[$,]/g, ""))
          .filter((n) => {
            const v = parseFloat(n);
            return !(v <= 12 && !n.endsWith("%")) && !(v >= 1990 && v <= 2099 && !n.includes("."));
          }),
      ),
    ];
    const unsupported = nums.filter((n) => !sources.includes(n.replace(/%$/, "")));
    if (unsupported.length) fail("Every statistic traceable to a source", `Not found in the org's data or brief: ${unsupported.join(", ")}.`, "human");
    else pass("Every statistic traceable to a source");
  }
  const approved = (opts.approvedClaims ?? []).join(" ").toLowerCase();
  const claims = [
    ...new Set(
      pieces.flatMap((p) => Object.values(p).flatMap((v) => v.match(CLAIM_PATTERN) ?? [])).filter((c) => !approved.includes(c.toLowerCase().replace(/\s/g, ""))),
    ),
  ].filter((c) => !approved.includes(c.toLowerCase()));
  if (grant) {
    // numbers handled above
  } else if (claims.length) fail("Only approved claims", `Unapproved claim(s): ${claims.join(", ")} — needs sign-off or proof.`, "human");
  else pass("Only approved claims");

  // 7. Distinct hooks
  const leads = pieces.map((p) => lead(p, spec)).filter(Boolean);
  const dupes = leads.filter((l, i) => leads.indexOf(l) !== i);
  const hookRule = spec.format === "cold-email" ? "Each email opens with a different angle" : "Each variant uses a distinct hook";
  if (dupes.length) fail(hookRule, `Repeated opening: "${dupes[0]}…"`, "regenerate");
  else pass(hookRule);

  const verdict: QAVerdict = severity.includes("human") ? "human" : severity.includes("regenerate") ? "regenerate" : severity.includes("edit") ? "edit" : "ready";
  const score = Math.max(30, 100 - severity.length * 14);
  return { verdict, score, checks, fixes };
}

export function copyToMarkdown(title: string, label: string, spec: CopySpec | undefined, pieces: CopyPiece[]): string {
  const lines = [`# ${title}`, "", `## ${label}${spec?.platform ? ` (${spec.platform})` : ""}`, ""];
  pieces.forEach((p, i) => {
    if (spec?.format === "grant-proposal") {
      for (const f of spec.fields) if (p[f.key] !== undefined) lines.push(`### ${f.label}`, "", p[f.key], "");
      return;
    }
    lines.push(`### ${spec?.format === "cold-email" ? `Email ${i + 1}` : `Variant ${i + 1}`}`, "");
    for (const f of spec?.fields ?? Object.keys(p).map((key) => ({ key, label: key }))) {
      if (p[f.key] !== undefined) lines.push(`**${f.label}:** ${p[f.key].includes("\n") ? `\n\n${p[f.key]}` : p[f.key]}`, "");
    }
  });
  return lines.join("\n");
}
