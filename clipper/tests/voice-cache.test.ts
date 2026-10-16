import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { initAuth } from "../server/auth";
import { getDoc, runInWorkspace, useMemoryBackend } from "../server/db";
import { ffmpegAvailable } from "../server/media";
import { enqueueRender } from "../server/render";

// B1.1/B1.2: a voiced render pays for its voiceover once. Rendering the same
// clip again reuses the take and every shot; a resumed or retried render
// checks the AI budget before paying.
let tts = 0;
let llm: http.Server;
let videoServer: http.Server;
let app: http.Server;
let base = "";
let cookie = "";
let tmp = "";

// 3 s of a 300 Hz tone, 24 kHz mono 16-bit, as the voice model streams it.
const pcm = Buffer.alloc(24000 * 2 * 3);
for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 300 * i) / 24000)), i * 2);

const PLAN = {
  clips: [
    {
      title: "Turbo Ball goals",
      angle: "Hype",
      hookStyle: "question",
      hook: "Have you played Turbo Ball yet?",
      narration: "Have you played Turbo Ball yet? It is soccer with rocket cars. Play Turbo Ball now.",
      onScreenText: [],
      cta: "Play Turbo Ball now",
      shots: [{ footageName: "Gameplay", moment: "goal", seconds: 6 }],
      lengthSec: 12,
      caption: "Turbo Ball",
      hashtags: ["roblox"],
    },
  ],
};

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vcache-"));
  process.env.DATA_DIR = tmp;
  process.env.ALLOW_PRIVATE_FETCH = "1";
  const src = path.join(tmp, "game.mp4");
  if (ffmpegAvailable()) execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=30", "-f", "lavfi", "-i", "sine=frequency=440:duration=30", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", src]);
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
  llm = http
    .createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw);
        if (body.modalities?.includes("audio")) {
          tts++;
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          for (let i = 0; i < pcm.length; i += 9600) res.write(`data: ${JSON.stringify({ choices: [{ delta: { audio: { data: pcm.subarray(i, i + 9600).toString("base64") } } }] })}\n\n`);
          res.end(`data: ${JSON.stringify({ choices: [], usage: { cost: 0.02 } })}\n\ndata: [DONE]\n\n`);
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: JSON.stringify(PLAN) } }], usage: { cost: 0.001 } }));
      });
    })
    .listen(0);
  process.env.OPENROUTER_API_KEY = "test";
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}`;
  useMemoryBackend();
  initAuth();
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(() => {
  app?.close();
  llm?.close();
  videoServer?.close();
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_BASE_URL;
  delete process.env.AI_DAILY_BUDGET_USD;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const api = async (p: string, method = "GET", body?: unknown) => {
  const r = await fetch(base + p, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const settle = async (clipId: string) => {
  for (let i = 0; i < 240; i++) {
    await new Promise((res) => setTimeout(res, 250));
    const rr = (await api("/api/state")).body.clips.find((x: { id: string }) => x.id === clipId).render;
    if (["done", "failed"].includes(rr.status)) return rr;
  }
  throw new Error("render didn't finish");
};

describe.skipIf(!ffmpegAvailable())("step cache in renders", () => {
  it("pays for a voiceover once and reuses it and every shot on a re-render", async () => {
    const videoUrl = `http://127.0.0.1:${(videoServer.address() as AddressInfo).port}/game.mp4`;
    await api("/api/auth/signup", "POST", { email: "vc@test.dev", password: "password123" });
    const brief = `Game Link: https://example.com/game\nThe name "Turbo Ball" must be spoken.\nEncourage viewers to play Turbo Ball now near the end of the video.\nCPM: $1\nVideos 10-20 seconds.\nFootage: ${videoUrl}`;
    const c = (await api("/api/campaigns", "POST", { text: brief })).body.campaign;
    await api(`/api/campaigns/${c.id}`, "PUT", { brief: { ...c.brief, footage: [{ label: "Gameplay", url: videoUrl }] } });
    await api(`/api/campaigns/${c.id}/footage/refresh`, "POST", {});
    const clip = (await api(`/api/campaigns/${c.id}/clips`, "POST", { count: 1 })).body.clips[0];

    expect((await api(`/api/clips/${clip.id}/render`, "POST", { voice: "ash", override: true })).status).toBe(202);
    const first = await settle(clip.id);
    expect(first.error).toBeUndefined();
    expect(tts).toBe(1);
    expect(first.steps.voiceover).toMatchObject({ status: "done" });
    expect(first.steps.voiceover.reused).toBeFalsy();

    expect((await api(`/api/clips/${clip.id}/render`, "POST", { voice: "ash", override: true })).status).toBe(202);
    const second = await settle(clip.id);
    expect(second.error).toBeUndefined();
    expect(tts).toBe(1); // nothing paid again
    expect(second.cost).toBe(0);
    for (const s of Object.values(second.steps) as { reused?: boolean }[]) expect(s.reused).toBe(true);
    expect(second.durationSec).toBeCloseTo(first.durationSec, 1);

    // A render whose voiceover isn't cached checks today's AI budget before paying.
    process.env.AI_DAILY_BUDGET_USD = "0.01";
    const ws = (await api("/api/auth/me")).body.workspace.id as string;
    await runInWorkspace(ws, undefined, () => {
      const doc = getDoc();
      doc.usage!.dayUsd = 1;
      enqueueRender(ws, doc.clips.find((x) => x.id === clip.id)!, "coral");
    });
    const third = await settle(clip.id);
    expect(third.status).toBe("failed");
    expect(third.error).toMatch(/budget/i);
    expect(tts).toBe(1);
  }, 180_000);
});
