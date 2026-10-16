import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CAPTION_STYLES } from "../shared/caption-styles";
import { speechLoad } from "../shared/rules";
import { BEAT_ANCHORS, HOOK_STYLES, OVERLAY_KINDS, type BeatAnchor, type FormatBreakdown, type HookStyle, type OverlayKind, type ReferenceFormat } from "../shared/types";
import { alert, isUserError } from "./alerts";
import { getDoc, HttpError, loadTenant, log, now, runInWorkspace, save, saveNow, tenantLoadHooks } from "./db";
import { chatJSON, mediaLive, modelFor } from "./llm";
import { netArgs, probe, run } from "./media";
import { currentSignal, errorText, isPending, submitJob, waitingCount } from "./jobs";
import { cachedStep } from "./steps";
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
 "beats": [{"start","end","purpose" (e.g. setup, payoff, twist, proof, cta),"job": what it does for the viewer in a few words,"anchor": what it hangs on (line|visual|cut|text|overlay),"visual","onScreenText","narration"}] covering the whole video,
 "systems": [{"name","job","how"}] for elements that run through the whole video (a running board, a counter, a recurring sound or visual gag),
 "pacing": {"cuts": number of cuts, "avgShotSec", "notes"},
 "captions": {"style": the closest of ${CAPTION_STYLES.map((s) => s.id).join("|")}, "wordsPerCaption": 1-4, "notes"},
 "overlays": [{"kind": one of ${OVERLAY_KINDS.map((k) => k.id).join("|")}, "atSec", "description", "example"}] for comment stickers, emoji pops, big pop-up words or ranking boards you see,
 "voice": {"type": "voiceover|on-camera|text-only|none", "tone"},
 "cta": {"text", "atSec"},
 "lengthSec",
 "recipe": numbered step-by-step instructions (under 160 words) for making a NEW video in this format: what each beat must do and for how long, the hook pattern as a fill-in template, where overlays go and what they say in general terms.}
Times are seconds from the start. Describe only what is actually in the video.`;

// ---- Queue ------------------------------------------------------------------------

type Task = { workspaceId: string; formatId: string; /** Re-run the paid breakdown instead of reusing a stored one. */ fresh?: boolean };

export function enqueueFormat(t: Task) {
  if (waitingCount(t.workspaceId, "format") >= 3) throw new HttpError(429, "You already have 3 videos waiting to be broken down. Try again when they finish.");
  submit(t);
}

const submit = (t: Task) =>
  submitJob({
    id: t.formatId,
    workspaceId: t.workspaceId,
    kind: "format",
    run: async () => {
      await loadTenant(t.workspaceId).catch(() => undefined);
      await runInWorkspace(t.workspaceId, undefined, () => analyze(t));
    },
  });

// A breakdown cut off by a restart starts again (once).
tenantLoadHooks.push((ws, doc) => {
  for (const f of doc.formats ?? []) {
    if (f.status !== "analyzing" || isPending(f.id)) continue;
    if (f.resumes) {
      Object.assign(f, { status: "failed", step: undefined, error: "Interrupted by a server restart — try again." });
      continue;
    }
    Object.assign(f, { resumes: 1, step: "Resuming after a server restart" });
    submit({ workspaceId: ws, formatId: f.id });
  }
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
    let speech: FormatBreakdown["speech"];
    if (transcriptionAvailable() && info.hasAudio) {
      set(f, { step: "Transcribing what's said" });
      try {
        const tr = await transcribe(src, {});
        const joiner = tr.joiner ?? " ";
        // How fast it's spoken: words and syllables (or characters/morae) a second, first word to last.
        const span = tr.words.length > 3 ? tr.words[tr.words.length - 1].end - tr.words[0].start : 0;
        if (span > 2) speech = { wordsPerSec: Math.round((tr.words.length / span) * 10) / 10, unitsPerSec: Math.round((speechLoad(tr.words.map((w) => w.text).join(joiner)) / span) * 10) / 10 };
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
    const ask = { durationSec: Math.round(info.duration * 10) / 10, frame: `${info.width}x${info.height}`, transcript: timedText || "(no speech)", sceneCutsSec: cuts.slice(0, 120) };
    // Kept per reference, prompt and model: a resume after a restart doesn't pay again.
    const { value: r, reused } = await cachedStep({
      workspaceId: t.workspaceId,
      receipts: (f.steps ??= {}),
      name: "breakdown",
      kind: "format-breakdown",
      version: 1,
      params: { source: f.sourceKey, ask, system: createHash("sha256").update(SYSTEM).digest("hex"), model: modelFor("format") },
      paid: true,
      fresh: t.fresh || f.refresh,
      save: saveNow,
      run: async () => {
        await buildReferenceProxy(src, proxy);
        return chatJSON<Record<string, unknown>>("format", SYSTEM, ask, 5000, [{ type: "video_url", video_url: { url: `data:video/mp4;base64,${fs.readFileSync(proxy).toString("base64")}` } }]);
      },
    });
    if (reused) r.cost = 0;
    const breakdown = cleanBreakdown(r.json, info.duration, speech);
    set(f, { status: "ready", step: undefined, refresh: undefined, breakdown, cost: Math.round(((f.cost ?? 0) + r.cost) * 10000) / 10000, model: r.model });
    log({ kind: "clip", message: `Broke down "${f.name}" into a format: ${breakdown.summary.slice(0, 120)}`, cost: r.cost || undefined });
  } catch (err) {
    const msg = errorText(err).slice(0, 400);
    console.error(`[formats] ${f.id} failed:`, msg);
    if (!isUserError(msg) && !currentSignal()?.aborted && !/references can be up to|needs an AI key/.test(msg)) alert("format breakdown failed", msg, `workspace ${t.workspaceId} · format ${f.id}`);
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

export function cleanBreakdown(raw: Record<string, unknown>, duration: number, speech?: FormatBreakdown["speech"]): FormatBreakdown {
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
    .map((b) => {
      const anchor = str(b.anchor, 12).toLowerCase() as BeatAnchor;
      return {
        start: num(b.start, duration),
        end: num(b.end, duration),
        purpose: str(b.purpose, 60),
        ...(str(b.job, 120) ? { job: str(b.job, 120) } : {}),
        ...(BEAT_ANCHORS.includes(anchor) ? { anchor } : {}),
        visual: str(b.visual, 240),
        onScreenText: str(b.onScreenText, 160) || undefined,
        narration: str(b.narration, 400) || undefined,
      };
    })
    .filter((b) => b.purpose && b.end > b.start)
    .sort((a, b) => a.start - b.start);
  return {
    summary: str(raw.summary, 600) || "A short-form format.",
    whyItWorks: (Array.isArray(raw.whyItWorks) ? raw.whyItWorks : []).map((x) => str(x, 200)).filter(Boolean).slice(0, 6),
    hook: { text: str(hook.text, 200), style: HOOK_STYLES.some((h) => h.id === style) ? style : "other", seconds: num(hook.seconds, 15) || 2, visual: str(hook.visual, 240) },
    beats,
    systems: (Array.isArray(raw.systems) ? raw.systems : [])
      .slice(0, 6)
      .map((x) => o(x))
      .map((x) => ({ name: str(x.name, 60), job: str(x.job, 120), how: str(x.how, 200) }))
      .filter((x) => x.name && x.job),
    ...(speech && speech.unitsPerSec > 0 ? { speech } : {}),
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

const share = (sec: number, total: number) => (total > 0 ? Math.round((sec / total) * 100) / 100 : 0);

/**
 * What the clip planner gets: the format's structure as relationships (order,
 * share of the runtime, what each part is for) rather than the reference's
 * seconds or words, plus lenses for footage that lacks the reference's elements.
 */
export function formatForPlanner(f: ReferenceFormat) {
  const b = f.breakdown!;
  const total = b.lengthSec || f.durationSec || Math.max(1, ...b.beats.map((x) => x.end));
  const systems = b.systems ?? [];
  return {
    name: f.name,
    summary: b.summary,
    recipe: b.recipe,
    hook: { style: b.hook.style, share: share(b.hook.seconds, total) },
    beats: b.beats.map((x, i) => ({ order: i + 1, share: share(x.end - x.start, total), purpose: x.purpose, job: x.job, anchor: x.anchor, visual: x.visual, onScreenText: x.onScreenText ? "yes" : undefined })),
    systems,
    pacing: { shotsPer10s: total ? Math.round((b.pacing.cuts / total) * 100) / 10 : 0, notes: b.pacing.notes },
    referenceLengthSec: b.lengthSec,
    overlays: b.overlays.map((o) => ({ kind: o.kind, at: share(o.atSec, total), what: o.description })),
    voice: { ...b.voice, ...(b.speech ? { syllablesPerSec: b.speech.unitsPerSec } : {}) },
    whyItWorks: b.whyItWorks,
    lenses: [
      "Keep the beats' order, jobs and shares of the runtime; scale them to this clip's length.",
      "Where this campaign's footage can't show what a beat shows, keep the beat's job and carry it with narration, on-screen text or an overlay instead.",
      ...systems.map((s) => `If you can't keep "${s.name}", give its job (${s.job}) to something that runs through the clip.`),
      "Use this campaign's product and facts; never the reference's subject, words or claims.",
    ],
  };
}

