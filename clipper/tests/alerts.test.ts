import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alert, isUserError } from "../server/alerts";

const got: { text: string; content: string }[] = [];
let hook: http.Server;
beforeAll(() => {
  hook = http
    .createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => (got.push(JSON.parse(b)), res.end("ok")));
    })
    .listen(0);
  process.env.ALERT_WEBHOOK_URL = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;
});
afterAll(() => {
  hook?.close();
  delete process.env.ALERT_WEBHOOK_URL;
});

describe("operator alerts", () => {
  it("posts to the webhook in a shape Slack and Discord both read, once per problem", async () => {
    alert("render failed", "ffmpeg failed (1): Invalid argument", "workspace ws_1 · clip clip_1");
    alert("render failed", "ffmpeg failed (1): Invalid argument", "workspace ws_2 · clip clip_9"); // same problem: deduped
    alert("server error", "GET /api/state: boom");
    await new Promise((r) => setTimeout(r, 300));
    expect(got).toHaveLength(2);
    expect(got[0].text).toMatch(/UGCMediaClips .* render failed: ffmpeg failed/);
    expect(got[0].content).toBe(got[0].text);
  });

  it("doesn't page anyone for problems users fix themselves", () => {
    expect(isUserError("Couldn't open \"a.mp4\": Google Drive's download limit for this file has been reached")).toBe(true);
    expect(isUserError("Today's AI budget ($5.00) is used up.")).toBe(true);
    expect(isUserError("ffmpeg failed (1): Error reinitializing filters")).toBe(false);
  });
});
