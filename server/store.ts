import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AuditEntry, AutonomyPolicy, ClientMemory, FirmProfile, Generation, Job, Lesson, RadarState } from "../shared/types";
import { getBackend } from "./persist";

// Each workspace (tenant) has its own document: jobs, clients, generations,
// audit, lessons, policy, firm profile and radar. Documents are loaded into
// memory on first use and written back (debounced) to Postgres or disk.
//
// Every request and background task runs inside a context naming its
// workspace, so getDB() can only ever see the current tenant's data.

export interface DB {
  version: 2;
  jobs: Job[];
  clients: ClientMemory[];
  generations: Generation[];
  audit: AuditEntry[];
  lessons: Lesson[];
  policy: AutonomyPolicy;
  profile: FirmProfile;
  radar: RadarState;
}

export const DEFAULT_POLICY: AutonomyPolicy = {
  maxSpendPerJob: 10,
  maxRepairSpendPerJob: 2,
  maxRepairCostPerAttempt: 0.5,
  maxAttemptsPerStep: 3,
  minGrossMargin: 0.7,
  autoStartBelowCost: 2,
  blockedFamilies: [],
  blockedOrigins: [],
  clientMessages: "draft-only",
  requireApproval: { acceptJob: true, finalDelivery: true, scopeChange: true },
  channelFees: { upwork: 0.1, fiverr: 0.2, contra: 0, direct: 0 },
  repairReservePct: 0.25,
  agentMayResolve: ["client-questions", "accept-job", "start-production", "qa-escalation"],
};

export const DEFAULT_PROFILE: FirmProfile = {
  firmName: "",
  positioning: "",
  services: [],
  proofPoints: [],
  portfolio: [],
  signature: "",
  tone: "Warm, specific, confident — no fluff",
};

export const newId = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;
export const now = () => new Date().toISOString();

export function emptyDB(): DB {
  return {
    version: 2,
    jobs: [],
    clients: [],
    generations: [],
    audit: [],
    lessons: [],
    policy: structuredClone(DEFAULT_POLICY),
    profile: structuredClone(DEFAULT_PROFILE),
    radar: { searches: [], leads: [] },
  };
}

/** Upgrade older documents (including the single-tenant v1 file). */
export function normalizeDB(raw: Partial<DB> | undefined): DB {
  const base = emptyDB();
  if (!raw) return base;
  return {
    ...base,
    ...raw,
    version: 2,
    policy: { ...base.policy, ...(raw.policy ?? {}) },
    profile: { ...base.profile, ...(raw.profile ?? {}) },
    radar: { searches: raw.radar?.searches ?? [], leads: raw.radar?.leads ?? [] },
  };
}

// ---------------------------------------------------------------------------
// Request context

export interface Ctx {
  workspaceId: string;
  actor: "human" | "agent";
  userId?: string;
  /** Force free simulators (seeding, demos) regardless of configured keys. */
  simulate?: boolean;
}

const context = new AsyncLocalStorage<Ctx>();
export const runWith = <T,>(ctx: Ctx, fn: () => T) => context.run(ctx, fn);
export const currentCtx = () => context.getStore();
export const currentActor = () => context.getStore()?.actor ?? "human";
export const currentWorkspaceId = () => context.getStore()?.workspaceId;
export const isSimulatedContext = () => !!context.getStore()?.simulate;

// ---------------------------------------------------------------------------
// Tenant cache

interface Tenant {
  db: DB;
  timer?: NodeJS.Timeout;
  saving?: Promise<void>;
}

const tenants = new Map<string, Tenant>();
const loading = new Map<string, Promise<Tenant>>();
let memoryDB: DB | null = null; // tests

/** Load a workspace document into memory (call before runWith for that workspace). */
export async function ensureTenant(workspaceId: string): Promise<DB> {
  if (memoryDB) return memoryDB;
  const hit = tenants.get(workspaceId);
  if (hit) return hit.db;
  let p = loading.get(workspaceId);
  if (!p) {
    p = getBackend()
      .loadData(workspaceId)
      .then((raw) => {
        const t: Tenant = { db: normalizeDB(raw as Partial<DB> | undefined) };
        // Jobs that were mid-run when the process stopped need a human to restart them.
        for (const j of t.db.jobs) if (j.running) j.running = false;
        tenants.set(workspaceId, t);
        return t;
      })
      .finally(() => loading.delete(workspaceId));
    loading.set(workspaceId, p);
  }
  return (await p).db;
}

/** For tests: a single in-memory DB that every context resolves to. */
export function useMemoryDB(): DB {
  memoryDB = emptyDB();
  return memoryDB;
}

export function getDB(): DB {
  if (memoryDB) return memoryDB;
  const id = currentWorkspaceId();
  if (!id) throw new Error("No workspace in context");
  const t = tenants.get(id);
  if (!t) throw new Error(`Workspace ${id} is not loaded`);
  return t.db;
}

export function save() {
  if (memoryDB) return;
  const id = currentWorkspaceId();
  if (!id) return;
  const t = tenants.get(id);
  if (!t || t.timer) return;
  t.timer = setTimeout(() => {
    t.timer = undefined;
    t.saving = getBackend()
      .saveData(id, t.db)
      .catch((err) => console.error(`[store] failed to save workspace ${id}:`, err));
  }, 400);
}

/** Write every dirty workspace now (graceful shutdown). */
export async function flushAll() {
  await Promise.all(
    [...tenants.entries()].map(async ([id, t]) => {
      if (t.timer) {
        clearTimeout(t.timer);
        t.timer = undefined;
        await getBackend().saveData(id, t.db);
      }
      await t.saving;
    }),
  );
}

// ---------------------------------------------------------------------------

export function audit(entry: Omit<AuditEntry, "id" | "at">): AuditEntry {
  const actor = entry.actor === "human" && currentActor() === "agent" ? "agent" : entry.actor;
  const e: AuditEntry = { id: newId("log"), at: now(), ...entry, actor };
  const db = getDB();
  db.audit.push(e);
  // Keep the document bounded; the newest entries matter most.
  if (db.audit.length > 5000) db.audit.splice(0, db.audit.length - 5000);
  save();
  return e;
}

export function findJob(id: string): Job {
  const job = getDB().jobs.find((j) => j.id === id);
  if (!job) throw new HttpError(404, `Job ${id} not found`);
  return job;
}

export function findClient(id: string): ClientMemory | undefined {
  return getDB().clients.find((c) => c.id === id);
}

export function touch(job: Job) {
  job.updatedAt = now();
  save();
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
