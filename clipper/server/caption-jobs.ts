import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCaptionStyle } from "../shared/caption-styles";
import type { CaptionJob } from "../shared/types";
import { buildAss, groups } from "./captions";
import { getDoc, HttpError, loadTenant, log, now, runInWorkspace, save, tenantLoadHooks } from "./db";
import { prepareFonts } from "./fonts";
import { BT709, burnFilter, probe, run, yuvMatrix } from "./media";
import { videoStore } from "./storage";
import { NO_SPACES, transcribe } from "./transcribe";
import { recordUsage } from "./usage";
import { alert, isUserError } from "./alerts";

// Captions page jobs: transcribe an uploaded video (any of Whisper's ~99
// languages), let the user fix words, then burn styled captions in. One job at
// a time per server: transcription and encoding are CPU-heavy.

type Task = { workspaceId: string; jobId: string; kind: "transcribe" | "render"; actor?: "human" | "agent" };
const queue: Task[] = [];
let busy = false;

export function enqueueCaptionJob(task: Task) {
  const max = Number(process.env.MAX_QUEUED_CAPTION_JOBS ?? 5);
  if (queue.filter((t) => t.workspaceId === task.workspaceId).length >= max) throw new HttpError(429, `You already have ${max} videos waiting for captions. Try again when some finish.`);
  queue.push(task);
  void pump();
}

async function pump() {
  if (busy) return;
  const t = queue.shift();
  if (!t) return;
  busy = true;
  try {
    await loadTenant(t.workspaceId).catch(() => undefined);
    await runInWorkspace(t.workspaceId, undefined, () => runTask(t), t.actor);
  } finally {
    busy = false;
    void pump();
  }
}

// Work cut off by a restart (deploys included) starts again, at most twice.
tenantLoadHooks.push((ws, doc) => {
  let resumed = false;
  for (const j of doc.captionJobs ?? []) {
    if ((j.status !== "transcribing" && j.status !== "rendering") || queue.some((t) => t.jobId === j.id)) continue;
    if ((j.resumes ?? 0) >= 2) {
      Object.assign(j, { status: j.status === "rendering" ? "ready" : "failed", error: "Interrupted by a server restart — try again.", step: undefined });
      continue;
    }
    j.resumes = (j.resumes ?? 0) + 1;
    j.step = "Resuming after a server restart";
    queue.push({ workspaceId: ws, jobId: j.id, kind: j.status === "rendering" ? "render" : "transcribe" });
    resumed = true;
  }
  // Runs once the workspace has finished loading.
  if (resumed) setImmediate(() => void pump());
});

const findJob = (id: string) => getDoc().captionJobs?.find((j) => j.id === id);
const set = (j: CaptionJob, patch: Partial<CaptionJob>) => {
  Object.assign(j, patch, { updatedAt: now() });
  save();
};

async function runTask(t: Task) {
  const j = findJob(t.jobId);
  if (!j) return;
  try {
    if (t.kind === "transcribe") await transcribeJob(j);
    else await renderJob(j, t.workspaceId);
  } catch (err) {
    const msg = (err as Error).message.slice(0, 400);
    console.error(`[captions] ${t.kind} ${j.id} failed:`, msg);
    if (!isUserError(msg)) alert(`caption ${t.kind} failed`, msg.slice(0, 300), `workspace ${t.workspaceId} · job ${j.id}`);
    set(j, t.kind === "render" ? { status: "ready", error: `Render failed: ${msg}`, step: undefined } : { status: "failed", error: msg, step: undefined });
  }
}

async function transcribeJob(j: CaptionJob) {
  set(j, { status: "transcribing", step: "Reading the video", error: undefined });
  const src = await videoStore().readUrl(j.sourceKey);
  const meta = await probe(src);
  if (!meta.hasAudio) throw new Error("This video has no audio track to caption");
  set(j, { width: meta.width || undefined, height: meta.height || undefined, durationSec: Math.round(meta.duration * 100) / 100, step: j.languageHint === "auto" ? "Detecting the language and transcribing" : "Transcribing" });
  const tr = await transcribe(src, { language: j.languageHint, glossary: j.glossary });
  if (!tr.words.length) throw new Error("No speech found in this video");
  set(j, { status: "ready", step: undefined, language: tr.language, joiner: tr.joiner, words: tr.words.map((w) => ({ text: w.text, start: round(w.start), end: round(w.end) })) });
  log({ kind: "clip", message: `Transcribed "${j.name}" (${tr.words.length} words, ${tr.language}).` });
}

async function renderJob(j: CaptionJob, workspaceId: string) {
  set(j, { status: "rendering", step: "Burning in captions", error: undefined });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capjob-"));
  try {
    const brand = getDoc().brand;
    const style = resolveCaptionStyle(brand, j.captions);
    const width = j.width ?? 1080;
    const height = j.height ?? 1920;
    const ass = path.join(dir, "captions.ass");
    fs.writeFileSync(
      ass,
      buildAss({
        hook: "",
        cta: "",
        ctaFrom: Number.MAX_SAFE_INTEGER,
        duration: j.durationSec ?? (j.words.at(-1)?.end ?? 0) + 1,
        captions: groups(j.words, style.wordsPerCaption),
        style,
        joiner: j.joiner ?? (j.language && NO_SPACES.has(j.language) ? "" : " "),
        language: j.language,
        frame: { width, height },
      }),
    );
    const fonts = await prepareFonts(dir, brand);
    const out = path.join(dir, "out.mp4");
    const src = await videoStore().readUrl(j.sourceKey);
    const info = await probe(src).catch(() => undefined);
    await run("ffmpeg", [
      "-v", "error", "-y",
      "-i", src,
      "-vf", burnFilter(ass, fonts, yuvMatrix(info?.colorSpace, info?.height ?? height)),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", ...BT709,
      "-c:a", "aac", "-b:a", "160k",
      "-movflags", "+faststart",
      out,
    ], 60 * 60_000);
    const key = `${workspaceId}/captions/${j.id}/captioned-${Date.now()}.mp4`;
    await videoStore().put(key, out, "video/mp4");
    if (j.outputKey) await videoStore().deletePrefix(j.outputKey).catch(() => undefined);
    set(j, { status: "done", step: undefined, outputKey: key, renderedAt: now() });
    recordUsage("captionJobs", 1);
    recordUsage("captionSec", j.durationSec ?? 0);
    log({ kind: "clip", message: `Captioned "${j.name}" in the ${style.name} style.` });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Apply an edited transcript, caption by caption: each caption keeps its time
 * span; if its word count changed, the words share the span by length.
 */
export function applyEdits(words: CaptionJob["words"], edits: { index: number; count: number; text: string }[]): CaptionJob["words"] {
  const out = [...words];
  // Apply from the end so earlier indexes stay valid.
  for (const e of [...edits].sort((a, b) => b.index - a.index)) {
    const old = out.slice(e.index, e.index + e.count);
    if (!old.length) continue;
    const start = old[0].start;
    const end = old[old.length - 1].end;
    const texts = e.text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    const weights = texts.map((t) => t.length + 1);
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    let t = start;
    const next = texts.map((text, i) => {
      const d = ((end - start) * weights[i]) / sum;
      const w = { text, start: round(t), end: round(t + d) };
      t += d;
      return w;
    });
    // Same number of words: keep each word's own timing.
    const merged = next.length === old.length ? old.map((w, i) => ({ ...w, text: next[i].text })) : next;
    out.splice(e.index, e.count, ...merged);
  }
  return out;
}
