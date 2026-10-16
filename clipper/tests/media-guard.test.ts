import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffmpegAvailable, hardenInputs, probe } from "../server/media";

// A "video" upload that is really a playlist pointing at an internal address.
let hits = 0;
let server: http.Server;
let file = "";
beforeAll(() => {
  server = http.createServer((_req, res) => (hits++, res.end("x"))).listen(0);
  const port = (server.address() as AddressInfo).port;
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "guard-")), "upload.m3u8");
  fs.writeFileSync(file, `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:${port}/internal.ts\n#EXT-X-ENDLIST\n`);
});
afterAll(() => server?.close());

describe("ffmpeg inputs", () => {
  it("restricts every input to local files (or our storage over https) and media formats", () => {
    expect(hardenInputs("ffmpeg", ["-y", "-i", "/tmp/a.mp4", "-i", "https://bucket/x.mp4?sig", "out.mp4"])).toEqual([
      "-y",
      "-protocol_whitelist", "file", "-format_whitelist", expect.stringContaining("mp4"), "-i", "/tmp/a.mp4",
      "-protocol_whitelist", "https,http,tls,tcp,crypto", "-format_whitelist", expect.any(String), "-i", "https://bucket/x.mp4?sig",
      "out.mp4",
    ]);
    expect(hardenInputs("ffmpeg", ["-i", "x"]).join(" ")).not.toMatch(/hls/);
  });

  it.skipIf(!ffmpegAvailable())("refuses an upload that is really a playlist, without fetching what it points to", async () => {
    await expect(probe(file)).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 300));
    expect(hits).toBe(0);
  });
});
