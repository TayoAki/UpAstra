import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import type { Role } from "../shared/types";

// Platform persistence: users, workspaces, memberships, invites, and each
// workspace's document (jobs, clients, generations, audit, lessons, policy,
// radar). Postgres when DATABASE_URL is set (Railway), JSON files otherwise.

export interface UserRow {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: string;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  createdAt: string;
  /** sha256 of the workspace's agent (MCP/API) token. */
  agentTokenHash?: string;
}

export interface MembershipRow {
  userId: string;
  workspaceId: string;
  role: Role;
}

export interface InviteRow {
  code: string;
  workspaceId: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
}

export interface Backend {
  kind: "postgres" | "file";
  init(): Promise<void>;
  createUser(u: UserRow): Promise<void>;
  findUserByEmail(email: string): Promise<UserRow | undefined>;
  getUser(id: string): Promise<UserRow | undefined>;
  createWorkspace(w: WorkspaceRow, data: unknown): Promise<void>;
  getWorkspace(id: string): Promise<WorkspaceRow | undefined>;
  updateWorkspace(id: string, patch: Partial<Omit<WorkspaceRow, "id">>): Promise<void>;
  findWorkspaceByAgentToken(hash: string): Promise<WorkspaceRow | undefined>;
  listAllWorkspaceIds(): Promise<string[]>;
  addMember(m: MembershipRow): Promise<void>;
  removeMember(workspaceId: string, userId: string): Promise<void>;
  getMembership(userId: string, workspaceId: string): Promise<MembershipRow | undefined>;
  listWorkspacesForUser(userId: string): Promise<(WorkspaceRow & { role: Role })[]>;
  listMembers(workspaceId: string): Promise<(MembershipRow & { email: string; name: string })[]>;
  createInvite(i: InviteRow): Promise<void>;
  takeInvite(code: string): Promise<InviteRow | undefined>;
  loadData(workspaceId: string): Promise<unknown | undefined>;
  saveData(workspaceId: string, data: unknown): Promise<void>;
}

// ---------------------------------------------------------------------------

class PgBackend implements Backend {
  kind = "postgres" as const;
  private pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({
      connectionString: url,
      max: 10,
      // Railway's internal network doesn't use TLS; public proxies do.
      ssl: /sslmode=require|proxy\.rlwy\.net/.test(url) ? { rejectUnauthorized: false } : undefined,
    });
  }
  private q = <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => this.pool.query<T>(sql, params);

  /** Tests only: wipe all platform data. */
  async reset() {
    await this.q(`TRUNCATE invites, memberships, workspaces, users CASCADE`);
  }

  async init() {
    await this.q(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
        password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, agent_token_hash TEXT UNIQUE,
        data JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS memberships (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        role TEXT NOT NULL, PRIMARY KEY (user_id, workspace_id));
      CREATE TABLE IF NOT EXISTS invites (
        code TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        role TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL);
    `);
  }

  private user = (r: Record<string, unknown>): UserRow => ({
    id: String(r.id),
    email: String(r.email),
    name: String(r.name),
    passwordHash: String(r.password_hash),
    createdAt: new Date(r.created_at as string).toISOString(),
  });
  private ws = (r: Record<string, unknown>): WorkspaceRow => ({
    id: String(r.id),
    name: String(r.name),
    agentTokenHash: (r.agent_token_hash as string) ?? undefined,
    createdAt: new Date(r.created_at as string).toISOString(),
  });

  async createUser(u: UserRow) {
    await this.q(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)`, [u.id, u.email, u.name, u.passwordHash]);
  }
  async findUserByEmail(email: string) {
    const r = await this.q(`SELECT * FROM users WHERE email = $1`, [email]);
    return r.rows[0] && this.user(r.rows[0]);
  }
  async getUser(id: string) {
    const r = await this.q(`SELECT * FROM users WHERE id = $1`, [id]);
    return r.rows[0] && this.user(r.rows[0]);
  }
  async createWorkspace(w: WorkspaceRow, data: unknown) {
    await this.q(`INSERT INTO workspaces (id, name, data) VALUES ($1, $2, $3)`, [w.id, w.name, JSON.stringify(data)]);
  }
  async getWorkspace(id: string) {
    const r = await this.q(`SELECT id, name, agent_token_hash, created_at FROM workspaces WHERE id = $1`, [id]);
    return r.rows[0] && this.ws(r.rows[0]);
  }
  async updateWorkspace(id: string, patch: Partial<Omit<WorkspaceRow, "id">>) {
    if (patch.name !== undefined) await this.q(`UPDATE workspaces SET name = $2 WHERE id = $1`, [id, patch.name]);
    if (patch.agentTokenHash !== undefined) await this.q(`UPDATE workspaces SET agent_token_hash = $2 WHERE id = $1`, [id, patch.agentTokenHash || null]);
  }
  async findWorkspaceByAgentToken(hash: string) {
    const r = await this.q(`SELECT id, name, agent_token_hash, created_at FROM workspaces WHERE agent_token_hash = $1`, [hash]);
    return r.rows[0] && this.ws(r.rows[0]);
  }
  async listAllWorkspaceIds() {
    return (await this.q<{ id: string }>(`SELECT id FROM workspaces`)).rows.map((r) => r.id);
  }
  async addMember(m: MembershipRow) {
    await this.q(`INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, $3) ON CONFLICT (user_id, workspace_id) DO UPDATE SET role = $3`, [m.userId, m.workspaceId, m.role]);
  }
  async removeMember(workspaceId: string, userId: string) {
    await this.q(`DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, userId]);
  }
  async getMembership(userId: string, workspaceId: string) {
    const r = await this.q(`SELECT * FROM memberships WHERE user_id = $1 AND workspace_id = $2`, [userId, workspaceId]);
    const m = r.rows[0];
    return m && { userId: String(m.user_id), workspaceId: String(m.workspace_id), role: m.role as Role };
  }
  async listWorkspacesForUser(userId: string) {
    const r = await this.q(
      `SELECT w.id, w.name, w.agent_token_hash, w.created_at, m.role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id WHERE m.user_id = $1 ORDER BY w.created_at`,
      [userId],
    );
    return r.rows.map((row) => ({ ...this.ws(row), role: row.role as Role }));
  }
  async listMembers(workspaceId: string) {
    const r = await this.q(`SELECT m.*, u.email, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY u.email`, [workspaceId]);
    return r.rows.map((m) => ({ userId: String(m.user_id), workspaceId, role: m.role as Role, email: String(m.email), name: String(m.name) }));
  }
  async createInvite(i: InviteRow) {
    await this.q(`INSERT INTO invites (code, workspace_id, role, expires_at) VALUES ($1, $2, $3, $4)`, [i.code, i.workspaceId, i.role, i.expiresAt]);
  }
  async takeInvite(code: string) {
    const r = await this.q(`DELETE FROM invites WHERE code = $1 AND expires_at > now() RETURNING *`, [code]);
    const i = r.rows[0];
    return i && { code: String(i.code), workspaceId: String(i.workspace_id), role: i.role as Role, createdAt: String(i.created_at), expiresAt: String(i.expires_at) };
  }
  async loadData(workspaceId: string) {
    const r = await this.q(`SELECT data FROM workspaces WHERE id = $1`, [workspaceId]);
    return r.rows[0]?.data;
  }
  async saveData(workspaceId: string, data: unknown) {
    await this.q(`UPDATE workspaces SET data = $2, updated_at = now() WHERE id = $1`, [workspaceId, JSON.stringify(data)]);
  }
}

// ---------------------------------------------------------------------------

interface PlatformFile {
  users: UserRow[];
  workspaces: WorkspaceRow[];
  memberships: MembershipRow[];
  invites: InviteRow[];
}

class FileBackend implements Backend {
  kind = "file" as const;
  private dir: string;
  private file: string;
  private p: PlatformFile = { users: [], workspaces: [], memberships: [], invites: [] };
  constructor(dir: string) {
    this.dir = dir;
    this.file = path.join(dir, "platform.json");
  }
  private write() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.p, null, 1));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
  private wsFile = (id: string) => path.join(this.dir, "workspaces", `${id.replace(/[^\w-]/g, "")}.json`);

  async init() {
    if (fs.existsSync(this.file)) this.p = JSON.parse(fs.readFileSync(this.file, "utf8"));
  }
  async createUser(u: UserRow) {
    if (this.p.users.some((x) => x.email === u.email)) throw new Error("duplicate email");
    this.p.users.push(u);
    this.write();
  }
  async findUserByEmail(email: string) {
    return this.p.users.find((u) => u.email === email);
  }
  async getUser(id: string) {
    return this.p.users.find((u) => u.id === id);
  }
  async createWorkspace(w: WorkspaceRow, data: unknown) {
    this.p.workspaces.push(w);
    this.write();
    await this.saveData(w.id, data);
  }
  async getWorkspace(id: string) {
    return this.p.workspaces.find((w) => w.id === id);
  }
  async updateWorkspace(id: string, patch: Partial<Omit<WorkspaceRow, "id">>) {
    const w = this.p.workspaces.find((x) => x.id === id);
    if (w) Object.assign(w, patch);
    this.write();
  }
  async findWorkspaceByAgentToken(hash: string) {
    return this.p.workspaces.find((w) => w.agentTokenHash && w.agentTokenHash === hash);
  }
  async listAllWorkspaceIds() {
    return this.p.workspaces.map((w) => w.id);
  }
  async addMember(m: MembershipRow) {
    this.p.memberships = this.p.memberships.filter((x) => !(x.userId === m.userId && x.workspaceId === m.workspaceId));
    this.p.memberships.push(m);
    this.write();
  }
  async removeMember(workspaceId: string, userId: string) {
    this.p.memberships = this.p.memberships.filter((x) => !(x.userId === userId && x.workspaceId === workspaceId));
    this.write();
  }
  async getMembership(userId: string, workspaceId: string) {
    return this.p.memberships.find((m) => m.userId === userId && m.workspaceId === workspaceId);
  }
  async listWorkspacesForUser(userId: string) {
    return this.p.memberships
      .filter((m) => m.userId === userId)
      .map((m) => ({ ...this.p.workspaces.find((w) => w.id === m.workspaceId)!, role: m.role }))
      .filter((w) => w.id);
  }
  async listMembers(workspaceId: string) {
    return this.p.memberships
      .filter((m) => m.workspaceId === workspaceId)
      .map((m) => {
        const u = this.p.users.find((x) => x.id === m.userId)!;
        return { ...m, email: u?.email ?? "", name: u?.name ?? "" };
      });
  }
  async createInvite(i: InviteRow) {
    this.p.invites.push(i);
    this.write();
  }
  async takeInvite(code: string) {
    const i = this.p.invites.find((x) => x.code === code && x.expiresAt > new Date().toISOString());
    this.p.invites = this.p.invites.filter((x) => x.code !== code);
    this.write();
    return i;
  }
  async loadData(workspaceId: string) {
    const f = this.wsFile(workspaceId);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : undefined;
  }
  async saveData(workspaceId: string, data: unknown) {
    const f = this.wsFile(workspaceId);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(data));
    fs.renameSync(`${f}.tmp`, f);
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

/** Tests: a file backend in a temp dir. */
export function setBackend(b: Backend | null) {
  backend = b;
}
export const fileBackend = (dir: string) => new FileBackend(dir);
export const pgBackend = (url: string) => new PgBackend(url);
