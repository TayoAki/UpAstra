import { createHmac, timingSafeEqual } from "node:crypto";
import type { Platform } from "../shared/types";
import { HttpError } from "./db";
import { videoStore } from "./storage";

// Outstand (outstand.so): one API for posting and scheduling to TikTok,
// Instagram, YouTube, Facebook, X, Threads, LinkedIn, Bluesky and more.
// UGCMediaClips uses one organization API key; each workspace's connected
// social accounts are tagged with the workspace id (Outstand's tenant_id).
// Docs: https://www.outstand.so/docs

export const outstandConfigured = () => !!process.env.OUTSTAND_API_KEY;
const base = () => (process.env.OUTSTAND_BASE_URL ?? "https://api.outstand.so/v1").replace(/\/$/, "");

/** Networks UGCMediaClips offers to connect, with how Outstand names them. */
export const NETWORKS: { id: string; label: string; platform: Platform }[] = [
  { id: "tiktok", label: "TikTok", platform: "tiktok" },
  { id: "instagram", label: "Instagram", platform: "instagram" },
  { id: "youtube", label: "YouTube", platform: "youtube" },
  { id: "facebook", label: "Facebook", platform: "facebook" },
  { id: "x", label: "X", platform: "x" },
  { id: "threads", label: "Threads", platform: "threads" },
  { id: "linkedin", label: "LinkedIn", platform: "linkedin" },
  { id: "bluesky", label: "Bluesky", platform: "bluesky" },
];
export const platformOfNetwork = (network: string): Platform => NETWORKS.find((n) => n.id === network)?.platform ?? "other";

async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, retry = true): Promise<T> {
  if (!outstandConfigured()) throw new HttpError(503, "Publishing isn't set up on this server (OUTSTAND_API_KEY)");
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.OUTSTAND_API_KEY}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 429 && retry) {
    const wait = Math.min(30, Number(res.headers.get("retry-after")) || 2);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return call(method, path, body, headers, false);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) {
    const msg = data.error ?? data.message ?? `HTTP ${res.status}`;
    throw new HttpError(res.status === 402 ? 402 : res.status >= 500 ? 502 : 422, `Outstand: ${msg}`);
  }
  return data as T;
}

export interface OutstandAccount {
  id: string;
  network: string;
  username?: string;
  nickname?: string;
  profile_picture_url?: string;
  isActive?: number | boolean;
  tenant_id?: string;
}

export async function authUrl(network: string, tenantId: string, redirectUri: string): Promise<string> {
  const r = await call<{ data: { auth_url: string } }>("POST", `/social-networks/${encodeURIComponent(network)}/auth-url`, { redirect_uri: redirectUri, tenant_id: tenantId });
  return r.data.auth_url;
}

export async function listAccounts(tenantId: string): Promise<OutstandAccount[]> {
  const r = await call<{ data?: OutstandAccount[] }>("GET", `/social-accounts?tenantId=${encodeURIComponent(tenantId)}&limit=100`);
  // Tenant isolation is ours to enforce: never trust the filter alone.
  return (r.data ?? []).filter((a) => a.tenant_id === tenantId);
}

export async function pendingPages(session: string): Promise<{ id: string; name: string; network?: string; picture?: string }[]> {
  const r = await call<{ data?: { pages?: { id: string; name: string; network?: string; picture?: string; profile_picture_url?: string }[] } }>("GET", `/social-accounts/pending/${encodeURIComponent(session)}`);
  return (r.data?.pages ?? []).map((p) => ({ id: p.id, name: p.name, network: p.network, picture: p.picture ?? p.profile_picture_url }));
}

export async function finalizePending(session: string, pageIds: string[]) {
  await call("POST", `/social-accounts/pending/${encodeURIComponent(session)}/finalize`, { selectedPageIds: pageIds });
}

export async function disconnectAccount(id: string) {
  await call("DELETE", `/social-accounts/${encodeURIComponent(id)}`);
}

/** Copy a stored video to Outstand's media storage (kept 60 days, outlives our 7-day links). */
export async function uploadVideo(key: string, filename: string): Promise<string> {
  const up = await call<{ data: { id: string; upload_url: string } }>("POST", "/media/upload", { filename, content_type: "video/mp4" });
  const file = await videoStore().read(key);
  const size = file.size;
  const put = await fetch(up.data.upload_url, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4", "Content-Length": String(size) },
    body: file.stream as unknown as BodyInit,
    duplex: "half",
    signal: AbortSignal.timeout(30 * 60_000),
  } as RequestInit);
  if (!put.ok) throw new HttpError(502, `Outstand: video upload failed (${put.status})`);
  const done = await call<{ data: { url: string } }>("POST", `/media/${encodeURIComponent(up.data.id)}/confirm`, { size });
  return done.data.url;
}

export interface OutstandPostAccount {
  id: string;
  network: string;
  username?: string;
  status?: "pending" | "published" | "failed" | "deleted";
  platformPostId?: string | null;
  platformPostUrl?: string | null;
  error?: string | null;
}

export async function createPost(body: Record<string, unknown>, idempotencyKey: string): Promise<{ id: string; socialAccounts: OutstandPostAccount[]; warnings?: string[] }> {
  const r = await call<{ post: { id: string; socialAccounts?: OutstandPostAccount[] }; warnings?: string[] }>("POST", "/posts", body, { "Idempotency-Key": idempotencyKey.slice(0, 255) });
  return { id: r.post.id, socialAccounts: r.post.socialAccounts ?? [], warnings: r.warnings };
}

export async function getPost(id: string): Promise<{ id: string; socialAccounts: OutstandPostAccount[] }> {
  const r = await call<{ post: { id: string; socialAccounts?: OutstandPostAccount[] } }>("GET", `/posts/${encodeURIComponent(id)}`);
  return { id: r.post.id, socialAccounts: r.post.socialAccounts ?? [] };
}

export async function deletePost(id: string) {
  await call("DELETE", `/posts/${encodeURIComponent(id)}`);
}

export interface AccountMetrics {
  social_account: { id: string; network: string; username?: string };
  platform_post_url?: string | null;
  metrics: { likes?: number; comments?: number; shares?: number; views?: number } | null;
}

export async function postAnalytics(id: string): Promise<AccountMetrics[]> {
  const r = await call<{ metrics_by_account?: AccountMetrics[] }>("GET", `/posts/${encodeURIComponent(id)}/analytics`);
  return r.metrics_by_account ?? [];
}

export async function tiktokPrivacyOptions(accountId: string): Promise<string[]> {
  const r = await call<{ data?: { privacy_level_options?: string[] } }>("GET", `/tiktok/accounts/${encodeURIComponent(accountId)}/creator-info`);
  return r.data?.privacy_level_options ?? [];
}

/** Webhook signature: "sha256=" + HMAC-SHA256(raw body, signing secret). */
export function verifyWebhook(raw: Buffer, signature: string | undefined): boolean {
  const secret = process.env.OUTSTAND_WEBHOOK_SECRET;
  if (!secret) return false;
  if (!signature) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
