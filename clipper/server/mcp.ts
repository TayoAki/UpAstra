import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CAPTION_STYLES } from "../shared/caption-styles";
import type { Campaign, CampaignStats, CaptionJob, Clip, Insights, LearningReport, Post, ReferenceFormat, ServiceStatus, SocialAccount } from "../shared/types";
import { HOOK_STYLES, PLATFORMS, VOICES } from "../shared/types";

// MCP server for UGCMediaClips: run the whole thing headless from Claude
// (Desktop, Code, claude.ai connectors) or any MCP client. Tools call the same
// HTTP API the dashboard uses, with the workspace agent key, so every brief
// rule, QA check, spend cap and render queue applies unchanged. Actions show
// up in Activity marked as done by an agent.

/** Stable error codes agents can branch on (B6.2). */
export type ErrorCode = "INVALID_ARGUMENT" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "FAILED_PRECONDITION" | "QUOTA_EXCEEDED" | "UNAVAILABLE" | "INTERNAL";

const HELP: Record<ErrorCode, string> = {
  INVALID_ARGUMENT: "Fix the arguments (see the tool's schema) and call again.",
  FORBIDDEN: "The agent key is missing, revoked or not allowed this; ask the user for a new key.",
  NOT_FOUND: "Check the id: overview lists campaigns and clips, get_campaign a campaign's clips.",
  CONFLICT: "It changed state meanwhile; read it again (get_clip / get_campaign) and retry.",
  FAILED_PRECONDITION: "It isn't ready for this yet; read it (get_clip / get_campaign) for what's missing.",
  QUOTA_EXCEEDED: "A spend cap or plan limit was reached; tell the user, don't retry.",
  UNAVAILABLE: "A service is down or not set up (see overview → services); retry later.",
  INTERNAL: "Something went wrong on the server; retry once, then tell the user.",
};

export class ToolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly help = HELP[code],
  ) {
    super(message);
  }
}

const codeFor = (status: number): ErrorCode =>
  status === 400 || status === 415 ? "INVALID_ARGUMENT" : status === 401 || status === 403 ? "FORBIDDEN" : status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : status === 422 ? "FAILED_PRECONDITION" : status === 429 ? "QUOTA_EXCEEDED" : status === 502 || status === 503 ? "UNAVAILABLE" : "INTERNAL";

export type ApiCall = <T = unknown>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) => Promise<T>;

/** Calls the UGCMediaClips HTTP API with a workspace agent key. */
export function httpApi(baseUrl: string, key: string, extraHeaders: Record<string, string> = {}, sessionAuth = false): ApiCall {
  return async (method, path, body) => {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api${path}`, {
      method,
      // An agent key, or (the in-app agent) the user's own session cookie in extraHeaders.
      headers: { "Content-Type": "application/json", ...(sessionAuth ? {} : { Authorization: `Bearer ${key}` }), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10 * 60_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ToolError(codeFor(res.status), (data as { error?: string }).error ?? `HTTP ${res.status}`);
    return data as never;
  };
}

type CampaignWithStats = Campaign & { stats: CampaignStats };
interface State {
  campaigns: CampaignWithStats[];
  clips: Clip[];
  posts: Post[];
  insights: Record<string, Insights>;
  accounts: SocialAccount[];
  formats?: Omit<ReferenceFormat, "transcript" | "cuts">[];
  status: ServiceStatus;
}

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
/** Every tool error as `{ ok: false, error: { code, message, help } }`. */
const fail = (err: unknown) => {
  const e = err instanceof ToolError ? err : new ToolError(/Input validation error|Invalid arguments/.test(String((err as Error)?.message ?? err)) ? "INVALID_ARGUMENT" : "INTERNAL", String((err as Error)?.message ?? err));
  return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: { code: e.code, message: e.message, help: e.help } }, null, 2) }], isError: true };
};
/** A suggested next call: which tool, with what, and why. */
export interface Next {
  tool: string;
  args: Record<string, unknown>;
  why: string;
}
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const failing = (c: Clip) => c.qa.checks.filter((x) => !x.pass).map((x) => (x.note ? `${x.rule} — ${x.note}` : x.rule));

function clipLine(c: Clip) {
  return {
    id: c.id,
    campaignId: c.campaignId,
    title: c.title,
    status: c.status,
    hook: c.hook,
    lengthSec: c.lengthSec,
    followsBrief: c.qa.pass,
    failingRules: c.qa.pass ? undefined : failing(c),
    traits: c.traits,
    render: c.render && { status: c.render.status, step: c.render.step, durationSec: c.render.durationSec, error: c.render.error },
  };
}

function clipFull(c: Clip, videoUrl?: string) {
  return {
    ...clipLine(c),
    angle: c.angle,
    narration: c.narration,
    onScreenText: c.onScreenText,
    cta: c.cta,
    shots: c.shots.map((s) => ({ footage: s.footageName, moment: s.moment, seconds: s.seconds })),
    caption: c.caption,
    hashtags: c.hashtags,
    renderedFrom: c.render?.segments,
    overlays: c.overlays,
    variant: c.variantGroup ? { group: c.variantGroup, label: c.variantLabel } : undefined,
    formatId: c.formatId,
    videoUrl,
  };
}

function campaignSummary(c: CampaignWithStats, s: State) {
  const b = c.brief;
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    product: b.product,
    payout: b.payout,
    platforms: b.platforms,
    lengthSec: b.lengthSec,
    requiredPhrases: b.requiredPhrases,
    callToAction: b.cta.text,
    bannedClaims: b.bannedClaims,
    accountRequirements: b.accountRequirements,
    minEngagementRate: b.minEngagementRate,
    deadline: b.deadline,
    footage: c.footage
      .filter((f) => f.kind === "video")
      .map((f) => ({ id: f.id, name: f.name, uploaded: !!f.storageKey, durationSec: f.durationSec, moments: f.moments?.length ?? (f.analyzedAt ? 0 : undefined), problem: f.analysisError })),
    footageError: c.footageError,
    stats: c.stats,
    clips: s.clips.filter((x) => x.campaignId === c.id).map(clipLine),
    posts: s.posts.filter((p) => p.campaignId === c.id).map(postLine),
  };
}

const captionJobOut = (j: CaptionJob, videoUrl?: string, full = false) => ({
  id: j.id,
  name: j.name,
  status: j.status,
  step: j.step,
  error: j.error,
  language: j.language,
  durationSec: j.durationSec,
  words: j.words.length,
  transcript: full ? j.words.map((w) => w.text).join(j.joiner ?? " ") : undefined,
  style: j.captions.style,
  videoUrl,
});

const postLine = (p: Post) => ({ id: p.id, clipId: p.clipId, platform: p.platform, account: p.account, url: p.url, postedAt: p.postedAt, status: p.status, metrics: p.metrics, metricsUpdatedAt: p.metricsUpdatedAt });

const VOICE = z.enum(VOICES.map((v) => v.id) as [string, ...string[]]).describe(`Voiceover: ${VOICES.map((v) => `${v.id} (${v.label})`).join("; ")}`);
const PLATFORM = z.enum(PLATFORMS as [string, ...string[]]);

export function createMcpServer(api: ApiCall): McpServer {
  const server = new McpServer(
    { name: "ugcmediaclips", version: "0.1.0" },
    {
      instructions:
        "UGCMediaClips turns paid clipping-campaign briefs into finished 9:16 shorts (TikTok, Reels, Shorts). " +
        "Fastest path: brief_to_shorts (brief link or text → plans → renders), then wait_for_renders for the video links. " +
        "Step by step: add_campaign → plan_clips → review_clip (approve) → render_clip → wait_for_renders. " +
        "Plans are checked against the brief in code (required phrases, CTA, length, banned claims); never approve a failing plan without telling the user why. " +
        "Posting is done by the user on their own accounts: after they post, record it with log_post and update views later with update_post_metrics — that data drives whats_working, which steers future plans. " +
        "Payouts are computed by the system from the brief; don't estimate them yourself.",
    },
  );

  // Schema errors are raised by the SDK before a handler runs; give them the same shape.
  (server as unknown as { createToolError: (message: string) => unknown }).createToolError = (message: string) => fail(new Error(message));

  // Strict arguments (an unknown key is an error, not ignored), and every
  // result stamped with a versioned format; arrays and strings go under `result`.
  const tool = <S extends z.ZodRawShape>(name: string, description: string, shape: S, run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>, readOnly = false) =>
    server.registerTool(name, { description, inputSchema: z.object(shape).strict(), annotations: { readOnlyHint: readOnly } } as never, (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        const value = await run(args);
        const format = `ugc.${name}@1`;
        return text(isPlain(value) ? { format, ...value } : { format, result: value });
      } catch (err) {
        return fail(err);
      }
    }) as never);

  const state = () => api<State>("GET", "/state");
  const campaignIn = (s: State, id: string) => {
    const c = s.campaigns.find((x) => x.id === id);
    if (!c) throw new ToolError("NOT_FOUND", `Campaign ${id} not found (see overview)`);
    return c;
  };
  const clipIn = (s: State, id: string) => {
    const c = s.clips.find((x) => x.id === id);
    if (!c) throw new ToolError("NOT_FOUND", `Clip ${id} not found`);
    return c;
  };
  const linksFor = (c: Clip) =>
    c.render?.status === "done" ? api<{ url: string; editorUrl?: string }>("GET", `/clips/${c.id}/link`).catch(() => undefined) : Promise.resolve(undefined);
  const linkFor = (c: Clip) => linksFor(c).then((l) => l?.url);

  /** Write plans, approve the ones that follow the brief, queue renders. */
  async function planAndRender(campaignId: string, count: number, voice: string, render: boolean, formatId?: string) {
    const before = new Set((await state()).clips.map((c) => c.id));
    const s = await api<State>("POST", `/campaigns/${encodeURIComponent(campaignId)}/clips`, { count, formatId });
    const fresh = s.clips.filter((c) => !before.has(c.id));
    const queued: string[] = [];
    if (render) {
      for (const c of fresh.filter((x) => x.qa.pass)) {
        await api("PUT", `/clips/${c.id}`, { status: "approved" });
        await api("POST", `/clips/${c.id}/render`, { voice });
        queued.push(c.id);
      }
    }
    const after = await state();
    const plans = fresh.map((c) => after.clips.find((x) => x.id === c.id) ?? c);
    return { plans: plans.map((c) => clipFull(c)), renderQueued: queued, next: planNext(plans, queued) };
  }

  /** After planning: wait for what's rendering, then review what's left as a draft. */
  function planNext(plans: Clip[], queued: string[]): Next[] {
    const next: Next[] = [];
    if (queued.length) next.push({ tool: "wait_for_renders", args: { clipIds: queued }, why: "Renders take about a minute each; this returns the video links." });
    for (const c of plans.filter((x) => !queued.includes(x.id)))
      next.push(
        c.qa.pass
          ? { tool: "review_clip", args: { clipId: c.id, decision: "approve" }, why: "This plan follows the brief; approve it to render." }
          : { tool: "review_clip", args: { clipId: c.id }, why: `Fails: ${failing(c).join("; ")}. Fix it with edit_clip, or approve with override only if the user accepts the risk.` },
      );
    return next;
  }

  tool(
    "overview",
    "Every campaign with payout terms, clip and post counts, views and estimated earnings; plus clips waiting for review and renders in progress. Start here.",
    {},
    async () => {
      const s = await state();
      return {
        campaigns: s.campaigns.map((c) => ({ id: c.id, name: c.name, status: c.status, cpm: c.brief.payout.cpm, maxPerPost: c.brief.payout.maxPerSubmission, clips: c.stats.clips, posts: c.stats.posts, views: c.stats.views, estimatedEarnings: c.stats.estimatedEarnings })),
        toReview: s.clips.filter((c) => c.status === "draft").map(clipLine),
        rendering: s.clips.filter((c) => c.render && !["done", "failed"].includes(c.render.status)).map(clipLine),
        services: s.status,
      };
    },
    true,
  );

  tool(
    "brief_to_shorts",
    "One step from a clipping brief to videos: reads the brief (Google Doc / public link, or pasted text), finds its footage, writes `count` clip plans checked against the brief, approves the ones that pass and queues their renders. Plans that fail a rule are left as drafts for review. Then call wait_for_renders with the returned clip ids.",
    {
      briefUrl: z.string().url().optional().describe("Google Doc shared 'anyone with the link', or a public page"),
      briefText: z.string().optional().describe("The brief pasted as text (use when there's no public link)"),
      count: z.number().int().min(1).max(6).default(3),
      voice: VOICE.default("ash"),
      render: z.boolean().default(true).describe("Approve passing plans and queue their renders (false: plans only, for review)"),
    },
    async ({ briefUrl, briefText, count, voice, render }) => {
      if (!briefUrl && !briefText) throw new ToolError("INVALID_ARGUMENT", "Give briefUrl or briefText");
      const { campaign } = await api<{ campaign: Campaign }>("POST", "/campaigns", briefUrl ? { url: briefUrl } : { text: briefText });
      const r = await planAndRender(campaign.id, count, voice, render);
      const s = await state();
      return {
        campaign: campaignSummary(campaignIn(s, campaign.id), s),
        ...r,
        note: r.renderQueued.length ? "Renders take about a minute each." : render ? "No plan passed every rule — see failingRules, then edit_clip or review_clip." : "Plans only; review them, then render_clip.",
      };
    },
  );

  tool(
    "add_campaign",
    "Add a clipping campaign from its brief. Extracts payout (CPM, cap), required phrases, call to action, banned claims, length, platforms and footage links, and lists the footage.",
    { briefUrl: z.string().url().optional(), briefText: z.string().optional() },
    async ({ briefUrl, briefText }) => {
      if (!briefUrl && !briefText) throw new ToolError("INVALID_ARGUMENT", "Give briefUrl or briefText");
      const { campaign } = await api<{ campaign: Campaign }>("POST", "/campaigns", briefUrl ? { url: briefUrl } : { text: briefText });
      const s = await state();
      const c = campaignIn(s, campaign.id);
      const unwatched = c.footage.some((f) => f.kind === "video" && !f.analyzedAt && !f.analysisError);
      const next: Next[] = [
        ...(unwatched ? [{ tool: "find_moments", args: { campaignId: c.id }, why: "Logging the footage's highlights first makes plans and cuts use real moments." }] : []),
        { tool: "plan_clips", args: { campaignId: c.id }, why: "Write clip plans checked against this brief." },
      ];
      return { ...campaignSummary(c, s), next };
    },
  );

  tool(
    "get_campaign",
    "One campaign: brief rules, footage (and which files have moments found), every clip with its QA and render status, posts and earnings.",
    { campaignId: z.string() },
    async ({ campaignId }) => {
      const s = await state();
      return campaignSummary(campaignIn(s, campaignId), s);
    },
    true,
  );

  tool(
    "find_moments",
    "Watch footage with a vision model and log its highlights (goals, saves, funny moments…) with timestamps, so plans and cuts use real moments. One file per call (about $0.01 and up to a few minutes for long files). Omit footageId to take the next file without moments.",
    { campaignId: z.string(), footageId: z.string().optional() },
    async ({ campaignId, footageId }) => {
      const c = campaignIn(await state(), campaignId);
      const f = footageId ? c.footage.find((x) => x.id === footageId) : c.footage.find((x) => x.kind === "video" && !x.analyzedAt && !x.analysisError);
      if (!f) return "Every video already has its moments logged.";
      const s = await api<State>("POST", `/campaigns/${encodeURIComponent(campaignId)}/footage/${f.id}/analyze`, {});
      const done = campaignIn(s, campaignId).footage.find((x) => x.id === f.id)!;
      return { footage: done.name, moments: done.moments, remaining: campaignIn(s, campaignId).footage.filter((x) => x.kind === "video" && !x.analyzedAt).length };
    },
  );

  tool(
    "plan_clips",
    "Write new clip plans for a campaign: hook, voiceover script, on-screen text, shots from the campaign's footage, caption and hashtags. Each is checked against the brief, and guided by what has worked in past posts (some plans are tagged as tests). Set autoRender to approve passing plans and queue their renders.",
    {
      campaignId: z.string(),
      count: z.number().int().min(1).max(10).default(3),
      autoRender: z.boolean().default(false),
      voice: VOICE.default("ash"),
      formatId: z.string().optional().describe("Write the plans in a format cloned from a reference video (see list_formats)"),
    },
    async ({ campaignId, count, autoRender, voice, formatId }) => planAndRender(campaignId, count, voice, autoRender, formatId),
  );

  const OVERLAY = z.object({
    kind: z.enum(["comment", "emoji", "text", "tier"]),
    cue: z.string().describe("Exact words from the voiceover the overlay appears with"),
    text: z.string().optional().describe("Comment text, pop-up word, or tier-list item"),
    user: z.string().optional().describe("Comment author handle"),
    emoji: z.string().optional(),
    tier: z.enum(["S", "A", "B", "C", "D"]).optional(),
    hold: z.number().optional().describe("Seconds on screen"),
  });

  tool(
    "make_variants",
    "A/B test a clip: write 1-6 variants with different hooks (and optionally new call-to-action lines). Shots and the rest of the script stay the same; variants are labelled A, B, C… and each is checked against the brief. Post them side by side to see which opening wins.",
    { clipId: z.string(), count: z.number().int().min(1).max(6).default(3), newCta: z.boolean().default(false) },
    async ({ clipId, count, newCta }) => {
      const s = await api<State>("POST", `/clips/${encodeURIComponent(clipId)}/variants`, { count, newCta });
      const base = clipIn(s, clipId);
      return s.clips.filter((c) => c.variantGroup && c.variantGroup === base.variantGroup).map((c) => ({ ...clipLine(c), variant: c.variantLabel }));
    },
  );

  tool(
    "clone_format",
    "Break a viral reference video down into a reusable format (hook, beats with timings, pacing, caption look, overlays, a recipe). Give a direct link to a video file (not a TikTok/Instagram/YouTube page). Takes a minute or two; check with get_format, then plan_clips with formatId.",
    { url: z.string().url(), name: z.string().optional() },
    async ({ url, name }) => {
      const r = await api<{ format: ReferenceFormat }>("POST", "/formats/from-url", { url, name });
      return { id: r.format.id, name: r.format.name, status: r.format.status, next: [{ tool: "get_format", args: { formatId: r.format.id }, why: "Call until status is ready, then plan_clips with formatId." }] satisfies Next[] };
    },
  );

  tool(
    "list_formats",
    "Formats cloned from reference videos, with their status and one-line summary.",
    {},
    async () => ((await state()).formats ?? []).map((f) => ({ id: f.id, name: f.name, status: f.status, summary: f.breakdown?.summary, error: f.error })),
    true,
  );

  tool(
    "get_format",
    "A format in full: summary, why it works, hook, beats, pacing, captions, overlays and the recipe plans follow.",
    { formatId: z.string() },
    async ({ formatId }) => {
      const f = await api<ReferenceFormat>("GET", `/formats/${encodeURIComponent(formatId)}`);
      return { id: f.id, name: f.name, status: f.status, step: f.step, error: f.error, durationSec: f.durationSec, breakdown: f.breakdown };
    },
    true,
  );

  tool(
    "get_clip",
    "A clip plan in full (script, shots, caption, QA) with its render status and, when rendered, a shareable video link (valid 7 days) and an editorUrl that opens it on a timeline in the browser editor (for the user; needs their login).",
    { clipId: z.string() },
    async ({ clipId }) => {
      const c = clipIn(await state(), clipId);
      const links = await linksFor(c);
      return { ...clipFull(c, links?.url), editorUrl: links?.editorUrl, editedInEditor: c.render?.editedAt };
    },
    true,
  );

  tool(
    "edit_clip",
    "Change a clip plan. The QA check re-runs against the brief and the result is returned.",
    {
      clipId: z.string(),
      hook: z.string().optional(),
      narration: z.string().optional().describe("Full voiceover script"),
      onScreenText: z.array(z.string()).optional(),
      cta: z.string().optional(),
      caption: z.string().optional(),
      hashtags: z.array(z.string()).optional(),
      lengthSec: z.number().int().positive().optional(),
      overlays: z.array(OVERLAY).max(12).optional().describe("Replaces the clip's overlays: comment bubbles, emoji, pop-up words or tier-list items, each on words of the voiceover"),
    },
    async ({ clipId, ...patch }) => {
      const s = await api<State>("PUT", `/clips/${encodeURIComponent(clipId)}`, patch);
      const c = clipIn(s, clipId);
      const next: Next[] = c.status === "draft" ? [{ tool: "review_clip", args: { clipId, decision: "approve" }, why: c.qa.pass ? "It follows the brief now." : `Still fails: ${failing(c).join("; ")}.` }] : c.status === "approved" ? [{ tool: "render_clip", args: { clipId }, why: "Render the edited plan." }] : [];
      return { ...clipFull(c), next };
    },
  );

  tool(
    "review_clip",
    "Approve or reject a clip plan. Approving a plan that fails a brief rule needs override: true — only do that when the user has accepted the risk.",
    { clipId: z.string(), decision: z.enum(["approve", "reject"]), override: z.boolean().default(false) },
    async ({ clipId, decision, override }) => {
      const s = await api<State>("PUT", `/clips/${encodeURIComponent(clipId)}`, { status: decision === "approve" ? "approved" : "rejected", override });
      const next: Next[] = decision === "approve" ? [{ tool: "render_clip", args: { clipId }, why: "Approved plans render into the finished video." }] : [];
      return { ...clipLine(clipIn(s, clipId)), next };
    },
  );

  tool(
    "render_clip",
    "Render an approved plan into a finished 1080×1920 MP4 (footage cut at the best moments, hook, word-timed captions, CTA card, optional AI voiceover). Queued; follow with wait_for_renders.",
    { clipId: z.string(), voice: VOICE.default("ash") },
    async ({ clipId, voice }) => {
      const s = await api<State>("POST", `/clips/${encodeURIComponent(clipId)}/render`, { voice });
      return { ...clipLine(clipIn(s, clipId)), next: [{ tool: "wait_for_renders", args: { clipIds: [clipId] }, why: "Returns the video link when the render finishes." }] satisfies Next[] };
    },
  );

  tool(
    "wait_for_renders",
    "Wait for renders to finish (polls up to timeoutSec), then return each clip's status and its shareable video link. Call again if some are still rendering.",
    { clipIds: z.array(z.string()).min(1), timeoutSec: z.number().int().min(5).max(240).default(90) },
    async ({ clipIds, timeoutSec }) => {
      const until = Date.now() + timeoutSec * 1000;
      let s = await state();
      const pending = () => clipIds.filter((id) => {
        const r = s.clips.find((c) => c.id === id)?.render;
        return r && !["done", "failed"].includes(r.status);
      });
      while (pending().length && Date.now() < until) {
        await sleep(5000);
        s = await state();
      }
      const out = await Promise.all(
        clipIds.map(async (id) => {
          const c = s.clips.find((x) => x.id === id);
          if (!c) return { id, error: "not found" };
          return { id, title: c.title, render: c.render?.status ?? "not started", step: c.render?.step, error: c.render?.error, durationSec: c.render?.durationSec, videoUrl: await linkFor(c) };
        }),
      );
      const still = pending();
      return { clips: out, stillRendering: still, next: still.length ? [{ tool: "wait_for_renders", args: { clipIds: still }, why: "Some renders are still going." }] : [] };
    },
  );

  tool(
    "caption_video",
    `Caption any video with speech: word-perfect captions in about 99 languages (detected automatically), burned in with a caption style and the workspace's brand fonts and colours. Give a public link to a video file. Waits up to waitSec for transcription and rendering, then returns a share link; call get_caption_job to check on it later. Styles: ${CAPTION_STYLES.map((x) => x.id).join(", ")}.`,
    {
      url: z.string().url().describe("Public link to a video file (MP4, MOV, WebM)"),
      language: z.string().default("auto").describe('"auto" or an ISO 639-1 code like "es"'),
      style: z.enum(CAPTION_STYLES.map((x) => x.id) as [string, ...string[]]).optional(),
      wordsPerCaption: z.number().int().min(1).max(12).optional(),
      glossary: z.array(z.string()).optional().describe("Names to spell right, e.g. product names"),
      waitSec: z.number().int().min(0).max(240).default(180),
    },
    async ({ url, language, style, wordsPerCaption, glossary, waitSec }) => {
      const { job } = await api<{ job: { id: string } }>("POST", "/captions/from-url", { url, language, glossary });
      const until = Date.now() + waitSec * 1000;
      const get = () => api<CaptionJob>("GET", `/captions/${job.id}`);
      let j = await get();
      while (["uploaded", "transcribing"].includes(j.status) && Date.now() < until) {
        await sleep(3000);
        j = await get();
      }
      if (j.status !== "ready") return captionJobOut(j);
      await api("POST", `/captions/${job.id}/render`, { captions: { style, wordsPerCaption } });
      j = await get();
      while (j.status === "rendering" && Date.now() < until) {
        await sleep(3000);
        j = await get();
      }
      return captionJobOut(j, j.status === "done" ? (await api<{ url: string }>("GET", `/captions/${job.id}/link`)).url : undefined);
    },
  );

  tool(
    "get_caption_job",
    "A captioning job: status, detected language, the transcript, and a share link once rendered.",
    { jobId: z.string() },
    async ({ jobId }) => {
      const j = await api<CaptionJob>("GET", `/captions/${encodeURIComponent(jobId)}`);
      return captionJobOut(j, j.status === "done" ? (await api<{ url: string }>("GET", `/captions/${encodeURIComponent(jobId)}/link`)).url : undefined, true);
    },
    true,
  );

  tool(
    "list_social_accounts",
    "Social accounts connected for posting and scheduling (through Outstand), with the id to use in schedule_clip. Accounts marked needsReconnect can't be posted to until the user reconnects them in Settings.",
    {},
    async () => {
      const s = await state();
      return {
        publishingEnabled: !!s.status.publishing,
        accounts: s.accounts.filter((a) => a.outstandId).map((a) => ({ id: a.id, platform: a.platform, handle: a.handle, needsReconnect: !!a.needsReconnect })),
      };
    },
    true,
  );

  tool(
    "schedule_clip",
    "Post a rendered clip now, or schedule it (up to 30 days ahead), to one or more connected accounts. This publishes publicly on the user's accounts: only do it when the user asked for it, and confirm accounts and time with them. TikTok goes to the creator's inbox as a draft unless tiktokDirect is set with a privacy level.",
    {
      clipId: z.string(),
      accountIds: z.array(z.string()).min(1).describe("ids from list_social_accounts"),
      at: z.string().optional().describe("ISO 8601 time with timezone; omit to post now"),
      caption: z.string().optional().describe("Defaults to the clip's caption and hashtags"),
      tiktokDirect: z.boolean().default(false),
      tiktokPrivacy: z.enum(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"]).optional(),
      youtubeTitle: z.string().max(100).optional(),
    },
    async ({ clipId, accountIds, at, caption, tiktokDirect, tiktokPrivacy, youtubeTitle }) => {
      const r = await api<{ posts: string[]; state: State }>("POST", `/clips/${encodeURIComponent(clipId)}/schedule`, {
        accountIds,
        at,
        caption,
        tiktok: tiktokDirect ? { mode: "direct", privacy: tiktokPrivacy } : { mode: "inbox" },
        youtube: youtubeTitle ? { title: youtubeTitle } : undefined,
      });
      return r.state.posts.filter((p) => r.posts.includes(p.id)).map(postLine);
    },
  );

  tool(
    "list_schedule",
    "Posts going out through connected accounts: scheduled (upcoming), published (with links and views), and failed (with the reason).",
    {},
    async () => {
      const posts = (await state()).posts.filter((p) => p.outstand);
      return {
        scheduled: posts.filter((p) => p.status === "scheduled").map(postLine),
        failed: posts.filter((p) => p.status === "failed").map((p) => ({ ...postLine(p), error: p.outstand?.error })),
        published: posts.filter((p) => p.status !== "scheduled" && p.status !== "failed").slice(0, 30).map(postLine),
      };
    },
    true,
  );

  tool(
    "cancel_scheduled_post",
    "Cancel a scheduled post before it goes out (on every account it was going to).",
    { postId: z.string() },
    async ({ postId }) => {
      await api("POST", `/posts/${encodeURIComponent(postId)}/cancel`, {});
      return "Cancelled.";
    },
  );

  tool(
    "log_post",
    "Record that the user posted a clip (link, platform, account). Views can be added now or later with update_post_metrics; earnings are computed from the campaign's CPM and cap.",
    {
      clipId: z.string(),
      platform: PLATFORM,
      account: z.string().describe("Handle it was posted from"),
      url: z.string().url().optional(),
      postedAt: z.string().optional().describe("ISO date; defaults to now"),
      views: z.number().int().nonnegative().optional(),
      likes: z.number().int().nonnegative().optional(),
      comments: z.number().int().nonnegative().optional(),
      shares: z.number().int().nonnegative().optional(),
    },
    async ({ clipId, platform, account, url, postedAt, views, likes, comments, shares }) => {
      const clip = clipIn(await state(), clipId);
      const s = await api<State>("POST", "/posts", { campaignId: clip.campaignId, clipId, platform, account, url, postedAt, metrics: { views, likes, comments, shares } });
      return postLine(s.posts[0]);
    },
  );

  tool(
    "update_post_metrics",
    "Update a post's views and engagement. Each update is kept with its date, so posts can be compared at the same age — update a day or two after posting, and again later.",
    {
      postId: z.string(),
      views: z.number().int().nonnegative(),
      likes: z.number().int().nonnegative().optional(),
      comments: z.number().int().nonnegative().optional(),
      shares: z.number().int().nonnegative().optional(),
      status: z.enum(["live", "submitted", "approved", "rejected", "paid", "failed"]).optional(),
    },
    async ({ postId, status, ...metrics }) => {
      const m = Object.fromEntries(Object.entries(metrics).filter(([, v]) => v !== undefined));
      const s = await api<State>("PUT", `/posts/${encodeURIComponent(postId)}`, { metrics: m, status });
      const p = s.posts.find((x) => x.id === postId)!;
      return { post: postLine(p), campaign: s.campaigns.find((c) => c.id === p.campaignId)?.stats };
    },
  );

  tool(
    "list_posts",
    "Posts with links, metrics and payout status, optionally for one campaign.",
    { campaignId: z.string().optional() },
    async ({ campaignId }) => (await state()).posts.filter((p) => !campaignId || p.campaignId === campaignId).map(postLine),
    true,
  );

  tool(
    "whats_working",
    `What the learning system has found from posted clips: performance by hook style (${HOOK_STYLES.map((h) => h.id).join(", ")}), format, length, voice, platform and day; best hooks; and the playbook new plans follow. Set refreshFindings for a written summary (do more / stop doing / test next).`,
    { scope: z.string().default("all").describe('"all" or a campaign id'), refreshFindings: z.boolean().default(false) },
    async ({ scope, refreshFindings }) => {
      const r = refreshFindings
        ? await api<{ report: LearningReport; insights: Insights }>("POST", "/learning/insights", { scope })
        : await api<{ report: LearningReport; insights?: Insights }>("GET", `/learning?scope=${encodeURIComponent(scope)}`);
      return { ...r, note: r.report.maturePosts < 20 ? `Based on ${r.report.maturePosts} posts old enough to compare; patterns firm up around 20–30.` : undefined };
    },
    true,
  );

  server.registerPrompt(
    "make_shorts",
    { description: "Turn a clipping brief into finished shorts.", argsSchema: { brief: z.string().describe("Link to the brief, or the brief text") } } as never,
    (({ brief }: { brief: string }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Use UGCMediaClips to make shorts for this clipping campaign brief:\n\n${brief}\n\n` +
              "Call brief_to_shorts (briefUrl if it's a link, else briefText) with 3 clips, then wait_for_renders until they finish. " +
              "Report the campaign's payout terms and rules in one short list, then each clip's hook, length and video link. " +
              "For plans left as drafts, say which rule failed and offer a fix. Remind me to log each post (link + account) after I upload it.",
          },
        },
      ],
    })) as never,
  );

  return server;
}
