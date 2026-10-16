import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { createApp } from "../server/app";
import { initAuth } from "../server/auth";
import { useMemoryBackend } from "../server/db";
import { setAISimulated } from "../server/llm";
import { ffmpegAvailable } from "../server/media";

// B7.1: caption and overlay changes preview in the browser (libass over the
// proxy), with no render.
const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium";
const ready = ffmpegAvailable() && fs.existsSync(CHROME) && fs.existsSync(path.resolve("dist/index.html"));

describe.skipIf(!ready)("in-browser preview", () => {
  let tmp = "";
  let videoServer: http.Server;
  let app: http.Server;
  let base = "";
  let browser: Browser;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ptest-"));
    process.env.ALLOW_PRIVATE_FETCH = "1";
    const src = path.join(tmp, "game.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=30", "-f", "lavfi", "-i", "sine=frequency=440:duration=30", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", src]);
    videoServer = http
      .createServer((req, res) => {
        const size = fs.statSync(src).size;
        const m = String(req.headers.range ?? "").match(/bytes=(\d+)-(\d*)/);
        const start = m ? Number(m[1]) : 0;
        const end = m && m[2] ? Number(m[2]) : size - 1;
        res.writeHead(m ? 206 : 200, { "Content-Type": "video/mp4", "Content-Length": end - start + 1, "Accept-Ranges": "bytes", ...(m ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}) });
        fs.createReadStream(src, { start, end }).pipe(res);
      })
      .listen(0);
    useMemoryBackend();
    setAISimulated(true);
    initAuth();
    app = createApp().listen(0);
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    browser = await chromium.launch({ executablePath: CHROME });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    app?.close();
    videoServer?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.ALLOW_PRIVATE_FETCH;
  });

  it("redraws captions for a new style with no render", async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
    const rq = ctx.request;
    const json = async (p: string, method: "GET" | "POST" | "PUT", data?: unknown) => (await rq.fetch(base + p, { method, data })).json();
    await json("/api/auth/signup", "POST", { email: "pv@test.dev", password: "password123" });
    const videoUrl = `http://127.0.0.1:${(videoServer.address() as AddressInfo).port}/game.mp4`;
    const c = await json("/api/campaigns", "POST", { text: `The name "Turbo Ball" must be spoken.\nEncourage viewers to play Turbo Ball now.\nCPM: $1\nVideos 10-20 seconds.` });
    const id = c.campaign.id;
    await json(`/api/campaigns/${id}`, "PUT", { brief: { ...c.campaign.brief, footage: [{ label: "Gameplay", url: videoUrl }] } });
    await json(`/api/campaigns/${id}/footage/refresh`, "POST", {});
    const clip = (await json(`/api/campaigns/${id}/clips`, "POST", { count: 1 })).clips[0];
    await json(`/api/clips/${clip.id}/render`, "POST", { voice: "none", override: true });
    for (let i = 0; i < 240; i++) {
      const r = (await json("/api/state", "GET")).clips.find((x: { id: string }) => x.id === clip.id).render;
      if (r.status === "done") break;
      if (r.status === "failed") throw new Error(r.error);
      await new Promise((res) => setTimeout(res, 500));
    }

    const page = await ctx.newPage();
    const renderCalls: string[] = [];
    page.on("request", (r) => /\/render$|\/recompose$/.test(new URL(r.url()).pathname) && r.method() === "POST" && renderCalls.push(r.url()));
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // A blocked worker or wasm (CSP) shows up as a console error; the proxy video not decoding here doesn't.
    page.on("console", (m) => m.type() === "error" && !/MEDIA_ERR|video|NotSupportedError|no supported source/i.test(m.text()) && errors.push(m.text()));
    // (This Chromium build can't decode H.264, so the check is on what libass is given, not pixels.)
    const asses: string[] = [];
    page.on("response", async (r) => {
      if (/\/preview$/.test(new URL(r.url()).pathname)) asses.push((await r.json()).ass);
    });
    const open = async () => {
      await page.goto(`${base}/#/c/${id}/clips`);
      await page.reload();
      await page.getByRole("button", { name: /Preview changes/ }).click();
      await page.locator(".preview-frame canvas").waitFor({ state: "attached", timeout: 30_000 });
    };
    await open();
    await json(`/api/campaigns/${id}`, "PUT", { captions: { style: "box-highlight", size: 120, position: 30 } });
    await open();
    await expect.poll(() => asses.length).toBe(2);
    expect(asses[0]).not.toBe(asses[1]);
    expect(asses[1]).toMatch(/Style: Cap,/);
    await page.waitForTimeout(3000); // let the worker load its wasm and fonts
    expect(errors).toEqual([]);
    expect(renderCalls).toEqual([]);
    await ctx.close();
  }, 240_000);
});
