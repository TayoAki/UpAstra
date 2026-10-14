import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Campaign, CampaignStats, Clip, Insights, LearningReport, Post } from "../shared/types";
import { HOOK_STYLES, PLATFORMS, VOICES } from "../shared/types";

// MCP server for Clip Operator: run the whole thing headless from Claude
// (Desktop, Code, claude.ai connectors) or any MCP client. Tools call the same
// HTTP API the dashboard uses, with the workspace agent key, so every brief
// rule, QA check, spend cap and render queue applies unchanged. Actions show
// up in Activity marked as done by an agent.

export type ApiCall = <T = unknown>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) => Promise<T>;

/** Calls the Clip Operator HTTP API with a workspace agent key. */
export function httpApi(baseUrl: string, key: string): ApiCall {
  return async (method, path, body) => {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10 * 60_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
    return data as never;
  };
}

type CampaignWithStats = Campaign & { stats: CampaignStats };
interface State {
  campaigns: CampaignWithStats[];
  clips: Clip[];
  posts: Post[];
  insights: Record<string, Insights>;
  status: Record<string, string>;
}

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const fail = (err: unknown) => ({ content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true });
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

const postLine = (p: Post) => ({ id: p.id, clipId: p.clipId, platform: p.platform, account: p.account, url: p.url, postedAt: p.postedAt, status: p.status, metrics: p.metrics, metricsUpdatedAt: p.metricsUpdatedAt });

const VOICE = z.enum(VOICES.map((v) => v.id) as [string, ...string[]]).describe(`Voiceover: ${VOICES.map((v) => `${v.id} (${v.label})`).join("; ")}`);
const PLATFORM = z.enum(PLATFORMS as [string, ...string[]]);

export function createMcpServer(api: ApiCall): McpServer {
  const server = new McpServer(
    { name: "clip-operator", version: "0.1.0" },
    {
      instructions:
        "Clip Operator turns paid clipping-campaign briefs into finished 9:16 shorts (TikTok, Reels, Shorts). " +
        "Fastest path: brief_to_shorts (brief link or text → plans → renders), then wait_for_renders for the video links. " +
        "Step by step: add_campaign → plan_clips → review_clip (approve) → render_clip → wait_for_renders. " +
        "Plans are checked against the brief in code (required phrases, CTA, length, banned claims); never approve a failing plan without telling the user why. " +
        "Posting is done by the user on their own accounts: after they post, record it with log_post and update views later with update_post_metrics — that data drives whats_working, which steers future plans. " +
        "Payouts are computed by the system from the brief; don't estimate them yourself.",
    },
  );

  const tool = <S extends z.ZodRawShape>(name: string, description: string, shape: S, run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>, readOnly = false) =>
    server.registerTool(name, { description, inputSchema: shape, annotations: { readOnlyHint: readOnly } } as never, (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        return text(await run(args));
      } catch (err) {
        return fail(err);
      }
    }) as never);

  const state = () => api<State>("GET", "/state");
  const campaignIn = (s: State, id: string) => {
    const c = s.campaigns.find((x) => x.id === id);
    if (!c) throw new Error(`Campaign ${id} not found (see overview)`);
    return c;
  };
  const clipIn = (s: State, id: string) => {
    const c = s.clips.find((x) => x.id === id);
    if (!c) throw new Error(`Clip ${id} not found`);
    return c;
  };
  const linkFor = (c: Clip) => (c.render?.status === "done" ? api<{ url: string }>("GET", `/clips/${c.id}/link`).then((r) => r.url).catch(() => undefined) : Promise.resolve(undefined));

  /** Write plans, approve the ones that follow the brief, queue renders. */
  async function planAndRender(campaignId: string, count: number, voice: string, render: boolean) {
    const before = new Set((await state()).clips.map((c) => c.id));
    const s = await api<State>("POST", `/campaigns/${campaignId}/clips`, { count });
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
    return { plans: fresh.map((c) => clipFull(after.clips.find((x) => x.id === c.id) ?? c)), renderQueued: queued };
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
    },
    async ({ briefUrl, briefText, count, voice }) => {
      if (!briefUrl && !briefText) throw new Error("Give briefUrl or briefText");
      const { campaign } = await api<{ campaign: Campaign }>("POST", "/campaigns", briefUrl ? { url: briefUrl } : { text: briefText });
      const r = await planAndRender(campaign.id, count, voice, true);
      const s = await state();
      return {
        campaign: campaignSummary(campaignIn(s, campaign.id), s),
        ...r,
        next: r.renderQueued.length ? `Renders take about a minute each. Call wait_for_renders with ${JSON.stringify(r.renderQueued)}.` : "No plan passed every rule — see failingRules, then edit_clip or review_clip.",
      };
    },
  );

  tool(
    "add_campaign",
    "Add a clipping campaign from its brief. Extracts payout (CPM, cap), required phrases, call to action, banned claims, length, platforms and footage links, and lists the footage.",
    { briefUrl: z.string().url().optional(), briefText: z.string().optional() },
    async ({ briefUrl, briefText }) => {
      if (!briefUrl && !briefText) throw new Error("Give briefUrl or briefText");
      const { campaign } = await api<{ campaign: Campaign }>("POST", "/campaigns", briefUrl ? { url: briefUrl } : { text: briefText });
      const s = await state();
      return campaignSummary(campaignIn(s, campaign.id), s);
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
      const s = await api<State>("POST", `/campaigns/${campaignId}/footage/${f.id}/analyze`, {});
      const done = campaignIn(s, campaignId).footage.find((x) => x.id === f.id)!;
      return { footage: done.name, moments: done.moments, remaining: campaignIn(s, campaignId).footage.filter((x) => x.kind === "video" && !x.analyzedAt).length };
    },
  );

  tool(
    "plan_clips",
    "Write new clip plans for a campaign: hook, voiceover script, on-screen text, shots from the campaign's footage, caption and hashtags. Each is checked against the brief, and guided by what has worked in past posts (some plans are tagged as tests). Set autoRender to approve passing plans and queue their renders.",
    { campaignId: z.string(), count: z.number().int().min(1).max(10).default(3), autoRender: z.boolean().default(false), voice: VOICE.default("ash") },
    async ({ campaignId, count, autoRender, voice }) => planAndRender(campaignId, count, voice, autoRender),
  );

  tool(
    "get_clip",
    "A clip plan in full (script, shots, caption, QA) with its render status and, when rendered, a shareable video link (valid 7 days).",
    { clipId: z.string() },
    async ({ clipId }) => {
      const c = clipIn(await state(), clipId);
      return clipFull(c, await linkFor(c));
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
    },
    async ({ clipId, ...patch }) => {
      const s = await api<State>("PUT", `/clips/${clipId}`, patch);
      return clipFull(clipIn(s, clipId));
    },
  );

  tool(
    "review_clip",
    "Approve or reject a clip plan. Approving a plan that fails a brief rule needs override: true — only do that when the user has accepted the risk.",
    { clipId: z.string(), decision: z.enum(["approve", "reject"]), override: z.boolean().default(false) },
    async ({ clipId, decision, override }) => {
      const s = await api<State>("PUT", `/clips/${clipId}`, { status: decision === "approve" ? "approved" : "rejected", override });
      return clipLine(clipIn(s, clipId));
    },
  );

  tool(
    "render_clip",
    "Render an approved plan into a finished 1080×1920 MP4 (footage cut at the best moments, hook, word-timed captions, CTA card, optional AI voiceover). Queued; follow with wait_for_renders.",
    { clipId: z.string(), voice: VOICE.default("ash") },
    async ({ clipId, voice }) => {
      const s = await api<State>("POST", `/clips/${clipId}/render`, { voice });
      return clipLine(clipIn(s, clipId));
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
      return { clips: out, stillRendering: pending() };
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
      status: z.enum(["live", "submitted", "approved", "rejected", "paid"]).optional(),
    },
    async ({ postId, status, ...metrics }) => {
      const m = Object.fromEntries(Object.entries(metrics).filter(([, v]) => v !== undefined));
      const s = await api<State>("PUT", `/posts/${postId}`, { metrics: m, status });
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
              `Use Clip Operator to make shorts for this clipping campaign brief:\n\n${brief}\n\n` +
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
