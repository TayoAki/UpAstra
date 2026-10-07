import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http, { type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { initAuth } from "../server/auth";
import { fileBackend, setBackend } from "../server/persist";
import { composeBrief } from "../server/portal";
import { simulateIntake } from "../server/astra";

let server: Server;
let base = "";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "so-portal-"));

beforeAll(async () => {
  process.env.RADAR_SCHEDULER = "0";
  process.env.DATA_DIR = dir;
  process.env.PORTAL_BASE_DOMAIN = "portal.test";
  process.env.DIST_DIR = path.join(dir, "dist");
  fs.mkdirSync(process.env.DIST_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.DIST_DIR, "index.html"), "<!doctype html><title>t</title>");
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENAI_API_KEY;
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
  return { status: res.status, headers: res.headers, data: await res.json().catch(() => ({})), setCookie: res.headers.get("set-cookie") };
}

/** fetch() can't set Host; use raw http to act like a request to a custom domain. */
function getWithHost(p: string, host: string): Promise<{ status: number; data: Record<string, string> }> {
  const u = new URL(base + p);
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { host } }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, data: JSON.parse(body || "{}") }));
      })
      .on("error", reject);
  });
}

describe("client portal", () => {
  let studio: Record<string, string> = {};
  let slug = "";
  let clientToken = "";
  let requestId = "";

  it("each workspace gets a portal address; the studio opens it", async () => {
    const s = await call("POST", "/api/auth/signup", { email: "owner@studio.com", password: "password123", workspaceName: "Northside Creative", demo: false });
    studio = { cookie: s.setCookie!.split(";")[0], "x-workspace-id": s.data.workspaces[0].id };
    const p = await call("GET", "/api/portal", undefined, studio);
    slug = p.data.config.slug;
    expect(slug).toBe("northside-creative");
    expect((await call("GET", `/papi/${slug}`)).status).toBe(404); // closed until enabled
    const open = await call("PUT", "/api/portal", { enabled: true, headline: "Work with Northside" }, studio);
    expect(open.status).toBe(200);
    const pub = await call("GET", `/papi/${slug}`);
    expect(pub.data.studio.headline).toBe("Work with Northside");
    expect(pub.data.packages.length).toBeGreaterThan(3);
    expect(JSON.stringify(pub.data)).not.toMatch(/templateId|margin|cost/i);
  });

  it("clients sign up, upload files and submit a request that becomes a job", async () => {
    const su = await call("POST", `/papi/${slug}/auth/signup`, { email: "dana@acme.com", password: "password123", name: "Dana", company: "Acme Payroll" });
    expect(su.status).toBe(201);
    clientToken = su.data.token;
    const auth = { "x-portal-token": clientToken };
    const up = await call("POST", `/papi/${slug}/uploads`, Buffer.from("%PDF-1.4 test"), { ...auth, "content-type": "application/pdf", "x-file-name": "case-study.pdf" });
    expect(up.status).toBe(201);
    const bad = await call("POST", `/papi/${slug}/uploads`, Buffer.from("MZ"), { ...auth, "content-type": "application/x-msdownload", "x-file-name": "x.exe" });
    expect(bad.status).toBe(415);

    const pub = await call("GET", `/papi/${slug}`);
    const pkg = pub.data.packages.find((p: { id: string }) => p.id === "pkg_cold-email-sequence");
    const missing = await call("POST", `/papi/${slug}/requests`, { packageId: pkg.id, answers: { brief: "Need outbound" } }, auth);
    expect(missing.status).toBe(400);
    const r = await call(
      "POST",
      `/papi/${slug}/requests`,
      {
        packageId: pkg.id,
        addOnIds: ["rush"],
        answers: {
          brief: "We need outbound to restaurant owners.",
          audience: "owners of independent restaurants with 1-3 locations",
          offer: "inventory software that cuts food waste",
          cta: "book a 15 minute demo",
          emails: "5",
          deadline: "Friday",
        },
        files: { proof: [up.data] },
      },
      auth,
    );
    expect(r.status).toBe(201);
    requestId = r.data.id;
    expect(r.data.price).toBe(pkg.price + pkg.addOns.find((a: { id: string }) => a.id === "rush").price);
    expect(r.data.status).toMatch(/received|in-progress/);
    expect(JSON.stringify(r.data)).not.toMatch(/economics|margin|modelId|qa/i);

    const job = await call("GET", `/api/jobs/${requestId}`, undefined, studio);
    expect(job.data.job.channel).toBe("portal");
    expect(job.data.job.templateId).toBe("cold-email-sequence");
    expect(job.data.job.deliverables[0].quantity).toBe(5);
    expect(job.data.job.portal.files[0].name).toBe("case-study.pdf");
    // The studio can download the client's file.
    const f = await fetch(`${base}/api/files/${job.data.job.portal.files[0].key}`, { headers: studio });
    expect(f.status).toBe(200);
  }, 30_000);

  it("clients only see their own requests", async () => {
    const other = await call("POST", `/papi/${slug}/auth/signup`, { email: "eve@other.com", password: "password123" });
    const auth = { "x-portal-token": other.data.token };
    expect((await call("GET", `/papi/${slug}/requests/${requestId}`, undefined, auth)).status).toBe(404);
    expect((await call("GET", `/papi/${slug}/me`, undefined, auth)).data.requests).toHaveLength(0);
    // A portal token is useless against the studio API.
    expect((await call("GET", "/api/jobs", undefined, auth)).status).toBe(401);
  });

  it("delivered work appears for the client, who can approve or ask for changes", async () => {
    const auth = { "x-portal-token": clientToken };
    const resolveAll = async () => {
      for (let i = 0; i < 8; i++) {
        const j = (await call("GET", `/api/jobs/${requestId}`, undefined, studio)).data.job;
        const cp = j.checkpoints.find((c: { status: string; kind: string }) => c.status === "open" && c.kind !== "client-questions");
        if (!cp) {
          if (j.running) await new Promise((r) => setTimeout(r, 300));
          else break;
          continue;
        }
        await call("POST", `/api/jobs/${requestId}/checkpoints/${cp.id}`, { decision: "approved" }, studio);
        await new Promise((r) => setTimeout(r, 300));
      }
    };
    await resolveAll();
    const v = await call("GET", `/papi/${slug}/requests/${requestId}`, undefined, auth);
    expect(v.data.status).toBe("ready");
    expect(v.data.deliverables[0].items[0].markdown).toMatch(/Email 1/);
    expect(v.data.canApprove).toBe(true);

    const change = await call("POST", `/papi/${slug}/requests/${requestId}/messages`, { body: "Could you make email 2 shorter please?" }, auth);
    expect(change.status).toBe(200);
    expect(["revising", "in-progress", "ready"]).toContain(change.data.status);
    await resolveAll();
    const after = await call("POST", `/papi/${slug}/requests/${requestId}/approve`, undefined, auth);
    expect(after.data.status).toBe("completed");
  }, 30_000);

  it("serves portals on subdomains and custom domains, and an embed script", async () => {
    await call("PUT", "/api/portal", { customDomain: "work.northside.studio" }, studio);
    const viaDomain = await getWithHost("/papi/_host", "work.northside.studio");
    expect(viaDomain.data.slug).toBe(slug);
    const viaSub = await getWithHost("/papi/_host", `${slug}.portal.test`);
    expect(viaSub.data.slug).toBe(slug);
    const page = await fetch(`${base}/p/${slug}`);
    expect(page.headers.get("content-security-policy")).toMatch(/frame-ancestors/);
    const app = await fetch(`${base}/api/health`);
    expect(app.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    const js = await fetch(`${base}/embed.js`);
    expect(await js.text()).toMatch(/data-studio/);
    // Another studio can't take the same slug or domain.
    const s2 = await call("POST", "/api/auth/signup", { email: "b@b.com", password: "password123", workspaceName: "Northside Creative", demo: false });
    const h2 = { cookie: s2.setCookie!.split(";")[0], "x-workspace-id": s2.data.workspaces[0].id };
    const p2 = await call("GET", "/api/portal", undefined, h2);
    expect(p2.data.config.slug).not.toBe(slug);
    expect((await call("PUT", "/api/portal", { slug }, h2)).status).toBe(409);
    expect((await call("PUT", "/api/portal", { customDomain: "work.northside.studio" }, h2)).status).toBe(409);
  }, 30_000);
});

describe("composeBrief", () => {
  it("turns guided answers into a brief intake understands", () => {
    const brief = composeBrief("Grant Proposal", "grant-proposal", [
      { questionId: "funder", label: "Funder", value: "Lakeside Community Foundation" },
      { questionId: "amount", label: "Amount", value: "$40k" },
      { questionId: "format", label: "Format", value: "Letter of inquiry (LOI)" },
      { questionId: "data", label: "Data", value: "We served 310 children in 2025." },
    ], [], []);
    const a = simulateIntake({ rawBrief: brief, channel: "portal", price: 600, referenceAssets: [], clientNotes: "" });
    expect(a.templateId).toBe("grant-proposal");
    expect(a.deliverables[0].copy).toMatchObject({ funder: "Lakeside Community Foundation", ask: "$40,000" });
    expect(a.deliverables[0].copy?.fields).toHaveLength(4);
  });
});
