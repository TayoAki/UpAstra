import { createHmac } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { initAuth } from "../server/auth";
import { getDoc, loadTenant, runInWorkspace, save, useMemoryBackend } from "../server/db";
import { setAISimulated } from "../server/llm";
import { videoStore } from "../server/storage";

// A stand-in for Outstand's API, shaped like its docs (https://www.outstand.so/docs).
const calls: { method: string; path: string; body?: Record<string, unknown>; headers: http.IncomingHttpHeaders }[] = [];
const fakePosts = new Map<string, { accounts: string[]; scheduledAt?: string }>();
let fake: http.Server;
let fakeBase = "";
let app: http.Server;
let base = "";
let tmp = "";
const SECRET = "whsec_test";

function startFake() {
  fake = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const u = new URL(req.url!, "http://x");
      const body = raw && req.headers["content-type"]?.includes("json") ? JSON.parse(raw) : undefined;
      calls.push({ method: req.method!, path: u.pathname + u.search, body, headers: req.headers });
      const send = (status: number, j: unknown) => (res.writeHead(status, { "Content-Type": "application/json" }), res.end(JSON.stringify(j)));
      const p = u.pathname;
      // Pre-signed upload URLs carry their own auth; the API needs the key.
      if (!p.startsWith("/upload/") && req.headers.authorization !== "Bearer sk_test") return send(401, { error: "Unauthorized" });
      if (p.startsWith("/upload/") && req.headers.authorization) return send(400, { error: "Don't send the API key to storage" });
      if (req.method === "POST" && /^\/v1\/social-networks\/\w+\/auth-url$/.test(p)) return send(200, { success: true, data: { auth_url: `https://outstand.example/connect?tenant=${body.tenant_id}&redirect=${encodeURIComponent(body.redirect_uri)}` } });
      if (req.method === "GET" && p === "/v1/social-accounts")
        return send(200, {
          data: [
            { id: "TT1", network: "tiktok", username: "carclips", isActive: 1, tenant_id: u.searchParams.get("tenantId") },
            { id: "YT1", network: "youtube", username: "carclips_yt", isActive: 1, tenant_id: u.searchParams.get("tenantId") },
            { id: "OTHER", network: "instagram", username: "someone_else", isActive: 1, tenant_id: "another_workspace" },
          ],
        });
      if (req.method === "POST" && p === "/v1/media/upload") return send(200, { success: true, data: { id: "M1", upload_url: `${fakeBase}/upload/M1`, expires_in: 3600 } });
      if (req.method === "PUT" && p === "/upload/M1") return (res.writeHead(200), res.end());
      if (req.method === "POST" && p === "/v1/media/M1/confirm") return send(200, { success: true, data: { id: "M1", url: "https://media.outstand.example/clip.mp4", size: body.size } });
      if (req.method === "POST" && p === "/v1/posts") {
        const id = `P${fakePosts.size + 1}`;
        fakePosts.set(id, { accounts: body.accounts, scheduledAt: body.scheduledAt });
        return send(200, { success: true, post: { id, scheduledAt: body.scheduledAt ?? null, socialAccounts: body.accounts.map((a: string) => ({ id: a, network: a === "TT1" ? "tiktok" : "youtube" })) } });
      }
      const m = p.match(/^\/v1\/posts\/(\w+)(\/analytics)?$/);
      if (m && req.method === "DELETE") return fakePosts.delete(m[1]) ? send(200, { success: true }) : send(404, { error: "Not found" });
      if (m && m[2])
        return send(200, {
          success: true,
          metrics_by_account: (fakePosts.get(m[1])?.accounts ?? []).map((a) => ({ social_account: { id: a, network: "tiktok" }, platform_post_url: `https://tiktok.example/${a}`, metrics: { views: 12000, likes: 900, comments: 40, shares: 12 } })),
        });
      if (m) return send(200, { success: true, post: { id: m[1], socialAccounts: (fakePosts.get(m[1])?.accounts ?? []).map((a) => ({ id: a, network: "tiktok", status: "published", platformPostUrl: `https://tiktok.example/${a}` })) } });
      send(404, { error: `no route ${req.method} ${p}` });
    });
  });
  return new Promise<void>((r) => fake.listen(0, () => r()));
}

beforeAll(async () => {
  await startFake();
  fakeBase = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pub-"));
  Object.assign(process.env, { OUTSTAND_API_KEY: "sk_test", OUTSTAND_BASE_URL: `${fakeBase}/v1`, OUTSTAND_WEBHOOK_SECRET: SECRET, DATA_DIR: tmp });
  useMemoryBackend();
  setAISimulated(true);
  initAuth();
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(() => {
  app?.close();
  fake?.close();
  for (const k of ["OUTSTAND_API_KEY", "OUTSTAND_BASE_URL", "OUTSTAND_WEBHOOK_SECRET", "DATA_DIR"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("publishing through Outstand", () => {
  it("connects accounts per workspace, schedules a clip, follows webhooks and syncs views", async () => {
    const su = await fetch(`${base}/api/auth/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "pub@test.dev", password: "password123" }) });
    const cookie = su.headers.get("set-cookie")!.split(";")[0];
    const me = await su.json();
    const ws = me.workspace.id;
    const call = async (p: string, method = "GET", body?: unknown) => {
      const r = await fetch(base + p, { method, redirect: "manual", headers: { cookie, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, location: r.headers.get("location"), body: await r.json().catch(() => ({})) };
    };
    expect((await (await fetch(`${base}/api/health`)).json()).publishing).toBe(true);

    // Connect: a hosted sign-in link tagged with this workspace, then the callback syncs accounts.
    const conn = await call("/api/social/connect", "POST", { network: "tiktok" });
    expect(conn.body.url).toContain(`tenant=${ws}`);
    expect(decodeURIComponent(conn.body.url)).toContain("/api/social/callback");
    const cb = await call("/api/social/callback?success=true&account_id=TT1&username=carclips");
    expect(cb.status).toBe(302);
    expect(cb.location).toBe("/#/settings/accounts?connected=1");
    let st = (await call("/api/state")).body;
    expect(st.accounts.map((a: { handle: string }) => a.handle).sort()).toEqual(["carclips", "carclips_yt"]); // not someone_else
    const [tt, yt] = ["carclips", "carclips_yt"].map((h) => st.accounts.find((a: { handle: string }) => a.handle === h).id);

    // A rendered clip to post.
    const brief = fs.readFileSync(new URL("./fixtures/car-league-brief.txt", import.meta.url), "utf8");
    const camp = (await call("/api/campaigns", "POST", { text: brief })).body.campaign;
    const clip = (await call(`/api/campaigns/${camp.id}/clips`, "POST", { count: 1 })).body.clips[0];
    const video = path.join(tmp, "v.mp4");
    fs.writeFileSync(video, Buffer.alloc(4096, 1));
    await videoStore().put(`${ws}/clips/${clip.id}-1.mp4`, video, "video/mp4");
    await loadTenant(ws);
    runInWorkspace(ws, undefined, () => {
      const c = getDoc().clips.find((x) => x.id === clip.id)!;
      c.render = { status: "done", step: "Ready", voice: "ash", requestedAt: new Date().toISOString(), cost: 0, videoKey: `${ws}/clips/${clip.id}-1.mp4` };
      save();
    });

    // Schedule to both accounts tomorrow.
    const at = new Date(Date.now() + 864e5).toISOString();
    const sch = await call(`/api/clips/${clip.id}/schedule`, "POST", { accountIds: [tt, yt], at, caption: "Soccer with cars #carleague" });
    expect(sch.status).toBe(201);
    const created = calls.find((c) => c.method === "POST" && c.path === "/v1/posts")!;
    expect(created.headers["idempotency-key"]).toMatch(/^[0-9a-f]{64}$/);
    expect(created.body).toMatchObject({
      accounts: ["TT1", "YT1"],
      scheduledAt: at,
      containers: [{ content: "Soccer with cars #carleague", media: [{ url: "https://media.outstand.example/clip.mp4" }] }],
      tiktok: { postMode: "MEDIA_UPLOAD" },
      youtube: { isShort: true, privacyStatus: "public" },
    });
    expect(calls.some((c) => c.method === "PUT" && c.path === "/upload/M1" && c.headers["content-length"] === "4096")).toBe(true);
    st = (await call("/api/state")).body;
    const scheduled = st.posts.filter((p: { status: string }) => p.status === "scheduled");
    expect(scheduled).toHaveLength(2);
    // Scheduled posts don't count toward earnings.
    expect(st.campaigns[0].stats.posts).toBe(0);

    // Webhooks: unsigned or tampered are refused; signed ones mark the post live.
    const payload = JSON.stringify({ event: "post.published", timestamp: new Date().toISOString(), data: { postId: "P1", socialAccounts: [{ accountId: "TT1", network: "tiktok", platformPostUrl: "https://tiktok.example/v/1" }] } });
    const sign = (s: string) => `sha256=${createHmac("sha256", SECRET).update(s).digest("hex")}`;
    expect((await fetch(`${base}/api/outstand/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload })).status).toBe(401);
    expect((await fetch(`${base}/api/outstand/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-Outstand-Signature": sign(payload) }, body: payload.replace("v/1", "v/2") })).status).toBe(401);
    const ok = await fetch(`${base}/api/outstand/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-Outstand-Signature": sign(payload) }, body: payload });
    expect(await ok.json()).toEqual({ ok: true, handled: true });
    st = (await call("/api/state")).body;
    const live = st.posts.find((p: { account: string }) => p.account === "carclips");
    expect(live).toMatchObject({ status: "live", url: "https://tiktok.example/v/1" });
    expect(st.clips.find((c: { id: string }) => c.id === clip.id).status).toBe("posted");

    // Views come back from Outstand: earnings and history update with no typing.
    const sync = await call("/api/social/sync-metrics", "POST", {});
    expect(sync.body.updated).toBeGreaterThanOrEqual(1);
    const synced = sync.body.state.posts.find((p: { account: string }) => p.account === "carclips");
    expect(synced.metrics.views).toBe(12000);
    expect(synced.history.at(-1).views).toBe(12000);
    expect(sync.body.state.campaigns[0].stats.views).toBeGreaterThanOrEqual(12000);

    // Cancel a scheduled post.
    const sch2 = await call(`/api/clips/${clip.id}/schedule`, "POST", { accountIds: [yt], at: new Date(Date.now() + 2 * 864e5).toISOString() });
    const pid = sch2.body.posts[0];
    const cancel = await call(`/api/posts/${pid}/cancel`, "POST", {});
    expect(cancel.status).toBe(200);
    expect(cancel.body.posts.some((p: { id: string }) => p.id === pid)).toBe(false);
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/v1/posts/P2")).toBe(true);

    // Guard rails.
    expect((await call(`/api/clips/${clip.id}/schedule`, "POST", { accountIds: ["acct_nope"] })).status).toBe(400);
    expect((await call(`/api/clips/${clip.id}/schedule`, "POST", { accountIds: [tt], at: new Date(Date.now() + 40 * 864e5).toISOString() })).status).toBe(400);
    expect((await call(`/api/clips/${clip.id}/schedule`, "POST", { accountIds: [tt], tiktok: { mode: "direct" } })).status).toBe(400);
  });
});
