// One controller for the server's CPU-heavy work: renders, caption jobs and
// format breakdowns share JOB_CAPACITY units (default 2). A render (cutting
// and encoding 1080×1920) weighs 2, a caption job or breakdown 1.
// Workspaces take turns, oldest job first within each, and a job that
// doesn't fit yet waits rather than being skipped, so light jobs can't
// starve renders. Enqueueing wakes the controller; nothing polls.

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
const running = new Map<string, { job: Job; weight: number }>();
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
    running.set(job.id, { job, weight });
    lastTurn = job.workspaceId;
    void job
      .run()
      .catch((err) => console.error(`[jobs] ${job.kind} ${job.id} failed:`, (err as Error).message))
      .finally(() => {
        used -= weight;
        running.delete(job.id);
        // Forget workspaces with nothing left, so the ring doesn't grow forever.
        if (!waiting.some((j) => j.workspaceId === job.workspaceId) && ![...running.values()].some((r) => r.job.workspaceId === job.workspaceId)) {
          const i = ring.indexOf(job.workspaceId);
          if (i >= 0) {
            ring.splice(i, 1);
            if (lastTurn === job.workspaceId) lastTurn = ring[(i - 1 + ring.length) % ring.length];
          }
        }
        drain();
      });
  }
}

/** Waiting or running. */
export const isPending = (id: string) => running.has(id) || waiting.some((j) => j.id === id);
export const isRunning = (id: string) => running.has(id);
export const waitingCount = (workspaceId: string, kind: JobKind) => waiting.filter((j) => j.workspaceId === workspaceId && j.kind === kind).length;
export const pendingCount = (kind?: JobKind) => waiting.filter((j) => !kind || j.kind === kind).length + [...running.values()].filter((r) => !kind || r.job.kind === kind).length;

/** Drop a job that hasn't started; false if it's running or unknown. */
export function cancelWaiting(id: string): boolean {
  const i = waiting.findIndex((j) => j.id === id);
  if (i < 0) return false;
  waiting.splice(i, 1);
  return true;
}
