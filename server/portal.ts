import { createHmac, timingSafeEqual } from "node:crypto";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import { copyToMarkdown } from "../shared/copy";
import { clientStatus } from "../shared/portal";
import { getTemplate } from "../shared/templates";
import type { ClientRequestView, FileRef, Job, PortalPublic, PortalQuestion, PortalUser } from "../shared/types";
import { hashPassword, throttle, clearThrottle, verifyPassword } from "./auth";
import { MAX_UPLOAD_BYTES, fileStore, keyBelongsTo, saveUpload } from "./files";
import { getBackend } from "./persist";
import { createJob, jobGenerations, receiveClientMessage } from "./pipeline";
import { HttpError, audit, ensureTenant, findJob, getDB, newId, now, runWith, save, touch } from "./store";

// The client portal: a public storefront per workspace where clients pick a
// package, answer a guided brief, upload files, and then follow their request
// through to delivery. Clients authenticate with a portal token (not the
// studio's session cookie), scoped to one workspace, and only ever see their
// own requests — never costs, margins, models, QA notes or internal drafts.

type Req = Request<Record<string, string>> & { portal?: { workspaceId: string; user?: PortalUser } };

const wrap =
  (fn: (req: Req, res: Response) => unknown) =>
  (req: Req, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_DAYS = 60;

const secret = () => process.env.SESSION_SECRET || "dev-portal-secret";
const sign = (p: string) => createHmac("sha256", `portal:${secret()}`).update(p).digest("base64url");

export function issuePortalToken(workspaceId: string, userId: string): string {
  const payload = Buffer.from(JSON.stringify({ w: workspaceId, u: userId, e: Date.now() + TOKEN_DAYS * 864e5 })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function readPortalToken(token: string | undefined): { w: string; u: string } | undefined {
  if (!token) return;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return;
  const expected = sign(payload);
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return;
  try {
    const t = JSON.parse(Buffer.from(payload, "base64url").toString());
    return t.e > Date.now() ? { w: t.w, u: t.u } : undefined;
  } catch {
    return;
  }
}

/** Resolve the portal's workspace from the URL slug, load it, and run the request in its context. */
async function resolvePortal(req: Req, _res: Response, next: NextFunction) {
  try {
    const ws = await getBackend().findWorkspaceByPortalSlug(String(req.params.slug ?? "").toLowerCase());
    if (!ws) throw new HttpError(404, "This portal doesn't exist");
    await ensureTenant(ws.id);
    runWith({ workspaceId: ws.id, actor: "human" }, () => {
      if (!getDB().portal.enabled) return next(new HttpError(404, "This portal isn't open right now"));
      req.portal = { workspaceId: ws.id };
      const t = readPortalToken(req.get("x-portal-token") ?? undefined);
      if (t && t.w === ws.id) req.portal.user = getDB().portalUsers.find((u) => u.id === t.u);
      next();
    });
  } catch (err) {
    next(err);
  }
}

function requireClient(req: Req): PortalUser {
  if (!req.portal?.user) throw new HttpError(401, "Sign in to continue");
  return req.portal.user;
}

function publicPortal(): PortalPublic {
  const db = getDB();
  const p = db.portal;
  return {
    slug: p.slug,
    studio: { name: db.profile.firmName || "Our studio", headline: p.headline, intro: p.intro, accentColor: p.accentColor, logoUrl: p.logoUrl },
    packages: p.packages.filter((x) => x.active).map(({ templateId: _t, active: _a, ...rest }) => rest),
  };
}

const publicUser = (u: PortalUser) => ({ id: u.id, email: u.email, name: u.name, company: u.company });

/** Turn guided-brief answers into a brief that reads naturally for intake. */
export function composeBrief(pkgName: string, templateId: string, answers: { questionId: string; label: string; value: string }[], fileNames: string[], addOns: string[]): string {
  const a = (id: string) => answers.find((x) => x.questionId === id)?.value?.trim() ?? "";
  const lines = [`Package: ${pkgName}.`];
  if (a("brief")) lines.push(a("brief"));
  // Phrase key answers the way a client would write them in a brief.
  switch (templateId) {
    case "cold-email-sequence":
      lines.push(`Need a ${a("emails") || "4"}-email cold outreach sequence${a("offer") ? ` for ${a("offer")}` : ""}${a("audience") ? `, targeting ${a("audience")}` : ""}.`);
      if (a("cta")) lines.push(`CTA is ${a("cta")}.`);
      if (a("proof")) lines.push(`Proof we can use: ${a("proof")}`);
      break;
    case "ad-copy-pack":
      lines.push(`Ad copy for ${a("platform") || "Meta"}${a("product") ? ` for ${a("product")}` : ""}${a("audience") ? `, aimed at ${a("audience")}` : ""}.`);
      break;
    case "grant-proposal":
      lines.push(`${/inquiry|loi/i.test(a("format")) ? "Letter of inquiry" : "Grant proposal"}${a("funder") ? ` to the ${a("funder").replace(/^the\s+/i, "")}` : ""}${a("amount") ? ` requesting ${a("amount")}` : ""}.`);
      if (a("data")) lines.push(a("data"));
      break;
    case "launch-video":
      lines.push(`A ${(a("length").match(/\d+/) ?? ["5"])[0]} second ${/9:16|vertical/i.test(a("format")) ? "9:16" : /1:1|square/i.test(a("format")) ? "1:1" : "16:9"} mp4 video.`);
      if (a("copy")) lines.push(`Text on video: "${a("copy")}"`);
      break;
    case "product-still-pack": {
      const ratio = a("placement").match(/\d+:\d+/)?.[0];
      lines.push(`Product images${ratio ? `, ${ratio}` : ""}, png.`);
      if (a("copy")) lines.push(`Text on image: "${a("copy")}"`);
      if (a("style")) lines.push(`Style: ${a("style")}`);
      break;
    }
  }
  for (const x of answers) {
    if (["brief", "emails", "offer", "audience", "cta", "proof", "platform", "product", "funder", "amount", "format", "data", "length", "copy", "placement", "style"].includes(x.questionId)) continue;
    if (x.value.trim()) lines.push(`${x.label}: ${x.value.trim()}`);
  }
  if (a("deadline")) lines.push(`Due ${/^(by|within|before)\b/i.test(a("deadline")) ? "" : "by "}${a("deadline")}.`);
  if (fileNames.length) lines.push(`Files attached: ${fileNames.join(", ")}.`);
  // Add-ons are applied structurally (extra units, rush) — keep their labels out of the brief
  // so intake doesn't read "+2 more images" as the requested quantity.
  void addOns;
  return lines.join("\n");
}

/** What the client sees for one of their requests. */
export function clientView(job: Job): ClientRequestView {
  const openQuestions = job.checkpoints.some((c) => c.kind === "client-questions" && c.status === "approved") && job.stage === "review";
  const { status, label } = clientStatus(job.stage, !!job.portal?.clientApprovedAt, openQuestions);
  // Work is visible to the client only after the studio approved delivery.
  const delivered = job.stage === "delivered";
  const gens = jobGenerations(job.id);
  return {
    id: job.id,
    title: job.title,
    packageName: job.portal?.packageName ?? getTemplate(job.templateId).name,
    price: job.price,
    status,
    statusLabel: label,
    submittedAt: job.portal?.submittedAt ?? job.createdAt,
    updatedAt: job.updatedAt,
    answers: job.portal?.answers ?? [],
    files: job.portal?.files ?? [],
    deliverables: delivered
      ? job.deliverables.map((d) => {
          const accepted = gens.filter((g) => d.outputIds.includes(g.id));
          return {
            label: d.label,
            kind: d.kind,
            items: accepted.map((g) => (g.copy ? { markdown: copyToMarkdown(job.title, d.label, d.copy, g.copy) } : { url: g.outputUrl })),
          };
        })
      : [],
    messages: job.messages
      .filter((m, i) => i > 0 && (m.direction === "inbound" || m.status === "sent"))
      .map((m) => ({ id: m.id, at: m.at, from: m.direction === "inbound" ? ("you" as const) : ("studio" as const), body: m.body })),
    canApprove: delivered && !job.portal?.clientApprovedAt,
    canRequestChanges: delivered || job.stage === "approval",
  };
}

function ownJob(req: Req): Job {
  const user = requireClient(req);
  const job = findJob(req.params.jobId);
  if (job.portal?.clientUserId !== user.id) throw new HttpError(404, "Request not found");
  return job;
}

function validateAnswers(questions: PortalQuestion[], raw: Record<string, unknown>, files: Record<string, FileRef[]>) {
  const answers: { questionId: string; label: string; value: string }[] = [];
  for (const q of questions) {
    if (q.type === "files") {
      const list = files[q.id] ?? [];
      if (q.required && !list.length) throw new HttpError(400, `Please upload: ${q.label}`);
      if (list.length) answers.push({ questionId: q.id, label: q.label, value: list.map((f) => f.name).join(", ") });
      continue;
    }
    const v = String(raw[q.id] ?? "").trim().slice(0, 5000);
    if (q.required && !v) throw new HttpError(400, `Please answer: ${q.label}`);
    if (q.type === "select" && v && q.options && !q.options.includes(v)) throw new HttpError(400, `Pick one of the options for: ${q.label}`);
    if (v) answers.push({ questionId: q.id, label: q.label, value: v });
  }
  return answers;
}

const requestsThisHour = new Map<string, number[]>();
function limitRequests(userId: string) {
  const nowMs = Date.now();
  const list = (requestsThisHour.get(userId) ?? []).filter((t) => nowMs - t < 3600e3);
  if (list.length >= Number(process.env.PORTAL_MAX_REQUESTS_PER_HOUR ?? 10)) throw new HttpError(429, "Too many requests — please try again later.");
  list.push(nowMs);
  requestsThisHour.set(userId, list);
}

// ---------------------------------------------------------------------------

export function portalRouter(): Router {
  const r = Router();

  /** Which portal does this host serve? (custom domains and *.PORTAL_BASE_DOMAIN subdomains) */
  r.get(
    "/_host",
    wrap(async (req, res) => {
      const slug = await slugForHost(req.hostname);
      if (!slug) throw new HttpError(404, "No portal on this domain");
      res.json({ slug });
    }),
  );

  const p = Router({ mergeParams: true });
  r.use("/:slug", resolvePortal as express.RequestHandler, p);

  p.get("/", (_req, res) => res.json(publicPortal()));

  p.post(
    "/auth/signup",
    wrap(async (req, res) => {
      const db = getDB();
      const email = String(req.body?.email ?? "").trim().toLowerCase();
      const password = String(req.body?.password ?? "");
      if (req.body?.website) throw new HttpError(400, "Invalid request"); // honeypot
      if (!EMAIL.test(email)) throw new HttpError(400, "Enter a valid email");
      if (password.length < 8) throw new HttpError(400, "Password must be at least 8 characters");
      throttle(`portal-signup:${req.ip}`);
      if (db.portalUsers.some((u) => u.email === email)) throw new HttpError(409, "You already have an account here — sign in instead");
      const name = String(req.body?.name ?? "").trim().slice(0, 80) || email.split("@")[0];
      const company = String(req.body?.company ?? "").trim().slice(0, 120);
      // Link to an existing client record with the same name, or start one.
      let client = company ? db.clients.find((c) => c.name.toLowerCase() === company.toLowerCase()) : undefined;
      if (!client) {
        client = { id: newId("cl"), name: company || name, contact: name, logo: "", colors: [], fonts: [], likes: [], rejectedStyles: [], approvedClaims: [], notes: `Portal client: ${email}` };
        db.clients.push(client);
      }
      const user: PortalUser = { id: newId("pu"), email, name, company, passwordHash: await hashPassword(password), clientId: client.id, createdAt: now() };
      db.portalUsers.push(user);
      audit({ actor: "system", type: "memory", message: `Portal client signed up: ${name} (${client.name})` });
      save();
      res.status(201).json({ token: issuePortalToken(req.portal!.workspaceId, user.id), user: publicUser(user) });
    }),
  );

  p.post(
    "/auth/login",
    wrap(async (req, res) => {
      const email = String(req.body?.email ?? "").trim().toLowerCase();
      const key = `portal-login:${req.portal!.workspaceId}:${req.ip}:${email}`;
      throttle(key);
      const user = getDB().portalUsers.find((u) => u.email === email);
      if (!user || !(await verifyPassword(String(req.body?.password ?? ""), user.passwordHash))) throw new HttpError(401, "Wrong email or password");
      clearThrottle(key);
      res.json({ token: issuePortalToken(req.portal!.workspaceId, user.id), user: publicUser(user) });
    }),
  );

  p.get("/me", (req, res) => {
    const user = requireClient(req);
    const requests = getDB()
      .jobs.filter((j) => j.portal?.clientUserId === user.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(clientView);
    res.json({ user: publicUser(user), requests });
  });

  p.post(
    "/uploads",
    express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
    wrap(async (req, res) => {
      requireClient(req);
      const name = decodeURIComponent(String(req.get("x-file-name") ?? "file"));
      const file = await saveUpload(req.portal!.workspaceId, name, String(req.get("content-type") ?? ""), req.body as Buffer);
      res.status(201).json(file);
    }),
  );

  p.post(
    "/requests",
    wrap(async (req, res) => {
      const user = requireClient(req);
      limitRequests(user.id);
      const db = getDB();
      const pkg = db.portal.packages.find((x) => x.id === req.body?.packageId && x.active);
      if (!pkg) throw new HttpError(400, "Pick a package");
      const addOns = pkg.addOns.filter((a) => (Array.isArray(req.body?.addOnIds) ? req.body.addOnIds : []).includes(a.id));
      // Uploaded files must belong to this workspace (keys are workspace-prefixed).
      const filesByQ: Record<string, FileRef[]> = {};
      for (const [qid, list] of Object.entries((req.body?.files ?? {}) as Record<string, FileRef[]>)) {
        filesByQ[qid] = (Array.isArray(list) ? list : []).filter((f) => f && typeof f.key === "string" && keyBelongsTo(f.key, req.portal!.workspaceId)).slice(0, 20);
      }
      const answers = validateAnswers(pkg.questions, (req.body?.answers ?? {}) as Record<string, unknown>, filesByQ);
      const files = Object.values(filesByQ).flat();
      const price = pkg.price + addOns.reduce((n, a) => n + a.price, 0);
      const title = String(req.body?.title ?? "").trim().slice(0, 80) || `${pkg.name} — ${user.company || user.name}`;

      // Claims the client gives us become approved claims in their memory.
      const client = db.clients.find((c) => c.id === user.clientId);
      const claims = answers.find((a) => a.questionId === "claims")?.value;
      if (client && claims) {
        for (const line of claims.split(/\n+/).map((s) => s.trim()).filter(Boolean)) if (!client.approvedClaims.includes(line)) client.approvedClaims.push(line);
      }

      const job = await createJob({
        title,
        channel: "portal",
        rawBrief: composeBrief(pkg.name, pkg.templateId, answers, files.map((f) => f.name), addOns.map((a) => a.label)),
        referenceAssets: files.map((f) => f.name),
        clientNotes: addOns.some((a) => a.kind === "rush") ? "RUSH: client paid for half turnaround." : "",
        clientId: user.clientId,
        price,
        templateId: pkg.templateId,
        extraUnits: addOns.filter((a) => a.kind === "extra-units").reduce((n, a) => n + (a.value ?? 0), 0),
        autoAccept: db.portal.autoAccept,
        portal: {
          packageId: pkg.id,
          packageName: pkg.name,
          addOnIds: addOns.map((a) => a.id),
          addOnLabels: addOns.map((a) => a.label),
          answers,
          files,
          clientUserId: user.id,
          submittedAt: now(),
        },
      });
      res.status(201).json(clientView(job));
    }),
  );

  p.get("/requests/:jobId", (req, res) => res.json(clientView(ownJob(req))));

  p.post(
    "/requests/:jobId/messages",
    wrap(async (req, res) => {
      const job = ownJob(req);
      const body = String(req.body?.body ?? "").trim().slice(0, 5000);
      if (!body) throw new HttpError(400, "Write a message first");
      if (["intake", "review", "planned"].includes(job.stage)) {
        // Before production, a reply is more brief — not a revision request.
        job.messages.push({ id: newId("msg"), at: now(), direction: "inbound", body, status: "received", classification: "question" });
        job.clientNotes = `${job.clientNotes}\n[Client, ${new Date().toISOString().slice(0, 10)}] ${body}`.trim();
        audit({ jobId: job.id, actor: "system", type: "message", message: "Client added details through the portal." });
        touch(job);
      } else {
        await receiveClientMessage(job, body);
      }
      res.json(clientView(job));
    }),
  );

  p.post("/requests/:jobId/approve", (req, res) => {
    const job = ownJob(req);
    if (job.stage !== "delivered") throw new HttpError(409, "There's nothing to approve yet");
    job.portal!.clientApprovedAt = now();
    audit({ jobId: job.id, actor: "system", type: "approval", message: "Client approved the delivered work in the portal." });
    touch(job);
    res.json(clientView(job));
  });

  p.get(
    "/files/*key",
    wrap(async (req, res) => {
      const user = requireClient(req);
      const raw = (req.params as unknown as { key: string | string[] }).key;
      const key = Array.isArray(raw) ? raw.join("/") : String(raw ?? "");
      if (!keyBelongsTo(key, req.portal!.workspaceId)) throw new HttpError(404, "File not found");
      const mine = getDB().jobs.some((j) => j.portal?.clientUserId === user.id && j.portal.files.some((f) => f.key === key));
      if (!mine) throw new HttpError(404, "File not found");
      const f = await fileStore().get(key);
      res.setHeader("Content-Type", f.type);
      res.setHeader("Content-Disposition", "attachment");
      res.send(f.body);
    }),
  );

  r.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  return r;
}

// ---------------------------------------------------------------------------
// Hosts: custom domains and subdomains of PORTAL_BASE_DOMAIN

export async function slugForHost(hostname: string): Promise<string | undefined> {
  const host = hostname.toLowerCase();
  const base = process.env.PORTAL_BASE_DOMAIN?.toLowerCase();
  if (base && host.endsWith(`.${base}`)) {
    const sub = host.slice(0, -(base.length + 1));
    if (!sub.includes(".")) return sub;
  }
  const ws = await getBackend().findWorkspaceByPortalDomain(host);
  return ws?.portalSlug;
}

/** Is this request for a portal host (not the studio app)? */
export async function isPortalHost(hostname: string): Promise<boolean> {
  const app = process.env.APP_URL ? new URL(process.env.APP_URL).hostname : "";
  if (!hostname || hostname === app || hostname === "localhost" || hostname === "127.0.0.1") return false;
  return !!(await slugForHost(hostname));
}

// ---------------------------------------------------------------------------
// Studio side: claim a unique public slug / custom domain for a workspace.

export async function claimSlug(workspaceId: string, desired: string): Promise<string> {
  const b = getBackend();
  const base = desired;
  for (let i = 0; i < 6; i++) {
    const candidate = i === 0 ? base : `${base.slice(0, 34)}-${Math.random().toString(36).slice(2, 6)}`;
    const taken = await b.findWorkspaceByPortalSlug(candidate);
    if (taken && taken.id !== workspaceId) continue;
    try {
      await b.updateWorkspace(workspaceId, { portalSlug: candidate });
      return candidate;
    } catch {
      /* raced with another workspace — try another */
    }
  }
  throw new HttpError(409, "Couldn't reserve a portal address — try another name");
}

/** Embed snippet: a floating "Request work" button that opens the portal in a modal. */
export function embedScript(appOrigin: string): string {
  return `(function(){
  var s=document.currentScript; if(!s) return;
  var slug=s.getAttribute("data-studio"); if(!slug) return;
  var label=s.getAttribute("data-label")||"Request work";
  var color=s.getAttribute("data-color")||"#111";
  var origin=${JSON.stringify(appOrigin)}||new URL(s.src).origin;
  var url=origin+"/p/"+encodeURIComponent(slug)+"?embed=1";
  var btn=document.createElement("button");
  btn.type="button"; btn.textContent=label;
  btn.setAttribute("style","position:fixed;right:20px;bottom:20px;z-index:2147483000;padding:12px 18px;border:0;border-radius:999px;background:"+color+";color:#fff;font:600 14px/1 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.2);cursor:pointer");
  var wrap=document.createElement("div");
  wrap.setAttribute("style","display:none;position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.45);align-items:center;justify-content:center;padding:16px");
  var frame=document.createElement("iframe");
  frame.title=label; frame.setAttribute("style","width:100%;max-width:880px;height:100%;max-height:820px;border:0;border-radius:14px;background:#fff");
  var close=document.createElement("button");
  close.type="button"; close.setAttribute("aria-label","Close"); close.textContent="\u00d7";
  close.setAttribute("style","position:absolute;top:12px;right:16px;width:36px;height:36px;border:0;border-radius:50%;background:#fff;font:400 22px/1 system-ui;cursor:pointer");
  wrap.appendChild(frame); wrap.appendChild(close);
  function open(){ if(!frame.src) frame.src=url; wrap.style.display="flex"; }
  function hide(){ wrap.style.display="none"; }
  btn.addEventListener("click",open); close.addEventListener("click",hide);
  wrap.addEventListener("click",function(e){ if(e.target===wrap) hide(); });
  document.addEventListener("keydown",function(e){ if(e.key==="Escape") hide(); });
  document.body.appendChild(btn); document.body.appendChild(wrap);
  window.StudioOperatorPortal={open:open,close:hide};
})();`;
}
