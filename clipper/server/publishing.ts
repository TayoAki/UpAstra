import { createHash } from "node:crypto";
import type { Clip, Post, SocialAccount } from "../shared/types";
import { getBackend, getDoc, HttpError, loadTenant, log, newId, now, runInWorkspace, save } from "./db";
import * as outstand from "./outstand";
import { recordUsage } from "./usage";

// Scheduling and publishing through Outstand, and reading views back so
// earnings and the learning system update without anyone typing numbers in.

/** Bring the workspace's connected accounts in line with Outstand. */
export async function syncAccounts(workspaceId: string): Promise<SocialAccount[]> {
  const remote = await outstand.listAccounts(workspaceId);
  const doc = getDoc();
  const seen = new Set<string>();
  for (const a of remote) {
    seen.add(a.id);
    await getBackend().linkExternal("outstand-account", a.id, workspaceId);
    const existing = doc.accounts.find((x) => x.outstandId === a.id);
    const fields = {
      platform: outstand.platformOfNetwork(a.network),
      handle: (a.username ?? a.nickname ?? a.id).replace(/^@/, ""),
      outstandId: a.id,
      avatarUrl: a.profile_picture_url ?? undefined,
      needsReconnect: a.isActive === 0 || a.isActive === false ? true : undefined,
    };
    if (existing) Object.assign(existing, fields);
    else doc.accounts.push({ id: newId("acct"), niche: "", ...fields });
  }
  // Disconnected elsewhere: keep the account for history, but it can't be posted to.
  for (const a of doc.accounts) if (a.outstandId && !seen.has(a.outstandId)) a.outstandId = undefined;
  save();
  return doc.accounts;
}

export interface ScheduleOptions {
  accountIds: string[];
  /** ISO time; omit to post now. */
  at?: string;
  caption: string;
  tiktok?: { mode: "inbox" | "direct"; privacy?: string };
  youtube?: { title?: string; privacy?: "public" | "unlisted" | "private" };
}

/** Schedule (or post now) a rendered clip to connected accounts. One Outstand post, one UGCMediaClips post per account. */
export async function scheduleClip(workspaceId: string, clip: Clip, o: ScheduleOptions): Promise<Post[]> {
  const doc = getDoc();
  const key = clip.render?.status === "done" ? clip.render.videoKey : undefined;
  if (!key) throw new HttpError(409, "Render this clip before scheduling it");
  const accounts = o.accountIds.map((id) => doc.accounts.find((a) => a.id === id && a.outstandId));
  if (!accounts.length || accounts.some((a) => !a)) throw new HttpError(400, "Pick connected accounts to post to");
  const at = o.at ? new Date(o.at) : undefined;
  if (at && Number.isNaN(at.getTime())) throw new HttpError(400, "That date isn't valid");
  if (at && at.getTime() > Date.now() + 30 * 864e5) throw new HttpError(400, "Posts can be scheduled up to 30 days ahead");
  const caption = o.caption.trim().slice(0, 2200);
  const networks = new Set(accounts.map((a) => a!.platform));

  const body: Record<string, unknown> = {
    containers: [{ content: caption, media: [{ url: await outstand.uploadVideo(key, `${slug(clip.title)}.mp4`), filename: `${slug(clip.title)}.mp4` }] }],
    accounts: accounts.map((a) => a!.outstandId),
    ...(at && at.getTime() > Date.now() + 60_000 ? { scheduledAt: at.toISOString() } : {}),
  };
  if (networks.has("tiktok")) {
    if (o.tiktok?.mode === "direct") {
      if (!o.tiktok.privacy) throw new HttpError(400, "Pick who can see the TikTok post");
      body.tiktok = { postMode: "DIRECT_POST", privacyLevel: o.tiktok.privacy, isAigc: true };
    } else body.tiktok = { postMode: "MEDIA_UPLOAD" };
  }
  if (networks.has("youtube")) body.youtube = { title: (o.youtube?.title || clip.title).slice(0, 100), isShort: true, privacyStatus: o.youtube?.privacy ?? "public", containsSyntheticMedia: clip.render?.voice !== "none" ? true : undefined };
  if (networks.has("instagram")) body.instagram = { content: caption };
  if (networks.has("facebook")) body.facebook = { publishAsReel: true };

  // Same clip, accounts and time → same key, so a retried request can't post twice.
  const idem = createHash("sha256").update(`${clip.id}|${key}|${[...o.accountIds].sort().join(",")}|${body.scheduledAt ?? "now"}`).digest("hex");
  const created = await outstand.createPost(body, idem);
  await getBackend().linkExternal("outstand-post", created.id, workspaceId);

  const posts: Post[] = accounts.map((a) => ({
    id: newId("post"),
    campaignId: clip.campaignId,
    clipId: clip.id,
    platform: a!.platform,
    account: a!.handle,
    url: "",
    postedAt: (body.scheduledAt as string | undefined) ?? now(),
    status: "scheduled",
    metrics: { views: 0, likes: 0, comments: 0, shares: 0 },
    notes: o.tiktok?.mode !== "direct" && a!.platform === "tiktok" ? "TikTok: sent to the creator's inbox as a draft — publish it in the TikTok app." : "",
    outstand: { postId: created.id, accountId: a!.outstandId!, scheduledAt: body.scheduledAt as string | undefined },
  }));
  doc.posts.unshift(...posts);
  log({ campaignId: clip.campaignId, kind: "post", message: `${body.scheduledAt ? `Scheduled for ${new Date(body.scheduledAt as string).toUTCString()}` : "Posting now"}: "${clip.title}" to ${accounts.map((a) => `${a!.platform} @${a!.handle}`).join(", ")}.` });
  save();
  return posts;
}

/** Cancel a scheduled post (all its accounts). */
export async function cancelScheduled(post: Post) {
  if (!post.outstand || post.status !== "scheduled") throw new HttpError(409, "Only scheduled posts can be cancelled");
  await outstand.deletePost(post.outstand.postId);
  const doc = getDoc();
  const ids = doc.posts.filter((p) => p.outstand?.postId === post.outstand!.postId).map((p) => p.id);
  doc.posts = doc.posts.filter((p) => !ids.includes(p.id));
  log({ campaignId: post.campaignId, kind: "post", message: `Cancelled a scheduled post (${ids.length} account${ids.length === 1 ? "" : "s"}).` });
  save();
}

/** Apply one per-account result from Outstand (webhook or poll). */
function applyResult(p: Post, r: { status?: string; platformPostUrl?: string | null; platform_post_url?: string | null; error?: string | null }) {
  const url = r.platformPostUrl ?? r.platform_post_url ?? undefined;
  if (r.status === "published" || (url && p.status === "scheduled")) {
    if (p.status === "scheduled" || p.status === "failed") {
      p.status = "live";
      p.postedAt = now();
    }
    if (url) p.url = url;
    p.outstand = { ...p.outstand!, error: undefined };
  } else if (r.status === "failed" || r.error) {
    p.status = "failed";
    p.outstand = { ...p.outstand!, error: (r.error ?? "Publishing failed").slice(0, 300) };
  }
}

export interface WebhookEvent {
  event: string;
  data: { postId?: string; accountId?: string | number; socialAccounts?: { accountId: string; status?: string; platformPostUrl?: string; error?: string }[] };
}

/** Outstand webhook → the workspace that owns the post or account. */
export async function handleWebhook(e: WebhookEvent): Promise<boolean> {
  const b = getBackend();
  if (e.event === "post.published" || e.event === "post.error") {
    const postId = e.data.postId;
    const ws = postId && (await b.workspaceForExternal("outstand-post", postId));
    if (!ws) return false;
    await loadTenant(ws);
    await runInWorkspace(ws, undefined, async () => {
      const doc = getDoc();
      const wasLive = new Set(doc.posts.filter((x) => x.outstand?.postId === postId && x.status === "live").map((x) => x.id));
      for (const r of e.data.socialAccounts ?? []) {
        const p = doc.posts.find((x) => x.outstand?.postId === postId && x.outstand.accountId === r.accountId);
        if (p) applyResult(p, e.event === "post.error" ? { status: "failed", error: r.error } : { status: "published", platformPostUrl: r.platformPostUrl });
      }
      const live = doc.posts.filter((x) => x.outstand?.postId === postId && x.status === "live");
      recordUsage("posts", live.filter((x) => !wasLive.has(x.id)).length);
      for (const clip of doc.clips.filter((c) => live.some((p) => p.clipId === c.id))) clip.status = "posted";
      log({ kind: "post", message: e.event === "post.published" ? `Published: ${live.map((p) => `${p.platform} @${p.account}`).join(", ") || "post"}.` : `Publishing failed: ${(e.data.socialAccounts ?? []).map((r) => r.error).filter(Boolean).join("; ").slice(0, 200)}` });
      save();
    });
    return true;
  }
  if (e.event === "account.token_expired" && e.data.accountId !== undefined) {
    const id = String(e.data.accountId);
    const ws = await b.workspaceForExternal("outstand-account", id);
    if (!ws) return false;
    await loadTenant(ws);
    await runInWorkspace(ws, undefined, async () => {
      const a = getDoc().accounts.find((x) => x.outstandId === id);
      if (a) {
        a.needsReconnect = true;
        log({ kind: "account", message: `${a.platform} @${a.handle} needs to be reconnected (its login expired).` });
        save();
      }
    });
    return true;
  }
  return false;
}

/** Pull views and status for this workspace's Outstand posts (last 30 days). */
export async function syncMetrics(): Promise<number> {
  const doc = getDoc();
  const cutoff = Date.now() - 30 * 864e5;
  const ids = [...new Set(doc.posts.filter((p) => p.outstand && Date.parse(p.postedAt) > cutoff && p.status !== "failed").map((p) => p.outstand!.postId))];
  let updated = 0;
  for (const id of ids) {
    try {
      const posts = doc.posts.filter((p) => p.outstand?.postId === id);
      if (posts.some((p) => p.status === "scheduled")) {
        const st = await outstand.getPost(id);
        for (const r of st.socialAccounts) {
          const p = posts.find((x) => x.outstand!.accountId === r.id);
          if (p) applyResult(p, r);
        }
      }
      if (!posts.some((p) => p.status === "live" || p.status === "submitted" || p.status === "approved" || p.status === "paid")) continue;
      for (const m of await outstand.postAnalytics(id)) {
        const p = posts.find((x) => x.outstand!.accountId === m.social_account.id);
        if (!p || !m.metrics) continue;
        if (m.platform_post_url && !p.url) p.url = m.platform_post_url;
        const n = (v?: number) => Math.max(0, Math.round(v ?? 0));
        p.metrics = { views: n(m.metrics.views), likes: n(m.metrics.likes), comments: n(m.metrics.comments), shares: n(m.metrics.shares) };
        p.metricsUpdatedAt = now();
        p.history = [...(p.history ?? []), { ...p.metrics, at: p.metricsUpdatedAt }].slice(-40);
        p.outstand = { ...p.outstand!, metricsSyncedAt: p.metricsUpdatedAt };
        updated++;
      }
    } catch (err) {
      console.error(`[outstand] sync ${id} failed:`, (err as Error).message);
    }
  }
  if (updated) save();
  return updated;
}

/** Every 30 minutes: refresh views for recent Outstand posts in every workspace. */
export function startMetricsPoller(intervalMs = Number(process.env.OUTSTAND_SYNC_MINUTES ?? 30) * 60_000) {
  if (!outstand.outstandConfigured()) return;
  const tick = async () => {
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    const workspaces = new Set((await getBackend().listExternal("outstand-post", since)).map((x) => x.workspaceId));
    for (const ws of workspaces) {
      try {
        await loadTenant(ws);
        await runInWorkspace(ws, undefined, () => syncMetrics());
      } catch (err) {
        console.error(`[outstand] poll ${ws} failed:`, (err as Error).message);
      }
    }
  };
  setInterval(() => void tick(), intervalMs).unref();
  setTimeout(() => void tick(), 60_000).unref();
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "clip";
