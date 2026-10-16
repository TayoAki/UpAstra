import { spawnSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { cancelJob, currentSignal, isPending, submitJob } from "../server/jobs";
import { chatJSON } from "../server/llm";
import { run } from "../server/media";

// B1.4: running work can be cancelled (its processes die with it), and AI
// calls retry rate limits and server errors instead of failing a render.
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("cancelling a job", () => {
  it("drops a waiting job and aborts a running one, killing its processes", async () => {
    let seen: AbortSignal | undefined;
    let outcome = "";
    submitJob({
      id: "cancel_run",
      workspaceId: "ws_cancel",
      kind: "render",
      run: async () => {
        seen = currentSignal();
        try {
          await run("sh", ["-c", "sleep 38.41"]);
          outcome = "finished";
        } catch (err) {
          outcome = (err as Error).message;
        }
      },
    });
    await tick(150);
    expect(seen).toBeDefined();
    expect(isPending("cancel_run")).toBe(true);
    expect(cancelJob("cancel_run")).toBe(true);
    await tick(300);
    expect(seen!.aborted).toBe(true);
    expect(outcome).toMatch(/cancel/i);
    expect(isPending("cancel_run")).toBe(false);
    const ps = spawnSync("ps", ["-eo", "args"], { encoding: "utf8" });
    expect(ps.stdout.split("\n").filter((l) => l.startsWith("sleep 38.41"))).toHaveLength(0);
    expect(cancelJob("nothing_here")).toBe(false);
  });
});

describe("AI calls", () => {
  let calls = 0;
  let script: number[] = [];
  const server = http
    .createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        calls++;
        const status = script.shift() ?? 200;
        if (status !== 200) {
          res.writeHead(status, { "Retry-After": "0", "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "slow down" } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ model: "m", choices: [{ message: { content: '{"ok":true}' } }], usage: { cost: 0.001 } }));
      });
    })
    .listen(0);
  process.env.OPENROUTER_API_KEY = "test";
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  afterAll(() => {
    server.close();
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_BASE_URL;
  });

  it("retries a rate limit or server error, then gives up", async () => {
    calls = 0;
    script = [429, 503];
    expect((await chatJSON<{ ok: boolean }>("script", "sys", "hi")).json).toEqual({ ok: true });
    expect(calls).toBe(3);
    calls = 0;
    script = [500, 500, 500, 500];
    await expect(chatJSON("script", "sys", "hi")).rejects.toThrow(/AI 500/);
    expect(calls).toBe(3);
    calls = 0;
    script = [401];
    await expect(chatJSON("script", "sys", "hi")).rejects.toThrow(/AI 401/);
    expect(calls).toBe(1);
  }, 30_000);
});
