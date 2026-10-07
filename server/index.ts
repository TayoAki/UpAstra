import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { MODEL_CATALOG } from "../shared/catalog";
import { SERVICE_TEMPLATES, getTemplate } from "../shared/templates";
import type { AutonomyPolicy, ClientMemory, Job, ProviderStatus } from "../shared/types";
import { astraMode, astraModel } from "./astra";
import { getProvider } from "./higgsfield";
import {
  acceptJob,
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
import { seed } from "./seed";
import { DEFAULT_POLICY, HttpError, audit, findClient, findJob, getDB, loadDB, newId, save } from "./store";

loadEnv();

const app = express();
app.use(express.json({ limit: "2mb" }));

const wrap =
  (fn: (req: Request<Record<string, string>>, res: Response) => unknown) =>
  (req: Request<Record<string, string>>, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

function jobSummary(job: Job) {
  const econ = jobEconomics(job);
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
    economics: econ,
    thumb,
    updatedAt: job.updatedAt,
    createdAt: job.createdAt,
  };
}

function jobDetail(job: Job) {
  const db = getDB();
  return {
    job,
    economics: jobEconomics(job),
    generations: jobGenerations(job.id),
    audit: db.audit.filter((a) => a.jobId === job.id),
    client: findClient(job.clientId),
    template: getTemplate(job.templateId),
  };
}

function providerStatus(): ProviderStatus {
  const p = getProvider();
  return { astra: { mode: astraMode(), model: astraModel() }, higgsfield: { mode: p.mode, baseUrl: p.baseUrl } };
}

app.get("/api/bootstrap", (_req, res) => {
  const db = getDB();
  res.json({ catalog: MODEL_CATALOG, templates: SERVICE_TEMPLATES, policy: db.policy, providers: providerStatus() });
});

app.get("/api/stats", (_req, res) => res.json(firmStats()));

app.get("/api/jobs", (_req, res) => {
  const jobs = [...getDB().jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  res.json(jobs.map(jobSummary));
});

app.get("/api/jobs/:id", (req, res) => res.json(jobDetail(findJob(req.params.id))));

app.post(
  "/api/jobs",
  wrap(async (req, res) => {
    const body = req.body ?? {};
    let rawBrief: string = body.rawBrief ?? "";
    if (!rawBrief.trim() && body.sourceUrl) rawBrief = await fetchListing(body.sourceUrl);
    const job = await createJob({ ...body, rawBrief, price: Number(body.price) });
    res.status(201).json(jobDetail(job));
  }),
);

app.post("/api/jobs/:id/accept", wrap(async (req, res) => {
  const job = findJob(req.params.id);
  const cp = job.checkpoints.find((c) => c.kind === "accept-job" && c.status === "open");
  if (cp) await resolveCheckpoint(job, cp.id, "approved");
  else await acceptJob(job);
  res.json(jobDetail(job));
}));

app.post("/api/jobs/:id/start", wrap(async (req, res) => {
  const job = findJob(req.params.id);
  const cp = job.checkpoints.find((c) => c.kind === "start-production" && c.status === "open");
  if (cp) await resolveCheckpoint(job, cp.id, "approved");
  else await startProduction(job);
  res.json(jobDetail(job));
}));

app.post("/api/jobs/:id/route", (req, res) => {
  const job = findJob(req.params.id);
  overrideRoute(job, String(req.body.stepId), req.body.modelId ?? null);
  res.json(jobDetail(job));
});

app.post("/api/jobs/:id/price", (req, res) => {
  const job = findJob(req.params.id);
  setPrice(job, Number(req.body.price));
  res.json(jobDetail(job));
});

app.post("/api/jobs/:id/checkpoints/:cpId", wrap(async (req, res) => {
  const job = findJob(req.params.id);
  const decision = req.body.decision === "rejected" ? "rejected" : "approved";
  await resolveCheckpoint(job, req.params.cpId, decision, req.body.note);
  res.json(jobDetail(job));
}));

app.post("/api/jobs/:id/messages", wrap(async (req, res) => {
  const job = findJob(req.params.id);
  await receiveClientMessage(job, String(req.body.body ?? ""));
  res.json(jobDetail(job));
}));

app.get("/api/policy", (_req, res) => res.json(getDB().policy));

app.put("/api/policy", (req, res) => {
  const db = getDB();
  const next = { ...db.policy, ...req.body } as AutonomyPolicy;
  const nums: (keyof AutonomyPolicy)[] = ["maxSpendPerJob", "maxRepairSpendPerJob", "maxRepairCostPerAttempt", "maxAttemptsPerStep", "minGrossMargin", "autoStartBelowCost", "repairReservePct"];
  for (const k of nums) if (!(Number(next[k]) >= 0)) throw new HttpError(400, `${k} must be a non-negative number`);
  for (const k of nums) (next as unknown as Record<string, number>)[k] = Number(next[k]);
  next.requireApproval = { ...next.requireApproval, finalDelivery: true };
  db.policy = next;
  audit({ actor: "human", type: "policy", message: "Autonomy policy updated." });
  rerouteOpenJobs();
  save();
  res.json(db.policy);
});

app.post("/api/policy/reset", (_req, res) => {
  getDB().policy = structuredClone(DEFAULT_POLICY);
  audit({ actor: "human", type: "policy", message: "Autonomy policy reset to defaults." });
  rerouteOpenJobs();
  save();
  res.json(getDB().policy);
});

app.get("/api/clients", (_req, res) => res.json(getDB().clients));

app.post("/api/clients", (req, res) => {
  const c: ClientMemory = { id: newId("cl"), name: "New client", contact: "", logo: "", colors: [], fonts: [], likes: [], rejectedStyles: [], approvedClaims: [], notes: "", ...req.body };
  getDB().clients.push(c);
  audit({ actor: "human", type: "memory", message: `Client added: ${c.name}` });
  res.status(201).json(c);
});

app.put("/api/clients/:id", (req, res) => {
  const c = findClient(req.params.id);
  if (!c) throw new HttpError(404, "Client not found");
  Object.assign(c, req.body, { id: c.id });
  audit({ actor: "human", type: "memory", message: `Client memory updated: ${c.name}` });
  save();
  res.json(c);
});

app.get("/api/lessons", (_req, res) => res.json([...getDB().lessons].reverse()));

app.get("/api/audit", (req, res) => {
  const all = getDB().audit;
  const list = req.query.jobId ? all.filter((a) => a.jobId === req.query.jobId) : all;
  res.json(list.slice(-300).reverse());
});

app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

// Production: serve the built client.
const dist = path.resolve(process.cwd(), "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.use((req, res, next) => (req.method === "GET" ? res.sendFile(path.join(dist, "index.html")) : next()));
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message });
});

/** Best-effort listing import. Marketplaces often require login; then paste the brief. */
async function fetchListing(url: string): Promise<string> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 StudioOperator" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(String(res.status));
    const html = await res.text();
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

function loadEnv() {
  const file = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2] !== "" && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const { fresh } = loadDB();
if (fresh && process.env.SEED !== "0") {
  console.log("Seeding demo firm…");
  await seed();
}
// Jobs that were mid-run when the server stopped need a human to restart them.
for (const job of getDB().jobs) if (job.running) job.running = false;

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  const p = providerStatus();
  console.log(`Studio Operator API on http://localhost:${port}  (Astra: ${p.astra.mode}, Higgsfield: ${p.higgsfield.mode})`);
});
