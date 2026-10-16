import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { initAuth } from "../server/auth";
import { useMemoryBackend } from "../server/db";
import { cleanBreakdown, sceneCuts } from "../server/formats";
import { ffmpegAvailable } from "../server/media";

const brief = fs.readFileSync(new URL("./fixtures/car-league-brief.txt", import.meta.url), "utf8").replace(/\(https:\/\/drive[^)]+\)/g, "");
const BREAKDOWN = {
  summary: "Reply-to-comment tier list: answer a viewer's question by ranking options on a board.",
  whyItWorks: ["The comment hook borrows social proof", "Each reveal is a mini payoff"],
  hook: { text: "Ranking every car in this game", style: "number", seconds: 2.5, visual: "Comment sticker over gameplay" },
  beats: [
    { start: 0, end: 2.5, purpose: "hook", visual: "comment sticker" },
    { start: 2.5, end: 9, purpose: "rank items", visual: "tier board fills in" },
    { start: 9, end: 12, purpose: "cta", visual: "end card" },
  ],
  pacing: { cuts: 2, avgShotSec: 4, notes: "Cut on every new item" },
  captions: { style: "hormozi", wordsPerCaption: 2, notes: "Yellow active word" },
  overlays: [{ kind: "tier", atSec: 3, description: "Items drop into S-D tiers" }, { kind: "laser", atSec: 1, description: "dropped" }],
  voice: { type: "voiceover", tone: "fast, opinionated" },
  cta: { text: "Follow for part 2", atSec: 10 },
  lengthSec: 12,
  recipe: "1. Open on a viewer comment asking for a ranking. 2. Rank 3-5 items, one per beat. 3. End on the CTA.",
};

const seen: { system: string; user: string; media: boolean }[] = [];
let llm: http.Server;
let app: http.Server;
let base = "";
let cookie = "";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmt-"));
const video = path.join(dir, "ref.mp4");

beforeAll(() => {
  // Black, white, black, 4 s each: two scene cuts, at 4 s and 8 s.
  if (ffmpegAvailable())
    execFileSync("ffmpeg", ["-v", "error", "-y", ...["black", "white", "black"].flatMap((c) => ["-f", "lavfi", "-i", `color=c=${c}:s=360x640:r=30:d=4`]), "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1[v]", "-map", "[v]", "-map", "3:a", "-t", "12", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", video]);
  llm = http
    .createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw);
        const user = body.messages[1].content;
        const text = Array.isArray(user) ? user[0].text : user;
        seen.push({ system: body.messages[0].content, user: text, media: Array.isArray(user) });
        const json = /reusable FORMAT/.test(body.messages[0].content)
          ? BREAKDOWN
          : {
              clips: [
                {
                  title: "Every car ranked",
                  angle: "Tier list",
                  hookStyle: "number",
                  hook: "Ranking every car in Car League",
                  narration: "Ranking every car in Car League. The Octane is S tier. Car League is free on Roblox. Play Car League on Roblox.",
                  onScreenText: ["Every car ranked"],
                  cta: "Play Car League on Roblox",
                  shots: [{ footageName: "x", moment: "goal", seconds: 5 }],
                  lengthSec: 20,
                  caption: "Every car ranked",
                  hashtags: ["roblox"],
                  overlays: [
                    { kind: "tier", cue: "The Octane", text: "Octane", tier: "S" },
                    { kind: "emoji", cue: "not in the script", emoji: "🔥" },
                  ],
                },
              ],
            };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: JSON.stringify(json) } }], usage: { cost: 0.004 } }));
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
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_BASE_URL;
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = async (p: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(base + p, { method, headers: { cookie, ...(body && !(body instanceof Uint8Array) ? { "Content-Type": "application/json" } : {}), ...headers }, body: body instanceof Uint8Array ? (body as unknown as BodyInit) : body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  return { status: r.status, body: await r.json() };
};

describe("formats", () => {
  it("cleans a model's breakdown", () => {
    const b = cleanBreakdown({ ...BREAKDOWN, hook: { ...BREAKDOWN.hook, style: "weird" }, captions: { style: "nope", wordsPerCaption: 9 }, beats: [...BREAKDOWN.beats, { start: 5, end: 4, purpose: "backwards" }] }, 12);
    expect(b.hook.style).toBe("other");
    expect(b.captions).toMatchObject({ style: "bold-pop", wordsPerCaption: 4 });
    expect(b.beats).toHaveLength(3);
    expect(b.overlays.map((o) => o.kind)).toEqual(["tier"]);
  });

  it.skipIf(!ffmpegAvailable())("finds scene cuts", async () => {
    const cuts = await sceneCuts(video);
    expect(cuts).toHaveLength(2);
    expect(cuts[0]).toBeCloseTo(4, 0);
    expect(cuts[1]).toBeCloseTo(8, 0);
  });

  it.skipIf(!ffmpegAvailable())("breaks a reference down, then writes plans in that format", async () => {
    await call("/api/auth/signup", "POST", { email: "fmt@test.dev", password: "password123" });
    const up = await call("/api/formats?name=Tier%20list%20reply", "POST", new Uint8Array(fs.readFileSync(video)), { "Content-Type": "video/mp4", "X-File-Name": "ref.mp4" });
    expect(up.status).toBe(201);
    const id = up.body.format.id;
    let f = up.body.format;
    for (let i = 0; i < 100 && f.status === "analyzing"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      f = (await call(`/api/formats/${id}`)).body;
    }
    expect(f.status).toBe("ready");
    expect(f.name).toBe("Tier list reply");
    expect(f.cuts).toHaveLength(2);
    expect(f.breakdown.recipe).toMatch(/Rank 3-5 items/);
    expect(f.breakdown.overlays).toHaveLength(1);
    // The vision model got the video, the cuts and the duration.
    const ask = seen.find((x) => /reusable FORMAT/.test(x.system))!;
    expect(ask.media).toBe(true);
    expect(JSON.parse(ask.user)).toMatchObject({ durationSec: 12, sceneCutsSec: [expect.any(Number), expect.any(Number)] });

    const camp = (await call("/api/campaigns", "POST", { text: brief })).body.campaign;
    const planned = await call(`/api/campaigns/${camp.id}/clips`, "POST", { count: 1, formatId: id });
    expect(planned.status).toBe(201);
    const clip = planned.body.clips[0];
    expect(clip.formatId).toBe(id);
    // Overlays cued to words that aren't in the voiceover are dropped.
    expect(clip.overlays).toEqual([expect.objectContaining({ kind: "tier", cue: "The Octane", tier: "S" })]);
    // The planner got the format's recipe — and not the reference's transcript.
    const plan = JSON.parse([...seen].reverse().find((x) => !/reusable FORMAT/.test(x.system))!.user);
    expect(plan.format).toMatchObject({ name: "Tier list reply", recipe: BREAKDOWN.recipe, hookStyle: "number" });
    // Not even the reference's hook line: the recipe carries the hook as a fill-in pattern.
    expect(JSON.stringify(plan.format)).not.toContain(BREAKDOWN.hook.text);

    // Usage: the breakdown counts as its own kind of AI work.
    const usage = (await call("/api/usage")).body.months[0].usage.ai;
    expect(usage.format.calls).toBe(1);
    // Not ready → refused; unknown id → refused.
    expect((await call(`/api/campaigns/${camp.id}/clips`, "POST", { count: 1, formatId: "fmt_nope" })).status).toBe(400);
    expect((await call(`/api/formats/${id}`, "DELETE")).body.formats).toHaveLength(0);
  }, 60_000);
});
