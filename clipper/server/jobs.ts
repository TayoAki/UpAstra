// One controller for the server's CPU-heavy work: renders, caption jobs and
// format breakdowns share JOB_CAPACITY units (default 2). A render (cutting
// and encoding 1080×1920) weighs 2, a caption job or breakdown 1.
// Workspaces take turns, oldest job first within each, and a job that
// doesn't fit yet waits rather than being skipped, so light jobs can't
// starve renders. Enqueueing wakes the controller; nothing polls.

import { AsyncLocalStorage } from "node:async_hooks";

export type JobKind = "render" | "caption" | "format";
const WEIGHT: Record<JobKind, number> = { render: 2, caption: 1, format: 1 };

export interface Job {
  /** Unique per piece of work (a clip id, caption job id or format id). */
  id: string;
  workspaceId: string;
  kind: JobKind;
  run: () => Promise<void>;
}

export const capacity = () => Math.max(1, Number(process.env.JOB_CAPACITY ?? 2) || 2);

const waiting: Job[] = [];
const running = new Map<string, { job: Job; weight: number; abort: AbortController }>();
const signals = new AsyncLocalStorage<AbortSignal>();

/** The running job's cancel signal, wherever its work is (ffmpeg runs, AI calls). */
export const currentSignal = () => signals.getStore();

/** Throw if the running job has been cancelled (call between steps). */
export function checkCancelled() {
  const s = currentSignal();
  if (s?.aborted) throw new Error(String(s.reason ?? "Cancelled"));
}

/** Workspaces in the order they first queued work; turns go round this ring. */
const ring: string[] = [];
let lastTurn: string | undefined;
let used = 0;
let scheduled = false;

export function submitJob(job: Job) {
  waiting.push(job);
  if (!ring.includes(job.workspaceId)) ring.push(job.workspaceId);
  wake();
}

/** Run the controller soon (after the current call stack, e.g. once a workspace has loaded). */
export function wake() {
  if (scheduled) return;
  scheduled = true;
  setImmediate(() => {
    scheduled = false;
    drain();
  });
}

/** The next workspace after the last one served that has work waiting, and its oldest job. */
function nextJob(): Job | undefined {
  if (!waiting.length) return undefined;
  const start = lastTurn ? ring.indexOf(lastTurn) + 1 : 0;
  for (let k = 0; k < ring.length; k++) {
    const ws = ring[(start + k) % ring.length];
    const job = waiting.find((j) => j.workspaceId === ws);
    if (job) return job;
  }
  return waiting[0];
}

function drain() {
  for (;;) {
    const job = nextJob();
    if (!job) break;
    const weight = Math.min(WEIGHT[job.kind], capacity());
    if (used + weight > capacity()) break;
    waiting.splice(waiting.indexOf(job), 1);
    used += weight;
    const abort = new AbortController();
    running.set(job.id, { job, weight, abort });
    lastTurn = job.workspaceId;
    void signals
      .run(abort.signal, () => job.run())
      .catch((err) => console.error(`[jobs] ${job.kind} ${job.id} failed:`, (err as Error).message))
      .finally(() => {
        used -= weight;
        running.delete(job.id);
        forgetIfIdle(job.workspaceId);
        drain();
      });
  }
}

/** Forget a workspace with nothing waiting or running, so the ring doesn't grow forever. */
function forgetIfIdle(workspaceId: string) {
  if (waiting.some((j) => j.workspaceId === workspaceId) || [...running.values()].some((r) => r.job.workspaceId === workspaceId)) return;
  const i = ring.indexOf(workspaceId);
  if (i < 0) return;
  ring.splice(i, 1);
  if (lastTurn === workspaceId) lastTurn = ring.length ? ring[(i - 1 + ring.length) % ring.length] : undefined;
}

/** Waiting or running. */
export const isPending = (id: string) => running.has(id) || waiting.some((j) => j.id === id);
export const isRunning = (id: string) => running.has(id);
export const waitingCount = (workspaceId: string, kind: JobKind) => waiting.filter((j) => j.workspaceId === workspaceId && j.kind === kind).length;
export const pendingCount = (kind?: JobKind) => waiting.filter((j) => !kind || j.kind === kind).length + [...running.values()].filter((r) => !kind || r.job.kind === kind).length;

/** Stop a job: drop it if it's waiting, abort it if it's running. False if it's unknown. */
export function cancelJob(id: string, reason = "Cancelled"): boolean {
  if (cancelWaiting(id)) return true;
  const r = running.get(id);
  if (!r) return false;
  r.abort.abort(reason);
  return true;
}

/** Drop a job that hasn't started; false if it's running or unknown. */
export function cancelWaiting(id: string): boolean {
  const i = waiting.findIndex((j) => j.id === id);
  if (i < 0) return false;
  const [job] = waiting.splice(i, 1);
  forgetIfIdle(job.workspaceId);
  return true;
}
