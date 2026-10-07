import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import type { Role } from "../shared/types";
import { getBackend, type UserRow } from "./persist";
import { HttpError, ensureTenant, runWith } from "./store";

// Accounts, sessions and workspace access.
// - Humans sign in with email + password and get an HttpOnly signed cookie.
// - Agents (MCP clients: Claude, Astra, …) use a per-workspace bearer token.
// Every tenant-scoped request resolves to exactly one workspace the caller
// belongs to, and runs inside that workspace's context.

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const COOKIE = "so_session";
const SESSION_DAYS = 30;

let secret = process.env.SESSION_SECRET ?? "";
export function initAuth() {
  secret = process.env.SESSION_SECRET ?? "";
  if (!secret) {
    secret = randomBytes(32).toString("hex");
    if (process.env.NODE_ENV === "production") console.warn("[auth] SESSION_SECRET is not set — sessions will reset on every restart.");
  }
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [, saltHex, keyHex] = stored.split("$");
  if (!saltHex || !keyHex) return false;
  const key = await scrypt(pw, Buffer.from(saltHex, "hex"), 64);
  const expected = Buffer.from(keyHex, "hex");
  return key.length === expected.length && timingSafeEqual(key, expected);
}

const sign = (payload: string) => createHmac("sha256", secret).update(payload).digest("base64url");

export function issueSession(res: Response, userId: string) {
  const payload = Buffer.from(JSON.stringify({ u: userId, e: Date.now() + SESSION_DAYS * 864e5 })).toString("base64url");
  res.cookie(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_DAYS * 864e5,
    path: "/",
  });
}

export function clearSession(res: Response) {
  res.clearCookie(COOKIE, { path: "/" });
}

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
}

export function sessionUserId(req: Request): string | undefined {
  const value = readCookie(req, COOKIE);
  if (!value) return;
  const [payload, sig] = value.split(".");
  if (!payload || !sig) return;
  const expected = sign(payload);
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return;
  try {
    const { u, e } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof u === "string" && e > Date.now() ? u : undefined;
  } catch {
    return;
  }
}

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
export const newAgentToken = () => `so_agent_${randomBytes(24).toString("base64url")}`;
export const newInviteCode = () => randomBytes(9).toString("base64url");

export const publicUser = (u: UserRow) => ({ id: u.id, email: u.email, name: u.name });

// ---------------------------------------------------------------------------
// Login throttling (per IP + email), in memory.

const attempts = new Map<string, { n: number; until: number }>();
export function throttle(key: string) {
  const now = Date.now();
  const a = attempts.get(key);
  if (a && a.until > now && a.n >= 10) throw new HttpError(429, "Too many attempts. Try again in a few minutes.");
  attempts.set(key, a && a.until > now ? { n: a.n + 1, until: a.until } : { n: 1, until: now + 15 * 60_000 });
}
export const clearThrottle = (key: string) => attempts.delete(key);

// ---------------------------------------------------------------------------
// Middleware

export interface AuthInfo {
  userId?: string;
  workspaceId: string;
  role: Role;
  actor: "human" | "agent";
}

declare module "express-serve-static-core" {
  interface Request {
    studio?: AuthInfo;
    userId?: string;
  }
}

/** Requires a signed-in user (no workspace needed). */
export async function requireUser(req: Request, _res: Response, next: NextFunction) {
  const uid = sessionUserId(req);
  if (!uid || !(await getBackend().getUser(uid))) return next(new HttpError(401, "Sign in required"));
  req.userId = uid;
  next();
}

/**
 * Resolves the caller's workspace and runs the rest of the request inside it.
 * Humans pick a workspace with the X-Workspace-Id header; agents are bound to
 * the workspace their token belongs to.
 */
export async function requireWorkspace(req: Request, _res: Response, next: NextFunction) {
  try {
    const b = getBackend();
    let info: AuthInfo | undefined;
    const bearer = req.get("authorization")?.match(/^Bearer\s+(so_agent_\S+)$/)?.[1];
    if (bearer) {
      const ws = await b.findWorkspaceByAgentToken(hashToken(bearer));
      if (!ws) throw new HttpError(401, "Invalid agent token");
      info = { workspaceId: ws.id, role: "member", actor: "agent" };
    } else {
      const uid = sessionUserId(req);
      if (!uid) throw new HttpError(401, "Sign in required");
      const wanted = req.get("x-workspace-id");
      const memberships = await b.listWorkspacesForUser(uid);
      const m = (wanted && memberships.find((w) => w.id === wanted)) || (!wanted ? memberships[0] : undefined);
      if (!m) throw new HttpError(wanted ? 403 : 404, wanted ? "You are not a member of that workspace" : "No workspace yet");
      info = { userId: uid, workspaceId: m.id, role: m.role, actor: "human" };
    }
    req.studio = info;
    await ensureTenant(info.workspaceId);
    runWith({ workspaceId: info.workspaceId, actor: info.actor, userId: info.userId }, next);
  } catch (err) {
    next(err);
  }
}

export function requireRole(req: Request, ...roles: Role[]) {
  if (!req.studio || req.studio.actor === "agent" || !roles.includes(req.studio.role)) throw new HttpError(403, `Requires ${roles.join(" or ")} role`);
}
