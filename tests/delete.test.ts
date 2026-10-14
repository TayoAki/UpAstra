import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { initAuth } from "../server/auth";
import { fileBackend, setBackend } from "../server/persist";

let server: Server;
let base = "";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "so-delete-"));

beforeAll(async () => {
  process.env.RADAR_SCHEDULER = "0";
  process.env.DATA_DIR = dir;
  delete process.env.S3_BUCKET;
  delete process.env.OPENROUTER_API_KEY;
  initAuth();
  const b = fileBackend(dir);
  await b.init();
  setBackend(b);
  await new Promise<void>((r) => (server = createApp({ port: 0 }).listen(0, () => r())));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const isBuf = Buffer.isBuffer(body);
  const res = await fetch(base + p, {
    method,
    headers: { ...(isBuf ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : isBuf ? new Uint8Array(body as Buffer) : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})), cookie: res.headers.get("set-cookie")?.split(";")[0] };
}

async function studio(email: string, workspaceName: string) {
  const s = await call("POST", "/api/auth/signup", { email, password: "password123", workspaceName, demo: false });
  return { headers: { cookie: s.cookie!, "x-workspace-id": s.data.workspaces[0].id }, wsId: s.data.workspaces[0].id as string };
}

describe("deleting accounts and workspaces", () => {
  it("a solo owner's account deletion removes their workspace, portal and uploaded files", async () => {
    const a = await studio("solo@x.com", "Solo Studio");
    const { data } = await call("PUT", "/api/portal", { enabled: true }, a.headers);
    const slug = data.config.slug;
    const c = await call("POST", `/papi/${slug}/auth/signup`, { email: "client@x.com", password: "password123" });
    const up = await call("POST", `/papi/${slug}/uploads`, Buffer.from("%PDF-1.4"), { "x-portal-token": c.data.token, "content-type": "application/pdf", "x-file-name": "a.pdf" });
    expect(up.status).toBe(201);
    expect(fs.existsSync(path.join(dir, "uploads", a.wsId))).toBe(true);

    expect((await call("DELETE", "/api/auth/account", { password: "wrong-password" }, a.headers)).status).toBe(401);
    const del = await call("DELETE", "/api/auth/account", { password: "password123" }, a.headers);
    expect(del.status).toBe(200);
    expect(del.data.deletedWorkspaces).toEqual(["Solo Studio"]);

    expect((await call("POST", "/api/auth/login", { email: "solo@x.com", password: "password123" })).status).toBe(401);
    expect((await call("GET", `/papi/${slug}`)).status).toBe(404);
    expect(fs.existsSync(path.join(dir, "uploads", a.wsId))).toBe(false);
    expect(fs.existsSync(path.join(dir, "workspaces", `${a.wsId}.json`))).toBe(false);
    // The slug is free again.
    const b = await studio("new@x.com", "Solo Studio");
    expect((await call("GET", "/api/portal", undefined, b.headers)).data.config.slug).toBe(slug);
  });

  it("an owner leaving a shared workspace hands it to the admin instead of deleting it", async () => {
    const owner = await studio("owner@x.com", "Team Studio");
    const inv = await call("POST", "/api/workspace/invites", { role: "admin" }, owner.headers);
    const admin = await call("POST", "/api/auth/signup", { email: "admin@x.com", password: "password123", invite: inv.data.code });
    const adminH = { cookie: admin.cookie!, "x-workspace-id": owner.wsId };
    await call("POST", "/api/clients", { name: "Keep me" }, owner.headers);

    const del = await call("DELETE", "/api/auth/account", { password: "password123" }, owner.headers);
    expect(del.data.transferredWorkspaces).toEqual([{ name: "Team Studio", newOwner: "admin@x.com" }]);
    const ws = await call("GET", "/api/workspace", undefined, adminH);
    expect(ws.data.role).toBe("owner");
    expect(ws.data.members.map((m: { email: string }) => m.email)).toEqual(["admin@x.com"]);
    expect((await call("GET", "/api/clients", undefined, adminH)).data.some((c: { name: string }) => c.name === "Keep me")).toBe(true);
  });

  it("only the owner can delete a workspace, and must type its name", async () => {
    const o = await studio("o2@x.com", "Delete Me");
    const inv = await call("POST", "/api/workspace/invites", { role: "admin" }, o.headers);
    const adm = await call("POST", "/api/auth/signup", { email: "a2@x.com", password: "password123", invite: inv.data.code });
    expect((await call("DELETE", "/api/workspace", { confirmName: "Delete Me" }, { cookie: adm.cookie!, "x-workspace-id": o.wsId })).status).toBe(403);
    expect((await call("DELETE", "/api/workspace", { confirmName: "nope" }, o.headers)).status).toBe(400);
    expect((await call("DELETE", "/api/workspace", { confirmName: "Delete Me" }, o.headers)).status).toBe(200);
    // Both former members are left without it.
    expect((await call("GET", "/api/auth/me", undefined, { cookie: adm.cookie! })).data.workspaces).toHaveLength(0);
  });

  it("portal clients can delete their own account; the studio keeps the job", async () => {
    const s = await studio("s3@x.com", "Portal Studio");
    const slug = (await call("PUT", "/api/portal", { enabled: true }, s.headers)).data.config.slug;
    const c = await call("POST", `/papi/${slug}/auth/signup`, { email: "c3@x.com", password: "password123" });
    const t = { "x-portal-token": c.data.token };
    const r = await call(
      "POST",
      `/papi/${slug}/requests`,
      { packageId: "pkg_ad-copy-pack", answers: { brief: "Ads for our app", platform: "Google Search", product: "budgeting app", audience: "freelancers" } },
      t,
    );
    expect(r.status).toBe(201);
    expect((await call("DELETE", `/papi/${slug}/me`, { password: "wrong-password" }, t)).status).toBe(401);
    expect((await call("DELETE", `/papi/${slug}/me`, { password: "password123" }, t)).status).toBe(200);
    expect((await call("GET", `/papi/${slug}/me`, undefined, t)).status).toBe(401);
    const job = await call("GET", `/api/jobs/${r.data.id}`, undefined, s.headers);
    expect(job.data.job.portal.clientUserId).toBe("deleted");

    // Studios can remove a portal client too.
    const c2 = await call("POST", `/papi/${slug}/auth/signup`, { email: "c4@x.com", password: "password123" });
    const id = (await call("GET", "/api/portal", undefined, s.headers)).data.clients.find((x: { email: string }) => x.email === "c4@x.com").id;
    expect((await call("DELETE", `/api/portal/clients/${id}`, undefined, s.headers)).status).toBe(200);
    expect((await call("GET", `/papi/${slug}/me`, undefined, { "x-portal-token": c2.data.token })).status).toBe(401);
  }, 20_000);
});
