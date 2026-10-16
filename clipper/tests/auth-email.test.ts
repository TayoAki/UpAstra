import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { initAuth } from "../server/auth";
import { useMemoryBackend } from "../server/db";
import { outbox } from "../server/email";

let app: http.Server;
let base = "";

beforeAll(() => {
  useMemoryBackend();
  initAuth();
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(() => app?.close());

const post = async (p: string, body: unknown, cookie?: string) => {
  const r = await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json(), cookie: r.headers.get("set-cookie")?.split(";")[0] };
};
const get = async (p: string, cookie: string) => (await fetch(base + p, { headers: { cookie } })).status;
const tokenIn = (text: string) => decodeURIComponent(text.match(/token=([^\s&]+)/)![1]);
const wait = () => new Promise((r) => setTimeout(r, 1100));

describe("email: confirm address, reset and change password", () => {
  it("confirms the email from the signup link", async () => {
    const su = await post("/api/auth/signup", { email: "mail@test.dev", password: "password123", name: "Mo" });
    expect(su.status).toBe(201);
    expect(su.body.user.emailVerified).toBe(false);
    const mail = [...outbox].reverse().find((m) => m.to === "mail@test.dev")!;
    expect(mail.subject).toMatch(/Confirm your email/);
    expect(mail.text).toContain(`${base}/#/verify?token=`);

    expect((await post("/api/auth/verify", { token: "nope.nope" })).status).toBe(400);
    expect((await post("/api/auth/verify", { token: tokenIn(mail.text) })).body).toMatchObject({ ok: true, email: "mail@test.dev" });
    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: su.cookie! } }).then((r) => r.json());
    expect(me.user.emailVerified).toBe(true);
  });

  it("resets a password once, and signs out older sessions", async () => {
    const su = await post("/api/auth/signup", { email: "reset@test.dev", password: "password123" });
    const before = outbox.length;
    // Unknown address: same answer, nothing sent.
    expect((await post("/api/auth/forgot", { email: "nobody@test.dev" })).body).toEqual({ ok: true });
    expect(outbox.length).toBe(before);

    expect((await post("/api/auth/forgot", { email: "Reset@test.dev" })).body).toEqual({ ok: true });
    const mail = outbox.at(-1)!;
    expect(mail).toMatchObject({ to: "reset@test.dev", subject: expect.stringMatching(/Reset/) });
    const token = tokenIn(mail.text);

    await wait(); // sessions are compared to the second
    expect((await post("/api/auth/reset", { token, password: "short" })).status).toBe(400);
    const r = await post("/api/auth/reset", { token, password: "newpassword1" });
    expect(r.status).toBe(200);
    expect(r.body.user.emailVerified).toBe(true);
    // The old session is signed out; the new one works.
    expect(await get("/api/state", su.cookie!)).toBe(401);
    expect(await get("/api/state", r.cookie!)).toBe(200);
    // The link only works once, and the new password is the one that signs in.
    expect((await post("/api/auth/reset", { token, password: "another123" })).status).toBe(400);
    expect((await post("/api/auth/login", { email: "reset@test.dev", password: "password123" })).status).toBe(401);
    expect((await post("/api/auth/login", { email: "reset@test.dev", password: "newpassword1" })).status).toBe(200);
  });

  it("changes a password with the current one, keeping this session", async () => {
    const su = await post("/api/auth/signup", { email: "change@test.dev", password: "password123" });
    const other = (await post("/api/auth/login", { email: "change@test.dev", password: "password123" })).cookie!;
    await wait();
    expect((await post("/api/auth/password", { current: "wrong-one", password: "newpassword1" }, su.cookie)).status).toBe(401);
    const r = await post("/api/auth/password", { current: "password123", password: "newpassword1" }, su.cookie);
    expect(r.status).toBe(200);
    expect(await get("/api/state", other)).toBe(401);
    expect(await get("/api/state", r.cookie!)).toBe(200);
  });

  it("serves the legal pages' settings without signing in", async () => {
    const r = await fetch(`${base}/api/public-config`).then((x) => x.json());
    expect(r.company).toBe("UGCMediaClips");
  });
});
