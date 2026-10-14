import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import { HttpError, getBackend, loadTenant, runInWorkspace } from "./db";

// Email + password accounts with a signed HttpOnly session cookie. Each user
// owns one workspace; every API call runs inside it.

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
  }
}

/** Signed-in user + their workspace; the rest of the request runs inside it. */
export async function requireWorkspace(req: Request, _res: Response, next: NextFunction) {
  try {
    const userId = sessionUserId(req);
    if (!userId) throw new HttpError(401, "Sign in required");
    const ws = await getBackend().workspaceForOwner(userId);
    if (!ws) throw new HttpError(401, "Sign in required");
    req.userId = userId;
    req.workspaceId = ws.id;
    await loadTenant(ws.id);
    runInWorkspace(ws.id, userId, next);
  } catch (err) {
    next(err);
  }
}
