import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { childEnv, hardenInputs, liveChildren, run } from "../server/media";

// B0.1: ffmpeg, ffprobe and whisper never see the server's secrets, and a
// timeout kills the whole process tree, not just the direct child.
describe("subprocess environment", () => {
  const saved = { ...process.env };
  beforeAll(() => {
    process.env.OPENROUTER_API_KEY = "sk-or-secret";
    process.env.DATABASE_URL = "postgres://u:p@h/db";
    process.env.CLIP_SECRET = "s3cret";
    process.env.LANG = "C.UTF-8";
  });
  afterAll(() => {
    process.env = saved;
  });

  it("passes only an allowlist", async () => {
    const { stdout } = await run("sh", ["-c", "env"]);
    expect(stdout).not.toMatch(/sk-or-secret|postgres:\/\/|s3cret/);
    expect(stdout).toMatch(/^PATH=/m);
    expect(stdout).toMatch(/^LANG=C\.UTF-8$/m);
  });

  it("childEnv drops anything not on the list, but keeps proxy routing", () => {
    const env = childEnv({ PATH: "/bin", HOME: "/root", AWS_SECRET_ACCESS_KEY: "x", FONTCONFIG_PATH: "/f", XDG_CACHE_HOME: "/c", no_proxy: "127.0.0.1", NO_PROXY: "s3.local", http_proxy: "http://p:1" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/root", FONTCONFIG_PATH: "/f", XDG_CACHE_HOME: "/c", no_proxy: "127.0.0.1", NO_PROXY: "s3.local", http_proxy: "http://p:1" });
  });

  it("lets https inputs go through an HTTP proxy", () => {
    const args = hardenInputs("ffmpeg", ["-i", "https://example.com/a.mp4"]);
    expect(args[args.indexOf("-protocol_whitelist") + 1]).toContain("httpproxy");
  });

  it("tracks running children so they can be killed when the server exits", async () => {
    const p = run("sh", ["-c", "sleep 0.3"]);
    expect(liveChildren()).toBe(1);
    await p;
    expect(liveChildren()).toBe(0);
  });

  it("kills grandchildren on timeout", async () => {
    // An odd duration so the check can't match anything else on the machine.
    await expect(run("sh", ["-c", "sleep 37.31 & wait"], 300)).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 300));
    const ps = spawnSync("ps", ["-eo", "args"], { encoding: "utf8" });
    expect(ps.status, "ps must be available for this check").toBe(0);
    expect(ps.stdout.split("\n").filter((l) => l.startsWith("sleep 37.31"))).toHaveLength(0);
  });
});
