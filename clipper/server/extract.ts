import type { CampaignBrief, LinkRef, Platform } from "../shared/types";
import { PLATFORMS } from "../shared/types";
import { aiLive, chatJSON } from "./llm";

// Brief → structured campaign. The AI reads it when a key is configured; a
// rules extractor covers the common brief layout otherwise (and backs up the
// AI when it fails). Neither invents values: missing fields stay empty.

const SYSTEM = `You read short-form "clipping" campaign briefs (creators get paid per view to post clips promoting a product, game, app or creator).
Extract every rule a clipper must follow. Never invent values — leave a field empty when the brief doesn't say.
Return JSON with exactly these keys:
{"title": campaign name, "brand": who runs it, "product": what is promoted, "productUrl": main product/game link or "",
 "summary": 1-2 sentences, "goal": the funnel goal,
 "platforms": subset of ["tiktok","instagram","youtube","x","facebook","snapchat"] (cross-posting to all = tiktok, instagram, youtube),
 "requiredPhrases": words/names that must be spoken in every video,
 "cta": {"text": the call to action as a short imperative, e.g. "Play Car League on Roblox", "placement": "end" | "anywhere"},
 "hookExamples": example hooks quoted in the brief, "contentIdeas": other concept ideas,
 "keyFacts": true facts about the product that clips may state (features, how it works),
 "dos": requirements and quality rules, "donts": things that get videos rejected,
 "bannedClaims": specific claims that must never be made,
 "accountRequirements": rules about which accounts may post,
 "minEngagementRate": number (0.01 for 1%) or null,
 "lengthSec": {"min": number, "max": number} or null,
 "payout": {"budget": number|null, "cpm": number|null (USD per 1,000 views), "maxPerSubmission": number|null, "minViews": number|null, "currency": "USD"},
 "footage": [{"label","url"}] links to footage/asset folders, "otherLinks": [{"label","url"}] any other links,
 "deadline": string or ""}`;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" && v.trim() ? [v] : [])
    .map((x) => (typeof x === "string" ? x : x && typeof x === "object" ? String(Object.values(x).find((y) => typeof y === "string") ?? "") : ""))
    .map((x) => x.trim())
    .filter(Boolean);
const num = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[$,\s]/g, "")) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
const links = (v: unknown): LinkRef[] =>
  (Array.isArray(v) ? v : [])
    .map((x) => (typeof x === "string" ? { label: x, url: x } : { label: str(x?.label) || str(x?.url), url: str(x?.url) }))
    .filter((l) => /^https?:\/\//.test(l.url));

/** Coerce anything model-shaped into a complete, valid brief. */
export function normalizeBrief(raw: Partial<Record<keyof CampaignBrief, unknown>>, fallback?: CampaignBrief): CampaignBrief {
  const f = fallback;
  const pick = <T,>(a: T, b: T | undefined, empty: (x: T) => boolean) => (empty(a) && b !== undefined ? b : a);
  const isEmptyList = (x: unknown[]) => x.length === 0;
  const isEmptyStr = (x: string) => !x;
  const cta = (raw.cta ?? {}) as { text?: unknown; placement?: unknown };
  const payout = (raw.payout ?? {}) as Record<string, unknown>;
  const len = (raw.lengthSec ?? {}) as { min?: unknown; max?: unknown };
  const platforms = list(raw.platforms)
    .map((p) => p.toLowerCase().replace(/ shorts|reels/, "").trim())
    .map((p) => (p === "twitter" ? "x" : p))
    .filter((p): p is Platform => (PLATFORMS as string[]).includes(p));
  const min = num(len.min) ?? f?.lengthSec.min ?? 15;
  const max = num(len.max) ?? f?.lengthSec.max ?? 60;
  return {
    title: pick(str(raw.title), f?.title, isEmptyStr) || "Untitled campaign",
    brand: pick(str(raw.brand), f?.brand, isEmptyStr),
    product: pick(str(raw.product), f?.product, isEmptyStr),
    productUrl: pick(str(raw.productUrl), f?.productUrl ?? "", isEmptyStr) || undefined,
    summary: pick(str(raw.summary), f?.summary, isEmptyStr),
    goal: pick(str(raw.goal), f?.goal, isEmptyStr),
    platforms: pick([...new Set(platforms)], f?.platforms, isEmptyList),
    requiredPhrases: pick(list(raw.requiredPhrases), f?.requiredPhrases, isEmptyList),
    cta: {
      text: str(cta.text) || f?.cta.text || "",
      placement: cta.placement === "anywhere" ? "anywhere" : cta.placement === "end" ? "end" : (f?.cta.placement ?? "end"),
    },
    hookExamples: pick(list(raw.hookExamples), f?.hookExamples, isEmptyList),
    contentIdeas: pick(list(raw.contentIdeas), f?.contentIdeas, isEmptyList),
    keyFacts: pick(list(raw.keyFacts), f?.keyFacts, isEmptyList),
    dos: pick(list(raw.dos), f?.dos, isEmptyList),
    donts: pick(list(raw.donts), f?.donts, isEmptyList),
    bannedClaims: pick(list(raw.bannedClaims), f?.bannedClaims, isEmptyList),
    accountRequirements: pick(list(raw.accountRequirements), f?.accountRequirements, isEmptyList),
    minEngagementRate: (() => {
      const n = num(raw.minEngagementRate);
      return n === undefined ? f?.minEngagementRate : n > 1 ? n / 100 : n;
    })(),
    lengthSec: { min: Math.min(min, max), max: Math.max(min, max) },
    payout: {
      budget: num(payout.budget) ?? f?.payout.budget,
      cpm: num(payout.cpm) ?? f?.payout.cpm,
      maxPerSubmission: num(payout.maxPerSubmission) ?? f?.payout.maxPerSubmission,
      minViews: num(payout.minViews) ?? f?.payout.minViews,
      currency: str(payout.currency) || "USD",
    },
    footage: pick(links(raw.footage), f?.footage, isEmptyList),
    otherLinks: pick(links(raw.otherLinks), f?.otherLinks, isEmptyList),
    deadline: str(raw.deadline) || f?.deadline || undefined,
  };
}

// ---------------------------------------------------------------------------
// Rules extractor

const money = (s: string | undefined) => {
  if (!s) return undefined;
  const m = s.replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*(k|m)?/i);
  if (!m) return undefined;
  return Number(m[1]) * (m[2]?.toLowerCase() === "k" ? 1000 : m[2]?.toLowerCase() === "m" ? 1e6 : 1);
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isHeading = (l: string) => l.length <= 60 && !/^[*•\-–]/.test(l) && !/[.:,;!?]$/.test(l) && !/https?:/.test(l) && /^[A-Z]/.test(l) && l.split(/\s+/).length <= 8;
const bullet = (l: string) => l.replace(/^[*•\-–]\s*/, "").trim();
const isFootageLink = (l: LinkRef) => /drive\.google\.com|dropbox\.com|wetransfer|frame\.io|mega\.nz|box\.com/.test(l.url) || /footage|assets|clips|b-?roll|backup/i.test(l.label);

export function extractWithRules(text: string, docLinks: LinkRef[] = []): CampaignBrief {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const sections: Record<string, string[]> = {};
  let current = "intro";
  for (const l of lines) {
    if (isHeading(l)) current = l.toLowerCase();
    else (sections[current] ??= []).push(l);
  }
  const sec = (re: RegExp) => Object.entries(sections).filter(([h]) => re.test(h)).flatMap(([, ls]) => ls);
  const all = lines.join("\n");

  // Links: from the doc's link list plus any bare URLs in the text.
  const found: LinkRef[] = [...docLinks];
  for (const l of lines) for (const m of l.matchAll(/https?:\/\/[^\s)]+/g)) if (!found.some((x) => x.url === m[0])) found.push({ label: l.split(/[:(]/)[0].trim() || m[0], url: m[0] });
  const footage = found.filter(isFootageLink);
  const otherLinks = found.filter((l) => !isFootageLink(l));

  // Required phrases: `The name "X" must be spoken`, `must say "X"`, `mention "X"`.
  const requiredPhrases = [...all.matchAll(/["“]([^"”]{2,40})["”][^.\n]{0,40}\bmust be (?:spoken|said|mentioned)|\bmust (?:say|mention|include)\s+["“]([^"”]{2,40})["”]/gi)].map((m) => (m[1] ?? m[2]).trim());

  const product = requiredPhrases[0] ?? otherLinks[0]?.url.match(/\/([A-Za-z][\w-]{2,40})\/?$/)?.[1]?.replace(/-/g, " ") ?? "";
  const ctaLine = lines.find((l) => /\bcta\b|call to action|encourag\w* viewers to/i.test(l) && /\bto\b/i.test(l)) ?? "";
  const ctaVerb = (all.match(/encourag\w* viewers to ([^.\n]+?)(?:\s+near the end| at the end|\.|$)/i)?.[1] ?? ctaLine.match(/\bcta to ([^.\n,]+)/i)?.[1] ?? "").trim();
  const ctaText = ctaVerb ? cap(ctaVerb.replace(/\bit\b/i, product || "it").replace(/\bthe game\b/i, product || "the game")) : "";

  const platforms = new Set<Platform>();
  if (/tiktok/i.test(all)) platforms.add("tiktok");
  if (/instagram|reels/i.test(all)) platforms.add("instagram");
  if (/youtube|shorts/i.test(all)) platforms.add("youtube");
  if (/\btwitter\b|\bx\.com\b/i.test(all)) platforms.add("x");
  if (/facebook/i.test(all)) platforms.add("facebook");
  if (/snapchat/i.test(all)) platforms.add("snapchat");
  if (/cross-?post\w* to all platforms/i.test(all)) ["tiktok", "instagram", "youtube"].forEach((p) => platforms.add(p as Platform));

  const ruleLines = [...sec(/requirement|rules|guideline/), ...sec(/quality|approval|standard/)].map(bullet);
  const donts = ruleLines.filter((l) => /^(do not|don'?t|no |never|avoid)|will be rejected|may be rejected|not allowed/i.test(l));
  const dos = ruleLines.filter((l) => !donts.includes(l) && !/account|engagement rate/i.test(l));
  const hookLines = sec(/hook|content idea|example/).map(bullet);
  const hookExamples = hookLines.flatMap((l) => [...l.matchAll(/["“]([^"”]{6,140})["”]/g)].map((m) => m[1].trim()));
  const len = all.match(/(\d{1,3})\s*(?:-|–|to)\s*(\d{1,3})\s*(?:s\b|sec|second)/i);
  const eng = all.match(/(\d+(?:\.\d+)?)\s*%\s*engagement/i);

  return normalizeBrief({
    title: product ? `${product} clipping campaign` : (lines[0] ?? "").slice(0, 80),
    product,
    productUrl: otherLinks[0]?.url ?? "",
    summary: sec(/goal|about|overview/)[0] ?? "",
    goal: sec(/goal/).join(" "),
    platforms: [...platforms],
    requiredPhrases,
    cta: { text: ctaText, placement: /near the end|at the end|end of the video/i.test(all) ? "end" : "anywhere" },
    hookExamples,
    contentIdeas: hookLines.filter((l) => !/["“]/.test(l) && !/^these are examples/i.test(l)),
    keyFacts: sec(/^the game|^the product|about|what (?:players|users) can do|features|how it works/).map(bullet),
    dos,
    donts,
    bannedClaims: donts.filter((l) => /invent|official|misleading|claim|codes?|rewards?|partner|collab|guarantee/i.test(l)),
    accountRequirements: ruleLines.filter((l) => /account|followers|creator/i.test(l) && !/^do not/i.test(l)),
    minEngagementRate: eng ? Number(eng[1]) / 100 : undefined,
    lengthSec: len ? { min: Number(len[1]), max: Number(len[2]) } : undefined,
    payout: {
      budget: money(all.match(/budget[^\n$\d]{0,20}\$?\s*([\d,.]+\s*[km]?)/i)?.[1]),
      cpm: money(all.match(/\bcpm[^\n$\d]{0,20}\$?\s*([\d.]+)/i)?.[1] ?? all.match(/\$\s*([\d.]+)\s*(?:per|\/)\s*(?:1,?000|1k|thousand) views/i)?.[1]),
      maxPerSubmission: money(all.match(/max(?:imum)? payout[^\n$\d]{0,20}\$?\s*([\d,.]+\s*[km]?)/i)?.[1]),
      minViews: money(all.match(/min(?:imum)?\s*(?:of\s*)?([\d,.]+\s*[km]?)\s*views/i)?.[1]),
      currency: "USD",
    },
    footage,
    otherLinks,
    deadline: all.match(/(?:deadline|ends?|due)\s*[:\-]?\s*([A-Z][a-z]+ \d{1,2}(?:st|nd|rd|th)?(?:,? \d{4})?)/)?.[1] ?? "",
  } as Partial<Record<keyof CampaignBrief, unknown>>);
}

/** AI extraction with the rules result filling any gaps; rules only when no AI. */
export async function extractBrief(text: string, docLinks: LinkRef[] = []): Promise<{ brief: CampaignBrief; by: "ai" | "rules"; model?: string; cost: number }> {
  const rules = extractWithRules(text, docLinks);
  if (!aiLive()) return { brief: rules, by: "rules", cost: 0 };
  try {
    const r = await chatJSON<Record<string, unknown>>("extract", SYSTEM, { brief: text.slice(0, 30_000), links: docLinks });
    const brief = normalizeBrief(r.json as Partial<Record<keyof CampaignBrief, unknown>>, rules);
    // Links are facts from the document: keep every footage link the rules found.
    for (const l of rules.footage) if (!brief.footage.some((x) => x.url === l.url)) brief.footage.push(l);
    return { brief, by: "ai", model: r.model, cost: r.cost };
  } catch (err) {
    console.warn("[extract] AI failed, using rules:", (err as Error).message);
    return { brief: rules, by: "rules", cost: 0 };
  }
}
