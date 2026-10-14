import type { Insights, LearningReport } from "../shared/types";
import { now } from "./db";
import { aiLive, chatJSON } from "./llm";

// Plain-language findings from a learning report: what's working, what to stop,
// what to try next. The numbers come from shared/learning.ts; the model only
// explains them, so it can't invent a pattern the data doesn't show.

const SYSTEM = `You coach a short-form "clipping" creator. You get a report of how their posted clips performed, grouped by trait.
"lift" is views versus that account's normal (1.0 = normal, 1.5 = 50% more views). "confidence" says how much data is behind it: "too-early" means ignore it, "early-signal" means a hint worth testing, "solid" means act on it.
Only describe patterns that are in the report — never invent numbers. Say how sure each finding is ("early signal from 4 posts"). Keep each bullet under 25 words, concrete and actionable.
Return JSON {"findings":[...],"doMore":[...],"stopDoing":[...],"testNext":[...]} with at most 4 bullets each.`;

const pct = (lift: number) => `${lift >= 1 ? "+" : "−"}${Math.round(Math.abs(lift - 1) * 100)}%`;
const sure = (posts: number, confidence: string) => (confidence === "solid" ? `${posts} posts` : `early signal, ${posts} posts`);

/** Findings straight from the numbers, for when AI is off (and as a floor when it fails). */
export function rulesInsights(r: LearningReport): Insights {
  const findings: string[] = [];
  if (r.maturePosts < 5) findings.push(`Only ${r.maturePosts} post${r.maturePosts === 1 ? "" : "s"} old enough to compare (a day or more). Patterns start to show around 20–30 tracked posts.`);
  for (const d of r.dimensions) {
    const ranked = d.stats.filter((s) => s.confidence !== "too-early");
    if (ranked.length < 2) continue;
    const best = ranked[0];
    const worst = ranked[ranked.length - 1];
    if (best.lift - worst.lift < 0.2) continue;
    findings.push(`${d.label}: "${best.label}" gets ${pct(best.lift)} vs normal (${sure(best.posts, best.confidence)}); "${worst.label}" gets ${pct(worst.lift)}.`);
  }
  return {
    generatedAt: now(),
    basedOnPosts: r.maturePosts,
    findings: findings.slice(0, 4),
    doMore: r.playbook.proven.slice(0, 4).map((p) => `${p.label} — ${pct(p.lift)} views over ${p.posts} posts.`),
    stopDoing: r.playbook.weak.slice(0, 4).map((p) => `${p.label} — ${pct(p.lift)} views over ${p.posts} posts.`),
    testNext: r.playbook.untested.slice(0, 4).map((u) => u.label),
    model: "rules",
  };
}

const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim().slice(0, 300)).slice(0, 4) : []);

export async function writeInsights(r: LearningReport): Promise<{ insights: Insights; cost: number }> {
  const floor = rulesInsights(r);
  if (!aiLive() || process.env.CLIP_SIMULATE || r.maturePosts === 0) return { insights: floor, cost: 0 };
  try {
    const res = await chatJSON<Record<string, unknown>>("extract", SYSTEM, {
      postsTracked: r.posts,
      postsOldEnoughToCompare: r.maturePosts,
      byTrait: r.dimensions.map((d) => ({ trait: d.label, values: d.stats.map(({ label, posts, medianViews, lift, confidence }) => ({ label, posts, medianViews, lift, confidence })) })),
      topHooks: r.topHooks.map(({ hook, views, lift, platform }) => ({ hook, views, lift, platform })),
      untested: r.playbook.untested.map((u) => u.label),
    }, 1500);
    const j = res.json;
    return {
      insights: {
        generatedAt: now(),
        basedOnPosts: r.maturePosts,
        findings: list(j.findings).length ? list(j.findings) : floor.findings,
        doMore: list(j.doMore),
        stopDoing: list(j.stopDoing),
        testNext: list(j.testNext).length ? list(j.testNext) : floor.testNext,
        model: res.model,
      },
      cost: res.cost,
    };
  } catch (err) {
    console.error("[insights]", (err as Error).message);
    return { insights: floor, cost: 0 };
  }
}
