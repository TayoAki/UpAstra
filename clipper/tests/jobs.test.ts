import { afterEach, describe, expect, it } from "vitest";
import { cancelWaiting, isPending, submitJob, waitingCount, type JobKind } from "../server/jobs";

// B1.3: one controller for renders, caption jobs and format breakdowns:
// weighted by CPU, fair across workspaces, woken by enqueue (no polling).
const tick = () => new Promise((r) => setImmediate(r));
afterEach(() => {
  delete process.env.JOB_CAPACITY;
});

function harness() {
  const started: string[] = [];
  const finish = new Map<string, () => void>();
  let live = 0;
  let peak = 0;
  const job = (id: string, workspaceId: string, kind: JobKind) =>
    submitJob({
      id,
      workspaceId,
      kind,
      run: () =>
        new Promise<void>((resolve) => {
          started.push(id);
          peak = Math.max(peak, ++live);
          finish.set(id, () => {
            live--;
            resolve();
          });
        }),
    });
  const done = async (id: string) => {
    finish.get(id)!();
    await tick();
    await tick();
  };
  return { started, job, done, peak: () => peak };
}

describe("job controller", () => {
  it("takes turns between workspaces", async () => {
    process.env.JOB_CAPACITY = "1";
    const h = harness();
    h.job("a1", "ws_a", "caption");
    h.job("a2", "ws_a", "caption");
    h.job("a3", "ws_a", "caption");
    h.job("b1", "ws_b", "caption");
    await tick();
    expect(h.started).toEqual(["a1"]);
    await h.done("a1");
    await h.done("b1");
    await h.done("a2");
    await h.done("a3");
    expect(h.started).toEqual(["a1", "b1", "a2", "a3"]);
  });

  it("weighs a render as two light jobs and never lets light jobs starve it", async () => {
    process.env.JOB_CAPACITY = "2";
    const h = harness();
    h.job("c1", "ws_c", "caption");
    h.job("r1", "ws_d", "render");
    h.job("c2", "ws_c", "caption");
    h.job("c3", "ws_e", "caption");
    await tick();
    // c1 runs; the render is next in turn and needs both units, so it waits for c1 alone.
    expect(h.started).toEqual(["c1"]);
    await h.done("c1");
    expect(h.started).toEqual(["c1", "r1"]);
    await h.done("r1");
    expect(h.started.slice(2).sort()).toEqual(["c2", "c3"]);
    expect(h.peak()).toBe(2);
    await h.done("c2");
    await h.done("c3");
  });

  it("knows what's pending, counts per workspace and kind, and can drop a waiting job", async () => {
    process.env.JOB_CAPACITY = "1";
    const h = harness();
    h.job("x1", "ws_x", "format");
    h.job("x2", "ws_x", "format");
    h.job("x3", "ws_x", "render");
    await tick();
    expect(isPending("x1")).toBe(true);
    expect(waitingCount("ws_x", "format")).toBe(1);
    expect(cancelWaiting("x2")).toBe(true);
    expect(cancelWaiting("x1")).toBe(false); // running, not waiting
    expect(isPending("x2")).toBe(false);
    await h.done("x1");
    expect(h.started).toEqual(["x1", "x3"]);
    await h.done("x3");
    expect(isPending("x3")).toBe(false);
  });
});
