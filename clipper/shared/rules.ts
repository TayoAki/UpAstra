import type { CampaignBrief, CampaignStats, Clip, ClipStatus, Post, QACheck } from "./types";

// Plain-code rules shared by the server and the dashboard: what a post earns,
// how engaged it is, and whether a clip plan follows the brief.

/** Posts that are (or were) actually live: not rejected, not still scheduled, not failed to publish. */
export const countsAsPost = (p: { status: string }) => p.status !== "rejected" && p.status !== "scheduled" && p.status !== "failed";

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const fmtUSD = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: n < 100 && n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
export const fmtNum = (n: number) => (n >= 1e6 ? `${round2(n / 1e6)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n.toLocaleString("en-US"));
export const fmtPct = (n: number) => `${round2(n * 100)}%`;

export const engagementRate = (m: Post["metrics"]) => (m.views > 0 ? (m.likes + m.comments + m.shares) / m.views : 0);

/** What a post should earn under the brief's payout terms (or what it was actually paid). */
export function postEarnings(post: Post, payout: CampaignBrief["payout"]): number {
  if (!countsAsPost(post)) return 0;
  if (typeof post.paidAmount === "number") return post.paidAmount;
  if (!payout.cpm) return 0;
  if (payout.minViews && post.metrics.views < payout.minViews) return 0;
  const raw = (post.metrics.views / 1000) * payout.cpm;
  return round2(payout.maxPerSubmission ? Math.min(raw, payout.maxPerSubmission) : raw);
}

export function campaignStats(brief: CampaignBrief, clips: Clip[], posts: Post[]): CampaignStats {
  const clipsByStatus = { draft: 0, approved: 0, rendering: 0, ready: 0, posted: 0, rejected: 0 } as Record<ClipStatus, number>;
  for (const c of clips) clipsByStatus[c.status]++;
  const live = posts.filter(countsAsPost);
  const views = live.reduce((s, p) => s + p.metrics.views, 0);
  const interactions = live.reduce((s, p) => s + p.metrics.likes + p.metrics.comments + p.metrics.shares, 0);
  const estimatedEarnings = round2(posts.reduce((s, p) => s + postEarnings(p, brief.payout), 0));
  return {
    clips: clips.length,
    clipsByStatus,
    posts: posts.filter((p) => p.status !== "scheduled" && p.status !== "failed").length,
    scheduled: posts.filter((p) => p.status === "scheduled").length,
    views,
    engagementRate: views ? interactions / views : 0,
    estimatedEarnings,
    paid: round2(posts.reduce((s, p) => s + (p.status === "paid" ? (p.paidAmount ?? postEarnings(p, brief.payout)) : 0), 0)),
    budgetShare: brief.payout.budget ? round2(Math.min(estimatedEarnings, brief.payout.budget)) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Clip QA

export const WORDS_PER_SECOND = 2.6;
export const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
const STOP = new Set(["the", "a", "an", "to", "on", "in", "and", "or", "of", "for", "it", "now", "your", "you", "this", "that", "with", "at", "go", "is"]);
const significant = (s: string) => norm(s).split(" ").filter((w) => w.length > 2 && !STOP.has(w));

/** Words in a claim that, if they show up in a script, probably make it. */
function bannedTriggers(claims: string[]): { word: RegExp; claim: string }[] {
  const out: { word: RegExp; claim: string }[] = [];
  for (const c of claims) {
    const l = c.toLowerCase();
    if (/official|affiliat|partner|collab|endorse/.test(l)) out.push({ word: /\b(official|officially|partnered|partnership|collab(?:oration)?|endorsed|affiliated)\b/i, claim: c });
    if (/\bcodes?\b/.test(l)) out.push({ word: /\bcodes?\b/i, claim: c });
    if (/reward|free robux|giveaway|prize/.test(l)) out.push({ word: /\b(free robux|giveaway|prizes?|rewards?)\b/i, claim: c });
    if (/guarantee/.test(l)) out.push({ word: /\bguarantee[sd]?\b/i, claim: c });
    for (const q of c.matchAll(/["“]([^"”]{3,60})["”]/g)) out.push({ word: new RegExp(q[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), claim: c });
  }
  return out;
}

export function checkClip(clip: Pick<Clip, "hook" | "narration" | "cta" | "lengthSec" | "onScreenText" | "shots"> & Partial<Pick<Clip, "render">>, brief: CampaignBrief): { pass: boolean; checks: QACheck[] } {
  const checks: QACheck[] = [];
  const spoken = norm(clip.narration);
  const all = norm([clip.narration, ...clip.onScreenText].join(" "));

  // 1. Required phrases are said out loud.
  for (const phrase of brief.requiredPhrases) {
    const ok = spoken.includes(norm(phrase));
    checks.push({ rule: `"${phrase}" is spoken`, pass: ok, note: ok ? undefined : "Say it in the voiceover — text on screen doesn't count." });
  }

  // 2. A hook up front.
  const hookWords = words(clip.hook);
  checks.push({ rule: "Opens with a short hook (≤ 14 words)", pass: hookWords > 0 && hookWords <= 14, note: hookWords ? `${hookWords} words` : "No hook" });

  // 3. CTA where the brief wants it.
  if (brief.cta.text) {
    const sentences = clip.narration.split(/(?<=[.!?])\s+/).filter(Boolean);
    const tail = norm(brief.cta.placement === "end" ? sentences.slice(-2).join(" ") : clip.narration);
    const want = significant(brief.cta.text);
    // An action ("play", "download"…) plus most of the CTA's other words.
    const [verb, ...rest] = want;
    const acted = !verb || new RegExp(`\\b(${verb}|play|try|download|get|join|search|check out|visit|tap|click|grab|install)\\b`).test(tail);
    const hits = rest.filter((w) => tail.includes(w)).length;
    const ok = want.length ? acted && (!rest.length || hits / rest.length >= 0.6) : tail.length > 0;
    checks.push({ rule: brief.cta.placement === "end" ? "Call to action in the last lines" : "Call to action included", pass: ok, note: ok ? undefined : `Expected something like "${brief.cta.text}"` });
  }

  // 4. Length fits the brief and the voiceover fits the length.
  const { min, max } = brief.lengthSec;
  checks.push({ rule: `Length ${min}–${max}s`, pass: clip.lengthSec >= min && clip.lengthSec <= max, note: `${clip.lengthSec}s planned` });
  // After a voiced render the real spoken length is known; before, estimate it from the word count.
  const measured = clip.render?.status === "done" && clip.render.voice !== "none" ? clip.render.spokenSec : undefined;
  const talk = Math.round(measured ?? words(clip.narration) / WORDS_PER_SECOND);
  checks.push({ rule: "Voiceover fits the clip", pass: talk <= clip.lengthSec + 2, note: measured !== undefined ? `${talk}s spoken` : `~${talk}s of narration` });

  // 5. No banned claims.
  const hits = bannedTriggers(brief.bannedClaims).filter((t) => t.word.test(all));
  checks.push({ rule: "No banned claims", pass: !hits.length, note: hits.length ? `Check: ${[...new Set(hits.map((h) => h.claim))].join(" · ")}` : undefined });

  // 6. Every shot points at real footage.
  if (clip.shots.length) {
    const missing = clip.shots.filter((s) => !s.footageId).length;
    checks.push({ rule: "Every shot uses campaign footage", pass: missing === 0, note: missing ? `${missing} shot(s) without footage` : undefined });
  }

  return { pass: checks.every((c) => c.pass), checks };
}
