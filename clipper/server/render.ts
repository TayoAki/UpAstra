import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkClip, round2 } from "../shared/rules";
import type { Campaign, Clip, FootageFile, RenderInfo, VoiceOption } from "../shared/types";
import { buildAss, chunk, sentences, timeWords } from "./captions";
import { HttpError, getDoc, loadTenant, log, now, runInWorkspace, save, tenantLoadHooks } from "./db";
import { mediaLive, speak } from "./llm";
import { concat, compose, cutSegment, ffmpegAvailable, run, speechSpans } from "./media";
import { footageSource } from "./footage-cache";
import { analyzeFootage, pickMoment } from "./moments";
import { videoStore } from "./storage";

// The render queue: approved clip plans → finished 9:16 MP4s.
//   1. find moments in each footage file the plan uses (cached)
//   2. voice the narration (optional)
//   3. cut each shot from its source link, framed for 9:16
//   4. burn hook, captions and CTA, mix audio, upload
// Jobs run one at a time in the background; each step is written to the clip
// so the dashboard can show progress.

interface Job {
  workspaceId: string;
  clipId: string;
}
const queue: Job[] = [];
const active = new Set<string>();
let running = 0;
const concurrency = () => Math.max(1, Number(process.env.RENDER_CONCURRENCY ?? 1));

export const renderAvailable = () => ffmpegAvailable();

// A render that was in flight when the server restarted can't resume.
tenantLoadHooks.push((_ws, doc) => {
  for (const c of doc.clips)
    if (c.render && !["done", "failed"].includes(c.render.status) && !active.has(c.id)) {
      c.render = { ...c.render, status: "failed", step: "Interrupted by a restart", error: "Interrupted by a server restart — render it again." };
      if (c.status === "rendering") c.status = "approved";
    }
});

export function enqueueRender(workspaceId: string, clip: Clip, voice: VoiceOption) {
  if (!ffmpegAvailable()) throw new HttpError(503, "Rendering isn't available on this server (ffmpeg missing)");
  if (active.has(clip.id) || queue.some((j) => j.clipId === clip.id)) throw new HttpError(409, "This clip is already rendering");
  clip.render = { status: "queued", step: "Waiting in the render queue", voice, requestedAt: now(), cost: 0 };
  clip.status = "rendering";
  queue.push({ workspaceId, clipId: clip.id });
  setImmediate(pump);
}

function pump() {
  while (running < concurrency() && queue.length) {
    const job = queue.shift()!;
    running++;
    active.add(job.clipId);
    void process_(job).finally(() => {
      running--;
      active.delete(job.clipId);
      pump();
    });
  }
}

async function process_(job: Job) {
  try {
    await loadTenant(job.workspaceId);
  } catch {
    return; // workspace deleted while queued
  }
  await runInWorkspace(job.workspaceId, undefined, async () => {
    const clip = getDoc().clips.find((c) => c.id === job.clipId);
    if (!clip?.render) return;
    const r = clip.render;
    try {
      await renderClip(job.workspaceId, clip, r);
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[render] ${clip.id} failed:`, msg);
      const c = getDoc().clips.find((x) => x.id === job.clipId);
      if (c?.render) {
        c.render.status = "failed";
        c.render.error = msg.slice(0, 500);
        c.render.step = "Failed";
        c.render.finishedAt = now();
        if (c.status === "rendering") c.status = "approved";
        log({ campaignId: c.campaignId, kind: "clip", message: `Render failed for "${c.title}": ${msg.slice(0, 160)}`, cost: c.render.cost || undefined });
      }
    } finally {
      save();
    }
  });
}

const step = (r: RenderInfo, status: RenderInfo["status"], text: string) => {
  r.status = status;
  r.step = text;
  save();
};

/** The footage file each shot should use: its own, or the next video in the campaign. */
function footageFor(c: Campaign, id: string | undefined, i: number): FootageFile {
  const videos = c.footage.filter((f) => f.kind === "video");
  if (!videos.length) throw new Error("This campaign has no video footage to cut from");
  return videos.find((f) => f.id === id) ?? videos[i % videos.length];
}

async function renderClip(workspaceId: string, clip: Clip, r: RenderInfo) {
  const c = getDoc().campaigns.find((x) => x.id === clip.campaignId);
  if (!c) throw new Error("Campaign not found");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "render-"));
  try {
    // 1. Moments in each footage file this clip uses.
    const shots = clip.shots.length ? clip.shots : [{ moment: clip.hook, seconds: clip.lengthSec }];
    const files = shots.map((s, i) => footageFor(c, s.footageId, i));
    const failed = new Map<string, string>();
    const ensure = async (f: FootageFile) => {
      if (f.analyzedAt && f.durationSec) return true;
      step(r, "analyzing", `Fetching and watching "${f.name}"`);
      try {
        const a = await analyzeFootage(f, c.brief);
        r.cost = round2((r.cost + a.cost) * 1000) / 1000;
        log({ campaignId: c.id, kind: "footage", message: `Found ${f.moments?.length ?? 0} moments in "${f.name}".`, cost: a.cost || undefined });
      } catch (err) {
        f.analysisError = (err as Error).message.slice(0, 300);
      }
      save();
      if (!f.durationSec) failed.set(f.id, f.analysisError ?? "couldn't open it");
      return !!f.durationSec;
    };
    for (const f of [...new Map(files.map((x) => [x.id, x])).values()]) await ensure(f);

    // Footage that couldn't be fetched (usually Drive's download limit) is swapped
    // for footage that is available: uploads and files already in storage.
    const substitutes: string[] = [];
    if (failed.size) {
      const pool = c.footage.filter((v) => v.kind === "video" && !failed.has(v.id) && (v.storageKey || v.durationSec));
      const usable: FootageFile[] = [];
      for (const v of pool) if (await ensure(v)) usable.push(v);
      if (!usable.length) {
        const [id, why] = [...failed][0];
        throw new Error(`Couldn't open "${c.footage.find((v) => v.id === id)?.name}": ${why}`);
      }
      let k = 0;
      for (let i = 0; i < files.length; i++)
        if (failed.has(files[i].id)) {
          const sub = usable[k++ % usable.length];
          substitutes.push(`${files[i].name} → ${sub.name}`);
          files[i] = sub;
        }
      log({ campaignId: c.id, kind: "clip", message: `Couldn't fetch ${failed.size} footage file(s) for "${clip.title}"; used available footage instead (${substitutes.join(", ")}).` });
    }

    // 2. Voiceover.
    let voicePath: string | undefined;
    let spans: { start: number; end: number }[] | undefined;
    let duration = clip.lengthSec;
    if (r.voice !== "none") {
      if (!mediaLive()) throw new Error("AI voice needs OPENROUTER_API_KEY — render with “No voice” instead");
      step(r, "voicing", `Recording the voiceover (${r.voice})`);
      const v = await speak(clip.narration, r.voice);
      r.cost = round2((r.cost + v.cost) * 1000) / 1000;
      const pcm = path.join(tmp, "vo.pcm");
      voicePath = path.join(tmp, "vo.wav");
      fs.writeFileSync(pcm, v.pcm);
      await run("ffmpeg", ["-v", "error", "-y", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", pcm, voicePath]);
      const spoken = v.pcm.length / 48000;
      spans = await speechSpans(voicePath, spoken);
      duration = Math.max(c.brief.lengthSec.min, spoken + 0.8);
    }
    duration = Math.round(Math.min(Math.max(duration, 5), 180) * 100) / 100;

    // 3. Cut the shots, scaled to fill the clip.
    step(r, "rendering", "Cutting shots from the footage");
    const planned = shots.reduce((s, x) => s + Math.max(1, x.seconds), 0) || 1;
    const used = new Set<string>();
    const segments: NonNullable<RenderInfo["segments"]> = [];
    const parts: string[] = [];
    let left = duration;
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i];
      const f = files[i];
      const len = i === shots.length - 1 ? left : Math.max(1.5, Math.round(((Math.max(1, s.seconds) * duration) / planned) * 100) / 100);
      left = Math.max(1.5, left - len);
      const total = f.durationSec ?? 0;
      const m = pickMoment(s.moment, f.moments ?? [], used);
      let start: number;
      if (m) {
        used.add(`${m.start}-${m.end}`);
        // Land goals and saves inside the shot with a beat after; everything else starts on the moment.
        start = ["goal", "save", "near-miss"].includes(m.type) ? m.end - len + 1 : m.start;
      } else start = total * (0.12 + (0.7 * (i + 1)) / (shots.length + 1));
      start = Math.max(0, Math.min(start, Math.max(0, total - len - 0.5)));
      step(r, "rendering", `Cutting shot ${i + 1} of ${shots.length} from "${f.name}"`);
      const out = path.join(tmp, `seg${i}.mp4`);
      await cutSegment(await footageSource(f), start, len, f.hasAudio !== false, out);
      parts.push(out);
      const swapped = substitutes.find((x) => x.endsWith(`→ ${f.name}`) && x.startsWith(s.footageName ?? "\u0000"));
      segments.push({ footageName: f.name, start: Math.round(start * 10) / 10, seconds: Math.round(len * 10) / 10, moment: [swapped ? `(instead of ${s.footageName})` : "", m?.description ?? ""].filter(Boolean).join(" ") || undefined });
    }
    const list = path.join(tmp, "list.txt");
    fs.writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n"));
    const joined = path.join(tmp, "joined.mp4");
    await concat(list, joined);

    // 4. Captions, CTA, audio mix.
    step(r, "rendering", "Adding captions and the call to action");
    const speechEnd = spans?.length ? spans[spans.length - 1].end : duration - 3.2;
    const words = timeWords(clip.narration, voicePath ? speechEnd : Math.max(3, duration - 3.2), voicePath ? spans : undefined);
    const sents = sentences(clip.narration);
    const lastSentenceStart = voicePath && spans && spans.length === sents.length ? spans[spans.length - 1].start : duration - 3;
    const ctaText = c.brief.cta.text || clip.cta;
    const ass = path.join(tmp, "subs.ass");
    fs.writeFileSync(ass, buildAss({ hook: clip.hook, captions: chunk(words), cta: ctaText, ctaFrom: Math.max(1, Math.min(lastSentenceStart, duration - 2.5)), duration }));
    const final = path.join(tmp, "final.mp4");
    await compose({ video: joined, ass, voice: voicePath, duration, out: final, fontsDir: process.env.FONTS_DIR, workDir: tmp });

    step(r, "rendering", "Uploading the video");
    const key = `${workspaceId}/clips/${clip.id}-${Date.now()}.mp4`;
    await videoStore().put(key, final, "video/mp4");

    const fresh = getDoc().clips.find((x) => x.id === clip.id);
    if (!fresh?.render) return; // deleted mid-render
    Object.assign(fresh.render, {
      status: "done",
      step: "Ready",
      videoKey: key,
      durationSec: duration,
      sizeBytes: fs.statSync(final).size,
      segments,
      finishedAt: now(),
      error: undefined,
    } satisfies Partial<RenderInfo>);
    if (fresh.status === "rendering") fresh.status = "ready";
    fresh.lengthSec = Math.round(duration);
    fresh.qa = checkClip(fresh, c.brief);
    log({ campaignId: c.id, kind: "clip", message: `Rendered "${fresh.title}" (${Math.round(duration)}s${r.voice !== "none" ? `, ${r.voice} voice` : ", no voice"}).`, cost: r.cost || undefined });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export const queueLength = () => queue.length + running;
