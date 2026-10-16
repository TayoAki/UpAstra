import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { videoStore } from "./storage";

// Expensive render steps (the paid voiceover, each shot cut) run once per
// content key and are kept in storage, so a resume after a restart, a
// re-render or a variant with the same inputs reuses them instead of paying
// or cutting again. Outputs live under a top-level `steps/` prefix: an S3
// lifecycle rule can expire them, and a miss only means recomputing.

/** What happened to each named step of a job, kept on the job itself. */
export interface Receipt {
  key: string;
  status: "started" | "done" | "failed";
  at: string;
  /** Restored from an earlier run instead of being run (and paid for) again. */
  reused?: boolean;
}
export type Receipts = Record<string, Receipt>;

/**
 * JSON with keys sorted by code point, so equal inputs always hash the same.
 * Anything that isn't plain data (a Date, Map, class instance, NaN) throws
 * rather than silently becoming `{}`.
 */
export function canonical(v: unknown): string {
  if (v === null || typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`Can't key a step on ${v}`);
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  throw new Error(`Can't key a step on a ${Object.prototype.toString.call(v)}`);
}

/** The content key of a step: its kind and version plus everything it reads. */
export const stepKey = (kind: string, version: number, params: unknown) =>
  createHash("sha256").update(`${kind}@${version}\n${canonical(params)}`).digest("hex").slice(0, 40);

const base = (workspaceId: string, key: string) => `steps/${workspaceId}/${key}`;

/** Whether a step's result is stored for reuse (without running it). */
export const stepStored = (workspaceId: string, kind: string, version: number, params: unknown) =>
  videoStore()
    .exists(`${base(workspaceId, stepKey(kind, version, params))}.json`)
    .catch(() => false);

export class StepNeedsAttention extends Error {}

/**
 * Run `run` once for this content key, or restore its stored result. With a
 * `file`, the step's output file is stored and restored at that path too.
 * A paid step that was started but never finished (the server stopped
 * mid-call) isn't run again blindly: it may already have been billed.
 */
export async function cachedStep<T>(o: {
  workspaceId: string;
  receipts: Receipts;
  name: string;
  kind: string;
  version: number;
  params: unknown;
  file?: string;
  paid?: boolean;
  /** Persist the receipts. For paid steps it's awaited before the call, so a crash can't lose the "started" mark. */
  save: () => unknown;
  /** Whether a result is good enough to reuse later (default: always). Others are kept only for this `scope`. */
  keep?: (value: T) => boolean;
  /** This run (e.g. a render's requestedAt): a result not worth keeping is still reused when this run resumes. */
  scope?: string;
  /** Run anew even if a result is stored (an explicit "try again"); the new result replaces it. */
  fresh?: boolean;
  /** Only reuse a stored result; never run (and pay for) the step. */
  cachedOnly?: boolean;
  run: () => Promise<T>;
}): Promise<{ value: T; reused: boolean }> {
  const key = stepKey(o.kind, o.version, o.params);
  const scoped = o.scope ? stepKey(o.kind, o.version, { params: o.params, scope: o.scope }) : undefined;
  const store = videoStore();
  const ext = o.file ? path.extname(o.file) : "";
  for (const k of o.fresh ? [] : [key, scoped]) {
    if (!k) continue;
    const at = base(o.workspaceId, k);
    if (!(await store.exists(`${at}.json`).catch(() => false))) continue;
    try {
      const value = JSON.parse(await readText(`${at}.json`)) as T;
      if (o.file) await pipeline((await store.read(`${at}${ext}`)).stream, fs.createWriteStream(o.file));
      o.receipts[o.name] = { key, status: "done", at: new Date().toISOString(), reused: true };
      return { value, reused: true };
    } catch {
      // A broken or half-written entry: run the step again.
    }
  }
  if (o.cachedOnly) throw new StepNeedsAttention(`The ${o.name} step isn't stored any more, so this can't be redone without running it again. Render instead.`);
  const prior = o.receipts[o.name];
  if (o.paid && prior?.key === key && prior.status === "started")
    throw new StepNeedsAttention(`The server restarted while the ${o.name} step was running and it may already have been charged, so it wasn't run again automatically. Start it again to redo it.`);
  o.receipts[o.name] = { key, status: "started", at: new Date().toISOString() };
  if (o.paid) await o.save();
  else void o.save();
  let value: T;
  try {
    value = await o.run();
    const keep = o.keep?.(value) ?? true;
    const target = keep ? key : scoped;
    if (target) {
      const at = base(o.workspaceId, target);
      // The value is written last: its presence means the whole entry is there.
      if (o.file) await store.put(`${at}${ext}`, o.file, "application/octet-stream");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "step-"));
      try {
        fs.writeFileSync(path.join(dir, "v.json"), JSON.stringify(value ?? null));
        await store.put(`${at}.json`, path.join(dir, "v.json"), "application/json");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  } catch (err) {
    o.receipts[o.name] = { key, status: "failed", at: new Date().toISOString() };
    await o.save();
    throw err;
  }
  o.receipts[o.name] = { key, status: "done", at: new Date().toISOString() };
  await o.save();
  return { value, reused: false };
}

async function readText(key: string): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of (await videoStore().read(key)).stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}
