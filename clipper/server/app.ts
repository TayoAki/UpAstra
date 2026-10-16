import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { campaignStats } from "../shared/rules";
import type { AdminUsage, AgentRun, CaptionJob, Campaign, CampaignBrief, Clip, ClipStatus, Me, Platform, Post, PostStatus, ServiceStatus, SocialAccount, VoiceOption } from "../shared/types";
import { CLIP_STATUSES, PLATFORMS, POST_STATUSES, VOICES } from "../shared/types";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bearerAgentKey, clearSession, clearThrottle, hashAgentKey, hashPassword, humansOnly, issueSession, newAgentKey, requireWorkspace, signVideoLink, throttle, verifyPassword, verifyVideoLink } from "./auth";
import { HttpError, emptyDoc, forgetTenant, getBackend, getDoc, loadedDoc, loadTenant, log, newId, now, runInWorkspace, save, type UserRow } from "./db";
import { createMcpServer, httpApi } from "./mcp";
import { extractBrief, normalizeBrief } from "./extract";
import { aiLive, editorModel, forwardChat, mediaLive, modelFor, spendAI } from "./llm";
import { emptyMonth, isAdmin, monthCost, monthKey, recordAI, usageReport } from "./usage";
import { analyzeFootage } from "./moments";
import { enqueueRender, renderAvailable } from "./render";
import { saveStream, saveTo, saveUpload } from "./footage-cache";
import { Readable } from "node:stream";
import { applyEdits, enqueueCaptionJob } from "./caption-jobs";
import { transcriptionAvailable } from "./transcribe";
import { LANGUAGES } from "../shared/languages";
import { safeFetch } from "./sources";
import { authUrl, disconnectAccount, finalizePending, NETWORKS, outstandConfigured, pendingPages, tiktokPrivacyOptions, verifyWebhook } from "./outstand";
import { isRunning, resolvePending, sendToAgent, stopAgent } from "./agent";
import { cancelScheduled, handleWebhook, scheduleClip, syncAccounts, syncMetrics, type WebhookEvent } from "./publishing";
import { bundledFontsDir, fontInfo } from "./fonts";
import { accentOf, BUNDLED_FONTS, CAPTION_STYLES, resolveCaptionStyle, type BrandKit, type CaptionOverrides } from "../shared/caption-styles";
import { probe, run } from "./media";
import { storageKind, videoStore } from "./storage";
import { checkClip } from "../shared/rules";
import { planClips, type PlanGuide } from "./scripts";
import { analyze, testShare } from "../shared/learning";
import { writeInsights } from "./insights";
import { driveThumb, readBriefUrl, resolveFootage } from "./sources";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

export function serviceStatus(): ServiceStatus {
  return {
    ai: aiLive() ? "live" : "simulated",
    aiModel: aiLive() ? modelFor("script") : "rules",
    render: renderAvailable() ? "connected" : "not-connected",
    voice: mediaLive() ? "live" : "off",
    storage: getBackend().kind,
    editor: fs.existsSync(path.join(editorDir(), "index.html")),
    captions: transcriptionAvailable(),
    publishing: outstandConfigured(),
  };
}


const findCampaign = (id: string) => {
  const c = getDoc().campaigns.find((x) => x.id === id);
  if (!c) throw new HttpError(404, "Campaign not found");
  return c;
};
const findClip = (id: string) => {
  const c = getDoc().clips.find((x) => x.id === id);
  if (!c) throw new HttpError(404, "Clip not found");
  return c;
};
const findPost = (id: string) => {
  const p = getDoc().posts.find((x) => x.id === id);
  if (!p) throw new HttpError(404, "Post not found");
  return p;
};

const count = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

async function refreshFootage(c: Campaign) {
  const { files, errors } = await resolveFootage(c.brief.footage);
  // Keep ids stable so clip shots stay linked across refreshes.
  // Keep ids (clip shots point at them) and any moments already found.
  const old = new Map(c.footage.map((f) => [f.sourceId, f]));
  c.footage = files.map((f) => {
    const prev = old.get(f.sourceId);
    return prev ? { ...f, id: prev.id, storageKey: prev.storageKey, sizeBytes: prev.sizeBytes, durationSec: prev.durationSec, hasAudio: prev.hasAudio, moments: prev.moments, analyzedAt: prev.analyzedAt, analysisError: prev.analysisError } : f;
  });
  // Uploaded files aren't behind any link: keep them.
  c.footage.push(...[...old.values()].filter((f) => f.storageKey && !f.folderUrl));
  c.footageCheckedAt = now();
  c.footageError = errors.length ? errors.join(" · ") : undefined;
  log({ campaignId: c.id, kind: "footage", message: `Footage checked: ${count(files.filter((f) => f.kind === "video").length, "video")}, ${count(files.filter((f) => f.kind === "image").length, "image")}${errors.length ? ` (${errors.length} link(s) failed)` : ""}.` });
}

function stateFor(): unknown {
  const doc = getDoc();
  return {
    campaigns: doc.campaigns.map((c) => ({
      ...c,
      // Older campaigns stored Drive's expiring thumbnail links.
      footage: c.footage.map((f) => (f.thumbUrl && /drive\.google\.com\/file\//.test(f.viewUrl) ? { ...f, thumbUrl: driveThumb(f.sourceId) } : f)),
      stats: campaignStats(c.brief, doc.clips.filter((x) => x.campaignId === c.id), doc.posts.filter((p) => p.campaignId === c.id)) })),
    clips: doc.clips,
    posts: doc.posts,
    accounts: doc.accounts,
    insights: doc.insights ?? {},
    brand: doc.brand ?? {},
    captionJobs: (doc.captionJobs ?? []).map(({ words, ...j }) => ({ ...j, wordCount: words.length })),
    agentRuns: (doc.agentRuns ?? []).map((r) => ({ id: r.id, title: r.title, status: r.status, updatedAt: r.updatedAt, pending: !!r.pending })),
    activity: doc.activity.slice(0, 100),
    status: serviceStatus(),
  };
}

function sanitizeMetrics(m: unknown): Post["metrics"] {
  const o = (m ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => Math.max(0, Math.round(Number(v) || 0));
  return { views: n(o.views), likes: n(o.likes), comments: n(o.comments), shares: n(o.shares) };
}

/** Keep a dated copy of each metrics update so posts can be compared at the same age. */
function snapshot(p: Post) {
  p.history = [...(p.history ?? []), { ...p.metrics, at: p.metricsUpdatedAt ?? now() }].slice(-40);
}

/** The playbook for new plans: this campaign's own data once it has enough, else the whole workspace's. */
function guideFor(campaignId: string, n: number): PlanGuide {
  const doc = getDoc();
  const own = analyze(doc, campaignId);
  const r = own.maturePosts >= 8 ? own : analyze(doc, "all");
  return { playbook: r.playbook, tests: testShare(n, r.playbook), basedOnPosts: r.maturePosts };
}

const scopeOf = (v: unknown) => {
  const s = String(v ?? "all");
  if (s !== "all") findCampaign(s);
  return s;
};

function captionOverrides(v: Record<string, unknown>): CaptionOverrides {
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
  return {
    style: typeof v.style === "string" && CAPTION_STYLES.some((s) => s.id === v.style) ? v.style : undefined,
    wordsPerCaption: num(v.wordsPerCaption),
    position: num(v.position),
    size: num(v.size),
  };
}

const platformOf = (v: unknown): Platform => ((PLATFORMS as string[]).includes(String(v)) ? (v as Platform) : "other");

const editorDir = () => process.env.EDITOR_DIR ?? path.resolve(process.cwd(), "editor-dist");

/** Where people reach this server (for links handed out to agents). */
const LOOPBACK = /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/;
const publicBase = (req: Request) => {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  // MCP tools call the API over loopback; they pass on the address the agent used.
  const relayed = LOOPBACK.test(req.socket.remoteAddress ?? "") ? req.get("x-clip-public-base") : undefined;
  if (relayed && /^https?:\/\/[\w.:-]+$/.test(relayed)) return relayed;
  return `${req.protocol}://${req.get("host")}`;
};

async function streamVideo(req: Request, res: Response, clip: Clip, workspaceId: string) {
  const key = clip.render?.videoKey;
  if (!key || !key.startsWith(`${workspaceId}/`)) throw new HttpError(404, "No video yet");
  await streamKey(req, res, key, "video/mp4", clip.title);
}

async function streamKey(req: Request, res: Response, key: string, type: string, title = "clip") {
  const m = String(req.headers.range ?? "").match(/^bytes=(\d*)-(\d*)$/);
  const range = m && (m[1] || m[2]) ? { start: m[1] ? Number(m[1]) : 0, end: m[2] ? Number(m[2]) : undefined } : undefined;
  const f = await videoStore().read(key, range);
  res.setHeader("Content-Type", type);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, max-age=3600");
  if (req.query.download) res.setHeader("Content-Disposition", `attachment; filename="${title.replace(/[^\w\- ]+/g, "").slice(0, 60) || "clip"}.mp4"`);
  if (range) {
    res.status(206);
    res.setHeader("Content-Range", `bytes ${f.start}-${f.end}/${f.size}`);
  }
  res.setHeader("Content-Length", String(f.end - f.start + 1));
  f.stream.pipe(res);
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });
  // Outstand webhooks: verified against the raw body, so mounted before the JSON parser.
  app.post(
    "/api/outstand/webhook",
    express.raw({ type: "*/*", limit: "1mb" }),
    wrap(async (req, res) => {
      if (!process.env.OUTSTAND_WEBHOOK_SECRET) throw new HttpError(503, "Webhook signing secret isn't configured");
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
      if (!verifyWebhook(raw, req.get("x-outstand-signature"))) throw new HttpError(401, "Bad signature");
      let event: WebhookEvent;
      try {
        event = JSON.parse(raw.toString("utf8"));
      } catch {
        throw new HttpError(400, "Not JSON");
      }
      const handled = await handleWebhook(event);
      res.json({ ok: true, handled });
    }),
  );

  // The editor's AI chat sends large requests (tool schemas, timeline state).
  app.use("/api/ai/v1", express.json({ limit: "8mb" }));
  app.use("/api", express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => res.json({ ok: true, ...serviceStatus(), videos: storageKind() }));

  // ---- Accounts --------------------------------------------------------------
  const me = async (userId: string): Promise<Me> => {
    const b = getBackend();
    const user = (await b.getUser(userId))!;
    const ws = (await b.workspaceForOwner(userId))!;
    return { user: { id: user.id, email: user.email, name: user.name, ...(isAdmin(user.email) ? { admin: true } : {}) }, workspace: { id: ws.id, name: ws.name, hasAgentKey: !!ws.hasAgentKey } };
  };

  app.post(
    "/api/auth/signup",
    wrap(async (req, res) => {
      if (process.env.ALLOW_SIGNUP === "false") throw new HttpError(403, "Sign-ups are closed right now.");
      const email = String(req.body?.email ?? "").trim().toLowerCase();
      const password = String(req.body?.password ?? "");
      const name = String(req.body?.name ?? "").trim().slice(0, 80) || email.split("@")[0];
      if (!EMAIL.test(email)) throw new HttpError(400, "Enter a valid email");
      if (password.length < 8) throw new HttpError(400, "Password must be at least 8 characters");
      throttle(`signup:${req.ip}`);
      const b = getBackend();
      if (await b.findUserByEmail(email)) throw new HttpError(409, "An account with that email already exists");
      const user: UserRow = { id: newId("usr"), email, name, passwordHash: await hashPassword(password), createdAt: now() };
      await b.createUser(user);
      await b.createWorkspace({ id: newId("ws"), ownerId: user.id, name: String(req.body?.workspaceName ?? "").trim().slice(0, 80) || `${name}'s clips`, createdAt: now() }, emptyDoc());
      issueSession(res, user.id);
      res.status(201).json(await me(user.id));
    }),
  );

  app.post(
    "/api/auth/login",
    wrap(async (req, res) => {
      const email = String(req.body?.email ?? "").trim().toLowerCase();
      const key = `login:${req.ip}:${email}`;
      throttle(key);
      const user = await getBackend().findUserByEmail(email);
      if (!user || !(await verifyPassword(String(req.body?.password ?? ""), user.passwordHash))) throw new HttpError(401, "Wrong email or password");
      clearThrottle(key);
      issueSession(res, user.id);
      res.json(await me(user.id));
    }),
  );

  app.post("/api/auth/logout", (_req, res) => {
    clearSession(res);
    res.json({ ok: true });
  });

  app.get(
    "/api/auth/me",
    requireWorkspace,
    wrap(async (req, res) => res.json(await me(req.userId!))),
  );

  app.delete(
    "/api/auth/account",
    requireWorkspace,
    humansOnly,
    wrap(async (req, res) => {
      const b = getBackend();
      const user = (await b.getUser(req.userId!))!;
      if (!(await verifyPassword(String(req.body?.password ?? ""), user.passwordHash))) throw new HttpError(401, "Wrong password");
      forgetTenant(req.workspaceId!);
      await videoStore()
        .deletePrefix(`${req.workspaceId}/`)
        .catch((e) => console.error("[account] video cleanup failed:", e));
      await b.deleteWorkspace(req.workspaceId!);
      await b.deleteUser(user.id);
      clearSession(res);
      res.json({ ok: true });
    }),
  );

  // ---- Bundled caption fonts (SIL Open Font License) ---------------------
  app.use("/fonts", (_req, res, next) => (res.setHeader("Cross-Origin-Resource-Policy", "same-origin"), next()), express.static(bundledFontsDir(), { maxAge: "30d", index: false }));

  // ---- Signed video links (no session) -------------------------------------
  app.get(
    "/v/:ws/:clip.mp4",
    wrap(async (req, res) => {
      const ws = String(req.params.ws);
      const clipId = String(req.params.clip);
      const e = Number(req.query.e);
      const sig = String(req.query.s ?? "");
      await loadTenant(ws).catch(() => {
        throw new HttpError(404, "Not found");
      });
      await runInWorkspace(ws, undefined, async () => {
        if (clipId.startsWith("cap_")) {
          const job = getDoc().captionJobs?.find((j) => j.id === clipId);
          if (!job?.outputKey || !verifyVideoLink(ws, clipId, job.outputKey, e, sig)) throw new HttpError(404, "This link has expired or the video was replaced");
          return void (await streamKey(req, res, job.outputKey, "video/mp4", job.name));
        }
        const clip = getDoc().clips.find((c) => c.id === clipId);
        const key = clip?.render?.videoKey;
        if (!clip || !key || !verifyVideoLink(ws, clipId, key, e, sig)) throw new HttpError(404, "This link has expired or the video was replaced");
        await streamVideo(req, res, clip, ws);
      });
    }),
  );

  // ---- MCP (remote agents: Claude, ChatGPT, n8n, …) -------------------------
  // Streamable HTTP, stateless. Authenticated with the workspace agent key; the
  // tools call this same API over loopback, so they follow every rule the UI does.
  app.all(
    "/mcp",
    express.json({ limit: "1mb" }),
    wrap(async (req, res) => {
      const key = bearerAgentKey(req);
      if (!key || !(await getBackend().workspaceByAgentKey(hashAgentKey(key)))) {
        res.status(401).json({ error: "Send your agent key: Authorization: Bearer co_agent_… (Settings → Agent access)" });
        return;
      }
      if (req.method !== "POST") {
        res.status(405).set("Allow", "POST").json({ error: "Use POST (stateless MCP)" });
        return;
      }
      const server = createMcpServer(httpApi(`http://127.0.0.1:${req.socket.localPort}`, key, { "X-Clip-Public-Base": publicBase(req) }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    }),
  );

  // ---- Workspace data ------------------------------------------------------
  const api = express.Router();
  api.use(requireWorkspace);

  api.get("/state", (_req, res) => res.json(stateFor()));

  // What this workspace has used and what it cost (AI as billed; compute and posts estimated).
  api.get("/usage", (_req, res) => res.json(usageReport()));

  // Every workspace's usage this month, for operators listed in ADMIN_EMAILS.
  api.get(
    "/admin/usage",
    humansOnly,
    wrap(async (req, res) => {
      const b = getBackend();
      const me = await b.getUser(req.userId!);
      if (!me || !isAdmin(me.email)) throw new HttpError(403, "Operators only");
      const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? String(req.query.month) : monthKey();
      const workspaces = (await b.listWorkspaceUsage()).map((w) => {
        const usage = (loadedDoc(w.id)?.usage ?? w.usage)?.months?.[month] ?? emptyMonth();
        return { id: w.id, name: w.name, email: w.email, createdAt: w.createdAt, usage, cost: monthCost(usage) };
      });
      workspaces.sort((x, y) => y.cost.total - x.cost.total);
      const total = workspaces.reduce((t, w) => ({ ai: t.ai + w.cost.ai, compute: t.compute + w.cost.compute, posts: t.posts + w.cost.posts, total: t.total + w.cost.total }), { ai: 0, compute: 0, posts: 0, total: 0 });
      res.json({ month, workspaces, total } satisfies AdminUsage);
    }),
  );

  api.put(
    "/workspace",
    humansOnly,
    wrap(async (req, res) => {
      const name = String(req.body?.name ?? "").trim().slice(0, 80);
      if (!name) throw new HttpError(400, "Name required");
      await getBackend().renameWorkspace(req.workspaceId!, name);
      res.json(await me(req.userId!));
    }),
  );

  // Agent key for the API and MCP. Shown once; only its hash is stored.
  api.post(
    "/workspace/agent-key",
    humansOnly,
    wrap(async (req, res) => {
      const key = newAgentKey();
      await getBackend().setAgentKey(req.workspaceId!, hashAgentKey(key));
      log({ kind: "account", message: "Agent key created (any older key stopped working)." });
      save();
      res.status(201).json({ key, me: await me(req.userId!) });
    }),
  );
  api.delete(
    "/workspace/agent-key",
    humansOnly,
    wrap(async (req, res) => {
      await getBackend().setAgentKey(req.workspaceId!, null);
      log({ kind: "account", message: "Agent key revoked." });
      save();
      res.json(await me(req.userId!));
    }),
  );

  // ---- Clipping Agent (in-app chat) --------------------------------------
  const agentCtx = (req: Request) => ({
    workspaceId: req.workspaceId!,
    baseUrl: `http://127.0.0.1:${req.socket.localPort}`,
    cookie: String(req.headers.cookie ?? ""),
    timezone: typeof req.body?.timezone === "string" && /^[\w/+-]{1,64}$/.test(req.body.timezone) ? req.body.timezone : "UTC",
  });
  const runOut = (r: AgentRun) => ({ ...r, working: isRunning(r.id) });
  api.get("/agent/runs/:id", (req, res) => {
    const r = getDoc().agentRuns?.find((x) => x.id === req.params.id);
    if (!r) throw new HttpError(404, "Run not found");
    res.json(runOut(r));
  });
  api.post("/agent/runs", humansOnly, (req, res) => {
    const message = String(req.body?.message ?? "").trim();
    if (!message) throw new HttpError(400, "Say what you'd like the agent to do");
    const run = sendToAgent(agentCtx(req), message, typeof req.body?.runId === "string" ? req.body.runId : undefined);
    res.status(202).json(runOut(run));
  });
  api.post("/agent/runs/:id/approve", humansOnly, (req, res) => res.json(runOut(resolvePending(agentCtx(req), String(req.params.id), req.body?.approve === true))));
  api.post("/agent/runs/:id/stop", humansOnly, (req, res) => res.json(runOut(stopAgent(String(req.params.id)))));
  api.delete("/agent/runs/:id", humansOnly, (req, res) => {
    const doc = getDoc();
    stopAgent(String(req.params.id));
    doc.agentRuns = (doc.agentRuns ?? []).filter((r) => r.id !== req.params.id);
    save();
    res.json(stateFor());
  });

  // ---- Publishing (Outstand) ---------------------------------------------
  api.post(
    "/social/connect",
    wrap(async (req, res) => {
      const network = String(req.body?.network ?? "");
      if (!NETWORKS.some((n) => n.id === network)) throw new HttpError(400, "Pick a network to connect");
      res.json({ url: await authUrl(network, req.workspaceId!, `${publicBase(req)}/api/social/callback`) });
    }),
  );

  // Where Outstand sends the browser after the network's sign-in.
  api.get(
    "/social/callback",
    wrap(async (req, res) => {
      const q = req.query as Record<string, string | undefined>;
      if (q.error || q.success === "false") return void res.redirect(`/#/settings/accounts?connect_error=${encodeURIComponent(String(q.error ?? q.message ?? "The connection was cancelled"))}`);
      if (q.session) return void res.redirect(`/#/settings/accounts?pending=${encodeURIComponent(String(q.session))}`);
      await syncAccounts(req.workspaceId!);
      log({ kind: "account", message: `Connected ${q.username ? `@${q.username}` : "a social account"}.` });
      save();
      res.redirect("/#/settings/accounts?connected=1");
    }),
  );

  // Facebook / LinkedIn: pick which pages to connect.
  api.get(
    "/social/pending/:session",
    wrap(async (req, res) => res.json({ pages: await pendingPages(String(req.params.session)) })),
  );
  api.post(
    "/social/pending/:session",
    wrap(async (req, res) => {
      const ids = Array.isArray(req.body?.pageIds) ? req.body.pageIds.map(String).slice(0, 50) : [];
      if (!ids.length) throw new HttpError(400, "Pick at least one page");
      await finalizePending(String(req.params.session), ids);
      await syncAccounts(req.workspaceId!);
      res.json(stateFor());
    }),
  );

  api.post(
    "/social/sync",
    wrap(async (req, res) => {
      await syncAccounts(req.workspaceId!);
      res.json(stateFor());
    }),
  );

  api.delete(
    "/social/accounts/:id",
    humansOnly,
    wrap(async (req, res) => {
      const doc = getDoc();
      const a = doc.accounts.find((x) => x.id === req.params.id);
      if (!a) throw new HttpError(404, "Account not found");
      if (a.outstandId) await disconnectAccount(a.outstandId).catch((e) => console.error("[outstand] disconnect:", (e as Error).message));
      doc.accounts = doc.accounts.filter((x) => x.id !== a.id);
      log({ kind: "account", message: `Disconnected ${a.platform} @${a.handle}.` });
      save();
      res.json(stateFor());
    }),
  );

  api.get(
    "/social/accounts/:id/tiktok-privacy",
    wrap(async (req, res) => {
      const a = getDoc().accounts.find((x) => x.id === req.params.id && x.outstandId && x.platform === "tiktok");
      if (!a) throw new HttpError(404, "Not a connected TikTok account");
      res.json({ options: await tiktokPrivacyOptions(a.outstandId!) });
    }),
  );

  api.post(
    "/clips/:id/schedule",
    wrap(async (req, res) => {
      const clip = findClip(String(req.params.id));
      const b = req.body ?? {};
      const posts = await scheduleClip(req.workspaceId!, clip, {
        accountIds: Array.isArray(b.accountIds) ? b.accountIds.map(String) : [],
        at: typeof b.at === "string" && b.at ? b.at : undefined,
        caption: String(b.caption ?? `${clip.caption}\n\n${clip.hashtags.join(" ")}`),
        tiktok: b.tiktok?.mode === "direct" ? { mode: "direct", privacy: String(b.tiktok.privacy ?? "") } : { mode: "inbox" },
        youtube: b.youtube ? { title: typeof b.youtube.title === "string" ? b.youtube.title : undefined, privacy: ["public", "unlisted", "private"].includes(b.youtube.privacy) ? b.youtube.privacy : undefined } : undefined,
      });
      res.status(201).json({ posts: posts.map((p) => p.id), state: stateFor() });
    }),
  );

  api.post(
    "/posts/:id/cancel",
    wrap(async (req, res) => {
      await cancelScheduled(findPost(String(req.params.id)));
      res.json(stateFor());
    }),
  );

  api.post(
    "/social/sync-metrics",
    wrap(async (_req, res) => {
      const updated = await syncMetrics();
      res.json({ updated, state: stateFor() });
    }),
  );

  // ---- Captions page: caption any video ----------------------------------
  const findJob = (id: string) => {
    const j = getDoc().captionJobs?.find((x) => x.id === id);
    if (!j) throw new HttpError(404, "Caption job not found");
    return j;
  };
  const newJob = (name: string, sourceKey: string, language: unknown, glossary: unknown): CaptionJob => {
    const lang = typeof language === "string" && (language === "auto" || LANGUAGES.some(([c]) => c === language)) ? language : "auto";
    const terms = (Array.isArray(glossary) ? glossary : typeof glossary === "string" ? glossary.split(",") : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 30);
    const at = now();
    return { id: newId("cap"), name: name.slice(0, 120) || "Video", status: "uploaded", sourceKey, languageHint: lang, glossary: terms.length ? terms : undefined, words: [], captions: {}, createdAt: at, updatedAt: at };
  };
  const startJob = (req: Request, j: CaptionJob) => {
    if (!transcriptionAvailable()) throw new HttpError(503, "Transcription isn't available on this server");
    const doc = getDoc();
    doc.captionJobs = [j, ...(doc.captionJobs ?? [])].slice(0, 200);
    enqueueCaptionJob({ workspaceId: req.workspaceId!, jobId: j.id, kind: "transcribe", actor: req.actor });
    log({ kind: "clip", message: `Captioning "${j.name}" — transcribing.` });
    save();
  };

  api.post(
    "/captions",
    wrap(async (req, res) => {
      const type = String(req.headers["content-type"] ?? "").split(";")[0];
      if (!/^(video\/(mp4|quicktime|webm|x-matroska|x-m4v)|application\/octet-stream)$/.test(type)) throw new HttpError(415, "Upload a video file (MP4, MOV, WebM or MKV)");
      if (!transcriptionAvailable()) throw new HttpError(503, "Transcription isn't available on this server");
      const name = decodeURIComponent(String(req.headers["x-file-name"] ?? "video.mp4")).slice(0, 120);
      const id = newId("src");
      const key = `${req.workspaceId}/captions/${id}/source${path.extname(name).toLowerCase().replace(/[^.\w]/g, "") || ".mp4"}`;
      try {
        await saveStream(key, req, type);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      const j = newJob(name.replace(/\.\w{2,4}$/, ""), key, req.query.language, req.query.glossary);
      startJob(req, j);
      res.status(201).json({ job: j, state: stateFor() });
    }),
  );

  api.post(
    "/captions/from-url",
    wrap(async (req, res) => {
      const url = String(req.body?.url ?? "").trim();
      if (!/^https?:\/\//.test(url)) throw new HttpError(400, "Give a public http(s) link to a video file");
      if (!transcriptionAvailable()) throw new HttpError(503, "Transcription isn't available on this server");
      const r = await safeFetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
      if (!r.ok || !r.body) throw new HttpError(422, `That link returned ${r.status}`);
      if (/text\/html/.test(r.headers.get("content-type") ?? "")) throw new HttpError(422, "That link is a web page, not a video file");
      const key = `${req.workspaceId}/captions/${newId("src")}/source.mp4`;
      try {
        await saveStream(key, Readable.fromWeb(r.body as never), "video/mp4");
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      const j = newJob(String(req.body?.name ?? decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "Video")).replace(/\.\w{2,4}$/, ""), key, req.body?.language, req.body?.glossary);
      startJob(req, j);
      res.status(201).json({ job: j, state: stateFor() });
    }),
  );

  api.get("/captions/:id", (req, res) => res.json(findJob(String(req.params.id))));

  api.put("/captions/:id", (req, res) => {
    const j = findJob(String(req.params.id));
    const b = req.body ?? {};
    if (j.status === "transcribing" || j.status === "rendering") throw new HttpError(409, "Wait for the current step to finish");
    if (typeof b.name === "string" && b.name.trim()) j.name = b.name.trim().slice(0, 120);
    if (b.captions && typeof b.captions === "object") j.captions = captionOverrides(b.captions);
    if (Array.isArray(b.edits)) {
      const edits = b.edits
        .map((e: Record<string, unknown>) => ({ index: Number(e.index), count: Number(e.count), text: String(e.text ?? "").slice(0, 500) }))
        .filter((e: { index: number; count: number }) => Number.isInteger(e.index) && Number.isInteger(e.count) && e.index >= 0 && e.count > 0 && e.index + e.count <= j.words.length);
      j.words = applyEdits(j.words, edits);
    }
    j.updatedAt = now();
    save();
    res.json(j);
  });

  api.post("/captions/:id/transcribe", (req, res) => {
    const j = findJob(String(req.params.id));
    if (j.status === "transcribing" || j.status === "rendering") throw new HttpError(409, "Already working on it");
    if (typeof req.body?.language === "string" && (req.body.language === "auto" || LANGUAGES.some(([c]) => c === req.body.language))) j.languageHint = req.body.language;
    Object.assign(j, { status: "transcribing", step: "Queued", error: undefined });
    enqueueCaptionJob({ workspaceId: req.workspaceId!, jobId: j.id, kind: "transcribe", actor: req.actor });
    save();
    res.status(202).json(stateFor());
  });

  api.post("/captions/:id/render", (req, res) => {
    const j = findJob(String(req.params.id));
    if (!j.words.length) throw new HttpError(409, "Transcribe the video first");
    if (j.status === "transcribing" || j.status === "rendering") throw new HttpError(409, "Already working on it");
    if (req.body?.captions && typeof req.body.captions === "object") j.captions = captionOverrides(req.body.captions);
    Object.assign(j, { status: "rendering", step: "Queued", error: undefined });
    enqueueCaptionJob({ workspaceId: req.workspaceId!, jobId: j.id, kind: "render", actor: req.actor });
    save();
    res.status(202).json(stateFor());
  });

  api.get(
    "/captions/:id/video",
    wrap(async (req, res) => {
      const j = findJob(String(req.params.id));
      const key = req.query.which === "source" ? j.sourceKey : j.outputKey;
      if (!key || !key.startsWith(`${req.workspaceId}/`)) throw new HttpError(404, "No video yet");
      await streamKey(req, res, key, "video/mp4", j.name);
    }),
  );

  api.get("/captions/:id/link", (req, res) => {
    const j = findJob(String(req.params.id));
    if (!j.outputKey || j.status !== "done") throw new HttpError(404, "Render the captions first");
    res.json({ url: `${publicBase(req)}${signVideoLink(req.workspaceId!, j.id, j.outputKey)}`, expiresInDays: 7 });
  });

  api.delete(
    "/captions/:id",
    wrap(async (req, res) => {
      const doc = getDoc();
      const j = findJob(String(req.params.id));
      doc.captionJobs = (doc.captionJobs ?? []).filter((x) => x.id !== j.id);
      for (const k of [j.sourceKey, j.outputKey]) if (k?.startsWith(`${req.workspaceId}/captions/`)) await videoStore().deletePrefix(k.slice(0, k.lastIndexOf("/") + 1)).catch(() => undefined);
      save();
      res.json(stateFor());
    }),
  );

  // ---- Brand kit: caption style, fonts, colours --------------------------
  api.get("/brand", (_req, res) => res.json(getDoc().brand ?? {}));
  api.put("/brand", (req, res) => {
    const doc = getDoc();
    const b = req.body ?? {};
    const brand: BrandKit = { ...(doc.brand ?? {}) };
    if (b.captionStyle === null || CAPTION_STYLES.some((x) => x.id === b.captionStyle)) brand.captionStyle = b.captionStyle ?? undefined;
    if (b.font === null || b.font === "") brand.font = undefined;
    else if (typeof b.font === "string") {
      const known = [...BUNDLED_FONTS.map((f) => f.family), ...(brand.fonts ?? []).map((f) => f.family)];
      if (!known.includes(b.font)) throw new HttpError(400, "Upload that font first, or pick a bundled one");
      brand.font = b.font;
    }
    if (b.colors === null) brand.colors = undefined;
    else if (b.colors && typeof b.colors === "object") {
      const hex = (v: unknown) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toUpperCase() : undefined);
      brand.colors = { text: hex(b.colors.text), highlight: hex(b.colors.highlight), outline: hex(b.colors.outline), accent: hex(b.colors.accent) };
    }
    if (b.uppercase === null) brand.uppercase = undefined;
    else if (typeof b.uppercase === "boolean") brand.uppercase = b.uppercase;
    doc.brand = brand;
    save();
    res.json(stateFor());
  });

  api.post(
    "/brand/fonts",
    wrap(async (req, res) => {
      const doc = getDoc();
      const name = decodeURIComponent(String(req.headers["x-file-name"] ?? "font.ttf")).slice(0, 120);
      const ext = (name.match(/\.(ttf|otf)$/i)?.[1] ?? "").toLowerCase();
      if (!ext) throw new HttpError(415, "Upload a .ttf or .otf font file");
      if ((doc.brand?.fonts ?? []).length >= 10) throw new HttpError(400, "Up to 10 brand fonts — remove one first");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "font-"));
      try {
        const file = path.join(dir, `font.${ext}`);
        try {
          await saveTo(file, req);
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
        if (fs.statSync(file).size > 15e6) throw new HttpError(400, "Fonts must be under 15 MB");
        const info = await fontInfo(file);
        if (!info) throw new HttpError(422, "That file isn't a font we can read");
        const id = newId("font");
        const key = `${req.workspaceId}/fonts/${id}.${ext}`;
        await videoStore().put(key, file, ext === "otf" ? "font/otf" : "font/ttf");
        // "Bebas Neue Regular" → "Bebas Neue"; heavier faces keep their full name ("Poppins Black").
        const family = /\sregular$/i.test(info.fullName) || info.fullName === info.family ? info.family : info.fullName;
        doc.brand = { ...(doc.brand ?? {}), fonts: [...(doc.brand?.fonts ?? []).filter((f) => f.family !== family), { id, family, key, file: `${id}.${ext}` }] };
        log({ kind: "account", message: `Brand font "${family}" uploaded.` });
        save();
        res.status(201).json(stateFor());
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  api.delete(
    "/brand/fonts/:id",
    wrap(async (req, res) => {
      const doc = getDoc();
      const f = doc.brand?.fonts?.find((x) => x.id === req.params.id);
      if (!f) throw new HttpError(404, "Font not found");
      await videoStore().deletePrefix(f.key).catch(() => undefined);
      doc.brand = { ...doc.brand, fonts: doc.brand!.fonts!.filter((x) => x.id !== f.id), font: doc.brand?.font === f.family ? undefined : doc.brand?.font };
      save();
      res.json(stateFor());
    }),
  );

  // Brand font files for previews and the editor (the workspace's own only).
  api.get(
    "/brand/fonts/:id/file",
    wrap(async (req, res) => {
      const f = getDoc().brand?.fonts?.find((x) => x.id === req.params.id);
      if (!f || !f.key.startsWith(`${req.workspaceId}/`)) throw new HttpError(404, "Font not found");
      await streamKey(req, res, f.key, f.file.endsWith(".otf") ? "font/otf" : "font/ttf", f.family);
    }),
  );

  // Campaigns: paste a brief (text or link) → extracted rules + footage.
  api.post(
    "/campaigns",
    wrap(async (req, res) => {
      const url = String(req.body?.url ?? "").trim();
      let text = String(req.body?.text ?? "").trim();
      let kind: Campaign["source"]["kind"] = "text";
      let links: { label: string; url: string }[] = [];
      if (!text && !url) throw new HttpError(400, "Paste the brief text or a link to it");
      if (!text) {
        const r = await readBriefUrl(url);
        ({ text, links, kind } = r);
      }
      if (text.length > 60_000) text = text.slice(0, 60_000);
      spendAI(req.workspaceId!);
      const x = await extractBrief(text, links);
      const at = now();
      const c: Campaign = {
        id: newId("cmp"),
        name: x.brief.title,
        status: "active",
        source: { kind, url: url || undefined, text },
        brief: x.brief,
        extractedBy: x.by,
        extractionModel: x.model,
        footage: [],
        notes: "",
        createdAt: at,
        updatedAt: at,
      };
      getDoc().campaigns.unshift(c);
      log({ campaignId: c.id, kind: "campaign", message: `Campaign "${c.name}" added — brief read by ${x.by === "ai" ? x.model : "the rules extractor"}.`, cost: x.cost });
      if (c.brief.footage.length) await refreshFootage(c).catch((e) => (c.footageError = (e as Error).message));
      save();
      res.status(201).json({ campaign: c, state: stateFor() });
    }),
  );

  api.put("/campaigns/:id", (req, res) => {
    const c = findCampaign(String(req.params.id));
    const b = req.body ?? {};
    if (typeof b.name === "string" && b.name.trim()) c.name = b.name.trim().slice(0, 120);
    if (["active", "paused", "ended"].includes(b.status)) c.status = b.status;
    if (typeof b.notes === "string") c.notes = b.notes.slice(0, 5000);
    if (b.captions === null) c.captions = undefined;
    else if (b.captions && typeof b.captions === "object") c.captions = captionOverrides(b.captions);
    if (b.brief && typeof b.brief === "object") {
      c.brief = normalizeBrief(b.brief as Partial<Record<keyof CampaignBrief, unknown>>, c.brief);
      // The rules changed: re-check every plan that hasn't been posted.
      for (const clip of getDoc().clips.filter((x) => x.campaignId === c.id && x.status !== "posted")) clip.qa = checkClip(clip, c.brief);
    }
    c.updatedAt = now();
    save();
    res.json(stateFor());
  });

  api.delete("/campaigns/:id", (req, res) => {
    const doc = getDoc();
    const c = findCampaign(String(req.params.id));
    doc.campaigns = doc.campaigns.filter((x) => x.id !== c.id);
    doc.clips = doc.clips.filter((x) => x.campaignId !== c.id);
    doc.posts = doc.posts.filter((x) => x.campaignId !== c.id);
    if (doc.insights) delete doc.insights[c.id];
    log({ kind: "campaign", message: `Campaign "${c.name}" deleted with its clips and posts.` });
    save();
    res.json(stateFor());
  });

  api.post(
    "/campaigns/:id/reextract",
    wrap(async (req, res) => {
      const c = findCampaign(String(req.params.id));
      let text = c.source.text;
      let links: { label: string; url: string }[] = [];
      if (c.source.url) ({ text, links } = await readBriefUrl(c.source.url));
      spendAI(req.workspaceId!);
      const x = await extractBrief(text, links);
      c.source.text = text;
      c.brief = x.brief;
      c.extractedBy = x.by;
      c.extractionModel = x.model;
      c.updatedAt = now();
      for (const clip of getDoc().clips.filter((y) => y.campaignId === c.id && y.status !== "posted")) clip.qa = checkClip(clip, c.brief);
      log({ campaignId: c.id, kind: "campaign", message: `Brief re-read${c.source.url ? " from its link" : ""}.`, cost: x.cost });
      await refreshFootage(c).catch(() => undefined);
      save();
      res.json(stateFor());
    }),
  );

  api.post(
    "/campaigns/:id/footage/refresh",
    wrap(async (req, res) => {
      const c = findCampaign(String(req.params.id));
      await refreshFootage(c);
      save();
      res.json(stateFor());
    }),
  );

  api.post(
    "/campaigns/:id/clips",
    wrap(async (req, res) => {
      const c = findCampaign(String(req.params.id));
      const n = Math.max(1, Math.min(10, Number(req.body?.count) || 3));
      spendAI(req.workspaceId!, 2);
      const doc = getDoc();
      const existing = doc.clips.filter((x) => x.campaignId === c.id);
      const guide = guideFor(c.id, n);
      const r = await planClips(c, n, existing, guide);
      doc.clips.unshift(...r.clips);
      const ok = r.clips.filter((x) => x.qa.pass).length;
      const learned = guide.basedOnPosts ? ` Guided by ${count(guide.basedOnPosts, "post")}: ${count(r.clips.filter((x) => x.traits?.strategy === "test").length, "test")}.` : "";
      log({ campaignId: c.id, kind: "clip", message: `${r.clips.length} clip plan(s) written by ${r.model} — ${ok} pass every rule.${learned}`, cost: r.cost });
      save();
      res.status(201).json(stateFor());
    }),
  );

  api.put("/clips/:id", (req, res) => {
    const clip = findClip(String(req.params.id));
    const c = findCampaign(clip.campaignId);
    const b = req.body ?? {};
    for (const k of ["title", "angle", "hook", "narration", "cta", "caption"] as const) if (typeof b[k] === "string") clip[k] = b[k].slice(0, 4000);
    if (Array.isArray(b.onScreenText)) clip.onScreenText = b.onScreenText.map(String).slice(0, 20);
    if (Array.isArray(b.hashtags)) clip.hashtags = b.hashtags.map(String).slice(0, 30);
    if (Number(b.lengthSec) > 0) clip.lengthSec = Math.min(600, Math.round(Number(b.lengthSec)));
    if (CLIP_STATUSES.includes(b.status)) {
      if (b.status === "approved" && !clip.qa.pass && !b.override) throw new HttpError(400, "This plan fails a rule. Fix it, or approve anyway.");
      clip.status = b.status as ClipStatus;
    }
    clip.qa = checkClip(clip, c.brief);
    clip.updatedAt = now();
    save();
    res.json(stateFor());
  });

  // Rendering: approved plan → finished 9:16 video.
  api.post("/clips/:id/render", (req, res) => {
    const clip = findClip(String(req.params.id));
    const voice = String(req.body?.voice ?? "ash") as VoiceOption;
    if (!VOICES.some((v) => v.id === voice)) throw new HttpError(400, "Unknown voice");
    if (clip.status === "draft" && !req.body?.override) throw new HttpError(400, "Approve the plan before rendering it");
    if (voice !== "none") spendAI(req.workspaceId!, 1);
    enqueueRender(req.workspaceId!, clip, voice, req.actor);
    log({ campaignId: clip.campaignId, kind: "clip", message: `Render queued for "${clip.title}".` });
    save();
    res.status(202).json(stateFor());
  });

  api.get(
    "/clips/:id/video",
    wrap(async (req, res) => {
      const clip = findClip(String(req.params.id));
      await streamVideo(req, res, clip, req.workspaceId!);
    }),
  );

  // ---- Editor (OpenReel at /editor/) ---------------------------------------
  // The pieces of the latest render, for the editor to lay out as a timeline.
  api.get("/clips/:id/edit-pack", (req, res) => {
    const clip = findClip(String(req.params.id));
    const p = clip.render?.status === "done" ? clip.render.parts : undefined;
    if (!p) throw new HttpError(409, "Render this clip first — the editor opens the rendered shots, voice and captions.");
    const part = (key: string) => `/api/clips/${clip.id}/parts/${encodeURIComponent(key.split("/").pop()!)}`;
    res.json({
      clip: { id: clip.id, title: clip.title },
      width: 1080,
      height: 1920,
      fps: 30,
      duration: p.duration,
      shots: p.shots.map((s, i) => ({ url: part(s.key), name: `shot${i + 1}.mp4`, seconds: s.seconds })),
      voice: p.voiceKey ? { url: part(p.voiceKey), name: "voice.wav" } : undefined,
      captions: p.captions,
      captionStyle: resolveCaptionStyle(getDoc().brand, findCampaign(clip.campaignId).captions),
      accent: accentOf(getDoc().brand),
      fonts: [
        ...BUNDLED_FONTS.map((f) => ({ family: f.family, url: `/fonts/${f.file}` })),
        ...(getDoc().brand?.fonts ?? []).map((f) => ({ family: f.family, url: `/api/brand/fonts/${f.id}/file` })),
      ],
      hook: p.hook,
      cta: p.cta,
      saveUrl: `/api/clips/${clip.id}/edited`,
      backUrl: `/#/c/${clip.campaignId}/clips`,
      ai: aiLive() ? { baseUrl: "/api/ai/v1", model: editorModel() } : undefined,
    });
  });

  api.get(
    "/clips/:id/parts/:name",
    wrap(async (req, res) => {
      const clip = findClip(String(req.params.id));
      const p = clip.render?.parts;
      const name = String(req.params.name);
      const key = [...(p?.shots.map((s) => s.key) ?? []), p?.voiceKey].find((k) => k && k.split("/").pop() === name);
      if (!key || !key.startsWith(`${req.workspaceId}/`)) throw new HttpError(404, "Part not found");
      await streamKey(req, res, key, name.endsWith(".wav") ? "audio/wav" : "video/mp4", name);
    }),
  );

  // The editor's export replaces the clip's video (the parts stay, so it can be re-edited).
  api.post(
    "/clips/:id/edited",
    wrap(async (req, res) => {
      const clip = findClip(String(req.params.id));
      if (!clip.render || clip.render.status !== "done") throw new HttpError(409, "Render this clip before saving an edit");
      const type = String(req.headers["content-type"] ?? "").split(";")[0];
      if (type !== "video/mp4") throw new HttpError(415, "Export as MP4 to save to UGCMediaClips");
      const key = `${req.workspaceId}/clips/${clip.id}-edit-${Date.now()}.mp4`;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edit-"));
      let size: number;
      let meta: Awaited<ReturnType<typeof probe>> | undefined;
      try {
        const raw = path.join(dir, "raw.mp4");
        try {
          await saveTo(raw, req);
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
        meta = await probe(raw).catch(() => undefined);
        if (!meta?.duration) throw new HttpError(422, "That export isn't a playable video");
        // Browser exports carry Opus audio and put the index at the end; platforms
        // want AAC and players want the index first. The video stream is copied as is.
        const out = path.join(dir, "out.mp4");
        await run("ffmpeg", ["-v", "error", "-y", "-i", raw, "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out]);
        size = fs.statSync(out).size;
        await videoStore().put(key, out, "video/mp4");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      const old = clip.render.videoKey;
      Object.assign(clip.render, { videoKey: key, sizeBytes: size, durationSec: Math.round(meta.duration * 100) / 100, editedAt: now() });
      clip.lengthSec = Math.round(meta.duration);
      clip.qa = checkClip(clip, findCampaign(clip.campaignId).brief);
      clip.updatedAt = now();
      if (old && old !== key && old.startsWith(`${req.workspaceId}/clips/`)) await videoStore().deletePrefix(old).catch(() => undefined);
      log({ campaignId: clip.campaignId, kind: "clip", message: `Saved an edit of "${clip.title}" from the editor (${clip.lengthSec}s).` });
      save();
      res.status(201).json({ ok: true, durationSec: clip.render.durationSec });
    }),
  );

  // The editor's AI chat (OpenAI-compatible), on the server's key and the workspace's daily AI limit.
  api.get("/ai/v1/models", (_req, res) => res.json({ object: "list", data: aiLive() ? [{ id: editorModel(), object: "model", owned_by: "ugcmediaclips" }] : [] }));
  api.post(
    "/ai/v1/chat/completions",
    wrap(async (req, res) => {
      if (!aiLive()) throw new HttpError(503, "AI isn't configured on this server");
      if (!Array.isArray(req.body?.messages)) throw new HttpError(400, "messages required");
      spendAI(req.workspaceId!, 1);
      const ctrl = new AbortController();
      res.on("close", () => ctrl.abort());
      const upstream = await forwardChat(req.body, ctrl.signal);
      res.status(upstream.status);
      res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/json");
      if (!upstream.body) return void res.end();
      // Pass the reply through as is, keeping its tail to read the billed cost from the final usage chunk.
      const ws = req.workspaceId!;
      let tail = "";
      const decoder = new TextDecoder();
      const { Readable, Transform } = await import("node:stream");
      const meter = new Transform({
        transform(chunk, _enc, cb) {
          tail = (tail + decoder.decode(chunk, { stream: true })).slice(-8192);
          cb(null, chunk);
        },
        flush(cb) {
          const costs = [...tail.matchAll(/"cost"\s*:\s*([0-9.eE+-]+)/g)];
          runInWorkspace(ws, undefined, () => recordAI("editor", Number(costs.at(-1)?.[1] ?? 0)));
          cb();
        },
      });
      Readable.fromWeb(upstream.body as never).pipe(meter).pipe(res);
    }),
  );

  // A shareable link to the finished video (expires in 7 days) — what agents hand to people and schedulers.
  api.get("/clips/:id/link", (req, res) => {
    const clip = findClip(String(req.params.id));
    const key = clip.render?.videoKey;
    if (!key || clip.render?.status !== "done") throw new HttpError(404, "No finished video yet");
    const editable = !!clip.render?.parts && fs.existsSync(path.join(editorDir(), "index.html"));
    res.json({
      url: `${publicBase(req)}${signVideoLink(req.workspaceId!, clip.id, key)}`,
      expiresInDays: 7,
      // Opens the clip on a timeline in the editor (needs the dashboard login).
      editorUrl: editable ? `${publicBase(req)}/editor/?co_clip=${encodeURIComponent(clip.id)}#/new?width=1080&height=1920&fps=30` : undefined,
    });
  });

  api.post(
    "/campaigns/:id/footage/:fid/analyze",
    wrap(async (req, res) => {
      const c = findCampaign(String(req.params.id));
      const f = c.footage.find((x) => x.id === String(req.params.fid));
      if (!f || f.kind !== "video") throw new HttpError(404, "Video not found");
      if (!renderAvailable()) throw new HttpError(503, "Footage analysis isn't available on this server");
      spendAI(req.workspaceId!, 1);
      try {
        const r = await analyzeFootage(f, c.brief);
        log({ campaignId: c.id, kind: "footage", message: `Found ${f.moments?.length ?? 0} moments in "${f.name}".`, cost: r.cost || undefined });
      } catch (err) {
        f.analysisError = (err as Error).message.slice(0, 300);
        throw new HttpError(422, `Couldn't analyze "${f.name}": ${f.analysisError}`);
      } finally {
        save();
      }
      res.json(stateFor());
    }),
  );

  // Footage upload: a new file, or the user's own copy of a linked file Drive won't serve.
  api.post(
    "/campaigns/:id/footage/upload",
    wrap(async (req, res) => {
      const c = findCampaign(String(req.params.id));
      const type = String(req.headers["content-type"] ?? "").split(";")[0];
      if (!/^(video\/(mp4|quicktime|webm|x-matroska|x-m4v)|application\/octet-stream)$/.test(type)) throw new HttpError(415, "Upload a video file (MP4, MOV, WebM or MKV)");
      const name = decodeURIComponent(String(req.headers["x-file-name"] ?? "footage.mp4")).slice(0, 120);
      const target = req.query.replace ? c.footage.find((f) => f.id === String(req.query.replace)) : undefined;
      if (req.query.replace && !target) throw new HttpError(404, "Footage not found");
      let saved: { key: string; size: number };
      try {
        saved = await saveUpload(req.workspaceId!, name, req);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      if (target) {
        Object.assign(target, { storageKey: saved.key, sizeBytes: saved.size, analyzedAt: undefined, analysisError: undefined, moments: undefined, durationSec: undefined });
        log({ campaignId: c.id, kind: "footage", message: `Uploaded your copy of "${target.name}" (${Math.round(saved.size / 1e6)} MB).` });
      } else {
        c.footage.push({ id: newId("ftg"), sourceId: saved.key, name, kind: "video", viewUrl: "", folderUrl: "", folderLabel: "Your uploads", storageKey: saved.key, sizeBytes: saved.size });
        log({ campaignId: c.id, kind: "footage", message: `Uploaded "${name}" (${Math.round(saved.size / 1e6)} MB).` });
      }
      save();
      res.status(201).json(stateFor());
    }),
  );

  api.delete("/clips/:id", (req, res) => {
    const doc = getDoc();
    const clip = findClip(String(req.params.id));
    doc.clips = doc.clips.filter((x) => x.id !== clip.id);
    for (const p of doc.posts.filter((x) => x.clipId === clip.id)) p.clipId = undefined;
    save();
    res.json(stateFor());
  });

  // Posts: where a clip went live, and how it's doing.
  api.post("/posts", (req, res) => {
    const b = req.body ?? {};
    const c = findCampaign(String(b.campaignId));
    const clip: Clip | undefined = b.clipId ? findClip(String(b.clipId)) : undefined;
    const url = String(b.url ?? "").trim();
    if (url && !/^https?:\/\//.test(url)) throw new HttpError(400, "Post link must start with https://");
    const post: Post = {
      id: newId("post"),
      campaignId: c.id,
      clipId: clip?.id,
      platform: platformOf(b.platform),
      account: String(b.account ?? "").trim().slice(0, 80),
      url,
      postedAt: typeof b.postedAt === "string" && !Number.isNaN(Date.parse(b.postedAt)) ? new Date(b.postedAt).toISOString() : now(),
      status: POST_STATUSES.includes(b.status) ? b.status : "live",
      metrics: sanitizeMetrics(b.metrics),
      metricsUpdatedAt: now(),
      notes: String(b.notes ?? "").slice(0, 2000),
    };
    if (post.metrics.views) snapshot(post);
    getDoc().posts.unshift(post);
    if (clip) clip.status = "posted";
    log({ campaignId: c.id, kind: "post", message: `Posted to ${post.platform}${post.account ? ` (@${post.account.replace(/^@/, "")})` : ""}.` });
    save();
    res.status(201).json(stateFor());
  });

  api.put("/posts/:id", (req, res) => {
    const p = findPost(String(req.params.id));
    const b = req.body ?? {};
    if (b.metrics) {
      p.metrics = sanitizeMetrics({ ...p.metrics, ...b.metrics });
      p.metricsUpdatedAt = now();
      snapshot(p);
    }
    if (POST_STATUSES.includes(b.status)) p.status = b.status as PostStatus;
    if (b.paidAmount === null) p.paidAmount = undefined;
    else if (Number.isFinite(Number(b.paidAmount)) && b.paidAmount !== "") p.paidAmount = Math.max(0, Number(b.paidAmount));
    if (typeof b.url === "string") p.url = /^https?:\/\//.test(b.url) ? b.url : p.url;
    if (typeof b.account === "string") p.account = b.account.slice(0, 80);
    if (b.platform) p.platform = platformOf(b.platform);
    if (typeof b.notes === "string") p.notes = b.notes.slice(0, 2000);
    save();
    res.json(stateFor());
  });

  api.delete("/posts/:id", (req, res) => {
    const doc = getDoc();
    findPost(String(req.params.id));
    doc.posts = doc.posts.filter((x) => x.id !== req.params.id);
    save();
    res.json(stateFor());
  });

  // Learning: what's working across posted clips, and written findings.
  api.get("/learning", (req, res) => {
    const doc = getDoc();
    const scope = scopeOf(req.query.scope);
    res.json({ report: analyze(doc, scope), insights: doc.insights?.[scope] });
  });

  api.post(
    "/learning/insights",
    wrap(async (req, res) => {
      const doc = getDoc();
      const scope = scopeOf(req.body?.scope);
      const report = analyze(doc, scope);
      if (report.maturePosts) spendAI(req.workspaceId!, 1);
      const { insights, cost } = await writeInsights(report);
      doc.insights = { ...doc.insights, [scope]: insights };
      log({ campaignId: scope === "all" ? undefined : scope, kind: "learning", message: `Findings refreshed from ${count(report.maturePosts, "post")} (${insights.model}).`, cost: cost || undefined });
      save();
      res.json({ report, insights });
    }),
  );

  // Accounts the user posts from (campaigns often restrict who may upload).
  api.post("/accounts", (req, res) => {
    const handle = String(req.body?.handle ?? "").trim().replace(/^@/, "").slice(0, 60);
    if (!handle) throw new HttpError(400, "Handle required");
    const a: SocialAccount = { id: newId("acct"), platform: platformOf(req.body?.platform), handle, niche: String(req.body?.niche ?? "").slice(0, 80), followers: Number(req.body?.followers) || undefined };
    getDoc().accounts.push(a);
    save();
    res.status(201).json(stateFor());
  });

  api.delete("/accounts/:id", (req, res) => {
    const doc = getDoc();
    doc.accounts = doc.accounts.filter((a) => a.id !== req.params.id);
    save();
    res.json(stateFor());
  });

  app.use("/api", api);
  app.use("/api", (_req, _res, next) => next(new HttpError(404, "Not found")));

  // ---- Editor: OpenReel (MIT), built by editor/build.sh ---------------------
  if (fs.existsSync(editorDir())) {
    const isolate = (_req: Request, res: Response, next: NextFunction) => {
      // OpenReel's own headers: cross-origin isolation for its media workers.
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      next();
    };
    app.get("/editor", (req, res, next) => (req.originalUrl.split("?")[0] === "/editor" ? res.redirect(301, `/editor/${req.originalUrl.slice(7)}`) : next()));
    app.use("/editor", isolate, express.static(editorDir(), { index: false, maxAge: "7d", setHeaders: (res, file) => file.endsWith(".html") && res.setHeader("Cache-Control", "no-cache") }));
    app.use("/editor", isolate, (req, res, next) => (req.method === "GET" && !path.extname(req.path) ? res.setHeader("Cache-Control", "no-cache").sendFile(path.join(editorDir(), "index.html")) : next()));
  }

  // ---- Web app -------------------------------------------------------------
  const dist = process.env.DIST_DIR ?? path.resolve(process.cwd(), "dist");
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: "1h" }));
    app.use((req, res, next) => (req.method === "GET" && !req.path.startsWith("/api") && !req.path.startsWith("/editor/") ? res.sendFile(path.join(dist, "index.html")) : next()));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : (err as { status?: number })?.status === 400 ? 400 : 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? "Something went wrong" : (err as Error).message });
  });
  return app;
}
