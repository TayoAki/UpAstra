import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { childEnv, run } from "../server/media";

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

  it("childEnv drops anything not on the list", () => {
    const env = childEnv({ PATH: "/bin", HOME: "/root", AWS_SECRET_ACCESS_KEY: "x", FONTCONFIG_PATH: "/f", XDG_CACHE_HOME: "/c" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/root", FONTCONFIG_PATH: "/f", XDG_CACHE_HOME: "/c" });
  });

  it("kills grandchildren on timeout", async () => {
    // An odd duration so the check can't match anything else on the machine.
    await expect(run("sh", ["-c", "sleep 37.31 & wait"], 300)).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 300));
    const ps = spawnSync("sh", ["-c", "ps -eo args | grep -c '^sleep 37.31' || true"], { encoding: "utf8" });
    expect(Number(ps.stdout.trim())).toBe(0);
  });
});
