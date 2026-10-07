import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { copyToMarkdown } from "../shared/copy";
import { MODEL_CATALOG } from "../shared/catalog";
import { SERVICE_TEMPLATES } from "../shared/templates";
import type { Checkpoint, ClientMemory, Generation, Job } from "../shared/types";

// MCP server for Studio Operator. Lets an outside agent — Claude (Desktop,
// Code, claude.ai connectors) or Astra via any MCP-capable client — run the
// firm through the same HTTP API the UI uses. Every call is tagged as the
// "agent" actor, so the audit log shows what the agent did, and the autonomy
// policy decides which checkpoints an agent may resolve. Final delivery always
// stays with a human, and agents cannot edit the policy that limits them.

export type ApiCall = <T = unknown>(method: "GET" | "POST" | "PUT", path: string, body?: unknown) => Promise<T>;

/** Calls the Studio Operator HTTP API with a workspace agent token (always the "agent" actor). */
export function httpApi(baseUrl: string, token: string): ApiCall {
  return async (method, path, body) => {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
    return data as never;
  };
}

interface JobDetail {
  job: Job;
  economics: Record<string, unknown>;
  generations: Generation[];
  client?: ClientMemory;
  template: { name: string; rulebook: string[] };
}

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

const fail = (err: unknown) => ({ content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true });

/** Data URIs and raw HTML are noise for a model — keep only http(s) URLs. */
const url = (u?: string) => (u && /^https?:/.test(u) ? u : undefined);

function summarizeJob(d: JobDetail) {
  const { job } = d;
  const copyOf = (deliverableId: string) => {
    const del = job.deliverables.find((x) => x.id === deliverableId);
    const gens = d.generations.filter((g) => g.deliverableId === deliverableId && g.copy);
    const g = gens.find((x) => x.id === del?.outputIds.at(-1)) ?? gens.at(-1);
    return g?.copy && del ? copyToMarkdown(job.title, del.label, del.copy, g.copy) : undefined;
  };
  return {
    id: job.id,
    title: job.title,
    stage: job.stage,
    running: !!job.running,
    client: d.client?.name,
    channel: job.channel,
    template: d.template.name,
    price: job.price,
    deadline: job.deadline,
    economics: d.economics,
    brief: job.rawBrief,
    analysis: job.analysis && {
      summary: job.analysis.summary,
      recommendation: job.analysis.recommendation,
      reasoning: job.analysis.reasoning,
      missingInputs: job.analysis.missingInputs,
      risks: job.analysis.risks,
      clientQuestions: job.analysis.clientQuestions,
    },
    deliverables: job.deliverables.map((x) => ({
      id: x.id,
      label: x.label,
      kind: x.kind,
      quantity: x.quantity,
      status: x.status,
      spec: x.copy ?? { format: x.format, aspect: x.aspect, durationSec: x.durationSec },
      outputs: x.kind === "text" ? undefined : d.generations.filter((g) => x.outputIds.includes(g.id)).map((g) => url(g.outputUrl) ?? g.id),
      copyMarkdown: x.kind === "text" ? copyOf(x.id) : undefined,
    })),
    steps: job.steps.map((s) => ({ id: s.id, label: s.label, lane: s.lane, intent: s.intent, modelId: s.modelId, routedBy: s.routedBy, units: s.units, status: s.status, rationale: s.rationale })),
    openCheckpoints: job.checkpoints.filter((c) => c.status === "open").map((c) => ({ id: c.id, kind: c.kind, title: c.title, detail: c.detail })),
    lastQA: d.generations
      .filter((g) => g.qa)
      .slice(-3)
      .map((g) => ({ generationId: g.id, model: g.modelId, attempt: g.attempt, verdict: g.qa!.verdict, score: g.qa!.score, summary: g.qa!.summary })),
    messages: job.messages.slice(-6).map((m) => ({ direction: m.direction, status: m.status, classification: m.classification, body: m.body })),
  };
}

const CHANNEL = z.enum(["upwork", "fiverr", "contra", "direct"]);
const KINDS = ["accept-job", "client-questions", "start-production", "budget-limit", "scope-change", "final-delivery", "qa-escalation", "client-message"] as const;

export function createMcpServer(api: ApiCall): McpServer {
  const server = new McpServer(
    { name: "studio-operator", version: "0.2.0" },
    {
      instructions:
        "Studio Operator runs an AI-native creative service firm (images, video, cold email, ad copy, grant proposals). " +
        "Typical loop: firm_overview → get_job → act on open checkpoints (resolve_checkpoint) → read outputs (get_job / get_copy). " +
        "Prices and margins are computed by the system; never estimate them yourself. Some checkpoints are reserved for a human " +
        "(always final delivery); when a tool refuses, tell the user what needs their decision in the Studio Operator UI.",
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

  tool(
    "firm_overview",
    "Pipeline value, estimated gross profit, spend, and the jobs waiting on a decision. Start here.",
    {},
    async () => {
      const [stats, jobs] = await Promise.all([api("GET", "/stats"), api<{ id: string; title: string; stage: string; openCheckpoints: number; clientName: string; price: number }[]>("GET", "/jobs")]);
      return { stats, waiting: jobs.filter((j) => j.openCheckpoints > 0).map(({ id, title, stage, openCheckpoints, clientName }) => ({ id, title, stage, openCheckpoints, clientName })) };
    },
    true,
  );

  tool(
    "list_jobs",
    "List jobs with stage, client, price and expected margin. Optionally filter by stage.",
    { stage: z.enum(["intake", "review", "planned", "production", "qa", "approval", "revision", "delivered", "rejected"]).optional() },
    async ({ stage }) => {
      const jobs = await api<{ id: string; title: string; stage: string; clientName: string; templateName: string; price: number; openCheckpoints: number; economics: { expectedMargin: number } }[]>("GET", "/jobs");
      return jobs
        .filter((j) => !stage || j.stage === stage)
        .map((j) => ({ id: j.id, title: j.title, stage: j.stage, client: j.clientName, template: j.templateName, price: j.price, margin: Math.round(j.economics.expectedMargin * 1000) / 10, openCheckpoints: j.openCheckpoints }));
    },
    true,
  );

  tool(
    "get_job",
    "Full state of one job: Astra's brief analysis, deliverables (with finished copy as Markdown for text jobs), production route, economics, open checkpoints, recent QA and messages.",
    { jobId: z.string() },
    async ({ jobId }) => summarizeJob(await api<JobDetail>("GET", `/jobs/${jobId}`)),
    true,
  );

  tool(
    "get_copy",
    "The current copy for a text job (cold email sequence, ad copy, grant proposal) as Markdown, ready to review or paste.",
    { jobId: z.string() },
    async ({ jobId }) => {
      const s = summarizeJob(await api<JobDetail>("GET", `/jobs/${jobId}`));
      const md = s.deliverables.map((d) => d.copyMarkdown).filter(Boolean);
      return md.length ? md.join("\n\n---\n\n") : "This job has no written copy yet.";
    },
    true,
  );

  tool(
    "create_job",
    "Bring in a new job from a marketplace listing or direct lead. Astra analyses the brief, plans production and prices it. Returns the analysed job.",
    {
      brief: z.string().describe("The client's brief, pasted exactly as written"),
      channel: CHANNEL.default("direct"),
      price: z.number().nonnegative().describe("What the client pays, in USD"),
      title: z.string().optional(),
      clientId: z.string().optional().describe("Existing client id (see list_clients)"),
      newClientName: z.string().optional(),
      sourceUrl: z.string().optional(),
      referenceAssets: z.array(z.string()).optional(),
      clientNotes: z.string().optional(),
      productionBudget: z.number().nonnegative().optional().describe("Per-job spend cap; defaults to policy"),
    },
    async (a) => summarizeJob(await api<JobDetail>("POST", "/jobs", { ...a, rawBrief: a.brief })),
  );

  tool(
    "resolve_checkpoint",
    "Approve or reject an open human checkpoint on a job. The autonomy policy decides which kinds an agent may resolve; final delivery always needs a human.",
    { jobId: z.string(), checkpointId: z.string(), decision: z.enum(["approved", "rejected"]), note: z.string().optional().describe("Reason; on QA rejections this becomes revision feedback") },
    async ({ jobId, checkpointId, decision, note }) => summarizeJob(await api<JobDetail>("POST", `/jobs/${jobId}/checkpoints/${checkpointId}`, { decision, note })),
  );

  tool(
    "set_route",
    "Override the model for a pending production step (or pass modelId null to restore Astra's pick). Returns updated economics.",
    { jobId: z.string(), stepId: z.string(), modelId: z.string().nullable() },
    async ({ jobId, stepId, modelId }) => {
      const d = summarizeJob(await api<JobDetail>("POST", `/jobs/${jobId}/route`, { stepId, modelId }));
      return { economics: d.economics, steps: d.steps };
    },
  );

  tool(
    "log_client_message",
    "Record a message the client sent. Astra classifies it (routine revision, scope change, question, approval) and acts within policy.",
    { jobId: z.string(), body: z.string() },
    async ({ jobId, body }) => summarizeJob(await api<JobDetail>("POST", `/jobs/${jobId}/messages`, { body })),
  );

  tool(
    "list_templates",
    "Service templates the firm sells: deliverables, recipe, rulebook (definition of correct) and approval points.",
    {},
    async () => SERVICE_TEMPLATES.map((t) => ({ id: t.id, name: t.name, buyer: t.buyer, basePrice: t.basePrice, deliverables: t.deliverables, rulebook: t.rulebook })),
    true,
  );

  tool(
    "list_models",
    "Model catalog by production lane with list prices, strengths and watch-outs. Filter by lane or kind.",
    { lane: z.string().optional(), kind: z.enum(["image", "video", "audio", "text"]).optional() },
    async ({ lane, kind }) => MODEL_CATALOG.filter((m) => (!lane || m.lanes.includes(lane as never)) && (!kind || m.kind === kind)),
    true,
  );

  tool("list_clients", "Clients and their account memory (brand, likes, rejected styles, approved claims / verified facts).", {}, async () => api("GET", "/clients"), true);

  tool(
    "update_client_memory",
    "Add to a client's memory. List fields are appended (not replaced) so nothing a human recorded is lost.",
    {
      clientId: z.string(),
      likes: z.array(z.string()).optional(),
      rejectedStyles: z.array(z.string()).optional(),
      approvedClaims: z.array(z.string()).optional().describe("Claims or verified facts the client has confirmed"),
      notes: z.string().optional().describe("Appended to existing notes"),
    },
    async ({ clientId, likes, rejectedStyles, approvedClaims, notes }) => {
      const clients = await api<ClientMemory[]>("GET", "/clients");
      const c = clients.find((x) => x.id === clientId);
      if (!c) throw new Error(`Client ${clientId} not found`);
      const merge = (a: string[], b?: string[]) => [...new Set([...a, ...(b ?? [])])];
      return api("PUT", `/clients/${clientId}`, {
        ...c,
        likes: merge(c.likes, likes),
        rejectedStyles: merge(c.rejectedStyles, rejectedStyles),
        approvedClaims: merge(c.approvedClaims, approvedClaims),
        notes: notes ? `${c.notes}${c.notes ? "\n" : ""}${notes}` : c.notes,
      });
    },
  );

  tool(
    "get_policy",
    "The autonomy policy: spend and repair limits, blocked models, approval gates, and which checkpoint kinds an agent may resolve. Read-only for agents.",
    {},
    async () => api("GET", "/policy"),
    true,
  );

  tool("list_lessons", "What the firm has learned from delivered jobs: missing inputs, model repairs, realized margins.", {}, async () => api("GET", "/lessons"), true);

  server.registerPrompt(
    "triage",
    { description: "Work through everything waiting on a decision, within the autonomy policy." },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Use Studio Operator. Call firm_overview, then get_job for each job waiting on a decision. Resolve the checkpoints the policy lets you resolve, " +
              "with a one-line reason as the note. For anything reserved for a human, summarize what needs my decision and why. Never guess prices.",
          },
        },
      ],
    }),
  );

  return server;
}

export const AGENT_NEVER: Checkpoint["kind"][] = ["final-delivery"];
export const CHECKPOINT_KINDS = KINDS;
