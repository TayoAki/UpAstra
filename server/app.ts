import fs from "node:fs";
import path from "node:path";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MODEL_CATALOG } from "../shared/catalog";
import { SERVICE_TEMPLATES, getTemplate } from "../shared/templates";
import type { AutonomyPolicy, ClientMemory, FirmProfile, Job, Lead, ProviderStatus, Role } from "../shared/types";
import { apifyConfigured } from "./apify";
import { astraMode, astraModel } from "./astra";
import {
  clearSession,
  clearThrottle,
  hashPassword,
  hashToken,
  issueSession,
  newAgentToken,
  newInviteCode,
  publicUser,
  requireRole,
  requireUser,
  requireWorkspace,
  sessionUserId,
  throttle,
  verifyPassword,
} from "./auth";
import { getProvider } from "./higgsfield";
import { llmProviderName } from "./llm";
import { CHECKPOINT_KINDS, createMcpServer, httpApi } from "./mcp";
import { getBackend } from "./persist";
import {
  acceptJob,
  assertAgentMay,
  createJob,
  firmStats,
  jobEconomics,
  jobGenerations,
  overrideRoute,
  receiveClientMessage,
  rerouteOpenJobs,
  resolveCheckpoint,
  setPrice,
  startProduction,
} from "./pipeline";
import { checkProposal, convertLeadToJob, draftProposal, newSearch, runSearch, scoreLead } from "./radar";
import { seed } from "./seed";
import { DEFAULT_POLICY, HttpError, audit, currentActor, emptyDB, ensureTenant, findClient, findJob, getDB, newId, now, runWith, save } from "./store";

type Req = Request<Record<string, string>>;
const wrap =
  (fn: (req: Req, res: Response) => unknown) =>
  (req: Req, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function providerStatus(): ProviderStatus & { ai: string; apify: "live" | "simulated" } {
  const p = getProvider();
  return {
    astra: { mode: astraMode(), model: astraModel() },
    higgsfield: { mode: p.mode, baseUrl: p.baseUrl },
    ai: llmProviderName(),
    apify: apifyConfigured() ? "live" : "simulated",
  };
}

function jobSummary(job: Job) {
  const gens = jobGenerations(job.id);
  const thumb = [...gens].reverse().find((g) => g.deliverableId && g.outputUrl && g.status === "completed")?.outputUrl;
  return {
    id: job.id,
    title: job.title,
    clientId: job.clientId,
    clientName: findClient(job.clientId)?.name ?? "—",
    channel: job.channel,
    stage: job.stage,
    templateName: getTemplate(job.templateId).name,
    price: job.price,
    running: !!job.running,
    openCheckpoints: job.checkpoints.filter((c) => c.status === "open").length,
    economics: jobEconomics(job),
    thumb,
    updatedAt: job.updatedAt,
    createdAt: job.createdAt,
  };
}

function jobDetail(job: Job) {
  return {
    job,
    economics: jobEconomics(job),
    generations: jobGenerations(job.id),
    audit: getDB().audit.filter((a) => a.jobId === job.id),
    client: findClient(job.clientId),
    template: getTemplate(job.templateId),
  };
}

/** Create a workspace, make the user its owner, optionally fill it with demo data. */
async function createWorkspace(userId: string, name: string, demo: boolean) {
  const b = getBackend();
  const ws = { id: newId("ws"), name: name.trim().slice(0, 80) || "My studio", createdAt: now() };
  await b.createWorkspace(ws, emptyDB());
  await b.addMember({ userId, workspaceId: ws.id, role: "owner" });
  await ensureTenant(ws.id);
  await runWith({ workspaceId: ws.id, actor: "human", userId }, async () => {
    audit({ actor: "system", type: "policy", message: `Workspace "${ws.name}" created.` });
    if (demo) await seed();
    save();
  });
  return ws;
}

async function me(userId: string) {
  const b = getBackend();
  const user = await b.getUser(userId);
  if (!user) throw new HttpError(401, "Sign in required");
  const workspaces = (await b.listWorkspacesForUser(userId)).map((w) => ({ id: w.id, name: w.name, role: w.role }));
  return { user: publicUser(user), workspaces };
}

// ---------------------------------------------------------------------------

export function createApp(opts: { port: number }) {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    next();
  });

  app.get("/api/health", (_req, res) => res.json({ ok: true, storage: getBackend().kind, ...providerStatus() }));

  // ---- Accounts --------------------------------------------------------------

  app.post(
    "/api/auth/signup",
    wrap(async (req, res) => {
      if (process.env.ALLOW_SIGNUP === "false" && !req.body?.invite) throw new HttpError(403, "Sign-ups are invite-only right now.");
      const email = String(req.body?.email ?? "").trim().toLowerCase();
      const password = String(req.body?.password ?? "");
      const name = String(req.body?.name ?? "").trim() || email.split("@")[0];
      if (!EMAIL.test(email)) throw new HttpError(400, "Enter a valid email");
      if (password.length < 8) throw new HttpError(400, "Password must be at least 8 characters");
      throttle(`signup:${req.ip}`);
      const b = getBackend();
      if (await b.findUserByEmail(email)) throw new HttpError(409, "An account with that email already exists");
      const user = { id: newId("usr"), email, name, passwordHash: await hashPassword(password), createdAt: now() };
      await b.createUser(user);
      const invite = req.body?.invite ? await b.takeInvite(String(req.body.invite)) : undefined;
      if (invite) await b.addMember({ userId: user.id, workspaceId: invite.workspaceId, role: invite.role });
      else await createWorkspace(user.id, String(req.body?.workspaceName ?? `${name}'s studio`), req.body?.demo !== false);
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
    wrap(async (req, res) => {
      const uid = sessionUserId(req);
      if (!uid) throw new HttpError(401, "Sign in required");
      res.json(await me(uid));
    }),
  );

  app.post(
    "/api/auth/join",
    requireUser,
    wrap(async (req, res) => {
      const invite = await getBackend().takeInvite(String(req.body?.code ?? "").trim());
      if (!invite) throw new HttpError(404, "That invite code is invalid or expired");
      await getBackend().addMember({ userId: req.userId!, workspaceId: invite.workspaceId, role: invite.role });
      res.json(await me(req.userId!));
    }),
  );

  app.post(
    "/api/workspaces",
    requireUser,
    wrap(async (req, res) => {
      const ws = await createWorkspace(req.userId!, String(req.body?.name ?? "New studio"), !!req.body?.demo);
      res.status(201).json({ workspace: ws, ...(await me(req.userId!)) });
    }),
  );

  // ---- MCP over HTTP (remote agents) — authenticated by a workspace agent token.
  app.all(
    "/mcp",
    wrap(async (req, res) => {
      const token = req.get("authorization")?.match(/^Bearer\s+(so_agent_\S+)$/)?.[1];
      if (!token || !(await getBackend().findWorkspaceByAgentToken(hashToken(token)))) {
        res.status(401).json({ error: "Send a workspace agent token: Authorization: Bearer so_agent_…" });
        return;
      }
      const server = createMcpServer(httpApi(`http://127.0.0.1:${opts.port}`, token));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    }),
  );

  // ---- Workspace-scoped API ---------------------------------------------------
  const api = Router();
  app.use("/api", requireWorkspace, api);

  api.get("/bootstrap", (req, res) => {
    const db = getDB();
    res.json({ catalog: MODEL_CATALOG, templates: SERVICE_TEMPLATES, policy: db.policy, providers: providerStatus(), workspaceId: req.studio!.workspaceId, role: req.studio!.role });
  });

  api.get("/stats", (_req, res) => res.json(firmStats()));

  api.get("/jobs", (_req, res) => res.json([...getDB().jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(jobSummary)));
  api.get("/jobs/:id", (req, res) => res.json(jobDetail(findJob(req.params.id))));

  api.post(
    "/jobs",
    wrap(async (req, res) => {
      const body = req.body ?? {};
      let rawBrief: string = body.rawBrief ?? "";
      if (!rawBrief.trim() && body.sourceUrl) rawBrief = await fetchListing(body.sourceUrl);
      const job = await createJob({ ...body, rawBrief, price: Number(body.price) });
      res.status(201).json(jobDetail(job));
    }),
  );

  api.post(
    "/jobs/:id/accept",
    wrap(async (req, res) => {
      const job = findJob(req.params.id);
      const cp = job.checkpoints.find((c) => c.kind === "accept-job" && c.status === "open");
      if (cp) await resolveCheckpoint(job, cp.id, "approved");
      else {
        assertAgentMay("accept-job");
        await acceptJob(job);
      }
      res.json(jobDetail(job));
    }),
  );

  api.post(
    "/jobs/:id/start",
    wrap(async (req, res) => {
      const job = findJob(req.params.id);
      const cp = job.checkpoints.find((c) => c.kind === "start-production" && c.status === "open");
      if (cp) await resolveCheckpoint(job, cp.id, "approved");
      else {
        assertAgentMay("start-production");
        await startProduction(job);
      }
      res.json(jobDetail(job));
    }),
  );

  api.post("/jobs/:id/route", (req, res) => {
    const job = findJob(req.params.id);
    overrideRoute(job, String(req.body.stepId), req.body.modelId ?? null);
    res.json(jobDetail(job));
  });

  api.post("/jobs/:id/price", (req, res) => {
    const job = findJob(req.params.id);
    setPrice(job, Number(req.body.price));
    res.json(jobDetail(job));
  });

  api.post(
    "/jobs/:id/checkpoints/:cpId",
    wrap(async (req, res) => {
      const job = findJob(req.params.id);
      await resolveCheckpoint(job, req.params.cpId, req.body.decision === "rejected" ? "rejected" : "approved", req.body.note);
      res.json(jobDetail(job));
    }),
  );

  api.post(
    "/jobs/:id/messages",
    wrap(async (req, res) => {
      const job = findJob(req.params.id);
      await receiveClientMessage(job, String(req.body.body ?? ""));
      res.json(jobDetail(job));
    }),
  );

  // ---- Policy (humans only) ----
  const humanAdmin = (req: Req) => {
    if (currentActor() === "agent") throw new HttpError(403, "Agents can read the autonomy policy but not change it.");
    requireRole(req, "owner", "admin");
  };

  api.get("/policy", (_req, res) => res.json(getDB().policy));

  api.put("/policy", (req, res) => {
    humanAdmin(req);
    const db = getDB();
    const next = { ...db.policy, ...req.body } as AutonomyPolicy;
    const nums: (keyof AutonomyPolicy)[] = ["maxSpendPerJob", "maxRepairSpendPerJob", "maxRepairCostPerAttempt", "maxAttemptsPerStep", "minGrossMargin", "autoStartBelowCost", "repairReservePct"];
    for (const k of nums) if (!(Number(next[k]) >= 0)) throw new HttpError(400, `${k} must be a non-negative number`);
    for (const k of nums) (next as unknown as Record<string, number>)[k] = Number(next[k]);
    // Platform ceiling on per-job spend, so one workspace can't run up the shared AI bill.
    const ceiling = Number(process.env.MAX_SPEND_PER_JOB_CEILING ?? 100);
    next.maxSpendPerJob = Math.min(next.maxSpendPerJob, ceiling);
    next.requireApproval = { ...next.requireApproval, finalDelivery: true };
    next.agentMayResolve = (next.agentMayResolve ?? []).filter((k) => CHECKPOINT_KINDS.includes(k) && k !== "final-delivery");
    db.policy = next;
    audit({ actor: "human", type: "policy", message: "Autonomy policy updated." });
    rerouteOpenJobs();
    save();
    res.json(db.policy);
  });

  api.post("/policy/reset", (req, res) => {
    humanAdmin(req);
    getDB().policy = structuredClone(DEFAULT_POLICY);
    audit({ actor: "human", type: "policy", message: "Autonomy policy reset to defaults." });
    rerouteOpenJobs();
    save();
    res.json(getDB().policy);
  });

  // ---- Clients & memory ----
  api.get("/clients", (_req, res) => res.json(getDB().clients));

  api.post("/clients", (req, res) => {
    const c: ClientMemory = { id: newId("cl"), name: "New client", contact: "", logo: "", colors: [], fonts: [], likes: [], rejectedStyles: [], approvedClaims: [], notes: "", ...req.body };
    c.id = newId("cl");
    getDB().clients.push(c);
    audit({ actor: "human", type: "memory", message: `Client added: ${c.name}` });
    res.status(201).json(c);
  });

  api.put("/clients/:id", (req, res) => {
    const c = findClient(req.params.id);
    if (!c) throw new HttpError(404, "Client not found");
    Object.assign(c, req.body, { id: c.id });
    audit({ actor: "human", type: "memory", message: `Client memory updated: ${c.name}` });
    save();
    res.json(c);
  });

  api.get("/lessons", (_req, res) => res.json([...getDB().lessons].reverse()));

  api.get("/audit", (req, res) => {
    const all = getDB().audit;
    const list = req.query.jobId ? all.filter((a) => a.jobId === req.query.jobId) : all;
    res.json(list.slice(-300).reverse());
  });

  // ---- Workspace settings ----
  api.get(
    "/workspace",
    wrap(async (req, res) => {
      const b = getBackend();
      const ws = await b.getWorkspace(req.studio!.workspaceId);
      const members = req.studio!.actor === "human" ? await b.listMembers(req.studio!.workspaceId) : [];
      res.json({ id: ws?.id, name: ws?.name, role: req.studio!.role, hasAgentToken: !!ws?.agentTokenHash, members, profile: getDB().profile });
    }),
  );

  api.put(
    "/workspace",
    wrap(async (req, res) => {
      requireRole(req, "owner", "admin");
      const name = String(req.body?.name ?? "").trim();
      if (name) await getBackend().updateWorkspace(req.studio!.workspaceId, { name: name.slice(0, 80) });
      res.json({ ok: true });
    }),
  );

  api.put("/profile", (req, res) => {
    if (currentActor() === "agent") throw new HttpError(403, "Agents cannot edit the firm profile.");
    const p = req.body as Partial<FirmProfile>;
    const list = (v: unknown) => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 30) : []);
    const db = getDB();
    db.profile = {
      firmName: String(p.firmName ?? db.profile.firmName).slice(0, 120),
      positioning: String(p.positioning ?? db.profile.positioning).slice(0, 2000),
      services: p.services ? list(p.services) : db.profile.services,
      proofPoints: p.proofPoints ? list(p.proofPoints) : db.profile.proofPoints,
      portfolio: p.portfolio ? list(p.portfolio) : db.profile.portfolio,
      signature: String(p.signature ?? db.profile.signature).slice(0, 500),
      tone: String(p.tone ?? db.profile.tone).slice(0, 200),
    };
    audit({ actor: "human", type: "memory", message: "Firm profile updated." });
    save();
    res.json(db.profile);
  });

  api.post(
    "/workspace/invites",
    wrap(async (req, res) => {
      requireRole(req, "owner", "admin");
      const role: Role = req.body?.role === "admin" ? "admin" : "member";
      const code = newInviteCode();
      await getBackend().createInvite({ code, workspaceId: req.studio!.workspaceId, role, createdAt: now(), expiresAt: new Date(Date.now() + 7 * 864e5).toISOString() });
      res.status(201).json({ code, role, expiresInDays: 7 });
    }),
  );

  api.delete(
    "/workspace/members/:userId",
    wrap(async (req, res) => {
      requireRole(req, "owner", "admin");
      const b = getBackend();
      const target = await b.getMembership(req.params.userId, req.studio!.workspaceId);
      if (!target) throw new HttpError(404, "Not a member");
      if (target.role === "owner") throw new HttpError(400, "The owner can't be removed");
      await b.removeMember(req.studio!.workspaceId, req.params.userId);
      res.json({ ok: true });
    }),
  );

  api.post(
    "/workspace/agent-token",
    wrap(async (req, res) => {
      requireRole(req, "owner", "admin");
      const token = newAgentToken();
      await getBackend().updateWorkspace(req.studio!.workspaceId, { agentTokenHash: hashToken(token) });
      audit({ actor: "human", type: "policy", message: "Agent (MCP) token created — any previous token was revoked." });
      res.status(201).json({ token });
    }),
  );

  api.delete(
    "/workspace/agent-token",
    wrap(async (req, res) => {
      requireRole(req, "owner", "admin");
      await getBackend().updateWorkspace(req.studio!.workspaceId, { agentTokenHash: "" });
      audit({ actor: "human", type: "policy", message: "Agent (MCP) token revoked." });
      res.json({ ok: true });
    }),
  );

  // ---- Job Radar ----
  api.get("/radar", (_req, res) => res.json(getDB().radar));

  api.post("/radar/searches", (req, res) => {
    const s = newSearch(req.body ?? {});
    getDB().radar.searches.push(s);
    save();
    res.status(201).json(s);
  });

  api.put("/radar/searches/:id", (req, res) => {
    const db = getDB();
    const i = db.radar.searches.findIndex((s) => s.id === req.params.id);
    if (i < 0) throw new HttpError(404, "Search not found");
    const old = db.radar.searches[i];
    db.radar.searches[i] = { ...newSearch({ ...old, ...req.body }), id: old.id, createdAt: old.createdAt, lastRunAt: old.lastRunAt, lastRunStatus: old.lastRunStatus };
    save();
    res.json(db.radar.searches[i]);
  });

  api.delete("/radar/searches/:id", (req, res) => {
    const db = getDB();
    db.radar.searches = db.radar.searches.filter((s) => s.id !== req.params.id);
    save();
    res.json({ ok: true });
  });

  api.post(
    "/radar/searches/:id/run",
    wrap(async (req, res) => {
      const s = getDB().radar.searches.find((x) => x.id === req.params.id);
      if (!s) throw new HttpError(404, "Search not found");
      const result = await runSearch(s);
      res.json({ ...result, radar: getDB().radar });
    }),
  );

  const findLead = (id: string): Lead => {
    const l = getDB().radar.leads.find((x) => x.id === id);
    if (!l) throw new HttpError(404, "Lead not found");
    return l;
  };

  api.post(
    "/radar/leads/:id/score",
    wrap(async (req, res) => {
      const l = findLead(req.params.id);
      l.fit = await scoreLead(l, getDB().policy);
      save();
      res.json(l);
    }),
  );

  api.post(
    "/radar/leads/:id/proposal",
    wrap(async (req, res) => {
      const l = findLead(req.params.id);
      await draftProposal(l);
      res.json(l);
    }),
  );

  api.put("/radar/leads/:id", (req, res) => {
    const l = findLead(req.params.id);
    const status = req.body?.status;
    if (status && ["new", "shortlisted", "dismissed", "applied", "won", "lost"].includes(status)) l.status = status;
    if (typeof req.body?.proposalText === "string" && l.proposal) {
      l.proposal.text = req.body.proposalText.slice(0, 10000);
      // Re-run the checks on the edited text.
      if (l.fit) l.proposal.checks = checkProposal(l.proposal.text, l, l.fit);
    }
    if (req.body?.proposalStatus && l.proposal && ["draft", "approved", "applied"].includes(req.body.proposalStatus)) l.proposal.status = req.body.proposalStatus;
    save();
    res.json(l);
  });

  api.post(
    "/radar/leads/:id/convert",
    wrap(async (req, res) => {
      const job = await convertLeadToJob(findLead(req.params.id));
      res.status(201).json(jobDetail(job));
    }),
  );

  // ---- Fallbacks ----
  api.use((_req, res) => res.status(404).json({ error: "Not found" }));

  // Production: serve the built client.
  const dist = path.resolve(process.cwd(), "dist");
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: "1h" }));
    app.use((req, res, next) => (req.method === "GET" && !req.path.startsWith("/api") ? res.sendFile(path.join(dist, "index.html")) : next()));
  }

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(err);
    if (!res.headersSent) res.status(status).json({ error: status >= 500 && process.env.NODE_ENV === "production" ? "Something went wrong" : err.message });
  });

  return app;
}

/** Best-effort listing import. Marketplaces often require login; then paste the brief. */
async function fetchListing(url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) throw new HttpError(400, "Listing URL must start with http(s)://");
  const host = new URL(url).hostname;
  // Don't let a workspace make the server fetch internal addresses.
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?|.*\.internal$|.*\.railway\.internal$)/i.test(host))
    throw new HttpError(400, "That address can't be fetched");
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 StudioOperator" }, signal: AbortSignal.timeout(8000), redirect: "follow" });
    if (!res.ok) throw new Error(String(res.status));
    const html = (await res.text()).slice(0, 2_000_000);
    const text = html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length < 80) throw new Error("page had no readable listing");
    return text.slice(0, 6000);
  } catch (err) {
    throw new HttpError(422, `Couldn't read that listing (${(err as Error).message}). Paste the brief text instead.`);
  }
}
