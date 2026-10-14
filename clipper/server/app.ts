import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { campaignStats } from "../shared/rules";
import type { Campaign, CampaignBrief, Clip, ClipStatus, Me, Platform, Post, PostStatus, ServiceStatus, SocialAccount, VoiceOption } from "../shared/types";
import { CLIP_STATUSES, PLATFORMS, POST_STATUSES, VOICES } from "../shared/types";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bearerAgentKey, clearSession, clearThrottle, hashAgentKey, hashPassword, humansOnly, issueSession, newAgentKey, requireWorkspace, signVideoLink, throttle, verifyPassword, verifyVideoLink } from "./auth";
import { HttpError, emptyDoc, forgetTenant, getBackend, getDoc, loadTenant, log, newId, now, runInWorkspace, save, type UserRow } from "./db";
import { createMcpServer, httpApi } from "./mcp";
import { extractBrief, normalizeBrief } from "./extract";
import { aiLive, mediaLive, modelFor } from "./llm";
import { analyzeFootage } from "./moments";
import { enqueueRender, renderAvailable } from "./render";
import { saveUpload } from "./footage-cache";
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
  };
}

// AI calls cost money; cap them per workspace per day.
const aiCalls = new Map<string, { day: string; n: number }>();
function spendAI(workspaceId: string, n = 1) {
  if (!aiLive()) return;
  const day = new Date().toISOString().slice(0, 10);
  const c = aiCalls.get(workspaceId);
  const used = c?.day === day ? c.n : 0;
  const limit = Number(process.env.AI_DAILY_LIMIT ?? 150);
  if (used + n > limit) throw new HttpError(429, `Daily AI limit reached (${limit}). It resets at midnight UTC.`);
  aiCalls.set(workspaceId, { day, n: used + n });
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

const platformOf = (v: unknown): Platform => ((PLATFORMS as string[]).includes(String(v)) ? (v as Platform) : "other");

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
  const m = String(req.headers.range ?? "").match(/^bytes=(\d*)-(\d*)$/);
  const range = m && (m[1] || m[2]) ? { start: m[1] ? Number(m[1]) : 0, end: m[2] ? Number(m[2]) : undefined } : undefined;
  const f = await videoStore().read(key, range);
  res.setHeader("Content-Type", f.type);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, max-age=3600");
  if (req.query.download) res.setHeader("Content-Disposition", `attachment; filename="${clip.title.replace(/[^\w\- ]+/g, "").slice(0, 60) || "clip"}.mp4"`);
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
  app.use("/api", express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => res.json({ ok: true, ...serviceStatus(), videos: storageKind() }));

  // ---- Accounts --------------------------------------------------------------
  const me = async (userId: string): Promise<Me> => {
    const b = getBackend();
    const user = (await b.getUser(userId))!;
    const ws = (await b.workspaceForOwner(userId))!;
    return { user: { id: user.id, email: user.email, name: user.name }, workspace: { id: ws.id, name: ws.name, hasAgentKey: !!ws.hasAgentKey } };
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

  // A shareable link to the finished video (expires in 7 days) — what agents hand to people and schedulers.
  api.get("/clips/:id/link", (req, res) => {
    const clip = findClip(String(req.params.id));
    const key = clip.render?.videoKey;
    if (!key || clip.render?.status !== "done") throw new HttpError(404, "No finished video yet");
    res.json({ url: `${publicBase(req)}${signVideoLink(req.workspaceId!, clip.id, key)}`, expiresInDays: 7 });
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

  // ---- Web app -------------------------------------------------------------
  const dist = process.env.DIST_DIR ?? path.resolve(process.cwd(), "dist");
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: "1h" }));
    app.use((req, res, next) => (req.method === "GET" && !req.path.startsWith("/api") ? res.sendFile(path.join(dist, "index.html")) : next()));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : (err as { status?: number })?.status === 400 ? 400 : 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? "Something went wrong" : (err as Error).message });
  });
  return app;
}
