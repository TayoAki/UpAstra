import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CAPTION_STYLES } from "../shared/caption-styles";
import { HOOK_STYLES, OVERLAY_KINDS, type FormatBreakdown, type HookStyle, type OverlayKind, type ReferenceFormat } from "../shared/types";
import { alert, isUserError } from "./alerts";
import { getDoc, HttpError, loadTenant, log, now, runInWorkspace, save, tenantLoadHooks } from "./db";
import { chatJSON, mediaLive } from "./llm";
import { netArgs, probe, run } from "./media";
import { videoStore } from "./storage";
import { transcribe, transcriptionAvailable } from "./transcribe";

// "Clone a viral video": a reference short is broken down into a reusable
// format — hook, beats with timings, pacing, caption look, overlays, voice and
// call to action — plus a recipe the clip planner follows to make new clips in
// that format from a campaign's own footage. Only the structure is reused,
// never the reference's words, footage or claims.

export const MAX_REFERENCE_SEC = 180;

const SYSTEM = `You are a short-form video strategist. You get one reference video (sampled frames with timestamps burned in, plus audio), its exact transcript with word timings, and the times of its scene cuts.
Break down the reusable FORMAT — the structure that makes it work, not its topic — so a creator can make new videos in the same format about a different product.
Return JSON:
{"summary": one paragraph naming the format (e.g. "reply-to-comment tier list"),
 "whyItWorks": [3-5 short reasons tied to what happens on screen],
 "hook": {"text": the exact opening line or on-screen hook, "style": one of ${HOOK_STYLES.map((h) => h.id).join("|")}, "seconds": how long the hook lasts, "visual": what's on screen during it},
 "beats": [{"start","end","purpose" (e.g. setup, payoff, twist, proof, cta),"visual","onScreenText","narration"}] covering the whole video,
 "pacing": {"cuts": number of cuts, "avgShotSec", "notes"},
 "captions": {"style": the closest of ${CAPTION_STYLES.map((s) => s.id).join("|")}, "wordsPerCaption": 1-4, "notes"},
 "overlays": [{"kind": one of ${OVERLAY_KINDS.map((k) => k.id).join("|")}, "atSec", "description", "example"}] for comment stickers, emoji pops, big pop-up words or ranking boards you see,
 "voice": {"type": "voiceover|on-camera|text-only|none", "tone"},
 "cta": {"text", "atSec"},
 "lengthSec",
 "recipe": numbered step-by-step instructions (under 160 words) for making a NEW video in this format: what each beat must do and for how long, the hook pattern as a fill-in template, where overlays go and what they say in general terms.}
Times are seconds from the start. Describe only what is actually in the video.`;

// ---- Queue ------------------------------------------------------------------------

type Task = { workspaceId: string; formatId: string };
const queue: Task[] = [];
let busy = false;

export function enqueueFormat(t: Task) {
  if (queue.filter((x) => x.workspaceId === t.workspaceId).length >= 3) throw new HttpError(429, "You already have 3 videos waiting to be broken down. Try again when they finish.");
  queue.push(t);
  void pump();
}

async function pump() {
  if (busy) return;
  const t = queue.shift();
  if (!t) return;
  busy = true;
  try {
    await loadTenant(t.workspaceId).catch(() => undefined);
    await runInWorkspace(t.workspaceId, undefined, () => analyze(t));
  } finally {
    busy = false;
    void pump();
  }
}

// A breakdown cut off by a restart starts again (once).
tenantLoadHooks.push((ws, doc) => {
  let resumed = false;
  for (const f of doc.formats ?? []) {
    if (f.status !== "analyzing" || queue.some((t) => t.formatId === f.id)) continue;
    if (f.resumes) {
      Object.assign(f, { status: "failed", step: undefined, error: "Interrupted by a server restart — try again." });
      continue;
    }
    Object.assign(f, { resumes: 1, step: "Resuming after a server restart" });
    queue.push({ workspaceId: ws, formatId: f.id });
    resumed = true;
  }
  if (resumed) setImmediate(() => void pump());
});

const findFormat = (id: string) => getDoc().formats?.find((f) => f.id === id);
const set = (f: ReferenceFormat, patch: Partial<ReferenceFormat>) => {
  Object.assign(f, patch, { updatedAt: now() });
  save();
};

// ---- Analysis ---------------------------------------------------------------------

/** Scene cuts (seconds) from ffmpeg's scene-change score. */
export async function sceneCuts(src: string): Promise<number[]> {
  const { stderr } = await run("ffmpeg", [...netArgs(src), "-v", "info", "-i", src, "-an", "-vf", "select='gt(scene,0.3)',showinfo", "-f", "null", "-"], 10 * 60_000);
  const cuts = [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Math.round(Number(m[1]) * 10) / 10);
  return cuts.filter((t, i) => i === 0 || t - cuts[i - 1] > 0.25);
}

/** A small preview for the vision model: 2 frames a second with the time burned in, and mono audio. */
async function buildReferenceProxy(src: string, out: string) {
  await run("ffmpeg", [
    ...netArgs(src),
    "-v", "error", "-y",
    "-i", src,
    "-vf", "fps=2,scale=432:-2,drawtext=text='%{pts\\:hms}':x=8:y=8:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.7",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "33",
    "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "32k",
    out,
  ], 10 * 60_000);
}

async function analyze(t: Task) {
  const f = findFormat(t.formatId);
  if (!f) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "format-"));
  try {
    set(f, { status: "analyzing", step: "Reading the video", error: undefined });
    const src = await videoStore().readUrl(f.sourceKey);
    const info = await probe(src);
    if (!info.duration) throw new Error("Couldn't read the video");
    if (info.duration > MAX_REFERENCE_SEC) throw new Error(`The video is ${Math.round(info.duration)}s long; references can be up to ${MAX_REFERENCE_SEC / 60} minutes (short-form).`);
    set(f, { durationSec: Math.round(info.duration * 10) / 10, width: info.width, height: info.height });

    let timedText = "";
    if (transcriptionAvailable() && info.hasAudio) {
      set(f, { step: "Transcribing what's said" });
      try {
        const tr = await transcribe(src, {});
        const joiner = tr.joiner ?? " ";
        set(f, { language: tr.language, transcript: tr.words.map((w) => w.text).join(joiner).trim().slice(0, 6000) });
        // Words grouped into short timed lines for the model.
        const lines: string[] = [];
        let cur: { start: number; words: string[] } | undefined;
        for (const w of tr.words) {
          if (!cur || w.start - cur.start > 2.5) {
            if (cur) lines.push(`[${cur.start.toFixed(1)}s] ${cur.words.join(joiner)}`);
            cur = { start: w.start, words: [] };
          }
          cur.words.push(w.text);
        }
        if (cur) lines.push(`[${cur.start.toFixed(1)}s] ${cur.words.join(joiner)}`);
        timedText = lines.join("\n").slice(0, 8000);
      } catch (err) {
        console.error(`[formats] transcription failed for ${f.id}:`, (err as Error).message);
      }
    }

    set(f, { step: "Finding the cuts" });
    const cuts = await sceneCuts(src).catch(() => []);
    set(f, { cuts });

    if (!mediaLive()) throw new Error("Breaking down a video needs an AI key on the server");
    set(f, { step: "Watching the video and writing the format" });
    const proxy = path.join(tmp, "proxy.mp4");
    await buildReferenceProxy(src, proxy);
    const r = await chatJSON<Record<string, unknown>>(
      "format",
      SYSTEM,
      { durationSec: Math.round(info.duration * 10) / 10, frame: `${info.width}x${info.height}`, transcript: timedText || "(no speech)", sceneCutsSec: cuts.slice(0, 120) },
      5000,
      [{ type: "video_url", video_url: { url: `data:video/mp4;base64,${fs.readFileSync(proxy).toString("base64")}` } }],
    );
    const breakdown = cleanBreakdown(r.json, info.duration);
    set(f, { status: "ready", step: undefined, breakdown, cost: Math.round(((f.cost ?? 0) + r.cost) * 10000) / 10000, model: r.model });
    log({ kind: "clip", message: `Broke down "${f.name}" into a format: ${breakdown.summary.slice(0, 120)}`, cost: r.cost || undefined });
  } catch (err) {
    const msg = (err as Error).message.slice(0, 400);
    console.error(`[formats] ${f.id} failed:`, msg);
    if (!isUserError(msg) && !/references can be up to|needs an AI key/.test(msg)) alert("format breakdown failed", msg, `workspace ${t.workspaceId} · format ${f.id}`);
    set(f, { status: "failed", step: undefined, error: msg });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- Cleaning the model's answer ---------------------------------------------------

const str = (v: unknown, n = 400) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
const num = (v: unknown, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(max, Math.round(n * 10) / 10) : 0;
};

export function cleanBreakdown(raw: Record<string, unknown>, duration: number): FormatBreakdown {
  const o = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const hook = o(raw.hook);
  const style = str(hook.style, 20) as HookStyle;
  const caps = o(raw.captions);
  const capStyle = str(caps.style, 20);
  const pacing = o(raw.pacing);
  const voice = o(raw.voice);
  const cta = o(raw.cta);
  const voiceType = str(voice.type, 20);
  const beats = (Array.isArray(raw.beats) ? raw.beats : [])
    .slice(0, 20)
    .map((b) => o(b))
    .map((b) => ({ start: num(b.start, duration), end: num(b.end, duration), purpose: str(b.purpose, 60), visual: str(b.visual, 240), onScreenText: str(b.onScreenText, 160) || undefined, narration: str(b.narration, 400) || undefined }))
    .filter((b) => b.purpose && b.end > b.start)
    .sort((a, b) => a.start - b.start);
  return {
    summary: str(raw.summary, 600) || "A short-form format.",
    whyItWorks: (Array.isArray(raw.whyItWorks) ? raw.whyItWorks : []).map((x) => str(x, 200)).filter(Boolean).slice(0, 6),
    hook: { text: str(hook.text, 200), style: HOOK_STYLES.some((h) => h.id === style) ? style : "other", seconds: num(hook.seconds, 15) || 2, visual: str(hook.visual, 240) },
    beats,
    pacing: { cuts: Math.round(num(pacing.cuts, 500)), avgShotSec: num(pacing.avgShotSec, 60), notes: str(pacing.notes, 300) },
    captions: { style: CAPTION_STYLES.some((s) => s.id === capStyle) ? capStyle : "bold-pop", wordsPerCaption: Math.max(1, Math.min(4, Math.round(num(caps.wordsPerCaption, 4)) || 3)), notes: str(caps.notes, 300) },
    overlays: (Array.isArray(raw.overlays) ? raw.overlays : [])
      .slice(0, 12)
      .map((x) => o(x))
      .filter((x) => OVERLAY_KINDS.some((k) => k.id === x.kind))
      .map((x) => ({ kind: x.kind as OverlayKind, atSec: num(x.atSec, duration), description: str(x.description, 200), example: str(x.example, 140) || undefined })),
    voice: { type: (["voiceover", "on-camera", "text-only", "none"].includes(voiceType) ? voiceType : "voiceover") as FormatBreakdown["voice"]["type"], tone: str(voice.tone, 200) },
    cta: { text: str(cta.text, 200) || undefined, atSec: cta.atSec === undefined ? undefined : num(cta.atSec, duration) },
    lengthSec: num(raw.lengthSec, 600) || Math.round(duration),
    recipe: str(raw.recipe, 2000),
  };
}

/** What the clip planner gets: the format without the reference's own words. */
export function formatForPlanner(f: ReferenceFormat) {
  const b = f.breakdown!;
  return {
    name: f.name,
    summary: b.summary,
    recipe: b.recipe,
    hookStyle: b.hook.style,
    hookSeconds: b.hook.seconds,
    beats: b.beats.map((x) => ({ start: x.start, end: x.end, purpose: x.purpose, visual: x.visual, onScreenText: x.onScreenText ? "yes" : undefined })),
    pacing: b.pacing,
    lengthSec: b.lengthSec,
    overlays: b.overlays.map((o) => ({ kind: o.kind, atSec: o.atSec, what: o.description })),
    voice: b.voice,
    whyItWorks: b.whyItWorks,
  };
}

