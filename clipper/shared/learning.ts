import type { Clip, ClipFormat, ClipTraits, Confidence, HookStyle, LearningReport, Platform, Playbook, Post, TraitStat, WorkspaceDoc } from "./types";
import { HOOK_STYLES, PLATFORM_LABEL, VOICES } from "./types";
import { countsAsPost } from "./rules";

// The learning system's math. Pure functions over the workspace document, so
// the dashboard, the planner and the tests all see the same numbers.
//
// Short-form views are noisy and depend heavily on the account, so:
//  - posts are compared at the same age (views at ~3 days, not "whenever
//    someone last typed a number"), and posts under a day old don't count yet;
//  - each post is scored against its own account's normal (its "lift"), so a
//    big account doesn't make every hook it posts look like a winner;
//  - a trait with few posts is pulled toward "normal" (shrinkage), so one lucky
//    post can't rewrite the playbook.

export const CHECKPOINT_H = 72;
export const MIN_AGE_H = 24;
/** Prior strength: a trait needs about this many posts before its own average dominates. */
export const SHRINK_K = 3;

const H = 3600_000;

// ---------------------------------------------------------------------------
// Traits

const HOOK_RULES: [HookStyle, RegExp][] = [
  ["pov", /^\s*pov\b/i],
  ["how-to", /^\s*(how (to|i)\b|here'?s how|tip:|the trick|stop doing|don'?t)/i],
  ["number", /^\s*(\d+|three|four|five|seven|ten)\b.*\b(ways?|tips?|things?|shots?|tricks?|reasons?|mistakes?|moves?)\b|^\s*top \d+/i],
  ["question", /\?\s*$|^\s*(can|could|would|do|does|did|is|are|was|why|what|who|which|have|will|should|ever)\b[^.!]*$/i],
  ["challenge", /\b(challeng\w*|i tried|tried to|trying to|beat (my|me|him|her|them)|1v1|vs\.?|against my|can i)\b/i],
  ["story", /^\s*(i was|when i|so i|my friend|we were)\b|\bthen this happened\b|\bhappened\b/i],
  ["reveal", /\b(someone made|nobody|no one|you won'?t believe|wait|secret|hidden|didn'?t know|turns out|actually|literally)\b|\.\.\.|…/i],
  ["bold-claim", /\b(best|worst|craziest|insane|most|greatest|never|only|cleanest|hardest|easiest)\b/i],
];

export function classifyHook(hook: string): HookStyle {
  for (const [style, re] of HOOK_RULES) if (re.test(hook)) return style;
  return "other";
}

export const formatOf = (clip: Pick<Clip, "shots">): ClipFormat => (clip.shots.length >= 3 ? "montage" : clip.shots.length >= 1 ? "single-moment" : "explainer");

/** Traits for a clip: what the planner recorded, filled in from the clip itself when missing. */
export function traitsOf(clip: Clip): ClipTraits {
  return {
    hookStyle: clip.traits?.hookStyle ?? classifyHook(clip.hook),
    format: clip.traits?.format ?? formatOf(clip),
    opening: clip.traits?.opening,
    voice: clip.traits?.voice ?? clip.render?.voice,
    strategy: clip.traits?.strategy,
  };
}

export function lengthBucket(sec: number): string {
  return sec <= 15 ? "≤15s" : sec <= 25 ? "16–25s" : sec <= 40 ? "26–40s" : "41s+";
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ---------------------------------------------------------------------------
// Comparable views

/** Views at about 3 days old, from the post's snapshots. Undefined until it's a day old. */
export function comparableViews(post: Post, nowMs = Date.now()): number | undefined {
  const posted = Date.parse(post.postedAt);
  if (!Number.isFinite(posted) || nowMs - posted < MIN_AGE_H * H) return undefined;
  const snaps = [...(post.history ?? [])];
  if (post.metricsUpdatedAt && !snaps.some((s) => s.at === post.metricsUpdatedAt)) snaps.push({ ...post.metrics, at: post.metricsUpdatedAt });
  if (!snaps.length) snaps.push({ ...post.metrics, at: new Date(nowMs).toISOString() });
  const aged = snaps.map((s) => ({ views: s.views, age: (Date.parse(s.at) - posted) / H })).filter((s) => Number.isFinite(s.age) && s.age >= MIN_AGE_H);
  if (!aged.length) return undefined;
  // The snapshot closest to the 3-day mark; ties go to the earlier one.
  aged.sort((a, b) => Math.abs(a.age - CHECKPOINT_H) - Math.abs(b.age - CHECKPOINT_H) || a.age - b.age);
  return aged[0].views;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ---------------------------------------------------------------------------
// Analysis

interface Row {
  post: Post;
  clip?: Clip;
  views: number;
  lift: number;
  values: Record<string, string>;
}

const DIMENSIONS: { id: string; label: string; name: (v: string) => string }[] = [
  { id: "hookStyle", label: "Hook style", name: (v) => HOOK_STYLES.find((h) => h.id === v)?.label ?? v },
  { id: "format", label: "Format", name: (v) => ({ montage: "Montage (3+ shots)", "single-moment": "One moment", explainer: "Explainer" })[v] ?? v },
  { id: "length", label: "Length", name: (v) => v },
  { id: "voice", label: "Voice", name: (v) => (v === "none" ? "No voice" : `${VOICES.find((x) => x.id === v)?.label.split(" — ")[0] ?? v} (AI voice)`) },
  { id: "opening", label: "Opens on", name: (v) => v.replace(/^./, (c) => c.toUpperCase()) },
  { id: "platform", label: "Platform", name: (v) => PLATFORM_LABEL[v as Platform] ?? v },
  { id: "weekday", label: "Day posted", name: (v) => v },
];

const confidenceOf = (n: number): Confidence => (n < 3 ? "too-early" : n < 8 ? "early-signal" : "solid");

export function analyze(doc: Pick<WorkspaceDoc, "posts" | "clips">, scope = "all", nowMs = Date.now()): LearningReport {
  const posts = doc.posts.filter((p) => countsAsPost(p) && (scope === "all" || p.campaignId === scope));
  const clipById = new Map(doc.clips.map((c) => [c.id, c]));

  const mature = posts.map((post) => ({ post, views: comparableViews(post, nowMs) })).filter((x): x is { post: Post; views: number } => x.views !== undefined);

  // Each account's normal: the median of its own posts once it has three, else
  // the median across everything in scope.
  const overall = median(mature.map((m) => m.views));
  const byAccount = new Map<string, number[]>();
  for (const m of mature) {
    const k = `${m.post.platform}:${m.post.account.toLowerCase()}`;
    byAccount.set(k, [...(byAccount.get(k) ?? []), m.views]);
  }
  const baseline = (p: Post) => {
    const own = byAccount.get(`${p.platform}:${p.account.toLowerCase()}`) ?? [];
    return own.length >= 3 ? median(own) : overall;
  };

  const rows: Row[] = mature.map(({ post, views }) => {
    const clip = post.clipId ? clipById.get(post.clipId) : undefined;
    const t = clip ? traitsOf(clip) : undefined;
    const values: Record<string, string> = { platform: post.platform, weekday: WEEKDAYS[new Date(post.postedAt).getUTCDay()] };
    if (clip && t) {
      values.hookStyle = t.hookStyle;
      values.format = t.format;
      values.length = lengthBucket(clip.render?.durationSec ?? clip.lengthSec);
      if (t.voice) values.voice = t.voice;
      if (t.opening) values.opening = t.opening;
    }
    // +50 keeps tiny accounts from producing absurd ratios (20 vs 10 views isn't "2×").
    return { post, clip, views, lift: (views + 50) / (baseline(post) + 50), values };
  });

  const dimensions = DIMENSIONS.map((d) => {
    const groups = new Map<string, Row[]>();
    for (const r of rows) if (r.values[d.id]) groups.set(r.values[d.id], [...(groups.get(r.values[d.id]) ?? []), r]);
    const stats: TraitStat[] = [...groups].map(([value, rs]) => {
      const meanLog = rs.reduce((s, r) => s + Math.log(r.lift), 0) / rs.length;
      return {
        value,
        label: d.name(value),
        posts: rs.length,
        medianViews: Math.round(median(rs.map((r) => r.views))),
        lift: Math.round(Math.exp((meanLog * rs.length) / (rs.length + SHRINK_K)) * 100) / 100,
        confidence: confidenceOf(rs.length),
      };
    });
    stats.sort((a, b) => b.lift - a.lift || b.posts - a.posts);
    return { id: d.id, label: d.label, stats };
  }).filter((d) => d.stats.length);

  const topHooks = rows
    .filter((r) => r.clip)
    .sort((a, b) => b.lift - a.lift)
    .slice(0, 8)
    .map((r) => ({ hook: r.clip!.hook, views: r.views, lift: Math.round(r.lift * 100) / 100, platform: r.post.platform, postId: r.post.id, campaignId: r.post.campaignId }));

  return { scope, posts: posts.length, maturePosts: rows.length, dimensions, topHooks, playbook: playbookFrom(dimensions, topHooks) };
}

const PLAN_DIMENSIONS = ["hookStyle", "format", "length", "voice", "opening"];

export function playbookFrom(dimensions: LearningReport["dimensions"], topHooks: LearningReport["topHooks"]): Playbook {
  const proven: Playbook["proven"] = [];
  const weak: Playbook["weak"] = [];
  for (const d of dimensions) {
    if (!PLAN_DIMENSIONS.includes(d.id)) continue;
    for (const s of d.stats) {
      if (s.confidence === "too-early") continue;
      const item = { dimension: d.id, value: s.value, label: `${d.label}: ${s.label}`, lift: s.lift, posts: s.posts };
      if (s.lift >= 1.15) proven.push(item);
      else if (s.lift <= 0.87) weak.push(item);
    }
  }
  const tried = (dim: string) => new Set((dimensions.find((d) => d.id === dim)?.stats ?? []).filter((s) => s.posts >= 2).map((s) => s.value));
  const hooksTried = tried("hookStyle");
  const formatsTried = tried("format");
  const untested: Playbook["untested"] = [
    ...HOOK_STYLES.filter((h) => h.id !== "other" && !hooksTried.has(h.id)).map((h) => ({ dimension: "hookStyle", value: h.id, label: `Hook style: ${h.label}` })),
    ...(["montage", "single-moment"] as ClipFormat[]).filter((f) => !formatsTried.has(f)).map((f) => ({ dimension: "format", value: f, label: `Format: ${f === "montage" ? "Montage" : "One moment"}` })),
  ];
  return {
    proven: proven.sort((a, b) => b.lift - a.lift),
    weak: weak.sort((a, b) => a.lift - b.lift),
    untested,
    winningHooks: topHooks.filter((h) => h.lift >= 1.2).slice(0, 5).map((h) => h.hook),
  };
}

/** How many of `n` new plans should test something new (the rest lean on what's proven). */
export function testShare(n: number, playbook: Playbook): number {
  if (!playbook.proven.length) return n; // nothing proven yet: every clip is a test
  return Math.max(1, Math.round(n * 0.3));
}
