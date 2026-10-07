import type { Lead, LeadSource, SavedSearch } from "../shared/types";
import { hash } from "./higgsfield";
import { newId, now } from "./store";

// Scraping through Apify. Any actor that returns job-like dataset items works:
// set the actor per saved search, or a platform default per source with
// APIFY_ACTOR_UPWORK / APIFY_ACTOR_FIVERR / APIFY_ACTOR_LINKEDIN / … .
// Item fields vary between actors, so normalizeItem() maps the common shapes.

export const apifyConfigured = () => !!process.env.APIFY_TOKEN;

export function defaultActor(source: LeadSource): string {
  return process.env[`APIFY_ACTOR_${source.toUpperCase()}`] ?? "";
}

/** Replace {{query}} / {{maxItems}} placeholders anywhere in the actor input. */
export function buildInput(search: SavedSearch): unknown {
  const fill = (v: unknown): unknown =>
    typeof v === "string"
      ? v === "{{maxItems}}"
        ? search.maxItems
        : v.replace(/\{\{query\}\}/g, search.query).replace(/\{\{maxItems\}\}/g, String(search.maxItems))
      : Array.isArray(v)
        ? v.map(fill)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]))
          : v;
  return fill(Object.keys(search.input).length ? search.input : { query: "{{query}}", searchQuery: "{{query}}", maxItems: "{{maxItems}}" });
}

export async function runActor(actorId: string, input: unknown, maxItems: number): Promise<Record<string, unknown>[]> {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error("APIFY_TOKEN is not set");
  const id = actorId.replace("/", "~");
  const url = `https://api.apify.com/v2/acts/${encodeURIComponent(id)}/run-sync-get-dataset-items?timeout=240&maxItems=${maxItems}&clean=true`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(300_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Apify ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  return Array.isArray(data) ? data : [];
}

// ---------------------------------------------------------------------------
// Normalization

const pick = (o: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) {
    const v = k.split(".").reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined), o);
    if (v !== undefined && v !== null && v !== "") return v;
  }
};
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
const num = (v: unknown): number | undefined => {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const m = v.replace(/,/g, "").match(/-?\d+(?:\.\d+)?\s*[kK]?/);
    if (!m) return;
    const n = parseFloat(m[0]);
    return /k$/i.test(m[0].trim()) ? n * 1000 : n;
  }
};

export function parseBudget(raw: unknown, hourlyHint?: boolean): Lead["budget"] {
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const min = num(pick(o, "min", "minimum", "from", "amount", "value"));
    const max = num(pick(o, "max", "maximum", "to")) ?? min;
    if (min === undefined && max === undefined) return;
    const type = /hour/i.test(String(pick(o, "type", "kind") ?? "")) || hourlyHint ? "hourly" : "fixed";
    return { type, min, max, currency: String(pick(o, "currency", "currencyCode") ?? "USD") };
  }
  const s = str(raw);
  if (!s) return;
  const nums = [...s.replace(/,/g, "").matchAll(/\d+(?:\.\d+)?\s*[kK]?/g)].map((m) => num(m[0])!).filter((n) => n > 0);
  if (!nums.length) return;
  return { type: /hour|\/hr|per hour/i.test(s) || hourlyHint ? "hourly" : "fixed", min: Math.min(...nums), max: Math.max(...nums), currency: "USD" };
}

export function normalizeItem(raw: Record<string, unknown>, source: LeadSource, searchId?: string): Lead | null {
  const title = str(pick(raw, "title", "jobTitle", "name", "position", "gigTitle"));
  const description = str(pick(raw, "description", "jobDescription", "descriptionText", "snippet", "body", "content", "summary", "text"));
  if (!title && !description) return null;
  const url = str(pick(raw, "url", "link", "jobUrl", "jobLink", "href", "applyUrl"));
  const hourly = /hour/i.test(String(pick(raw, "jobType", "type", "paymentType") ?? ""));
  const budget = parseBudget(pick(raw, "budget", "amount", "price", "fixedPrice", "hourlyRange", "hourlyBudget", "salary", "rate"), hourly);
  const skillsRaw = pick(raw, "skills", "tags", "categories", "skillTags");
  const skills = Array.isArray(skillsRaw) ? skillsRaw.map((s) => (typeof s === "string" ? s : str((s as Record<string, unknown>)?.name) ?? "")).filter(Boolean) : [];
  const verified = pick(raw, "client.paymentVerified", "clientPaymentVerified", "paymentVerified", "buyer.verified");
  return {
    id: newId("lead"),
    searchId,
    source,
    externalId: str(pick(raw, "id", "jobId", "uid", "ciphertext", "gigId")) ?? `h${hash(`${url ?? ""}${title ?? ""}`)}`,
    url,
    title: (title ?? description!.slice(0, 80)).trim(),
    description: (description ?? title!).trim().slice(0, 8000),
    budget,
    postedAt: str(pick(raw, "postedAt", "publishedAt", "createdAt", "datePosted", "postedOn", "date")),
    client: {
      country: str(pick(raw, "client.country", "clientCountry", "country", "location", "buyer.country")),
      paymentVerified: typeof verified === "boolean" ? verified : typeof verified === "string" ? /true|verified|yes/i.test(verified) : undefined,
      totalSpent: num(pick(raw, "client.totalSpent", "clientTotalSpent", "totalSpent", "client.spent")),
      hireRate: num(pick(raw, "client.hireRate", "clientHireRate", "hireRate")),
      rating: num(pick(raw, "client.rating", "clientRating", "rating", "client.feedbackScore")),
    },
    proposalsCount: num(pick(raw, "proposals", "proposalsCount", "numberOfProposals", "applicants", "applicantsCount")),
    skills,
    status: "new",
    scrapedAt: now(),
  };
}

// ---------------------------------------------------------------------------
// Simulated scraping: a realistic mix of good, borderline and bad fits.

const SAMPLE_POSTS: Record<string, unknown>[] = [
  { title: "Cold email sequence for B2B SaaS (5 emails)", description: "We sell inventory software to independent restaurants. Need a 5-email cold outreach sequence targeting restaurant owners with 1-3 locations. CTA is book a 15 minute demo. We have 3 case studies. Due by Friday.", budget: "$300", client: { paymentVerified: true, totalSpent: 12000, hireRate: 80, rating: 4.9, country: "United States" }, proposals: 8 },
  { title: "Amazon lifestyle images for kitchen product", description: "Need 4 lifestyle images 1:1 png for our Amazon listing — bamboo cutting board set. Product photos attached. Warm kitchen setting. Within 3 days.", budget: "$180", client: { paymentVerified: true, totalSpent: 4200, hireRate: 65, rating: 4.7, country: "Canada" }, proposals: 14 },
  { title: "Grant writer for youth arts nonprofit", description: 'Seeking a grant writer for a $40k proposal to the Riverside Community Foundation for our after-school arts program "Canvas". We served 180 students in 2025 across 3 schools. Foundation guidelines attached. Due by November 20th.', budget: "$900", client: { paymentVerified: true, totalSpent: 2500, rating: 5, country: "United States" }, proposals: 11 },
  { title: "Meta ad copy — 10 variations for skincare", description: "Need 10 Meta ad copy variations (headline, primary text, description) for our vitamin C serum, aimed at women 30-45. Approved claims list provided. Within 2 days.", budget: "$150", client: { paymentVerified: true, totalSpent: 30000, hireRate: 70, rating: 4.8 }, proposals: 22 },
  { title: "15s product video for TikTok", description: "Looking for a 15 second 9:16 mp4 product video of our wireless earbuds, dynamic camera moves, urban night vibe. Product photos attached. Need by next Friday.", budget: "$400", client: { paymentVerified: true, totalSpent: 800, rating: 4.4 }, proposals: 30 },
  { title: "Logo + full brand identity, unlimited revisions", description: "Need a logo, brand guide and social templates for my startup. Unlimited revisions until I love it. Budget is tight.", budget: "$50", client: { paymentVerified: false }, proposals: 55 },
  { title: "Video ad with celebrity lookalike", description: "Need a 10 second ad where a guy who looks like Drake drinks our energy drink. 9:16. ASAP.", budget: "$250", client: { paymentVerified: true, totalSpent: 150 }, proposals: 6 },
  { title: "Free test article then long term work", description: "Write a free test sample first, then we discuss. Contact me on WhatsApp for details. Paying $5 per article after.", budget: "$5", client: { paymentVerified: false }, proposals: 70 },
  { title: "Letter of inquiry for food bank", description: "Need a letter of inquiry (LOI) requesting $25,000 from the Hartwell Family Foundation for our weekend meals program. 1,800 children received weekend meal kits in 2025. Due within 7 days.", budget: "$250", client: { paymentVerified: true, totalSpent: 600, rating: 5 }, proposals: 4 },
  { title: "Google Ads headlines for HVAC company", description: "Need 15 Google ads headlines and descriptions for our HVAC repair service, aimed at homeowners in Phoenix. Within 2 days.", budget: "$15-$30 /hr", jobType: "hourly", client: { paymentVerified: true, totalSpent: 9000, hireRate: 90, rating: 4.9 }, proposals: 9 },
  { title: "Python developer for data pipeline", description: "Need a Python developer to build an ETL pipeline from Postgres to BigQuery with Airflow. 3 month contract.", budget: "$5,000", client: { paymentVerified: true, totalSpent: 50000 }, proposals: 40 },
  { title: "Franchise promo localization — 12 locations", description: "We have a national campaign and need local versions for 12 franchise locations with each address, phone number and price. Disclaimer required. Spreadsheet attached. Within 5 days.", budget: "$1,200", client: { paymentVerified: true, totalSpent: 22000, hireRate: 75, rating: 4.8 }, proposals: 7 },
];

export function simulatedItems(search: SavedSearch): Record<string, unknown>[] {
  const q = search.query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const scored = SAMPLE_POSTS.map((p, i) => ({ p, i, hit: q.some((w) => `${p.title} ${p.description}`.toLowerCase().includes(w)) }));
  // Relevant posts first, then the rest — real marketplace searches are noisy too.
  const ordered = [...scored.filter((x) => x.hit), ...scored.filter((x) => !x.hit)].slice(0, Math.min(search.maxItems, SAMPLE_POSTS.length));
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
  return ordered.map(({ p, i }) => ({
    ...p,
    id: `sim-${search.source}-${i}`,
    url: `https://www.${search.source === "custom" ? "example" : search.source}.com/jobs/~sim${i}`,
    postedAt: hoursAgo((i * 7) % 60),
  }));
}
