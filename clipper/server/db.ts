import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import type { Activity, WorkspaceDoc } from "../shared/types";

// Storage: users and workspaces in Postgres (DATABASE_URL) or JSON files.
// Each workspace's data is one document, cached in memory and written back
// (debounced). Every request runs inside a context naming its workspace, so
// getDoc() only ever sees the caller's own data.

export interface UserRow {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: string;
  emailVerifiedAt?: string;
  /** Sessions issued before this are rejected (set on password reset or change). */
  sessionsValidAfter?: string;
}

export interface WorkspaceRow {
  id: string;
  ownerId: string;
  name: string;
  createdAt: string;
  hasAgentKey?: boolean;
}

interface Backend {
  kind: "postgres" | "file";
  init(): Promise<void>;
  /** Throws if the store can't be reached. */
  ping(): Promise<void>;
  createUser(u: UserRow): Promise<void>;
  findUserByEmail(email: string): Promise<UserRow | undefined>;
  getUser(id: string): Promise<UserRow | undefined>;
  updateUser(id: string, patch: Partial<Pick<UserRow, "passwordHash" | "emailVerifiedAt" | "sessionsValidAfter" | "name">>): Promise<void>;
  deleteUser(id: string): Promise<void>;
  createWorkspace(w: WorkspaceRow, doc: WorkspaceDoc): Promise<void>;
  workspaceForOwner(userId: string): Promise<WorkspaceRow | undefined>;
  /** Agent (API / MCP) key: only its SHA-256 is stored. */
  setAgentKey(id: string, hash: string | null): Promise<void>;
  /** Global lookup for ids from outside services (e.g. an Outstand post id → its workspace). */
  linkExternal(kind: string, externalId: string, workspaceId: string): Promise<void>;
  workspaceForExternal(kind: string, externalId: string): Promise<string | undefined>;
  listExternal(kind: string, since: string): Promise<{ externalId: string; workspaceId: string }[]>;
  workspaceByAgentKey(hash: string): Promise<WorkspaceRow | undefined>;
  renameWorkspace(id: string, name: string): Promise<void>;
  deleteWorkspace(id: string): Promise<void>;
  loadDoc(id: string): Promise<WorkspaceDoc | undefined>;
  /** Workspaces with renders or caption jobs that were in progress (to resume them after a restart). */
  workspacesWithPendingWork(): Promise<string[]>;
  /** Every workspace with its owner's email and usage record (for the operator's usage view). */
  listWorkspaceUsage(): Promise<(WorkspaceRow & { email: string; usage?: WorkspaceDoc["usage"] })[]>;
  saveDoc(id: string, doc: WorkspaceDoc): Promise<void>;
}

class PgBackend implements Backend {
  kind = "postgres" as const;
  private pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 5, ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined });
  }
  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS co_users (
        id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
        password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS co_workspaces (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES co_users(id) ON DELETE CASCADE,
        name TEXT NOT NULL, data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE INDEX IF NOT EXISTS co_workspaces_owner ON co_workspaces(owner_id);
      ALTER TABLE co_workspaces ADD COLUMN IF NOT EXISTS agent_key_hash TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS co_workspaces_agent_key ON co_workspaces(agent_key_hash);
      CREATE TABLE IF NOT EXISTS co_external (
        kind TEXT NOT NULL, external_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES co_workspaces(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (kind, external_id));
      CREATE INDEX IF NOT EXISTS co_external_recent ON co_external(kind, created_at);
      ALTER TABLE co_users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
      ALTER TABLE co_users ADD COLUMN IF NOT EXISTS sessions_valid_after TIMESTAMPTZ;`);
  }
  async ping() {
    await this.pool.query("SELECT 1");
  }
  private user = (r: Record<string, unknown> | undefined): UserRow | undefined =>
    r && {
      id: r.id as string,
      email: r.email as string,
      name: r.name as string,
      passwordHash: r.password_hash as string,
      createdAt: new Date(r.created_at as string).toISOString(),
      emailVerifiedAt: r.email_verified_at ? new Date(r.email_verified_at as string).toISOString() : undefined,
      sessionsValidAfter: r.sessions_valid_after ? new Date(r.sessions_valid_after as string).toISOString() : undefined,
    };
  async createUser(u: UserRow) {
    await this.pool.query("INSERT INTO co_users (id, email, name, password_hash, created_at) VALUES ($1,$2,$3,$4,$5)", [u.id, u.email, u.name, u.passwordHash, u.createdAt]);
  }
  async findUserByEmail(email: string) {
    return this.user((await this.pool.query("SELECT * FROM co_users WHERE email=$1", [email])).rows[0]);
  }
  async getUser(id: string) {
    return this.user((await this.pool.query("SELECT * FROM co_users WHERE id=$1", [id])).rows[0]);
  }
  async deleteUser(id: string) {
    await this.pool.query("DELETE FROM co_users WHERE id=$1", [id]);
  }
  async updateUser(id: string, patch: Partial<Pick<UserRow, "passwordHash" | "emailVerifiedAt" | "sessionsValidAfter" | "name">>) {
    const cols: Record<string, string> = { passwordHash: "password_hash", emailVerifiedAt: "email_verified_at", sessionsValidAfter: "sessions_valid_after", name: "name" };
    const keys = Object.keys(patch).filter((k) => k in cols) as (keyof typeof patch)[];
    if (!keys.length) return;
    await this.pool.query(`UPDATE co_users SET ${keys.map((k, n) => `${cols[k]}=$${n + 2}`).join(", ")} WHERE id=$1`, [id, ...keys.map((k) => patch[k] ?? null)]);
  }
  async createWorkspace(w: WorkspaceRow, doc: WorkspaceDoc) {
    await this.pool.query("INSERT INTO co_workspaces (id, owner_id, name, data, created_at) VALUES ($1,$2,$3,$4,$5)", [w.id, w.ownerId, w.name, JSON.stringify(doc), w.createdAt]);
  }
  private ws = (r: Record<string, unknown> | undefined): WorkspaceRow | undefined =>
    r && { id: r.id as string, ownerId: r.owner_id as string, name: r.name as string, createdAt: new Date(r.created_at as string).toISOString(), hasAgentKey: !!r.agent_key_hash };
  async workspaceForOwner(userId: string) {
    return this.ws((await this.pool.query("SELECT id, owner_id, name, created_at, agent_key_hash FROM co_workspaces WHERE owner_id=$1 ORDER BY created_at LIMIT 1", [userId])).rows[0]);
  }
  async setAgentKey(id: string, hash: string | null) {
    await this.pool.query("UPDATE co_workspaces SET agent_key_hash=$2 WHERE id=$1", [id, hash]);
  }
  async linkExternal(kind: string, externalId: string, workspaceId: string) {
    await this.pool.query("INSERT INTO co_external (kind, external_id, workspace_id) VALUES ($1,$2,$3) ON CONFLICT (kind, external_id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id", [kind, externalId, workspaceId]);
  }
  async workspaceForExternal(kind: string, externalId: string) {
    return (await this.pool.query("SELECT workspace_id FROM co_external WHERE kind=$1 AND external_id=$2", [kind, externalId])).rows[0]?.workspace_id as string | undefined;
  }
  async listExternal(kind: string, since: string) {
    const rows = (await this.pool.query("SELECT external_id, workspace_id FROM co_external WHERE kind=$1 AND created_at >= $2 ORDER BY created_at DESC LIMIT 5000", [kind, since])).rows;
    return rows.map((r) => ({ externalId: r.external_id as string, workspaceId: r.workspace_id as string }));
  }
  async workspaceByAgentKey(hash: string) {
    return this.ws((await this.pool.query("SELECT id, owner_id, name, created_at, agent_key_hash FROM co_workspaces WHERE agent_key_hash=$1", [hash])).rows[0]);
  }
  async renameWorkspace(id: string, name: string) {
    await this.pool.query("UPDATE co_workspaces SET name=$2 WHERE id=$1", [id, name]);
  }
  async deleteWorkspace(id: string) {
    await this.pool.query("DELETE FROM co_workspaces WHERE id=$1", [id]);
  }
  async workspacesWithPendingWork() {
    const rows = (
      await this.pool.query(
        `SELECT id FROM co_workspaces WHERE jsonb_path_exists(data, '$.clips[*].render.status ? (@ == "queued" || @ == "analyzing" || @ == "voicing" || @ == "rendering")')
           OR jsonb_path_exists(data, '$.captionJobs[*].status ? (@ == "transcribing" || @ == "rendering")')
           OR jsonb_path_exists(data, '$.formats[*].status ? (@ == "analyzing")')`,
      )
    ).rows;
    return rows.map((r) => r.id as string);
  }
  async listWorkspaceUsage() {
    const rows = (await this.pool.query("SELECT w.id, w.owner_id, w.name, w.created_at, u.email, w.data->'usage' AS usage FROM co_workspaces w JOIN co_users u ON u.id = w.owner_id ORDER BY w.created_at")).rows;
    return rows.map((r) => ({ ...this.ws(r)!, email: r.email as string, usage: (r.usage ?? undefined) as WorkspaceDoc["usage"] }));
  }
  async loadDoc(id: string) {
    return (await this.pool.query("SELECT data FROM co_workspaces WHERE id=$1", [id])).rows[0]?.data as WorkspaceDoc | undefined;
  }
  async saveDoc(id: string, doc: WorkspaceDoc) {
    await this.pool.query("UPDATE co_workspaces SET data=$2, updated_at=now() WHERE id=$1", [id, JSON.stringify(doc)]);
  }
}

/** JSON files on disk (dev), or nothing at all (tests: dir = null). */
class FileBackend implements Backend {
  kind = "file" as const;
  private users: UserRow[] = [];
  private workspaces: (WorkspaceRow & { agentKeyHash?: string })[] = [];
  private external: { kind: string; externalId: string; workspaceId: string; createdAt: string }[] = [];
  private docs = new Map<string, WorkspaceDoc>();
  constructor(private dir: string | null) {}
  private get platformFile() {
    return this.dir && path.join(this.dir, "platform.json");
  }
  private persist() {
    if (!this.dir) return;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.platformFile!, JSON.stringify({ users: this.users, workspaces: this.workspaces, external: this.external }, null, 1));
  }
  async ping() {}
  async init() {
    if (this.dir && fs.existsSync(this.platformFile!)) Object.assign(this, JSON.parse(fs.readFileSync(this.platformFile!, "utf8")));
  }
  async createUser(u: UserRow) {
    this.users.push(u);
    this.persist();
  }
  async findUserByEmail(email: string) {
    return this.users.find((u) => u.email === email);
  }
  async getUser(id: string) {
    return this.users.find((u) => u.id === id);
  }
  async updateUser(id: string, patch: Partial<Pick<UserRow, "passwordHash" | "emailVerifiedAt" | "sessionsValidAfter" | "name">>) {
    const u = this.users.find((x) => x.id === id);
    if (u) Object.assign(u, patch);
    this.persist();
  }
  async deleteUser(id: string) {
    for (const w of this.workspaces.filter((x) => x.ownerId === id)) await this.deleteWorkspace(w.id);
    this.users = this.users.filter((u) => u.id !== id);
    this.persist();
  }
  async createWorkspace(w: WorkspaceRow, doc: WorkspaceDoc) {
    this.workspaces.push(w);
    this.persist();
    await this.saveDoc(w.id, doc);
  }
  private row = (w?: WorkspaceRow & { agentKeyHash?: string }): WorkspaceRow | undefined => {
    if (!w) return;
    const { agentKeyHash, ...rest } = w;
    return { ...rest, hasAgentKey: !!agentKeyHash };
  };
  async workspaceForOwner(userId: string) {
    return this.row(this.workspaces.find((w) => w.ownerId === userId));
  }
  async setAgentKey(id: string, hash: string | null) {
    const w = this.workspaces.find((x) => x.id === id);
    if (w) w.agentKeyHash = hash ?? undefined;
    this.persist();
  }
  async workspaceByAgentKey(hash: string) {
    return this.row(this.workspaces.find((w) => w.agentKeyHash === hash));
  }
  async linkExternal(kind: string, externalId: string, workspaceId: string) {
    this.external = [...this.external.filter((e) => !(e.kind === kind && e.externalId === externalId)), { kind, externalId, workspaceId, createdAt: new Date().toISOString() }];
    this.persist();
  }
  async workspaceForExternal(kind: string, externalId: string) {
    return this.external.find((e) => e.kind === kind && e.externalId === externalId)?.workspaceId;
  }
  async listExternal(kind: string, since: string) {
    return this.external.filter((e) => e.kind === kind && e.createdAt >= since).map(({ externalId, workspaceId }) => ({ externalId, workspaceId }));
  }
  async renameWorkspace(id: string, name: string) {
    const w = this.workspaces.find((x) => x.id === id);
    if (w) w.name = name;
    this.persist();
  }
  async deleteWorkspace(id: string) {
    this.workspaces = this.workspaces.filter((w) => w.id !== id);
    this.external = this.external.filter((e) => e.workspaceId !== id);
    this.docs.delete(id);
    if (this.dir) fs.rmSync(path.join(this.dir, "workspaces", `${id}.json`), { force: true });
    this.persist();
  }
  async workspacesWithPendingWork() {
    const ids: string[] = [];
    for (const w of this.workspaces) {
      const d = await this.loadDoc(w.id);
      if (d?.clips.some((c) => c.render && !["done", "failed"].includes(c.render.status)) || d?.captionJobs?.some((j) => j.status === "transcribing" || j.status === "rendering") || d?.formats?.some((f) => f.status === "analyzing")) ids.push(w.id);
    }
    return ids;
  }
  async listWorkspaceUsage() {
    return Promise.all(
      this.workspaces.map(async (w) => ({ ...this.row(w)!, email: this.users.find((u) => u.id === w.ownerId)?.email ?? "", usage: (await this.loadDoc(w.id))?.usage })),
    );
  }
  async loadDoc(id: string) {
    if (this.docs.has(id)) return structuredClone(this.docs.get(id));
    const f = this.dir && path.join(this.dir, "workspaces", `${id}.json`);
    return f && fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as WorkspaceDoc) : undefined;
  }
  async saveDoc(id: string, doc: WorkspaceDoc) {
    if (!this.dir) return void this.docs.set(id, structuredClone(doc));
    fs.mkdirSync(path.join(this.dir, "workspaces"), { recursive: true });
    fs.writeFileSync(path.join(this.dir, "workspaces", `${id}.json`), JSON.stringify(doc));
  }
}

let backend: Backend | null = null;
export function getBackend(): Backend {
  if (!backend) {
    backend = process.env.DATABASE_URL
      ? new PgBackend(process.env.DATABASE_URL)
      : new FileBackend(process.env.DATA_DIR ?? path.resolve(process.cwd(), "data"));
  }
  return backend;
}
/** Tests: a fresh in-memory store. */
export function useMemoryBackend() {
  backend = new FileBackend(null);
  tenants.clear();
}

// ---------------------------------------------------------------------------
// Workspace documents

export const newId = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;
export const now = () => new Date().toISOString();

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const emptyDoc = (): WorkspaceDoc => ({ version: 1, campaigns: [], clips: [], posts: [], accounts: [], activity: [] });

interface Tenant {
  doc: WorkspaceDoc;
  timer?: NodeJS.Timeout;
}
const tenants = new Map<string, Tenant>();
const ctx = new AsyncLocalStorage<{ workspaceId: string; userId?: string; actor?: "human" | "agent" }>();

export const runInWorkspace = <T,>(workspaceId: string, userId: string | undefined, fn: () => T, actor?: "human" | "agent") => ctx.run({ workspaceId, userId, actor }, fn);
export const currentWorkspaceId = () => ctx.getStore()?.workspaceId;

// One load per workspace at a time: two requests arriving together must share
// the same in-memory document, or one's changes would overwrite the other's.
const loading = new Map<string, Promise<void>>();
export async function loadTenant(workspaceId: string) {
  if (tenants.has(workspaceId)) return;
  const inflight = loading.get(workspaceId);
  if (inflight) return inflight;
  const p = (async () => {
    const doc = await getBackend().loadDoc(workspaceId);
    if (!doc) throw new HttpError(404, "Workspace not found");
    const full = { ...emptyDoc(), ...doc };
    for (const hook of tenantLoadHooks) hook(workspaceId, full);
    tenants.set(workspaceId, { doc: full });
  })().finally(() => loading.delete(workspaceId));
  loading.set(workspaceId, p);
  return p;
}

/** Run when a workspace document is loaded into memory (e.g. to fix up work interrupted by a restart). */
export const tenantLoadHooks: ((workspaceId: string, doc: WorkspaceDoc) => void)[] = [];

export function getDoc(): WorkspaceDoc {
  const id = currentWorkspaceId();
  if (!id) throw new Error("getDoc() called outside a workspace context");
  const t = tenants.get(id);
  if (!t) throw new Error(`Workspace ${id} is not loaded`);
  return t.doc;
}

export function save() {
  const id = currentWorkspaceId();
  const t = id ? tenants.get(id) : undefined;
  if (!id || !t) return;
  clearTimeout(t.timer);
  t.timer = setTimeout(() => {
    t.timer = undefined;
    getBackend()
      .saveDoc(id, t.doc)
      .catch((e) => console.error(`[db] save ${id} failed:`, e));
  }, 300);
}

export async function flushAll() {
  await Promise.all(
    [...tenants].map(async ([id, t]) => {
      if (!t.timer) return;
      clearTimeout(t.timer);
      t.timer = undefined;
      await getBackend().saveDoc(id, t.doc);
    }),
  );
}

/** A workspace document if it's loaded in memory (fresher than the saved copy). */
export const loadedDoc = (id: string) => tenants.get(id)?.doc;

export function forgetTenant(id: string) {
  const t = tenants.get(id);
  if (t) clearTimeout(t.timer);
  tenants.delete(id);
}

export function log(entry: Omit<Activity, "id" | "at">) {
  const doc = getDoc();
  doc.activity.unshift({ id: newId("act"), at: now(), ...(ctx.getStore()?.actor === "agent" ? { actor: "agent" as const } : {}), ...entry });
  doc.activity.length = Math.min(doc.activity.length, 300);
}
