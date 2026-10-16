import type { AIKind, MonthUsage, UsageReport, WorkspaceUsage } from "../shared/types";
import { currentWorkspaceId, getDoc, HttpError, save } from "./db";

// What each workspace uses, kept in its document: AI dollars as billed by the
// provider, plus renders, caption jobs and posts. Powers the daily AI budget
// and the Usage page.

const day = () => new Date().toISOString().slice(0, 10);
export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
export const emptyMonth = (): MonthUsage => ({ ai: {}, renders: 0, renderSec: 0, captionJobs: 0, captionSec: 0, posts: 0 });

/** Dollars of AI a workspace may spend per UTC day. */
export const dailyBudget = () => Number(process.env.AI_DAILY_BUDGET_USD ?? 5);

/** Estimates for what isn't billed per call (Railway compute, Outstand posts). */
export const RATES = {
  /** Compute per second of rendered video (voice, captions, encode at 1080x1920). */
  renderSec: Number(process.env.COST_RENDER_SEC ?? 0.0001),
  /** Compute per second of video captioned on the Captions page. */
  captionSec: Number(process.env.COST_CAPTION_SEC ?? 0.00008),
  /** Outstand's price per published post. */
  post: Number(process.env.COST_POST ?? 0.007),
};

function usage(): WorkspaceUsage | undefined {
  if (!currentWorkspaceId()) return undefined;
  const doc = getDoc();
  const u = (doc.usage ??= { day: day(), dayUsd: 0, dayCalls: 0, months: {} });
  if (u.day !== day()) Object.assign(u, { day: day(), dayUsd: 0, dayCalls: 0 });
  return u;
}

const month = (u: WorkspaceUsage) => (u.months[monthKey()] ??= emptyMonth());

/** Before an AI call: refuse once today's budget is spent. */
export function checkAIBudget() {
  const u = usage();
  const budget = dailyBudget();
  if (u && budget > 0 && u.dayUsd >= budget) throw new HttpError(429, `Today's AI budget ($${budget.toFixed(2)}) is used up. It resets at midnight UTC.`);
}

/** After an AI call: what the provider billed. Outside a workspace (tests, scripts) it's a no-op. */
export function recordAI(kind: AIKind, usd: number) {
  const u = usage();
  if (!u) return;
  const c = Number.isFinite(usd) && usd > 0 ? usd : 0;
  u.dayUsd = round(u.dayUsd + c);
  u.dayCalls++;
  const m = month(u);
  const k = (m.ai[kind] ??= { usd: 0, calls: 0 });
  k.usd = round(k.usd + c);
  k.calls++;
  save();
}

export function recordUsage(field: "renders" | "renderSec" | "captionJobs" | "captionSec" | "posts", n: number) {
  const u = usage();
  if (!u || !Number.isFinite(n)) return;
  month(u)[field] = round(month(u)[field] + n);
  save();
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** A month's cost: AI as billed, compute and posts estimated. */
export function monthCost(m: MonthUsage) {
  const ai = Object.values(m.ai).reduce((s, k) => s + (k?.usd ?? 0), 0);
  const compute = m.renderSec * RATES.renderSec + m.captionSec * RATES.captionSec;
  const posts = m.posts * RATES.post;
  return { ai: round(ai), compute: round(compute), posts: round(posts), total: round(ai + compute + posts) };
}

export function usageReport(): UsageReport {
  const u = usage();
  const months = Object.entries(u?.months ?? {})
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 12)
    .map(([month, m]) => ({ month, usage: m, cost: monthCost(m) }));
  if (!months.some((m) => m.month === monthKey())) months.unshift({ month: monthKey(), usage: emptyMonth(), cost: monthCost(emptyMonth()) });
  return {
    today: { usd: u?.dayUsd ?? 0, calls: u?.dayCalls ?? 0, budget: dailyBudget(), callLimit: Number(process.env.AI_DAILY_LIMIT ?? 150) },
    months,
    rates: RATES,
  };
}

/** Operators (ADMIN_EMAILS, comma-separated) can see every workspace's usage. */
export const isAdmin = (email: string) =>
  (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
