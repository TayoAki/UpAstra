import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AuditEntry, AutonomyPolicy, ClientMemory, Generation, Job, Lesson } from "../shared/types";

// A single JSON file is the firm's system of record: every job, generation,
// cost, decision and lesson. Small, inspectable, and easy to back up.

export interface DB {
  version: 1;
  jobs: Job[];
  clients: ClientMemory[];
  generations: Generation[];
  audit: AuditEntry[];
  lessons: Lesson[];
  policy: AutonomyPolicy;
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
};

const DATA_DIR = process.env.DATA_DIR ?? path.resolve(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

let db: DB | null = null;
let writeTimer: NodeJS.Timeout | null = null;

export const newId = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;
export const now = () => new Date().toISOString();

export function emptyDB(): DB {
  return { version: 1, jobs: [], clients: [], generations: [], audit: [], lessons: [], policy: structuredClone(DEFAULT_POLICY) };
}

export function loadDB(): { db: DB; fresh: boolean } {
  if (db) return { db, fresh: false };
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, "utf8")) as DB;
    db.policy = { ...structuredClone(DEFAULT_POLICY), ...db.policy };
    return { db, fresh: false };
  }
  db = emptyDB();
  return { db, fresh: true };
}

/** For tests: use an in-memory DB that is never written to disk. */
export function useMemoryDB(): DB {
  db = emptyDB();
  persistEnabled = false;
  return db;
}

let persistEnabled = true;

export function getDB(): DB {
  return loadDB().db;
}

export function save() {
  if (!persistEnabled) return;
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
    fs.renameSync(tmp, DB_FILE);
  }, 150);
}

export function audit(entry: Omit<AuditEntry, "id" | "at">): AuditEntry {
  const e: AuditEntry = { id: newId("log"), at: now(), ...entry };
  getDB().audit.push(e);
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
