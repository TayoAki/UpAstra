import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAss, chunk, timeWords } from "../server/captions";
import { cleanMoments, parseTime, pickMoment } from "../server/moments";
import { createApp } from "../server/app";
import { initAuth } from "../server/auth";
import { useMemoryBackend } from "../server/db";
import { setAISimulated } from "../server/llm";
import { ffmpegAvailable } from "../server/media";

describe("captions", () => {
  const script = "Soccer, but with cars. This is Car League. Play Car League on Roblox.";
  it("matches sentences to speech spans when they line up", () => {
    const words = timeWords(script, 10, [
      { start: 0.1, end: 2 },
      { start: 2.4, end: 4 },
      { start: 4.5, end: 7 },
    ]);
    expect(words[0].start).toBeCloseTo(0.1);
    expect(words.find((w) => w.text === "This")!.start).toBeCloseTo(2.4);
    expect(words.at(-1)!.end).toBeCloseTo(7);
  });
  it("spreads words over the time when spans don't line up, and chunks them", () => {
    const words = timeWords(script, 9);
    expect(words.at(-1)!.end).toBeCloseTo(9);
    const caps = chunk(words);
    expect(caps.every((c) => c.text.split(" ").length <= 3)).toBe(true);
    expect(caps[0].text).toBe("Soccer,");
  });
  it("writes a valid ASS file with hook, captions and CTA", () => {
    const ass = buildAss({ hook: "Soccer {but} with cars", captions: chunk(timeWords(script, 9)), cta: "Play Car League on Roblox", ctaFrom: 7, duration: 10 });
    expect(ass).toMatch(/Style: Hook/);
    expect(ass).toMatch(/Dialogue: 9,0:00:07.00,0:00:10.00,Cta,,0,0,0,,.*Play Car League on Roblox/);
    expect(ass).not.toMatch(/\{but\}/);
  });
});

describe("moments", () => {
  it("parses MM:SS and drops times past the end of the footage", () => {
    expect(parseTime("01:05")).toBe(65);
    expect(parseTime("1:02:03")).toBe(3723);
    const m = cleanMoments({ moments: [{ start: "00:56", end: "01:05", type: "goal", description: "goal", score: 8 }, { start: "08:40", end: "08:50", type: "goal", description: "made up" }, { start: "02:00", end: "01:50", type: "weird" }] }, 495);
    expect(m).toHaveLength(2);
    expect(m[1]).toMatchObject({ start: 110, end: 120, type: "other" });
  });
  it("picks the moment that fits the shot and doesn't reuse it", () => {
    const moments = cleanMoments({ moments: [{ start: "00:10", end: "00:20", type: "boost", description: "boosts up the wall", score: 6 }, { start: "01:00", end: "01:10", type: "goal", description: "last-second goal", score: 7 }] }, 300);
    const used = new Set<string>();
    const a = pickMoment("a goal going into the net", moments, used)!;
    expect(a.type).toBe("goal");
    used.add(`${a.start}-${a.end}`);
    expect(pickMoment("another goal", moments, used)!.type).toBe("boost");
  });
});

// The full pipeline against a generated video served over HTTP: cache → probe →
// cut → concat → captions → upload → stream back with ranges.
describe.skipIf(!ffmpegAvailable())("render pipeline", () => {
  let tmp = "";
  let videoServer: http.Server;
  let videoUrl = "";
  let app: http.Server;
  let base = "";
  let cookie = "";
  const api = async (p: string, method = "GET", body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rtest-"));
    process.env.DATA_DIR = tmp;
    process.env.ALLOW_PRIVATE_FETCH = "1";
    const src = path.join(tmp, "game.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=40", "-f", "lavfi", "-i", "sine=frequency=440:duration=40", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", src]);
    videoServer = http.createServer((req, res) => {
      const size = fs.statSync(src).size;
      const m = String(req.headers.range ?? "").match(/bytes=(\d+)-(\d*)/);
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Number(m[2]) : size - 1;
      res.writeHead(m ? 206 : 200, { "Content-Type": "video/mp4", "Content-Length": end - start + 1, "Accept-Ranges": "bytes", ...(m ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}) });
      fs.createReadStream(src, { start, end }).pipe(res);
    }).listen(0);
    videoUrl = `http://127.0.0.1:${(videoServer.address() as AddressInfo).port}/game.mp4`;
    useMemoryBackend();
    setAISimulated(true);
    initAuth();
    app = createApp().listen(0);
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    app?.close();
    videoServer?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.ALLOW_PRIVATE_FETCH;
  });

  it("renders an approved plan into a 9:16 video with captions", async () => {
    await api("/api/auth/signup", "POST", { email: "r@test.dev", password: "password123" });
    const brief = `Game Link: https://example.com/game\nThe name "Turbo Ball" must be spoken.\nEncourage viewers to play Turbo Ball now near the end of the video.\nCPM: $1\nVideos 10-20 seconds.\nFootage: ${videoUrl}`;
    const c = await api("/api/campaigns", "POST", { text: brief });
    expect(c.status).toBe(201);
    const id = c.body.campaign.id;
    // A direct video link is footage too; add it explicitly for the test.
    await api(`/api/campaigns/${id}`, "PUT", { brief: { ...c.body.campaign.brief, footage: [{ label: "Gameplay", url: videoUrl }] } });
    const st = await api(`/api/campaigns/${id}/footage/refresh`, "POST", {});
    const camp = st.body.campaigns.find((x: { id: string }) => x.id === id);
    expect(camp.footage).toHaveLength(1);
    expect(camp.footage[0].kind).toBe("video");
    const planned = await api(`/api/campaigns/${id}/clips`, "POST", { count: 1 });
    const clip = planned.body.clips[0];
    const r = await api(`/api/clips/${clip.id}/render`, "POST", { voice: "none", override: true });
    expect(r.status).toBe(202);
    let done: { status: string; error?: string; videoKey?: string; durationSec?: number } | undefined;
    for (let i = 0; i < 120 && !done; i++) {
      await new Promise((res) => setTimeout(res, 500));
      const s = await api("/api/state");
      const rr = s.body.clips.find((x: { id: string }) => x.id === clip.id).render;
      if (["done", "failed"].includes(rr.status)) done = rr;
    }
    expect(done?.error).toBeUndefined();
    expect(done?.status).toBe("done");
    const v = await fetch(`${base}/api/clips/${clip.id}/video`, { headers: { cookie, Range: "bytes=0-1023" } });
    expect(v.status).toBe(206);
    const full = Buffer.from(await (await fetch(`${base}/api/clips/${clip.id}/video`, { headers: { cookie } })).arrayBuffer());
    // A signed link plays without a session, and stops working when tampered with.
    const link = (await api(`/api/clips/${clip.id}/link`)).body.url as string;
    expect(link).toMatch(/\/v\/ws_[\w]+\/clip_[\w]+\.mp4\?e=\d+&s=/);
    const pub = await fetch(link, { headers: { Range: "bytes=0-99" } });
    expect(pub.status).toBe(206);
    expect(pub.headers.get("content-type")).toBe("video/mp4");
    expect((await fetch(link.replace(/s=./, "s=x"))).status).toBe(404);
    const out = path.join(tmp, "out.mp4");
    fs.writeFileSync(out, full);
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height:format=duration", "-of", "json", out]).toString());
    expect(probe.streams[0]).toMatchObject({ width: 1080, height: 1920 });
    expect(Number(probe.format.duration)).toBeGreaterThan(9);

    // The render keeps its parts, so the editor can open it as a timeline.
    const pack = await api(`/api/clips/${clip.id}/edit-pack`);
    expect(pack.status).toBe(200);
    expect(pack.body).toMatchObject({ width: 1080, height: 1920, fps: 30, saveUrl: `/api/clips/${clip.id}/edited` });
    expect(pack.body.shots.length).toBeGreaterThan(0);
    expect(pack.body.voice).toBeUndefined(); // rendered with no voice
    expect(pack.body.captions[0].words.length).toBeGreaterThan(0);
    expect(pack.body.hook.text).toBe(clip.hook);
    const shotSum = pack.body.shots.reduce((t: number, x: { seconds: number }) => t + x.seconds, 0);
    expect(Math.abs(shotSum - pack.body.duration)).toBeLessThan(0.5);
    const part = await fetch(base + pack.body.shots[0].url, { headers: { cookie } });
    expect(part.status).toBe(200);
    expect(part.headers.get("content-type")).toBe("video/mp4");
    expect((await fetch(`${base}/api/clips/${clip.id}/parts/..%2F..%2Fetc`, { headers: { cookie } })).status).toBe(404);

    // Saving an edit replaces the clip's video; a non-video is refused.
    const notVideo = await fetch(`${base}/api/clips/${clip.id}/edited`, { method: "POST", headers: { cookie, "Content-Type": "video/mp4" }, body: Buffer.alloc(5000, 1) });
    expect(notVideo.status).toBe(422);
    const edited = await fetch(`${base}/api/clips/${clip.id}/edited`, { method: "POST", headers: { cookie, "Content-Type": "video/mp4" }, body: fs.readFileSync(path.join(tmp, "game.mp4")) });
    expect(edited.status).toBe(201);
    const afterEdit = (await api("/api/state")).body.clips.find((x: { id: string }) => x.id === clip.id).render;
    expect(afterEdit.editedAt).toBeTruthy();
    expect(afterEdit.durationSec).toBeGreaterThan(39);
    expect(afterEdit.parts.shots.length).toBe(pack.body.shots.length);

    // Uploading your own copy adds a stored file that survives a footage refresh.
    const up = await fetch(`${base}/api/campaigns/${id}/footage/upload`, { method: "POST", headers: { cookie, "Content-Type": "video/mp4", "X-File-Name": "my%20copy.mp4" }, body: fs.readFileSync(path.join(tmp, "game.mp4")) });
    expect(up.status).toBe(201);
    const after = await api(`/api/campaigns/${id}/footage/refresh`, "POST", {});
    const uploaded = after.body.campaigns.find((x: { id: string }) => x.id === id).footage.find((f: { folderLabel: string }) => f.folderLabel === "Your uploads");
    expect(uploaded).toMatchObject({ name: "my copy.mp4", kind: "video" });
    expect(uploaded.storageKey).toMatch(/\/footage\//);
    const bad = await fetch(`${base}/api/campaigns/${id}/footage/upload`, { method: "POST", headers: { cookie, "Content-Type": "text/html" }, body: "<html>" });
    expect(bad.status).toBe(415);
  }, 120_000);
});
