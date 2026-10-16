import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cachedStep, canonical, stepKey, type Receipts } from "../server/steps";

// B1.1/B1.2: a step runs once per content key; paid steps are never repeated
// blindly after a crash.
const ws = `ws_steps_${Date.now().toString(36)}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "steps-"));

describe("step keys", () => {
  it("canonicalises by code point and rejects things that aren't plain data", () => {
    expect(canonical({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
    expect(stepKey("cut", 1, { a: 1, b: 2 })).toBe(stepKey("cut", 1, { b: 2, a: 1 }));
    expect(stepKey("cut", 1, { a: 1 })).not.toBe(stepKey("cut", 2, { a: 1 }));
    expect(stepKey("cut", 1, { a: 1 })).not.toBe(stepKey("voice", 1, { a: 1 }));
    // Uppercase sorts before lowercase by code point; localeCompare would not.
    expect(canonical({ b: 1, B: 2 })).toBe('{"B":2,"b":1}');
    expect(() => canonical({ when: new Date() })).toThrow();
    expect(() => canonical({ m: new Map() })).toThrow();
    expect(() => canonical({ n: Number.NaN })).toThrow();
  });
});

describe("cachedStep", () => {
  it("runs once per key and restores the stored file and value", async () => {
    const receipts: Receipts = {};
    let runs = 0;
    const file = path.join(tmp, "out.txt");
    const go = (n: number) =>
      cachedStep({
        workspaceId: ws,
        receipts,
        name: "thing",
        kind: "test",
        version: 1,
        params: { n },
        file,
        save: () => undefined,
        run: async () => {
          runs++;
          fs.writeFileSync(file, `made ${n}`);
          return { n, at: runs };
        },
      });
    const a = await go(1);
    expect(a).toEqual({ value: { n: 1, at: 1 }, reused: false });
    fs.rmSync(file);
    const b = await go(1);
    expect(b).toEqual({ value: { n: 1, at: 1 }, reused: true });
    expect(fs.readFileSync(file, "utf8")).toBe("made 1");
    expect(runs).toBe(1);
    await go(2);
    expect(runs).toBe(2);
    expect(receipts.thing).toMatchObject({ status: "done", key: stepKey("test", 1, { n: 2 }) });
  });

  it("refuses to repeat a paid step whose outcome is unknown", async () => {
    const params = { script: "hello" };
    const receipts: Receipts = { voice: { key: stepKey("voice-test", 1, params), status: "started", at: new Date().toISOString() } };
    let runs = 0;
    const go = () => cachedStep({ workspaceId: ws, receipts, name: "voice", kind: "voice-test", version: 1, params, paid: true, save: () => undefined, run: async () => ++runs });
    await expect(go()).rejects.toThrow(/needs attention|already started/i);
    expect(runs).toBe(0);
    // A different script is a different step: it runs.
    const other = await cachedStep({ workspaceId: ws, receipts, name: "voice", kind: "voice-test", version: 1, params: { script: "bye" }, paid: true, save: () => undefined, run: async () => ++runs });
    expect(other.value).toBe(1);
  });

  it("records a failed run so it can be tried again", async () => {
    const receipts: Receipts = {};
    const go = (fail: boolean) => cachedStep({ workspaceId: ws, receipts, name: "x", kind: "fail-test", version: 1, params: {}, paid: true, save: () => undefined, run: async () => { if (fail) throw new Error("boom"); return 7; } });
    await expect(go(true)).rejects.toThrow("boom");
    expect(receipts.x.status).toBe("failed");
    expect((await go(false)).value).toBe(7);
  });
});
