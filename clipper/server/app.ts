import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { campaignStats } from "../shared/rules";
import type { AdminUsage, AgentRun, ReferenceFormat, CaptionJob, Campaign, CampaignBrief, Clip, ClipStatus, Me, Platform, Post, PostStatus, ServiceStatus, SocialAccount, VoiceOption } from "../shared/types";
import { CLIP_STATUSES, PLATFORMS, POST_STATUSES } from "../shared/types";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bearerAgentKey, clearSession, clientKey, clearThrottle, hashAgentKey, hashPassword, humansOnly, issueSession, newAgentKey, passwordFingerprint, readToken, requireWorkspace, signToken, signVideoLink, throttle, verifyPassword, verifyVideoLink } from "./auth";
import { buttonEmail, sendEmail } from "./email";
import { HttpError, emptyDoc, forgetTenant, getBackend, getDoc, loadedDoc, loadTenant, log, newId, now, runInWorkspace, save, type UserRow } from "./db";
import { createMcpServer, httpApi } from "./mcp";
import { preflightBrief, preflightRender } from "./preflight";
import { reviseFromComments } from "./revise";
import { extractBrief, normalizeBrief } from "./extract";
import { aiLive, editorModel, forwardChat, mediaLive, modelFor, spendAI } from "./llm";
import { emptyMonth, isAdmin, monthCost, monthKey, recordAI, usageReport } from "./usage";
import { analyzeFootage } from "./moments";
import { buildClipAss, cancelRender, enqueueRender, renderAvailable } from "./render";
import { cancelJob, isPending, waitingCount } from "./jobs";
import { footageSource, isCached, saveStream, saveTo, saveUpload } from "./footage-cache";
import { contactSheets, frameTimes, grabFrames, MAX_CUTS_WINDOW, MAX_WINDOW, phraseWindow, sceneCutsIn, workDir } from "./frames";
import { Readable } from "node:stream";
import { applyEdits, enqueueCaptionJob } from "./caption-jobs";
import { transcriptionAvailable } from "./transcribe";
import { LANGUAGES } from "../shared/languages";
import { safeFetch } from "./sources";
import { authUrl, disconnectAccount, finalizePending, NETWORKS, outstandConfigured, pendingPages, tiktokPrivacyOptions, verifyWebhook } from "./outstand";
import { isRunning, resolvePending, sendToAgent, stopAgent } from "./agent";
import { cancelScheduled, handleWebhook, scheduleClip, syncAccounts, syncMetrics, type WebhookEvent } from "./publishing";
import { bundledFontsDir, fontInfo, measureFont } from "./fonts";
import { accentOf, BUNDLED_FONTS, CAPTION_STYLES, resolveCaptionStyle, type BrandKit, type CaptionOverrides } from "../shared/caption-styles";
import { probe, run, VIDEO_H, VIDEO_TOP } from "./media";
import { storageKind, videoStore } from "./storage";
import { checkClip, speechLoad, speechSeconds, UNITS_PER_SECOND } from "../shared/rules";
import { spokenText } from "../shared/markup";
import { planClips, type PlanGuide } from "./scripts";
import { makeVariants } from "./variants";
import { enqueueFormat, formatForPlanner } from "./formats";
import { sanitizeOverlays } from "../shared/overlays";
import { analyze, testShare } from "../shared/learning";
import { writeInsights } from "./insights";
import { driveThumb, readBriefUrl, resolveFootage } from "./sources";
import { alert } from "./alerts";

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

/**
 * What to look at for frames and scene cuts: a rendered clip (with its timed
 * words, for aroundPhrase) or a campaign's footage file, and the window.
 */
async function lookSource(workspaceId: string, b: Record<string, unknown>, maxWindow: number) {
  let src: string;
  let duration: number;
  let words: { text: string; start: number; end: number }[] | undefined;
  let label: string;
  let shotCuts: number[] | undefined;
  let rendered = false;
  if (b.clipId) {
    const clip = findClip(String(b.clipId));
    const key = clip.render?.videoKey;
    if (clip.render?.status !== "done" || !key || !key.startsWith(`${workspaceId}/`)) throw new HttpError(409, "Render this clip first");
    src = await videoStore().readUrl(key);
    duration = clip.render.durationSec ?? 0;
    words = clip.render.parts?.captions.flatMap((c) => c.words);
    label = `clip "${clip.title}"`;
    rendered = true;
    // The render knows where its shots change (unless it was re-cut in the editor since).
    if (clip.render.parts && !clip.render.editedAt) {
      let t = 0;
      shotCuts = clip.render.parts.shots.slice(0, -1).map((x) => Math.round((t += x.seconds) * 1000) / 1000);
    }
  } else if (b.campaignId && b.footageId) {
    const f = findCampaign(String(b.campaignId)).footage.find((x) => x.id === String(b.footageId) && x.kind === "video");
    if (!f) throw new HttpError(404, "Footage not found");
    // A look shouldn't start a multi-gigabyte download inside the request.
    if (!(await isCached(f).catch(() => false))) throw new HttpError(409, "This footage isn't downloaded yet. Run find_moments on it (or render a clip from it) first.");
    src = await footageSource(f);
    duration = f.durationSec ?? 0;
    label = `footage "${f.name}"`;
  } else throw new HttpError(400, "Give clipId, or campaignId and footageId");
  let start = Math.max(0, Number(b.start) || 0);
  let end = Number(b.end) || (duration ? Math.min(duration, start + maxWindow) : start + Math.min(maxWindow, 10));
  if (typeof b.aroundPhrase === "string" && b.aroundPhrase.trim()) {
    if (!words?.length) throw new HttpError(400, "aroundPhrase needs a rendered clip with timed words");
    if (!/[\p{L}\p{N}]/u.test(b.aroundPhrase)) throw new HttpError(400, "aroundPhrase needs words");
    const w = phraseWindow(words, b.aroundPhrase, Math.max(1, Math.round(Number(b.occurrence) || 1)));
    if (!w) throw new HttpError(404, `"${b.aroundPhrase}" isn't said${Number(b.occurrence) > 1 ? ` ${b.occurrence} times` : ""} in this clip`);
    ({ start, end } = w);
  }
  if (duration) end = Math.min(end, duration);
  if (!(end > start)) throw new HttpError(400, "The window is empty (end must be after start)");
  if (end - start > maxWindow) throw new HttpError(400, `Look at ${maxWindow} s or less at a time`);
  return { src, start, end, label, shotCuts, rendered };
}

const b64 = (file: string) => fs.readFileSync(file).toString("base64");

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
    formats: (doc.formats ?? []).map(({ transcript, cuts, ...f }) => ({ ...f, hasTranscript: !!transcript, cutCount: cuts?.length ?? 0 })),
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
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "DENY");
    if (process.env.NODE_ENV === "production") res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    // The app's own pages load only from this origin (videos and avatars may come
    // from storage and social CDNs). The third-party editor at /editor sets its own needs.
    if (!req.path.startsWith("/editor"))
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
      );
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
  app.use("/api/ai/v1", express.json({ limit: "2mb" }));
  app.use("/api", express.json({ limit: "1mb" }));

  app.get(
    "/api/health",
    wrap(async (_req, res) => {
      const db = await getBackend()
        .ping()
        .then(() => true)
        .catch(() => false);
      if (!db) alert("database", "The database isn't answering health checks");
      res.status(db ? 200 : 503).json({ ok: db, db, ...serviceStatus(), videos: storageKind() });
    }),
  );

  // ---- Accounts --------------------------------------------------------------
  const me = async (userId: string): Promise<Me> => {
    const b = getBackend();
    const user = (await b.getUser(userId))!;
    const ws = (await b.workspaceForOwner(userId))!;
    return { user: { id: user.id, email: user.email, name: user.name, emailVerified: !!user.emailVerifiedAt, ...(isAdmin(user.email) ? { admin: true } : {}) }, workspace: { id: ws.id, name: ws.name, hasAgentKey: !!ws.hasAgentKey } };
  };

  // Shown on the public Terms and Privacy pages.
  app.get("/api/public-config", (_req, res) =>
    res.json({ company: process.env.LEGAL_NAME || "UGCMediaClips", contact: process.env.CONTACT_EMAIL || undefined, effective: process.env.LEGAL_EFFECTIVE || "October 16, 2026" }),
  );

  app.post(
    "/api/auth/signup",
    wrap(async (req, res) => {
      if (process.env.ALLOW_SIGNUP === "false") throw new HttpError(403, "Sign-ups are closed right now.");
      const email = String(req.body?.email ?? "").trim().toLowerCase();
      const password = String(req.body?.password ?? "");
      const name = String(req.body?.name ?? "").trim().slice(0, 80) || email.split("@")[0];
      if (!EMAIL.test(email)) throw new HttpError(400, "Enter a valid email");
      if (password.length < 8) throw new HttpError(400, "Password must be at least 8 characters");
      throttle(`signup:${clientKey(req.ip)}`);
      const b = getBackend();
      if (await b.findUserByEmail(email)) throw new HttpError(409, "An account with that email already exists");
      const user: UserRow = { id: newId("usr"), email, name, passwordHash: await hashPassword(password), createdAt: now() };
      await b.createUser(user);
      await b.createWorkspace({ id: newId("ws"), ownerId: user.id, name: String(req.body?.workspaceName ?? "").trim().slice(0, 80) || `${name}'s clips`, createdAt: now() }, emptyDoc());
      issueSession(res, user.id);
      await sendVerification(req, user).catch((e) => console.error("[email] verification failed:", (e as Error).message));
      res.status(201).json(await me(user.id));
    }),
  );

  app.post(
    "/api/auth/login",
    wrap(async (req, res) => {
      const email = String(req.body?.email ?? "").trim().toLowerCase();
      const key = `login:${clientKey(req.ip)}:${email}`;
      throttle(key);
      // However many addresses they come from, an account gets a limited number of guesses.
      throttle(`login-account:${email}`, 30);
      const user = await getBackend().findUserByEmail(email);
      if (!user || !(await verifyPassword(String(req.body?.password ?? ""), user.passwordHash))) throw new HttpError(401, "Wrong email or password");
      clearThrottle(key);
      clearThrottle(`login-account:${email}`);
      issueSession(res, user.id);
      res.json(await me(user.id));
    }),
  );

  // ---- Email: confirm address, reset or change password ----------------------
  // Links are built from APP_URL (never the request's Host header, which a
  // caller controls) so an emailed link can't be pointed at another site.
  const linkBase = (req: Request) => (process.env.APP_URL || process.env.PUBLIC_URL || (process.env.NODE_ENV === "production" ? "" : publicBase(req))).replace(/\/$/, "");
  const sendVerification = async (req: Request, user: UserRow) => {
    const base = linkBase(req);
    if (!base) return console.warn("[email] APP_URL is not set; can't build links");
    const token = signToken("verify", { u: user.id, m: user.email }, 7 * 86400);
    await sendEmail(
      buttonEmail({
        to: user.email,
        subject: "Confirm your email for UGCMediaClips",
        intro: `Hi ${user.name}, confirm this is your email so you can recover your account if you ever lose your password.`,
        button: "Confirm email",
        url: `${base}/#/verify?token=${encodeURIComponent(token)}`,
        outro: "The link works for 7 days. If you didn't create an account, ignore this email.",
      }),
    );
  };

  app.post(
    "/api/auth/forgot",
    wrap(async (req, res) => {
      const email = String(req.body?.email ?? "").trim().toLowerCase();
      if (!EMAIL.test(email)) throw new HttpError(400, "Enter a valid email");
      throttle(`forgot:${clientKey(req.ip)}`);
      throttle(`forgot:${email}`);
      const user = await getBackend().findUserByEmail(email);
      const base = linkBase(req);
      // Same answer whether or not the account exists, so this can't be used to find accounts.
      if (user && base) {
        const token = signToken("reset", { u: user.id, f: passwordFingerprint(user.passwordHash) }, 3600);
        await sendEmail(
          buttonEmail({
            to: user.email,
            subject: "Reset your UGCMediaClips password",
            intro: "Someone (hopefully you) asked to reset the password for this account.",
            button: "Choose a new password",
            url: `${base}/#/reset?token=${encodeURIComponent(token)}`,
            outro: "The link works once, for 1 hour. If you didn't ask for this, ignore this email; your password stays the same.",
          }),
        ).catch((e) => console.error("[email] reset failed:", (e as Error).message));
      }
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/auth/reset",
    wrap(async (req, res) => {
      throttle(`reset:${clientKey(req.ip)}`);
      const t = readToken("reset", String(req.body?.token ?? ""));
      const password = String(req.body?.password ?? "");
      if (password.length < 8) throw new HttpError(400, "Password must be at least 8 characters");
      const b = getBackend();
      const user = t && (await b.getUser(t.u));
      if (!user || passwordFingerprint(user.passwordHash) !== t.f) throw new HttpError(400, "This reset link has expired or was already used. Ask for a new one.");
      const at = new Date().toISOString();
      // Following the link proves the inbox, so it also confirms the email.
      await b.updateUser(user.id, { passwordHash: await hashPassword(password), sessionsValidAfter: at, emailVerifiedAt: user.emailVerifiedAt ?? now() });
      clearThrottle(`login:${clientKey(req.ip)}:${user.email}`);
      clearThrottle(`login-account:${user.email}`);
      issueSession(res, user.id);
      res.json(await me(user.id));
    }),
  );

  app.post(
    "/api/auth/verify",
    wrap(async (req, res) => {
      throttle(`verify:${clientKey(req.ip)}`);
      const t = readToken("verify", String(req.body?.token ?? ""));
      const b = getBackend();
      const user = t && (await b.getUser(t.u));
      if (!user || user.email !== t.m) throw new HttpError(400, "This confirmation link has expired. Sign in and send a new one.");
      if (!user.emailVerifiedAt) await b.updateUser(user.id, { emailVerifiedAt: now() });
      res.json({ ok: true, email: user.email });
    }),
  );

  app.post(
    "/api/auth/resend-verification",
    requireWorkspace,
    humansOnly,
    wrap(async (req, res) => {
      throttle(`resend:${req.userId}`);
      const user = (await getBackend().getUser(req.userId!))!;
      if (!user.emailVerifiedAt) await sendVerification(req, user);
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/auth/password",
    requireWorkspace,
    humansOnly,
    wrap(async (req, res) => {
      const b = getBackend();
      const user = (await b.getUser(req.userId!))!;
      throttle(`password:${user.id}`);
      if (!(await verifyPassword(String(req.body?.current ?? ""), user.passwordHash))) throw new HttpError(401, "Your current password is wrong");
      const next = String(req.body?.password ?? "");
      if (next.length < 8) throw new HttpError(400, "Password must be at least 8 characters");
      await b.updateUser(user.id, { passwordHash: await hashPassword(next), sessionsValidAfter: new Date().toISOString() });
      clearThrottle(`password:${user.id}`);
      // Signs out every other device; this one gets a fresh session.
      issueSession(res, user.id);
      res.json(await me(user.id));
    }),
  );

  // Ends every session for this account (all devices), including this one.
  app.post(
    "/api/auth/logout-everywhere",
    requireWorkspace,
    humansOnly,
    wrap(async (req, res) => {
      await getBackend().updateUser(req.userId!, { sessionsValidAfter: new Date().toISOString() });
      clearSession(res);
      res.json({ ok: true });
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
      // The workspace's files, and its cached render steps (kept under steps/).
      for (const prefix of [`${req.workspaceId}/`, `steps/${req.workspaceId}/`])
        await videoStore()
          .deletePrefix(prefix)
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
      if (q.session) {
        // Remember which workspace this page-picking session belongs to.
        const doc = getDoc();
        doc.pendingSocial = [...(doc.pendingSocial ?? []).filter((p) => Date.now() - Date.parse(p.at) < 3600_000), { session: String(q.session).slice(0, 200), at: now() }];
        save();
        return void res.redirect(`/#/settings/accounts?pending=${encodeURIComponent(String(q.session))}`);
      }
      await syncAccounts(req.workspaceId!);
      log({ kind: "account", message: `Connected ${q.username ? `@${q.username}` : "a social account"}.` });
      save();
      res.redirect("/#/settings/accounts?connected=1");
    }),
  );

  // Facebook / LinkedIn: pick which pages to connect.
  const ownPending = (session: string) => {
    if (!(getDoc().pendingSocial ?? []).some((p) => p.session === session && Date.now() - Date.parse(p.at) < 3600_000)) throw new HttpError(404, "That connection has expired. Connect the account again.");
    return session;
  };
  api.get(
    "/social/pending/:session",
    wrap(async (req, res) => res.json({ pages: await pendingPages(ownPending(String(req.params.session))) })),
  );
  api.post(
    "/social/pending/:session",
    wrap(async (req, res) => {
      const ids = Array.isArray(req.body?.pageIds) ? req.body.pageIds.map(String).slice(0, 50) : [];
      if (!ids.length) throw new HttpError(400, "Pick at least one page");
      await finalizePending(ownPending(String(req.params.session)), ids);
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
    try {
      // Queued before it's added, so a full queue doesn't leave a job stuck as "working".
      enqueueCaptionJob({ workspaceId: req.workspaceId!, jobId: j.id, kind: "transcribe", actor: req.actor });
    } catch (err) {
      void videoStore().deletePrefix(j.sourceKey).catch(() => undefined);
      throw err;
    }
    const doc = getDoc();
    doc.captionJobs = [j, ...(doc.captionJobs ?? [])].slice(0, 200);
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

  // ---- Formats: clone a viral video's structure ------------------------------
  const findFormat = (id: string) => {
    const f = getDoc().formats?.find((x) => x.id === id);
    if (!f) throw new HttpError(404, "Format not found");
    return f;
  };
  const addFormat = (req: Request, name: string, sourceKey: string, source: ReferenceFormat["source"]) => {
    const at = now();
    const f: ReferenceFormat = { id: newId("fmt"), name: name.slice(0, 80) || "Reference video", status: "analyzing", step: "Queued", source, sourceKey, cost: 0, createdAt: at, updatedAt: at };
    try {
      enqueueFormat({ workspaceId: req.workspaceId!, formatId: f.id });
    } catch (err) {
      void videoStore().deletePrefix(sourceKey).catch(() => undefined);
      throw err;
    }
    const doc = getDoc();
    doc.formats = [f, ...(doc.formats ?? [])].slice(0, 100);
    log({ kind: "clip", message: `Breaking down "${f.name}" into a reusable format.` });
    save();
    return f;
  };

  api.post(
    "/formats",
    wrap(async (req, res) => {
      const type = String(req.headers["content-type"] ?? "").split(";")[0];
      if (!/^(video\/(mp4|quicktime|webm|x-matroska|x-m4v)|application\/octet-stream)$/.test(type)) throw new HttpError(415, "Upload a video file (MP4, MOV, WebM or MKV)");
      spendAI(req.workspaceId!, 1);
      const name = decodeURIComponent(String(req.headers["x-file-name"] ?? "reference.mp4")).slice(0, 120);
      const key = `${req.workspaceId}/formats/${newId("src")}/reference${path.extname(name).toLowerCase().replace(/[^.\w]/g, "") || ".mp4"}`;
      try {
        await saveStream(key, req, type);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      const f = addFormat(req, String(req.query.name ?? "") || name.replace(/\.\w{2,4}$/, ""), key, { kind: "upload", fileName: name });
      res.status(201).json({ format: f, state: stateFor() });
    }),
  );

  api.post(
    "/formats/from-url",
    wrap(async (req, res) => {
      const url = String(req.body?.url ?? "").trim();
      if (!/^https?:\/\//.test(url)) throw new HttpError(400, "Give a public http(s) link to a video file");
      spendAI(req.workspaceId!, 1);
      const r = await safeFetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
      if (!r.ok || !r.body) throw new HttpError(422, `That link returned ${r.status}`);
      if (/text\/html/.test(r.headers.get("content-type") ?? ""))
        throw new HttpError(422, "That link is a web page, not a video file. For TikTok, Instagram or YouTube, download the video and upload it here.");
      const key = `${req.workspaceId}/formats/${newId("src")}/reference.mp4`;
      try {
        await saveStream(key, Readable.fromWeb(r.body as never), "video/mp4");
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      const f = addFormat(req, String(req.body?.name ?? "") || decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "").replace(/\.\w{2,4}$/, ""), key, { kind: "url", url });
      res.status(201).json({ format: f, state: stateFor() });
    }),
  );

  api.get("/formats/:id", (req, res) => res.json(findFormat(String(req.params.id))));

  api.put("/formats/:id", (req, res) => {
    const f = findFormat(String(req.params.id));
    if (typeof req.body?.name === "string" && req.body.name.trim()) f.name = req.body.name.trim().slice(0, 80);
    if (typeof req.body?.recipe === "string" && f.breakdown) f.breakdown.recipe = req.body.recipe.slice(0, 2000);
    f.updatedAt = now();
    save();
    res.json(stateFor());
  });

  api.post("/formats/:id/analyze", (req, res) => {
    const f = findFormat(String(req.params.id));
    if (f.status === "analyzing") throw new HttpError(409, "Already working on it");
    spendAI(req.workspaceId!, 1);
    // Asked to try again: a fresh breakdown, not the stored one, and no stale receipts.
    enqueueFormat({ workspaceId: req.workspaceId!, formatId: f.id, fresh: true });
    Object.assign(f, { status: "analyzing", step: "Queued", error: undefined, resumes: undefined, steps: undefined, refresh: true, updatedAt: now() });
    save();
    res.status(202).json(stateFor());
  });

  api.get(
    "/formats/:id/video",
    wrap(async (req, res) => {
      const f = findFormat(String(req.params.id));
      await streamKey(req, res, f.sourceKey, "video/mp4", f.name);
    }),
  );

  api.delete(
    "/formats/:id",
    wrap(async (req, res) => {
      const f = findFormat(String(req.params.id));
      const doc = getDoc();
      cancelJob(f.id, "Deleted");
      doc.formats = (doc.formats ?? []).filter((x) => x.id !== f.id);
      await videoStore().deletePrefix(f.sourceKey.replace(/[^/]+$/, "")).catch(() => undefined);
      save();
      res.json(stateFor());
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
    enqueueCaptionJob({ workspaceId: req.workspaceId!, jobId: j.id, kind: "transcribe", actor: req.actor });
    Object.assign(j, { status: "transcribing", step: "Queued", error: undefined });
    save();
    res.status(202).json(stateFor());
  });

  api.post("/captions/:id/render", (req, res) => {
    const j = findJob(String(req.params.id));
    if (!j.words.length) throw new HttpError(409, "Transcribe the video first");
    if (j.status === "transcribing" || j.status === "rendering") throw new HttpError(409, "Already working on it");
    if (req.body?.captions && typeof req.body.captions === "object") j.captions = captionOverrides(req.body.captions);
    enqueueCaptionJob({ workspaceId: req.workspaceId!, jobId: j.id, kind: "render", actor: req.actor });
    Object.assign(j, { status: "rendering", step: "Queued", error: undefined });
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
      cancelJob(j.id, "Deleted");
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
        // Measured once here, so captions and overlays in this font fit tightly.
        const widths = await measureFont(dir, family);
        doc.brand = { ...(doc.brand ?? {}), fonts: [...(doc.brand?.fonts ?? []).filter((f) => f.family !== family), { id, family, key, file: `${id}.${ext}`, widths }] };
        log({ kind: "account", message: widths ? `Brand font "${family}" uploaded.` : `Brand font "${family}" uploaded, but the video renderer doesn't recognise it by that name, so captions would fall back to another font. Try a different file of this font (e.g. the static .ttf rather than a variable font).` });
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
      const fmt = req.body?.formatId ? getDoc().formats?.find((f) => f.id === String(req.body.formatId)) : undefined;
      if (req.body?.formatId && fmt?.status !== "ready") throw new HttpError(400, "That format isn't ready yet");
      const r = await planClips(c, n, existing, guide, fmt ? { id: fmt.id, plan: formatForPlanner(fmt) } : undefined);
      doc.clips.unshift(...r.clips);
      const ok = r.clips.filter((x) => x.qa.pass).length;
      const learned = guide.basedOnPosts ? ` Guided by ${count(guide.basedOnPosts, "post")}: ${count(r.clips.filter((x) => x.traits?.strategy === "test").length, "test")}.` : "";
      log({ campaignId: c.id, kind: "clip", message: `${r.clips.length} clip plan(s) written by ${r.model}${fmt ? ` in the "${fmt.name}" format` : ""} — ${ok} pass every rule.${learned}`, cost: r.cost });
      save();
      res.status(201).json(stateFor());
    }),
  );

  // Edits are made on a copy and only kept if they pass the checks: a stale
  // baseRevision (someone else changed it since) is a 409, and an edit that
  // breaks a rule on a plan that followed the brief is a 422 unless allowFailing.
  api.put("/clips/:id", (req, res) => {
    const clip = findClip(String(req.params.id));
    const c = findCampaign(clip.campaignId);
    const b = req.body ?? {};
    const rev = clip.revision ?? 0;
    if (b.baseRevision !== undefined && Number(b.baseRevision) !== rev)
      throw new HttpError(409, `This plan was changed since you opened it (now revision ${rev}, yours ${Number(b.baseRevision)}). Reload it and make your edit again.`);
    const next: Clip = { ...clip };
    for (const k of ["title", "angle", "hook", "narration", "cta", "caption"] as const) if (typeof b[k] === "string") next[k] = b[k].slice(0, 4000);
    if (Array.isArray(b.onScreenText)) next.onScreenText = b.onScreenText.map(String).slice(0, 20);
    if (Array.isArray(b.hashtags)) next.hashtags = b.hashtags.map(String).slice(0, 30);
    if (Number(b.lengthSec) > 0) next.lengthSec = Math.min(600, Math.round(Number(b.lengthSec)));
    if (Array.isArray(b.overlays)) next.overlays = sanitizeOverlays(b.overlays, undefined, () => newId("ov"));
    next.qa = checkClip(next, c.brief);
    if (clip.qa.pass && !next.qa.pass && !b.allowFailing && !b.override) {
      const broken = next.qa.checks.filter((x) => !x.pass).map((x) => x.rule);
      throw new HttpError(422, `This edit breaks a brief rule (${broken.join("; ")}), so nothing was saved. Fix it, or save anyway.`);
    }
    if (CLIP_STATUSES.includes(b.status)) {
      if (b.status === "approved" && !next.qa.pass && !b.override) throw new HttpError(400, "This plan fails a rule. Fix it, or approve anyway.");
      next.status = b.status as ClipStatus;
    }
    Object.assign(clip, next, { revision: rev + 1, updatedAt: now() });
    save();
    res.json(stateFor());
  });

  // Review comments pinned to moments of a clip.
  const MAX_COMMENTS = 100;
  api.post("/clips/:id/comments", (req, res) => {
    const clip = findClip(String(req.params.id));
    const text = String(req.body?.text ?? "").trim().slice(0, 2000);
    if (!text) throw new HttpError(400, "Write a comment");
    const at = req.body?.at === undefined || req.body?.at === null ? undefined : Number(req.body.at);
    if (at !== undefined && !(at >= 0 && at <= 600)) throw new HttpError(400, "at is seconds into the video");
    if ((clip.comments ?? []).length >= MAX_COMMENTS) throw new HttpError(400, `Up to ${MAX_COMMENTS} comments a clip — delete resolved ones first`);
    const comment = { id: newId("cm"), ...(at !== undefined ? { at: Math.round(at * 100) / 100 } : {}), text, author: req.actor === "agent" ? ("agent" as const) : ("human" as const), resolved: false, createdAt: now() };
    clip.comments = [...(clip.comments ?? []), comment];
    save();
    res.status(201).json({ comment, state: stateFor() });
  });

  api.put("/clips/:id/comments/:cid", (req, res) => {
    const clip = findClip(String(req.params.id));
    const cm = clip.comments?.find((x) => x.id === req.params.cid);
    if (!cm) throw new HttpError(404, "Comment not found");
    if (typeof req.body?.resolved === "boolean") cm.resolved = req.body.resolved;
    if (typeof req.body?.text === "string" && req.body.text.trim()) cm.text = req.body.text.trim().slice(0, 2000);
    save();
    res.json({ comment: cm, state: stateFor() });
  });

  api.delete("/clips/:id/comments/:cid", (req, res) => {
    const clip = findClip(String(req.params.id));
    if (!clip.comments?.some((x) => x.id === req.params.cid)) throw new HttpError(404, "Comment not found");
    clip.comments = clip.comments.filter((x) => x.id !== req.params.cid);
    save();
    res.json(stateFor());
  });

  // Re-plan a clip from its open comments; the comments it answered are resolved.
  api.post(
    "/clips/:id/apply-comments",
    wrap(async (req, res) => {
      const clip = findClip(String(req.params.id));
      const c = findCampaign(clip.campaignId);
      if (!clip.comments?.some((x) => !x.resolved)) throw new HttpError(409, "This clip has no open comments");
      spendAI(req.workspaceId!, 1);
      const rev = clip.revision ?? 0;
      const r = await reviseFromComments(c, clip);
      // Someone edited it while the planner worked: don't overwrite their change.
      if ((clip.revision ?? 0) !== rev) throw new HttpError(409, "The plan was edited while the comments were being applied; apply them again.");
      const d = r.draft;
      Object.assign(clip, { hook: d.hook, narration: d.narration, onScreenText: d.onScreenText, cta: d.cta, shots: d.shots, lengthSec: d.lengthSec, caption: d.caption, hashtags: d.hashtags, ...(d.overlays ? { overlays: d.overlays } : {}), revision: rev + 1, updatedAt: now() });
      clip.qa = checkClip(clip, c.brief);
      if (clip.status === "rejected") clip.status = "draft";
      for (const cm of clip.comments ?? []) if (r.applied.includes(cm.id)) cm.resolved = true;
      log({ campaignId: c.id, kind: "clip", message: `Applied ${r.applied.length} review comment(s) to "${clip.title}"${clip.qa.pass ? "" : " — it now fails a rule, check it"}.`, cost: r.cost });
      save();
      res.json(stateFor());
    }),
  );

  // A/B variants: the same clip with different hooks (and optionally CTAs).
  api.post(
    "/clips/:id/variants",
    wrap(async (req, res) => {
      const base = findClip(String(req.params.id));
      const c = findCampaign(base.campaignId);
      const n = Math.max(1, Math.min(6, Number(req.body?.count) || 3));
      spendAI(req.workspaceId!, 1);
      const doc = getDoc();
      const group = base.variantGroup ?? base.id;
      const siblings = doc.clips.filter((x) => x.id !== base.id && x.variantGroup === group);
      const r = await makeVariants(c, base, siblings, n, !!req.body?.newCta);
      if (!r.clips.length) throw new HttpError(422, "Couldn't come up with new openings for this clip. Edit the hook and try again.");
      if (!base.variantGroup) Object.assign(base, { variantGroup: group, variantLabel: "A", updatedAt: now() });
      // Variants sit right after their group in the list.
      const at = doc.clips.indexOf(base);
      doc.clips.splice(at + 1, 0, ...r.clips);
      log({ campaignId: c.id, kind: "clip", message: `${r.clips.length} variant(s) of "${base.title}" written (${r.clips.map((x) => `${x.variantLabel}: “${x.hook}”`).join("; ")}).`, cost: r.cost });
      save();
      res.status(201).json(stateFor());
    }),
  );

  // Rendering: approved plan → finished 9:16 video.
  // With dryRun, only the preflight: costs, blockers and quota, nothing queued or counted.
  // A real request refuses on any blocker before queuing.
  api.post(
    "/clips/:id/render",
    wrap(async (req, res) => {
      const clip = findClip(String(req.params.id));
      const voice = String(req.body?.voice ?? "ash") as VoiceOption;
      const pre = await preflightRender(req.workspaceId!, clip, voice, !!req.body?.override);
      if (req.body?.dryRun) return void res.json({ preflight: pre });
      if (pre.blockers.length) throw new HttpError(pre.blockers[0].status, `${pre.blockers[0].message} Nothing was charged.`);
      // The preflight awaited storage; re-check what may have changed meanwhile before counting anything.
      if (isPending(clip.id)) throw new HttpError(409, "This clip is already rendering. Nothing was charged.");
      const maxQueued = Number(process.env.MAX_QUEUED_RENDERS ?? 20);
      if (waitingCount(req.workspaceId!, "render") >= maxQueued) throw new HttpError(429, `You already have ${maxQueued} clips waiting to render. Try again when some finish. Nothing was charged.`);
      // A recorded take is reused, so it isn't counted as an AI call.
      if (voice !== "none" && !pre.voice.takeCached) spendAI(req.workspaceId!, 1);
      enqueueRender(req.workspaceId!, clip, voice, req.actor);
      log({ campaignId: clip.campaignId, kind: "clip", message: `Render queued for "${clip.title}".` });
      save();
      res.status(202).json(stateFor());
    }),
  );

  api.post("/preflight/brief", (req, res) => {
    const count = Math.min(10, Math.max(1, Math.round(Number(req.body?.count) || 3)));
    res.json(preflightBrief(req.workspaceId!, count, String(req.body?.voice ?? "ash") as VoiceOption, req.body?.render !== false));
  });

  api.post(
    "/preflight",
    wrap(async (req, res) => {
      const ids: unknown = req.body?.clipIds;
      if (!Array.isArray(ids) || !ids.length || ids.length > 50) throw new HttpError(400, "Give clipIds (1–50)");
      const voice = String(req.body?.voice ?? "ash") as VoiceOption;
      const clips = await Promise.all(ids.map((id) => preflightRender(req.workspaceId!, findClip(String(id)), voice, !!req.body?.override)));
      const totalUsd = Math.round(clips.reduce((n, c) => n + c.estimate.totalUsd, 0) * 1e4) / 1e4;
      res.json({ clips, totalUsd, ok: clips.every((c) => c.ok) });
    }),
  );

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
      overlays: p.overlays ?? [],
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
      const key = [...(p?.shots.map((s) => s.key) ?? []), p?.voiceKey, p?.proxyKey].find((k) => k && k.split("/").pop() === name);
      if (!key || !key.startsWith(`${req.workspaceId}/`)) throw new HttpError(404, "Part not found");
      await streamKey(req, res, key, name.endsWith(".wav") ? "audio/wav" : "video/mp4", name);
    }),
  );

  // The in-browser preview: the clip's captions, hook, CTA and overlays as ASS,
  // rebuilt now with the current caption style and overlays (no render), to draw
  // over the small caption-free proxy of the last render.
  api.get("/clips/:id/preview", (req, res) => {
    const clip = findClip(String(req.params.id));
    const p = clip.render?.status === "done" ? clip.render.parts : undefined;
    if (!p?.timing || !p.proxyKey) throw new HttpError(409, "Render this clip once more to preview caption and overlay changes here.");
    const c = findCampaign(clip.campaignId);
    const brand = getDoc().brand;
    const { ass, missed } = buildClipAss({ clip, campaign: c, brand, words: p.timing.words, moments: p.timing.moments, duration: p.duration, ctaFrom: p.cta.from, ctaText: p.cta.text, language: p.timing.language });
    const fonts: Record<string, string> = Object.fromEntries([...BUNDLED_FONTS.map((f) => [f.family, `/fonts/${f.file}`]), ...(brand?.fonts ?? []).map((f) => [f.family, `/api/brand/fonts/${f.id}/file`])]);
    res.json({ proxyUrl: `/api/clips/${clip.id}/parts/${encodeURIComponent(p.proxyKey.split("/").pop()!)}`, ass, fonts, duration: p.duration, missed: missed.map((o) => o.cue ?? o.text), revision: clip.revision ?? 0 });
  });

  // Apply caption and overlay changes to the video: only the final compose runs,
  // from the stored voiceover and shots. Refused if that would need anything paid.
  api.post(
    "/clips/:id/recompose",
    wrap(async (req, res) => {
      const clip = findClip(String(req.params.id));
      const r = clip.render;
      if (r?.status !== "done") throw new HttpError(409, "Render this clip first");
      const pre = await preflightRender(req.workspaceId!, clip, r.voice, true);
      if (pre.blockers.length) throw new HttpError(pre.blockers[0].status, `${pre.blockers[0].message} Nothing was charged.`);
      if (r.voice !== "none" && !pre.voice.takeCached) throw new HttpError(409, "The voiceover would have to be recorded again (the script changed). Render instead.");
      if (isPending(clip.id)) throw new HttpError(409, "This clip is already rendering. Nothing was charged.");
      enqueueRender(req.workspaceId!, clip, r.voice, req.actor, true);
      log({ campaignId: clip.campaignId, kind: "clip", message: `Re-composing "${clip.title}" with the current captions and overlays.` });
      save();
      res.status(202).json(stateFor());
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
          billed = true;
          runInWorkspace(ws, undefined, () => recordAI("editor", Number(costs.at(-1)?.[1] ?? 0)));
          cb();
        },
      });
      // If the viewer leaves mid-reply the provider still bills: charge an estimate
      // from the request size so abandoned streams still count toward the budget.
      let billed = false;
      res.on("close", () => {
        if (billed) return;
        billed = true;
        const inputChars = JSON.stringify(req.body?.messages ?? []).length;
        runInWorkspace(ws, undefined, () => recordAI("editor", (inputChars / 4) * 3e-6 + 0.01));
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

  // Frames and contact sheets of a rendered clip or footage, for agents to look at.
  api.post(
    "/frames",
    wrap(async (req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const { src, start, end, label } = await lookSource(req.workspaceId!, b, MAX_WINDOW);
      const sheet = b.sheet === true;
      const n = b.count ? Math.min(9, Math.max(1, Math.round(Number(b.count)))) : undefined;
      const times = frameTimes(start, end, n);
      const dir = workDir();
      try {
        if (sheet) {
          const { pages, frames } = await contactSheets(src, times, dir);
          res.json({ source: label, window: { start, end }, times: frames.map((f) => f.t), images: pages.map((p) => ({ mimeType: "image/jpeg", data: b64(p) })) });
        } else {
          const width = Math.min(720, Math.max(160, Math.round(Number(b.width) || 480)));
          const frames = await grabFrames(src, times, width, dir);
          res.json({ source: label, window: { start, end }, times: frames.map((f) => f.t), images: frames.map((f) => ({ mimeType: "image/jpeg", data: b64(f.file) })) });
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  api.post(
    "/scene-cuts",
    wrap(async (req, res) => {
      const { src, start, end, label, shotCuts, rendered } = await lookSource(req.workspaceId!, (req.body ?? {}) as Record<string, unknown>, MAX_CUTS_WINDOW);
      if (shotCuts) return void res.json({ source: label, window: { start, end }, cuts: shotCuts.filter((t) => t > start && t < end), method: "render" });
      // In a finished clip the blurred background and captions carry over a cut, so look at the footage band only, more sensitively.
      const cuts = await sceneCutsIn(src, start, end, rendered ? { threshold: 0.1, crop: { y: VIDEO_TOP, h: VIDEO_H } } : undefined);
      res.json({ source: label, window: { start, end }, cuts, method: "detected" });
    }),
  );

  // One clip's render state, for cheap polling: no full /state. `stalled` means
  // it says it's rendering but no worker has it (queued or running).
  api.get("/clips/:id/status", (req, res) => {
    const clip = findClip(String(req.params.id));
    const r = clip.render;
    const pending = isPending(clip.id);
    const active = !!r && !["done", "failed"].includes(r.status);
    res.json({
      id: clip.id,
      status: clip.status,
      pending,
      stalled: active && !pending,
      render: r && { status: r.status, step: r.step, error: r.error, voice: r.voice, requestedAt: r.requestedAt, startedAt: r.startedAt, finishedAt: r.finishedAt, durationSec: r.durationSec, cost: r.cost, captionTiming: r.captionTiming, log: r.log, steps: r.steps },
    });
  });

  // How long a script will take to say, from this workspace's measured voice pace when there is one.
  api.post("/estimate-voiceover", (req, res) => {
    const text = String(req.body?.text ?? "");
    if (!text.trim()) throw new HttpError(400, "Give text");
    if (text.length > 20_000) throw new HttpError(400, "Text is too long");
    const voice = req.body?.voice ? String(req.body.voice) : undefined;
    const rates = getDoc().voiceRates ?? {};
    const learned = voice ? rates[voice] : undefined;
    const avg = Object.values(rates);
    const unitsPerSec = learned?.unitsPerSec ?? (avg.length ? avg.reduce((n, r) => n + r.unitsPerSec, 0) / avg.length : UNITS_PER_SECOND);
    const spoken = spokenText(text);
    const load = speechLoad(spoken);
    res.json({ spoken, units: Math.round(load * 10) / 10, unitsPerSec: Math.round(unitsPerSec * 100) / 100, seconds: Math.round(speechSeconds(spoken, unitsPerSec) * 10) / 10, calibrated: learned ? `${learned.n} render(s) of ${voice}` : avg.length ? "average of this workspace's voices" : false });
  });

  api.post("/clips/:id/render/cancel", (req, res) => {
    const clip = findClip(String(req.params.id));
    if (!cancelRender(clip)) throw new HttpError(409, "This clip isn't rendering (or is already stopping)");
    log({ campaignId: clip.campaignId, kind: "clip", message: `Render cancelled for "${clip.title}".` });
    save();
    res.json(stateFor());
  });

  api.delete("/clips/:id", (req, res) => {
    const doc = getDoc();
    const clip = findClip(String(req.params.id));
    cancelJob(clip.id, "Deleted");
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

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : (err as { status?: number })?.status === 400 ? 400 : 500;
    if (status >= 500) console.error(err);
    // Unexpected failures page the operator; deliberate ones (503 "not configured", 429 limits) don't.
    if (status === 500) alert("server error", `${req.method} ${req.path.replace(/[\w-]{16,}/g, ":id")}: ${(err as Error)?.message ?? err}`, (err as Error)?.stack?.split("\n").slice(1, 4).join("\n"));
    res.status(status).json({ error: status >= 500 ? "Something went wrong" : (err as Error).message });
  });
  return app;
}
