import type { Clip, VoiceOption } from "../shared/types";
import { VOICES } from "../shared/types";
import { getDoc } from "./db";
import { isCached } from "./footage-cache";
import { isPending, pendingCount, waitingCount } from "./jobs";
import { aiCallsLeft, aiLive, mediaLive } from "./llm";
import { ffmpegAvailable } from "./media";
import { footageFor, VOICE_STEP, voiceStepParams } from "./render";
import { stepStored } from "./steps";
import { averageCost, budgetLeft } from "./usage";

// What a render will cost and what would stop it, worked out without
// spending anything: the same checks a real render request makes, plus
// estimates from this workspace's own billing history.

/** Typical costs before a workspace has history (dollars per call). */
export const DEFAULT_COST = { voice: Number(process.env.EST_VOICE_USD ?? 0.02), moments: Number(process.env.EST_MOMENTS_USD ?? 0.01) };

export interface Blocker {
  status: number;
  message: string;
}

export interface Preflight {
  clipId: string;
  ok: boolean;
  blockers: Blocker[];
  warnings: string[];
  footage: { id: string; name: string; cached: boolean; momentsPending: boolean; opened: boolean }[];
  voice: { id: VoiceOption; takeCached: boolean };
  /** voiceUsd is one take; a take that goes off script is recorded once more (up to voiceUsdMax). */
  estimate: { voiceUsd: number; voiceUsdMax: number; momentsUsd: number; totalUsd: number; paidCalls: number };
  queue: { ahead: number };
  quota: { aiUsdLeft: number | null; aiCallsLeft: number | null; renderSlotsLeft: number };
}

/**
 * Budget and call limits. Only the voice needs them: footage that can't be
 * watched for moments is still cut (evenly), as the render has always done.
 */
export function budgetRule(o: { live: boolean; voiceCalls: number; momentCalls: number; totalUsd: number; usdLeft: number; callsLeft: number }) {
  const blockers: Blocker[] = [];
  const warnings: string[] = [];
  if (!o.live) return { blockers, warnings };
  if (o.voiceCalls && o.usdLeft <= 0) blockers.push({ status: 429, message: "Today's AI budget is used up. It resets at midnight UTC." });
  else if (o.momentCalls && o.usdLeft <= 0) warnings.push("Today's AI budget is used up, so footage won't be watched for moments; shots will be cut evenly.");
  else if (o.totalUsd > o.usdLeft) warnings.push(`This render is estimated at $${r4(o.totalUsd)}, more than the $${r4(o.usdLeft)} left in today's AI budget; it may stop partway.`);
  if (o.voiceCalls && o.callsLeft < 1) blockers.push({ status: 429, message: "Daily AI limit reached. It resets at midnight UTC." });
  return { blockers, warnings };
}

const fin = (n: number) => (Number.isFinite(n) ? n : null);
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** `scope`: also count a take kept only for that run (a recompose of it reuses it). */
export async function preflightRender(workspaceId: string, clip: Clip, voice: VoiceOption, override = false, scope?: string): Promise<Preflight> {
  const blockers: Blocker[] = [];
  const warnings: string[] = [];
  const block = (status: number, message: string) => blockers.push({ status, message });
  const c = getDoc().campaigns.find((x) => x.id === clip.campaignId);
  if (!VOICES.some((v) => v.id === voice)) block(400, "Unknown voice");
  if (!ffmpegAvailable()) block(503, "Rendering isn't available on this server (ffmpeg missing)");
  if (isPending(clip.id)) block(409, "This clip is already rendering");
  if (clip.status === "draft" && !override) block(400, "Approve the plan before rendering it");
  if (voice !== "none" && !mediaLive()) block(503, "AI voice needs OPENROUTER_API_KEY — render with “No voice” instead");

  // Footage: which files are already stored, and which still need watching (a vision call each).
  const footage: Preflight["footage"] = [];
  if (!c) block(404, "Campaign not found");
  else if (!c.footage.some((f) => f.kind === "video")) block(422, "This campaign has no video footage to cut from");
  else {
    const shots = clip.shots.length ? clip.shots : [{ footageId: undefined }];
    const files = [...new Map(shots.map((s, i) => footageFor(c, s.footageId, i)).map((f) => [f.id, f])).values()];
    for (const f of files) footage.push({ id: f.id, name: f.name, cached: !!f.storageKey || (await isCached(f).catch(() => false)), momentsPending: !(f.analyzedAt && f.durationSec), opened: !!f.durationSec });
  }

  const params = c ? voiceStepParams(c, clip, voice) : undefined;
  const takeCached = !!c && voice !== "none" && ((await stepStored(workspaceId, "voice", VOICE_STEP, params)) || (!!scope && (await stepStored(workspaceId, "voice", VOICE_STEP, { params, scope }))));
  const voiceCalls = voice !== "none" && !takeCached ? 1 : 0;
  const momentCalls = footage.filter((f) => f.momentsPending).length;
  const voiceUsd = voiceCalls * averageCost("voice", DEFAULT_COST.voice);
  const momentsUsd = momentCalls * averageCost("moments", DEFAULT_COST.moments);
  const totalUsd = voiceUsd + momentsUsd;

  // Quota, as the real request and the render itself would check it.
  const usdLeft = budgetLeft();
  const callsLeft = aiCallsLeft(workspaceId);
  const max = Number(process.env.MAX_QUEUED_RENDERS ?? 20);
  const slots = Math.max(0, max - waitingCount(workspaceId, "render"));
  const paid = voiceCalls + momentCalls;
  const rule = budgetRule({ live: aiLive(), voiceCalls, momentCalls, totalUsd, usdLeft, callsLeft });
  blockers.push(...rule.blockers);
  warnings.push(...rule.warnings);
  if (!slots) block(429, `You already have ${max} clips waiting to render. Try again when some finish.`);
  if (takeCached) warnings.push("The voiceover for this script is already recorded and will be reused (not charged again).");

  return {
    clipId: clip.id,
    ok: !blockers.length,
    blockers,
    warnings,
    footage,
    voice: { id: voice, takeCached },
    estimate: { voiceUsd: r4(voiceUsd), voiceUsdMax: r4(2 * voiceUsd), momentsUsd: r4(momentsUsd), totalUsd: r4(totalUsd), paidCalls: paid },
    queue: { ahead: pendingCount("render") },
    quota: { aiUsdLeft: fin(usdLeft), aiCallsLeft: fin(callsLeft), renderSlotsLeft: slots },
  };
}

/**
 * Before brief_to_shorts: what reading a brief, planning `count` clips and
 * rendering them would cost, and what would stop it. Footage isn't known
 * until the brief is read, so each clip counts one file to watch.
 */
export function preflightBrief(workspaceId: string, count: number, voice: VoiceOption, render: boolean) {
  const blockers: Blocker[] = [];
  if (!aiLive()) blockers.push({ status: 503, message: "Reading briefs and writing plans needs OPENROUTER_API_KEY" });
  if (render && !ffmpegAvailable()) blockers.push({ status: 503, message: "Rendering isn't available on this server (ffmpeg missing)" });
  if (render && voice !== "none" && !mediaLive()) blockers.push({ status: 503, message: "AI voice needs OPENROUTER_API_KEY — use voice “none” instead" });
  const extract = averageCost("extract", 0.005);
  const script = averageCost("script", 0.01);
  const perClip = render ? (voice !== "none" ? averageCost("voice", DEFAULT_COST.voice) : 0) + averageCost("moments", DEFAULT_COST.moments) : 0;
  const totalUsd = r4(extract + script + count * perClip);
  const usdLeft = budgetLeft();
  const callsLeft = aiCallsLeft(workspaceId);
  const calls = 2 + (render ? count * (voice !== "none" ? 2 : 1) : 0);
  if (aiLive() && usdLeft <= 0) blockers.push({ status: 429, message: "Today's AI budget is used up. It resets at midnight UTC." });
  if (callsLeft < calls) blockers.push({ status: 429, message: `This needs about ${calls} AI calls; ${callsLeft} are left today.` });
  return { ok: !blockers.length, blockers, estimate: { extractUsd: r4(extract), planUsd: r4(script), perClipRenderUsd: r4(perClip), totalUsd, paidCalls: calls }, quota: { aiUsdLeft: fin(usdLeft), aiCallsLeft: fin(callsLeft) } };
}
