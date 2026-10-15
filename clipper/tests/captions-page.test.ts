import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyEdits } from "../server/caption-jobs";
import { groupWords } from "../shared/caption-styles";
import { createApp } from "../server/app";
import { initAuth } from "../server/auth";
import { useMemoryBackend } from "../server/db";
import { setAISimulated } from "../server/llm";

const words = "esto es carleague futbol con coches".split(" ").map((text, i) => ({ text, start: i, end: i + 0.9 }));

describe("transcript edits", () => {
  it("keeps each word's timing when the word count is unchanged", () => {
    const out = applyEdits(words, [{ index: 0, count: 3, text: "Esto es Carleague," }]);
    expect(out.slice(0, 3)).toEqual([
      { text: "Esto", start: 0, end: 0.9 },
      { text: "es", start: 1, end: 1.9 },
      { text: "Carleague,", start: 2, end: 2.9 },
    ]);
  });

  it("shares a line's time when words are split or merged, and leaves other lines alone", () => {
    const out = applyEdits(words, [
      { index: 0, count: 3, text: "esto es Car League" },
      { index: 3, count: 3, text: "fútbol con coches" },
    ]);
    expect(out.map((w) => w.text)).toEqual(["esto", "es", "Car", "League", "fútbol", "con", "coches"]);
    expect(out[0].start).toBe(0);
    expect(out[3].end).toBeCloseTo(2.9);
    expect(out[4]).toEqual({ text: "fútbol", start: 3, end: 3.9 });
    for (let i = 1; i < out.length; i++) expect(out[i].start).toBeGreaterThanOrEqual(out[i - 1].start);
  });

  it("groups lines the same way on both sides (index of each line's first word)", () => {
    const g = groupWords([...words.slice(0, 2), { text: "carleague,", start: 2, end: 2.9 }, ...words.slice(3)], 4);
    expect(g.map((x) => [x.first, x.words.length])).toEqual([[0, 3], [3, 3]]);
  });
});

describe("captions api without speech-to-text", () => {
  let base = "";
  let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
  beforeAll(() => {
    process.env.WHISPER_BIN = "/nonexistent/whisper-cli";
    useMemoryBackend();
    setAISimulated(true);
    initAuth();
    server = createApp().listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
    delete process.env.WHISPER_BIN;
  });

  it("says so instead of accepting uploads it can't transcribe", async () => {
    const su = await fetch(`${base}/api/auth/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "cap@test.dev", password: "password123" }) });
    const cookie = su.headers.get("set-cookie")!.split(";")[0];
    expect((await (await fetch(`${base}/api/health`)).json()).captions).toBe(false);
    const up = await fetch(`${base}/api/captions`, { method: "POST", headers: { cookie, "Content-Type": "video/mp4", "X-File-Name": "a.mp4" }, body: new Uint8Array(5000) as unknown as BodyInit });
    expect(up.status).toBe(503);
    const bad = await fetch(`${base}/api/captions`, { method: "POST", headers: { cookie, "Content-Type": "text/plain" }, body: "hi" });
    expect(bad.status).toBe(415);
    expect((await fetch(`${base}/api/captions/cap_nope`, { headers: { cookie } })).status).toBe(404);
    const st = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json();
    expect(st.captionJobs).toEqual([]);
  });
});
