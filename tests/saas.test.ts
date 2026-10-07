import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { initAuth } from "../server/auth";
import { fileBackend, pgBackend, setBackend } from "../server/persist";

let server: Server;
let base = "";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "so-saas-"));

beforeAll(async () => {
  process.env.RADAR_SCHEDULER = "0";
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.APIFY_TOKEN;
  initAuth();
  // TEST_DATABASE_URL runs the same suite against Postgres.
  const url = process.env.TEST_DATABASE_URL;
  const b = url ? pgBackend(url) : fileBackend(dir);
  await b.init();
  if (url) await (b as ReturnType<typeof pgBackend>).reset();
  setBackend(b);
  await new Promise<void>((resolve) => {
    server = createApp({ port: 0 }).listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A tiny client that keeps its session cookie and workspace. */
function client() {
  let cookie = "";
  let ws = "";
  const call = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(ws ? { "x-workspace-id": ws } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };
  return { call, setWs: (id: string) => (ws = id) };
}

describe("multi-tenant SaaS", () => {
  const alice = client();
  const bob = client();
  let aliceWs = "";
  let aliceJob = "";

  it("signs up with a demo workspace and isolates data per workspace", async () => {
    const a = await alice.call("POST", "/api/auth/signup", { email: "alice@example.com", password: "password123", name: "Alice" });
    expect(a.status).toBe(201);
    aliceWs = a.data.workspaces[0].id;
    alice.setWs(aliceWs);
    const jobs = await alice.call("GET", "/api/jobs");
    expect(jobs.data.length).toBeGreaterThan(5);
    aliceJob = jobs.data[0].id;

    const b = await bob.call("POST", "/api/auth/signup", { email: "bob@example.com", password: "password123", demo: false });
    expect(b.status).toBe(201);
    bob.setWs(b.data.workspaces[0].id);
    expect((await bob.call("GET", "/api/jobs")).data).toHaveLength(0);
    expect((await bob.call("GET", `/api/jobs/${aliceJob}`)).status).toBe(404);
  }, 30_000);

  it("refuses access to a workspace you are not a member of", async () => {
    const r = await bob.call("GET", "/api/jobs", undefined, { "x-workspace-id": aliceWs });
    expect(r.status).toBe(403);
  });

  it("rejects bad logins and unauthenticated calls", async () => {
    expect((await client().call("GET", "/api/jobs")).status).toBe(401);
    expect((await client().call("POST", "/api/auth/login", { email: "alice@example.com", password: "wrong-password" })).status).toBe(401);
    const ok = await client().call("POST", "/api/auth/login", { email: "alice@example.com", password: "password123" });
    expect(ok.status).toBe(200);
  });

  it("invites a teammate as a member who cannot change the policy", async () => {
    const inv = await alice.call("POST", "/api/workspace/invites", { role: "member" });
    expect(inv.status).toBe(201);
    const carol = client();
    const c = await carol.call("POST", "/api/auth/signup", { email: "carol@example.com", password: "password123", invite: inv.data.code });
    expect(c.data.workspaces.map((w: { id: string }) => w.id)).toContain(aliceWs);
    carol.setWs(aliceWs);
    expect((await carol.call("GET", "/api/jobs")).data.length).toBeGreaterThan(5);
    expect((await carol.call("PUT", "/api/policy", { minGrossMargin: 0.1 })).status).toBe(403);
  });

  it("issues an agent token that is scoped to one workspace and never approves delivery", async () => {
    const t = await alice.call("POST", "/api/workspace/agent-token");
    const auth = { authorization: `Bearer ${t.data.token}` };
    const agent = client();
    const jobs = await agent.call("GET", "/api/jobs", undefined, auth);
    expect(jobs.status).toBe(200);
    const waiting = (await agent.call("GET", "/api/jobs", undefined, auth)).data.find((j: { stage: string }) => j.stage === "approval");
    const detail = await agent.call("GET", `/api/jobs/${waiting.id}`, undefined, auth);
    const final = detail.data.job.checkpoints.find((c: { kind: string; status: string }) => c.kind === "final-delivery" && c.status === "open");
    const r = await agent.call("POST", `/api/jobs/${waiting.id}/checkpoints/${final.id}`, { decision: "approved" }, auth);
    expect(r.status).toBe(403);
    expect((await agent.call("PUT", "/api/policy", {}, auth)).status).toBe(403);
    // The token can't be pointed at another workspace.
    const other = await agent.call("GET", "/api/jobs", undefined, { ...auth, "x-workspace-id": "ws_other" });
    expect(other.data.map((j: { id: string }) => j.id)).toContain(aliceJob);
  });

  it("runs the job radar: scrape → score → draft proposals → convert to a job", async () => {
    const radar = (await alice.call("GET", "/api/radar")).data;
    expect(radar.searches.length).toBe(1);
    expect(radar.leads.length).toBeGreaterThan(5);
    const verdicts = radar.leads.map((l: { fit: { verdict: string } }) => l.fit.verdict);
    expect(verdicts).toContain("good");
    expect(verdicts).toContain("skip");
    const scam = radar.leads.find((l: { title: string }) => /free test/i.test(l.title));
    expect(scam.fit.verdict).toBe("skip");
    const lookalike = radar.leads.find((l: { title: string }) => /lookalike/i.test(l.title));
    expect(lookalike.fit.verdict).toBe("skip");
    const offTopic = radar.leads.find((l: { title: string }) => /python/i.test(l.title));
    expect(offTopic.fit.verdict).toBe("skip");
    const good = radar.leads.find((l: { fit: { verdict: string }; proposal?: unknown }) => l.fit.verdict === "good" && l.proposal);
    expect(good.proposal.text.length).toBeGreaterThan(200);
    const conv = await alice.call("POST", `/api/radar/leads/${good.id}/convert`);
    expect(conv.status).toBe(201);
    expect(conv.data.job.stage).toBe("review");
  }, 30_000);

  it("creates and runs a saved search", async () => {
    const s = await bob.call("POST", "/api/radar/searches", { source: "fiverr", query: "grant writing", schedule: "manual" });
    expect(s.status).toBe(201);
    const run = await bob.call("POST", `/api/radar/searches/${s.data.id}/run`);
    expect(run.status).toBe(200);
    expect(run.data.added).toBeGreaterThan(0);
    // Bob's radar doesn't leak into Alice's workspace.
    const aliceRadar = (await alice.call("GET", "/api/radar")).data;
    expect(aliceRadar.searches.some((x: { id: string }) => x.id === s.data.id)).toBe(false);
  }, 30_000);
});
