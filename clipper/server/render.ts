import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { traitsOf } from "../shared/learning";
import { checkClip, round2 } from "../shared/rules";
import type { Campaign, Clip, EditParts, FootageFile, RenderInfo, VoiceOption } from "../shared/types";
import { buildAss, groups, HOOK_SECONDS, lastSentenceStart, sentences, timeWords } from "./captions";
import { HttpError, getDoc, loadTenant, log, now, runInWorkspace, save, tenantLoadHooks } from "./db";
import { mediaLive, modelFor, speak } from "./llm";
import { blackSpans, concat, compose, cutSegment, ffmpegAvailable, FPS, H, run, speechSpans, VIDEO_H, VIDEO_TOP, W } from "./media";
import { cacheKey, footageSource, isCached } from "./footage-cache";
import { isPending, pendingCount, submitJob, waitingCount } from "./jobs";
import { cachedStep } from "./steps";
import { alignScript, type Alignment } from "./align";
import { NO_SPACES, transcribe, transcriptionAvailable, type Word } from "./transcribe";
import { accentOf, resolveCaptionStyle } from "../shared/caption-styles";
import { prepareFonts } from "./fonts";
import { analyzeFootage, pickMoment } from "./moments";
import { videoStore } from "./storage";
import { checkAIBudget, recordUsage } from "./usage";
import { alert, isUserError } from "./alerts";
import { emojiStickers, hiddenComments, placeOverlays } from "./overlays";

// The render queue: approved clip plans → finished 9:16 MP4s.
//   1. find moments in each footage file the plan uses (cached)
//   2. voice the narration (optional)
//   3. cut each shot from its source link, framed for 9:16
//   4. burn hook, captions and CTA, mix audio, upload
// Jobs run in the background through the shared job controller (jobs.ts); each step is written to the clip
// so the dashboard can show progress.

interface Job {
  workspaceId: string;
  clipId: string;
  /** Who asked for it, so its Activity entries are attributed the same way. */
  actor?: "human" | "agent";
}

export const renderAvailable = () => ffmpegAvailable();

// A render cut off by a restart (deploys included) starts again from the
// beginning, at most twice, so a render that crashes the server can't loop.
export const MAX_RESUMES = 2;
tenantLoadHooks.push((ws, doc) => {
  for (const c of doc.clips) {
    const r = c.render;
    if (!r || ["done", "failed"].includes(r.status) || isPending(c.id)) continue;
    if (!ffmpegAvailable() || (r.resumes ?? 0) >= MAX_RESUMES) {
      c.render = { ...r, status: "failed", step: "Interrupted by a restart", error: "Interrupted by a server restart — render it again." };
      if (c.status === "rendering") c.status = "approved";
      continue;
    }
    c.render = { ...r, status: "queued", step: "Resuming after a server restart", resumes: (r.resumes ?? 0) + 1 };
    c.status = "rendering";
    // The controller starts it after this hook, once the workspace has finished loading.
    submit({ workspaceId: ws, clipId: c.id });
  }
});

export function enqueueRender(workspaceId: string, clip: Clip, voice: VoiceOption, actor?: "human" | "agent") {
  if (!ffmpegAvailable()) throw new HttpError(503, "Rendering isn't available on this server (ffmpeg missing)");
  if (isPending(clip.id)) throw new HttpError(409, "This clip is already rendering");
  // One workspace can't fill the shared queue.
  const max = Number(process.env.MAX_QUEUED_RENDERS ?? 20);
  if (waitingCount(workspaceId, "render") >= max) throw new HttpError(429, `You already have ${max} clips waiting to render. Try again when some finish.`);
  clip.render = { status: "queued", step: "Waiting in the render queue", voice, requestedAt: now(), cost: 0 };
  clip.status = "rendering";
  submit({ workspaceId, clipId: clip.id, actor });
}

const submit = (job: Job) => submitJob({ id: job.clipId, workspaceId: job.workspaceId, kind: "render", run: () => process_(job) });

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
      if (!isUserError(msg)) alert("render failed", msg.slice(0, 300), `workspace ${job.workspaceId} · clip ${clip.id}`);
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
  }, job.actor);
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
      // Ready first (uploads, files already opened, files another workspace
      // already cached), then a few others: Drive's limit is per file.
      const others = c.footage.filter((v) => v.kind === "video" && !failed.has(v.id));
      const ready: FootageFile[] = [];
      for (const v of others) if (v.storageKey || v.durationSec || (await isCached(v).catch(() => false))) ready.push(v);
      const usable: FootageFile[] = [];
      for (const v of ready) if (await ensure(v)) usable.push(v);
      for (const v of others.filter((x) => !ready.includes(x)).slice(0, usable.length ? 0 : 4)) {
        if (await ensure(v)) {
          usable.push(v);
          break;
        }
      }
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
    // Word-perfect timing: the script's words, timed from the voiceover itself.
    let timed: Word[] | undefined;
    let duration = clip.lengthSec;
    if (r.voice !== "none") {
      if (!mediaLive()) throw new Error("AI voice needs OPENROUTER_API_KEY — render with “No voice” instead");
      const glossary = [c.brief.product, c.brief.brand, ...c.brief.requiredPhrases].filter(Boolean);
      // Voice models sometimes talk around the script ("Sure, here it is…").
      // Each take is transcribed and checked against the script; a take that
      // strays inside the script is recorded once more.
      // The take (and its word timings) is kept per script and voice, so a
      // resume or a re-render with the same narration doesn't pay again.
      const takeFile = path.join(tmp, "take.wav");
      const take = await cachedStep({
        workspaceId,
        receipts: (r.steps ??= {}),
        name: "voiceover",
        kind: "voice",
        version: 1,
        params: { narration: clip.narration, voice: r.voice, model: modelFor("voice"), glossary, timed: transcriptionAvailable() },
        file: takeFile,
        paid: true,
        save,
        run: async () => {
          let best: { wav: string; seconds: number; al?: Alignment } | undefined;
          for (let attempt = 1; attempt <= 2; attempt++) {
            step(r, "voicing", attempt === 1 ? `Recording the voiceover (${r.voice})` : "Re-recording the voiceover (the first take went off script)");
            checkAIBudget();
            const v = await speak(clip.narration, r.voice);
            r.cost = round2((r.cost + v.cost) * 1000) / 1000;
            const pcm = path.join(tmp, `vo${attempt}.pcm`);
            const wav = path.join(tmp, `vo${attempt}.wav`);
            fs.writeFileSync(pcm, v.pcm);
            await run("ffmpeg", ["-v", "error", "-y", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", pcm, wav]);
            let al: Alignment | undefined;
            if (transcriptionAvailable()) {
              step(r, "voicing", "Timing every word of the voiceover");
              try {
                const tr = await transcribe(wav, { glossary });
                al = alignScript(clip.narration, tr.words, tr.language);
                r.language = tr.language;
              } catch (err) {
                console.error(`[render] transcription failed for ${clip.id}:`, (err as Error).message);
              }
            }
            const take = { wav, seconds: v.pcm.length / 48000, al };
            const score = (t: { al?: Alignment }) => (t.al ? t.al.matched - t.al.extra.inside / 20 : 0);
            if (!best || score(take) > score(best)) best = take;
            if (!al || (al.matched >= 0.85 && al.extra.inside <= 3)) break;
          }
          fs.copyFileSync(best!.wav, takeFile);
          return { seconds: best!.seconds, al: best!.al, language: r.language };
        },
      });
      if (take.reused) {
        r.language = take.value.language;
        log({ campaignId: c.id, kind: "clip", message: `Reused the recorded voiceover for "${clip.title}" (nothing charged).` });
      }
      const best = { wav: takeFile, seconds: take.value.seconds, al: take.value.al };
      voicePath = best.wav;
      let spoken = best.seconds;
      const al = best.al;
      if (al && al.matched >= 0.6) {
        let shift = 0;
        if (al.extra.before || al.extra.after) {
          // Cut the chatter around the read.
          shift = Math.max(0, al.span.start - 0.12);
          const to = Math.min(spoken, al.span.end + 0.3);
          const trimmed = path.join(tmp, "vo-trimmed.wav");
          await run("ffmpeg", ["-v", "error", "-y", "-i", voicePath, "-af", `atrim=start=${shift.toFixed(3)}:end=${to.toFixed(3)},asetpts=PTS-STARTPTS`, trimmed]);
          voicePath = trimmed;
          spoken = to - shift;
          log({ campaignId: c.id, kind: "clip", message: `Cut ${al.extra.before + al.extra.after} off-script word(s) the voice model added around "${clip.title}".` });
        }
        timed = al.words.map((w) => ({ text: w.text, start: Math.max(0, w.start - shift), end: Math.max(0, w.end - shift) }));
        r.captionTiming = "aligned";
      } else {
        spans = await speechSpans(voicePath, spoken);
        r.captionTiming = "estimated";
      }
      duration = Math.max(c.brief.lengthSec.min, spoken + 0.8);
    } else r.captionTiming = "estimated";
    duration = Math.round(Math.min(Math.max(duration, 5), 180) * 100) / 100;

    // 3. Cut the shots, scaled to fill the clip.
    step(r, "rendering", "Cutting shots from the footage");
    const planned = shots.reduce((s, x) => s + Math.max(1, x.seconds), 0) || 1;
    const used = new Set<string>();
    let opening: string | undefined;
    const segments: NonNullable<RenderInfo["segments"]> = [];
    const shotLens: number[] = [];
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
      if (i === 0) opening = m?.type;
      if (m) {
        used.add(`${m.start}-${m.end}`);
        // Land goals and saves inside the shot with a beat after; everything else starts on the moment.
        start = ["goal", "save", "near-miss"].includes(m.type) ? m.end - len + 1 : m.start;
      } else start = total * (0.12 + (0.7 * (i + 1)) / (shots.length + 1));
      start = Math.max(0, Math.min(start, Math.max(0, total - len - 0.5)));
      step(r, "rendering", `Cutting shot ${i + 1} of ${shots.length} from "${f.name}"`);
      const out = path.join(tmp, `seg${i}.mp4`);
      const requested = start;
      // Kept per source, start and length: re-renders and variants reuse the cut.
      const cut = await cachedStep({
        workspaceId,
        receipts: (r.steps ??= {}),
        name: `shot${i + 1}`,
        kind: "cut",
        version: 1,
        params: { source: f.storageKey ?? cacheKey(f), start: requested, len, audio: f.hasAudio !== false, total, frame: [W, H, FPS] },
        file: out,
        save,
        run: async () => {
          const src = await footageSource(f);
          await cutSegment(src, start, len, f.hasAudio !== false, out);
          // Goals often fade to black before the replay: if a shot has more than a
          // moment of black, slide it away from the black and cut again.
          const black = (await blackSpans(out)).reduce((t, b) => t + (b.end - b.start), 0);
          if (black > 0.5 && total > len + 2) {
            const first = (await blackSpans(out))[0];
            const shift = first.start < len / 2 ? first.end + 0.3 : -(len - first.start + 0.3);
            const moved = Math.max(0, Math.min(start + shift, total - len - 0.5));
            if (Math.abs(moved - start) > 0.2) {
              await cutSegment(src, moved, len, f.hasAudio !== false, out);
              if ((await blackSpans(out)).reduce((t, b) => t + (b.end - b.start), 0) < black) start = moved;
              else await cutSegment(src, start, len, f.hasAudio !== false, out);
            }
          }
          return { start };
        },
      });
      start = cut.value.start;
      parts.push(out);
      shotLens.push(len);
      const swapped = substitutes.find((x) => x.endsWith(`→ ${f.name}`) && x.startsWith(s.footageName ?? "\u0000"));
      segments.push({ footageName: f.name, start: Math.round(start * 10) / 10, seconds: Math.round(len * 10) / 10, moment: [swapped ? `(instead of ${s.footageName})` : "", m?.description ?? ""].filter(Boolean).join(" ") || undefined });
    }
    const list = path.join(tmp, "list.txt");
    fs.writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n"));
    const joined = path.join(tmp, "joined.mp4");
    await concat(list, joined);

    // 4. Captions, CTA, audio mix.
    step(r, "rendering", "Adding captions and the call to action");
    const speechEnd = timed?.length ? timed[timed.length - 1].end : spans?.length ? spans[spans.length - 1].end : duration - 3.2;
    const words = timed ?? timeWords(clip.narration, voicePath ? speechEnd : Math.max(3, duration - 3.2), voicePath ? spans : undefined);
    const sents = sentences(clip.narration);
    const lastStart = (timed && lastSentenceStart(clip.narration, timed, r.language))
      ?? (voicePath && spans && spans.length === sents.length ? spans[spans.length - 1].start : duration - 3);
    const ctaText = c.brief.cta.text || clip.cta;
    const ctaFrom = Math.max(1, Math.min(lastStart, duration - 2.5));
    const brand = getDoc().brand;
    const style = resolveCaptionStyle(brand, c.captions);
    const captionGroups = groups(words, style.wordsPerCaption);
    // Overlays land on the words they're cued to (tier items stay until the call to action).
    const layout = { width: W, height: H, bandTop: VIDEO_TOP, bandHeight: VIDEO_H, font: style.font, accent: accentOf(brand), uppercase: style.uppercase, hook: { text: clip.hook, end: Math.min(HOOK_SECONDS, duration) } };
    const { placed, missed } = placeOverlays(clip.overlays ?? [], words, duration, ctaFrom);
    const crowded = hiddenComments(placed, layout);
    if (crowded.length) log({ campaignId: c.id, kind: "clip", message: `Left out ${crowded.length} comment overlay(s) in "${clip.title}": too many on screen at once (${crowded.map((x) => `@${x.user}`).join(", ")}).` });
    const { stickers, missing } = await emojiStickers(placed, layout, tmp);
    if (missed.length || missing.length)
      log({ campaignId: c.id, kind: "clip", message: `Left out ${missed.length + missing.length} overlay(s) on "${clip.title}"${missed.length ? ` — cue words not in the voiceover: ${missed.map((o) => `"${o.cue ?? o.text}"`).join(", ")}` : ""}${missing.length ? ` — no image for ${missing.join(" ")}` : ""}.` });
    const ass = path.join(tmp, "subs.ass");
    fs.writeFileSync(ass, buildAss({ hook: clip.hook, captions: captionGroups, cta: ctaText, ctaFrom, duration, style, accent: accentOf(brand), joiner: r.language && NO_SPACES.has(r.language) ? "" : " ", language: r.language, overlays: { placed, layout } }));
    const final = path.join(tmp, "final.mp4");
    await compose({ video: joined, ass, voice: voicePath, duration, out: final, fontsDir: await prepareFonts(tmp, brand), workDir: tmp, stickers });

    step(r, "rendering", "Uploading the video");
    const key = `${workspaceId}/clips/${clip.id}-${Date.now()}.mp4`;
    await videoStore().put(key, final, "video/mp4");

    // Keep the pieces so the editor can open this render as a timeline.
    step(r, "rendering", "Saving the editable parts");
    const partsPrefix = `${workspaceId}/clips/${clip.id}/parts/`;
    await videoStore().deletePrefix(partsPrefix).catch(() => undefined);
    const stamp = `${partsPrefix}${Date.now()}`;
    const round = (n: number) => Math.round(n * 1000) / 1000;
    const editParts: EditParts = { shots: [], captions: [], hook: { text: clip.hook, end: Math.min(HOOK_SECONDS, duration) }, cta: { text: ctaText, from: round(ctaFrom) }, duration };
    for (const [i, file] of parts.entries()) {
      const k = `${stamp}/shot${i + 1}.mp4`;
      await videoStore().put(k, file, "video/mp4");
      editParts.shots.push({ key: k, seconds: round(shotLens[i]) });
    }
    if (voicePath) {
      editParts.voiceKey = `${stamp}/voice.wav`;
      await videoStore().put(editParts.voiceKey, voicePath, "audio/wav");
    }
    editParts.overlays = placed.map((p) => ({
      kind: p.o.kind,
      text: p.o.kind === "emoji" ? p.o.emoji ?? "" : p.o.kind === "comment" ? `@${p.o.user ?? "viewer"}: ${p.o.text ?? ""}` : (p.o.text ?? ""),
      start: round(p.start),
      end: round(p.end),
      tier: p.o.tier,
    }));
    editParts.captions = captionGroups.map((g) => ({ text: g.text, start: round(g.start), end: round(g.end), words: g.words.map((w) => ({ text: w.text, start: round(w.start), end: round(w.end) })) }));

    const fresh = getDoc().clips.find((x) => x.id === clip.id);
    if (!fresh?.render) return; // deleted mid-render
    Object.assign(fresh.render, {
      status: "done",
      step: "Ready",
      videoKey: key,
      durationSec: duration,
      sizeBytes: fs.statSync(final).size,
      segments,
      parts: editParts,
      spokenSec: voicePath ? Math.round(speechEnd * 10) / 10 : undefined,
      editedAt: undefined,
      finishedAt: now(),
      error: undefined,
    } satisfies Partial<RenderInfo>);
    if (fresh.status === "rendering") fresh.status = "ready";
    fresh.lengthSec = Math.round(duration);
    // What the learning system compares once this clip is posted.
    fresh.traits = { ...traitsOf(fresh), voice: r.voice, opening };
    fresh.qa = checkClip(fresh, c.brief);
    recordUsage("renders", 1);
    recordUsage("renderSec", duration);
    log({ campaignId: c.id, kind: "clip", message: `Rendered "${fresh.title}" (${Math.round(duration)}s${r.voice !== "none" ? `, ${r.voice} voice` : ", no voice"}).`, cost: r.cost || undefined });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export const queueLength = () => pendingCount("render");
