import { displayText, spokenText } from "./markup";
import { sentences } from "./sentences";
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

// ---------------------------------------------------------------------------
// How long a script takes to say

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** An integer as it's said in English. */
export function spellNumber(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`;
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${spellNumber(n % 100)}` : ""}`;
  for (const [size, name] of [[1e9, "billion"], [1e6, "million"], [1e3, "thousand"]] as const)
    if (n >= size) return `${spellNumber(Math.floor(n / size))} ${name}${n % size ? ` ${spellNumber(n % size)}` : ""}`;
  return String(n);
}

/** Numbers and amounts spelled out the way they're read ("$5" → "five dollars", "2026" → "twenty twenty six"). */
function spokenNumbers(text: string): string {
  return text.replace(/\$?\d[\d,]*(\.\d+)?%?/g, (m) => {
    const dollars = m.startsWith("$");
    const pct = m.endsWith("%");
    const raw = m.replace(/[$%]/g, "");
    const [whole, frac] = raw.split(".");
    const n = Number(whole.replace(/,/g, ""));
    if (!Number.isFinite(n) || n > 1e12) return m;
    // A four-digit year (not a round hundred) is read in pairs.
    const isYear = !dollars && !pct && !whole.includes(",") && /^\d{4}$/.test(whole) && n >= 1100 && n < 2100 && n % 100 !== 0 && n % 1000 >= 10;
    let said = isYear ? `${spellNumber(Math.floor(n / 100))} ${spellNumber(n % 100)}` : spellNumber(n);
    if (frac) said += ` point ${[...frac].map((d) => ONES[+d]).join(" ")}`;
    return `${said}${dollars ? " dollars" : ""}${pct ? " percent" : ""}`;
  });
}

/** Syllables in an English-like word (vowel groups, minus a silent final e). */
function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  let n = (w.match(/[aeiouy]+/g) ?? []).length;
  if (/[^aeiouy]e$/.test(w) && !/[^aeiouy]le$/.test(w) && n > 1) n--; // silent e ("game"), but "table"
  if (/[gq]ue$/.test(w) && n > 1) n--; // "league", "unique"
  return Math.max(1, n);
}

const HAN = /\p{Script=Han}/u;
const KANA_MORA = /[\p{Script=Hiragana}\p{Script=Katakana}ー]/u;
const SMALL_KANA = /[ぁぃぅぇぉゃゅょゎァィゥェォャュョヮ]/; // part of the mora before (っ/ッ count)
const HANGUL = /\p{Script=Hangul}/u;
const THAI = /[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

function units(text: string) {
  const u = { latin: 0, han: 0, kana: 0, other: 0 };
  for (const token of spokenNumbers(text).split(/\s+/)) {
    let latin = "";
    for (const ch of token) {
      if (HAN.test(ch)) u.han++;
      else if (KANA_MORA.test(ch)) u.kana += SMALL_KANA.test(ch) ? 0 : 1;
      else if (HANGUL.test(ch)) u.other++;
      else if (THAI.test(ch)) u.other += 1 / 3;
      else latin += ch;
    }
    u.latin += syllables(latin);
  }
  return u;
}

/** Spoken units in a script: syllables, Chinese characters, Japanese morae. */
export const speechUnits = (text: string) => {
  const u = units(text);
  return Math.round(u.latin + u.han + u.kana + u.other);
};

/** Syllables a second for a typical TTS voice (≈ 2.6 English words a second). */
export const UNITS_PER_SECOND = 3.6;

/** Units weighted to English syllables: Chinese is read ~4.5 characters/s, Japanese ~7 morae/s. */
export const speechLoad = (text: string) => {
  const u = units(text);
  return u.latin + u.other + u.han * (UNITS_PER_SECOND / 4.5) + u.kana * (UNITS_PER_SECOND / 7);
};

/** Seconds to say `text`, at a voice's learned pace if known. */
export const speechSeconds = (text: string, unitsPerSec = UNITS_PER_SECOND) => speechLoad(text) / unitsPerSec;

/** Learn a voice's pace from a render: a running mean of units per second. */
export function calibrate(prev: { unitsPerSec: number; n: number } | undefined, load: number, seconds: number) {
  if (!(seconds > 0.5) || !(load > 0)) return prev;
  const rate = load / seconds;
  const n = Math.min((prev?.n ?? 0) + 1, 20); // the last ~20 renders count
  return { unitsPerSec: prev ? prev.unitsPerSec + (rate - prev.unitsPerSec) / n : rate, n };
}
// Scripts written without spaces (Chinese, Japanese, Thai, …) count about two
// characters per spoken "word", so length estimates work for them too.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/gu;
export const words = (s: string) =>
  s
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .reduce((n, tok) => {
      const c = tok.match(UNSPACED)?.length ?? 0;
      return n + (c ? Math.ceil(c / 2) : 1);
    }, 0);
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
  // Required phrases must be said; banned claims count whether said or shown.
  const spoken = norm(spokenText(clip.narration));
  const all = norm([spokenText(clip.narration), displayText(clip.narration), ...clip.onScreenText].join(" "));

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
    const tail = norm(brief.cta.placement === "end" ? sentences(spokenText(clip.narration)).slice(-2).join(" ") : spokenText(clip.narration));
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
  const talk = Math.round(measured ?? speechSeconds(spokenText(clip.narration)));
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
