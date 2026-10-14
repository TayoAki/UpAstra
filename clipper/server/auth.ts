import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import { HttpError, getBackend, loadTenant, runInWorkspace } from "./db";

// Email + password accounts with a signed HttpOnly session cookie. Each user
// owns one workspace; every API call runs inside it. Agents (MCP clients,
// scripts) use the workspace's agent key as a bearer token instead.

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const COOKIE = "co_session";
const SESSION_DAYS = 30;

let secret = "";
export function initAuth() {
  secret = process.env.SESSION_SECRET ?? "";
  if (!secret) {
    secret = randomBytes(32).toString("hex");
    if (process.env.NODE_ENV === "production") console.warn("[auth] SESSION_SECRET is not set — sessions reset on every restart.");
  }
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${(await scrypt(pw, salt, 64)).toString("hex")}`;
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

export const clearSession = (res: Response) => res.clearCookie(COOKIE, { path: "/" });

export function sessionUserId(req: Request): string | undefined {
  const raw = (req.headers.cookie ?? "").split(";").map((p) => p.trim()).find((p) => p.startsWith(`${COOKIE}=`));
  if (!raw) return;
  const [payload, sig] = decodeURIComponent(raw.slice(COOKIE.length + 1)).split(".");
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

// ---- Agent keys ------------------------------------------------------------
export const AGENT_KEY_PREFIX = "co_agent_";
export const newAgentKey = () => `${AGENT_KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
export const hashAgentKey = (key: string) => createHash("sha256").update(key).digest("hex");
export const bearerAgentKey = (req: Request) => req.get("authorization")?.match(/^Bearer\s+(co_agent_[\w-]{20,})$/)?.[1];

// ---- Signed video links ------------------------------------------------------
// A finished video can be shared as a plain link (for agents, schedulers, a
// phone) without a session. The link names the workspace, clip and exact file,
// and expires.
export function signVideoLink(workspaceId: string, clipId: string, videoKey: string, ttlSec = 7 * 86400) {
  const e = Math.floor(Date.now() / 1000) + ttlSec;
  const s = sign(`${workspaceId}.${clipId}.${videoKey}.${e}`);
  return `/v/${encodeURIComponent(workspaceId)}/${encodeURIComponent(clipId)}.mp4?e=${e}&s=${s}`;
}
export function verifyVideoLink(workspaceId: string, clipId: string, videoKey: string, e: number, s: string) {
  if (!(e * 1000 > Date.now())) return false;
  const expected = sign(`${workspaceId}.${clipId}.${videoKey}.${e}`);
  return expected.length === s.length && timingSafeEqual(Buffer.from(expected), Buffer.from(s));
}

const attempts = new Map<string, { n: number; until: number }>();
export function throttle(key: string) {
  const t = Date.now();
  const a = attempts.get(key);
  if (a && a.until > t && a.n >= 10) throw new HttpError(429, "Too many attempts. Try again in a few minutes.");
  attempts.set(key, a && a.until > t ? { n: a.n + 1, until: a.until } : { n: 1, until: t + 15 * 60_000 });
}
export const clearThrottle = (key: string) => attempts.delete(key);

declare module "express-serve-static-core" {
  interface Request {
    userId?: string;
    workspaceId?: string;
    actor?: "human" | "agent";
  }
}

/** Signed-in user + their workspace; the rest of the request runs inside it. */
export async function requireWorkspace(req: Request, _res: Response, next: NextFunction) {
  try {
    const key = bearerAgentKey(req);
    let userId: string | undefined;
    let ws;
    if (key) {
      ws = await getBackend().workspaceByAgentKey(hashAgentKey(key));
      if (!ws) throw new HttpError(401, "Invalid agent key");
      userId = ws.ownerId;
      req.actor = "agent";
    } else {
      userId = sessionUserId(req);
      if (!userId) throw new HttpError(401, "Sign in required");
      ws = await getBackend().workspaceForOwner(userId);
      if (!ws) throw new HttpError(401, "Sign in required");
      req.actor = "human";
    }
    req.userId = userId;
    req.workspaceId = ws.id;
    await loadTenant(ws.id);
    runInWorkspace(ws.id, userId, next, req.actor);
  } catch (err) {
    next(err);
  }
}

/** Routes an agent key may not use (account and key management). */
export function humansOnly(req: Request, _res: Response, next: NextFunction) {
  next(req.actor === "agent" ? new HttpError(403, "Agent keys can't do this — sign in to the dashboard.") : undefined);
}
