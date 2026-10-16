import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { traitsOf } from "../shared/learning";
import { calibrate, checkClip, round2, speechLoad } from "../shared/rules";
import type { Campaign, Clip, EditParts, FootageFile, RenderInfo, VoiceOption } from "../shared/types";
import { buildAss, fitCaptionsFor, groups, HOOK_SECONDS, lastSentenceStart, sentences, timeWords } from "./captions";
import { HttpError, getDoc, loadTenant, log, now, runInWorkspace, save, saveNow, tenantLoadHooks } from "./db";
import { mediaLive, modelFor, speak } from "./llm";
import { blackSpans, concat, compose, cutSegment, cutSignature, ffmpegAvailable, H, run, sceneCutNear, speechSpans, VIDEO_H, VIDEO_TOP, W } from "./media";
import { cacheKey, footageSource, isCached } from "./footage-cache";
import { cancelJob, cancelWaiting, checkCancelled, currentSignal, errorText, isPending, pendingCount, submitJob, waitingCount } from "./jobs";
import { displayText, displayTimed, hasMarkup, parseNarration, spokenText } from "../shared/markup";
import { shotTimes } from "./shots";
import { sfxEvents } from "./sfx";
import { cachedStep } from "./steps";
import { alignScript, scriptLanguage, scriptWords, type Alignment } from "./align";
import { transcribe, transcriptionAvailable, whisperModel, type Word } from "./transcribe";
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
    r.startedAt = now();
    r.log = [];
    try {
      await renderClip(job.workspaceId, clip, r);
    } catch (err) {
      const cancelled = !!currentSignal()?.aborted;
      const msg = cancelled ? "Cancelled" : errorText(err);
      console.error(`[render] ${clip.id} ${cancelled ? "cancelled" : "failed"}:`, errorText(err));
      if (!cancelled && !isUserError(msg)) alert("render failed", msg.slice(0, 300), `workspace ${job.workspaceId} · clip ${clip.id}`);
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

const glossaryOf = (c: Campaign) => [c.brief.product, c.brief.brand, ...c.brief.requiredPhrases].filter(Boolean);
export const VOICE_STEP = 1;
/** What the voiceover step reads: the same script, voice, model and timing reuse its take. */
export const voiceStepParams = (c: Campaign, clip: Clip, voice: string) => ({ narration: clip.narration, voice, model: modelFor("voice"), glossary: glossaryOf(c), timing: transcriptionAvailable() ? path.basename(whisperModel()) : null });

/** Show progress, keep a timed log of the steps, and stop here if the render was cancelled. */
const step = (r: RenderInfo, status: RenderInfo["status"], text: string) => {
  checkCancelled();
  r.status = status;
  r.step = text;
  const at = r.startedAt ? Math.round((Date.now() - Date.parse(r.startedAt)) / 100) / 10 : 0;
  r.log = [...(r.log ?? []), { at, step: text }].slice(-80);
  save();
};

/** The footage file each shot should use: its own, or the next video in the campaign. */
export function footageFor(c: Campaign, id: string | undefined, i: number): FootageFile {
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
        checkCancelled(); // a cancel isn't a problem with the footage
        f.analysisError = errorText(err).slice(0, 300);
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

    // What the voice reads and what the captions show (they differ only where
    // the narration is marked up, e.g. <$5|five dollars>).
    const said = spokenText(clip.narration);
    const shown = displayText(clip.narration);

    // 2. Voiceover.
    let voicePath: string | undefined;
    let freshTake = false;
    let spans: { start: number; end: number }[] | undefined;
    // Word-perfect timing: the script's words, timed from the voiceover itself.
    let timed: Word[] | undefined;
    let duration = clip.lengthSec;
    if (r.voice !== "none") {
      if (!mediaLive()) throw new Error("AI voice needs OPENROUTER_API_KEY — render with “No voice” instead");
      const glossary = glossaryOf(c);
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
        version: VOICE_STEP,
        params: voiceStepParams(c, clip, r.voice),
        file: takeFile,
        paid: true,
        save: saveNow,
        // Only a clean, word-timed take is reused later; a weak one is kept for this render only.
        keep: (t) => !transcriptionAvailable() || (!!t.al && t.al.matched >= 0.85 && t.al.extra.inside <= 3),
        scope: r.requestedAt,
        run: async () => {
          let best: { wav: string; seconds: number; al?: Alignment } | undefined;
          for (let attempt = 1; attempt <= 2; attempt++) {
            step(r, "voicing", attempt === 1 ? `Recording the voiceover (${r.voice})` : "Re-recording the voiceover (the first take went off script)");
            checkAIBudget();
            const v = await speak(said, r.voice);
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
                al = alignScript(said, tr.words, tr.language);
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
      freshTake = !take.reused;
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

    // When each word is said: from the voiceover's alignment, else estimated;
    // then the shown words (markup like <$5|five dollars>) take their spoken words' times.
    const speechEnd = timed?.length ? timed[timed.length - 1].end : spans?.length ? spans[spans.length - 1].end : duration - 3.2;
    const saidTimes = timed ?? timeWords(said, voicePath ? speechEnd : Math.max(3, duration - 3.2), voicePath ? spans : undefined);
    // (Plain narration passes through untouched, keeping its own segmentation, e.g. for Chinese.)
    const { words, moments } = hasMarkup(clip.narration) ? displayTimed(parseNarration(clip.narration), saidTimes, (t) => scriptWords(t, r.language ?? scriptLanguage(clip.narration))) : { words: saidTimes, moments: {} as Record<string, number> };

    // 3. Cut the shots: each starts when its phrase is said (else shares the time by planned seconds).
    step(r, "rendering", "Cutting shots from the footage");
    const timing = shotTimes(shots, words, duration);
    const unbound = shots.filter((s, i) => i > 0 && s.phrase && !timing[i].bound).length;
    if (unbound) log({ campaignId: c.id, kind: "clip", message: `${unbound} shot(s) in "${clip.title}" couldn't be lined up with their words, so they were timed by their planned length.` });
    const used = new Set<string>();
    let opening: string | undefined;
    const segments: NonNullable<RenderInfo["segments"]> = [];
    const shotLens: number[] = [];
    const parts: string[] = [];
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i];
      const f = files[i];
      const len = Math.round(timing[i].len * 1000) / 1000;
      const total = f.durationSec ?? 0;
      const m = pickMoment(s.moment, f.moments ?? [], used);
      const endAnchored = !!m && ["goal", "save", "near-miss"].includes(m.type);
      let start: number;
      if (i === 0) opening = m?.type;
      if (m) {
        used.add(`${m.start}-${m.end}`);
        // Land goals and saves inside the shot with a beat after; everything else starts on the moment.
        start = endAnchored ? m.end - len + 1 : m.start;
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
        version: 3, // 2: snaps to a nearby scene cut; 3: end-anchored moments snap only earlier
        params: { source: f.storageKey ?? cacheKey(f), start: requested, len, audio: f.hasAudio !== false, total, cut: cutSignature() },
        file: out,
        save,
        run: async () => {
          const src = await footageSource(f);
          checkCancelled();
          // Start on a scene cut if there's one within 0.4 s.
          // (A shot timed to end just after its moment only snaps earlier, keeping the beat after it.)
          start = Math.max(0, Math.min(await sceneCutNear(src, start, 0.4, endAnchored), Math.max(0, total - len - 0.5)));
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
    const sents = sentences(shown);
    const lastStart = (timed && lastSentenceStart(shown, words, r.language))
      ?? (voicePath && spans && spans.length === sents.length ? spans[spans.length - 1].start : duration - 3);
    const ctaText = c.brief.cta.text || clip.cta;
    const ctaFrom = Math.max(1, Math.min(lastStart, duration - 2.5));
    const brand = getDoc().brand;
    const style = resolveCaptionStyle(brand, c.captions);
    const captionGroups = groups(words, style.wordsPerCaption);
    // Overlays land on the words they're cued to (tier items stay until the call to action).
    const layout = { width: W, height: H, bandTop: VIDEO_TOP, bandHeight: VIDEO_H, font: style.font, fontWidths: style.fontWidths, accent: accentOf(brand), uppercase: style.uppercase, hook: { text: clip.hook, end: Math.min(HOOK_SECONDS, duration) } };
    const { placed, missed } = placeOverlays(clip.overlays ?? [], words, duration, ctaFrom, moments);
    const crowded = hiddenComments(placed, layout);
    if (crowded.length) log({ campaignId: c.id, kind: "clip", message: `Left out ${crowded.length} comment overlay(s) in "${clip.title}": too many on screen at once (${crowded.map((x) => `@${x.user}`).join(", ")}).` });
    const { stickers, missing } = await emojiStickers(placed, layout, tmp);
    if (missed.length || missing.length)
      log({ campaignId: c.id, kind: "clip", message: `Left out ${missed.length + missing.length} overlay(s) on "${clip.title}"${missed.length ? ` — cue words not in the voiceover: ${missed.map((o) => `"${o.cue ?? o.text}"`).join(", ")}` : ""}${missing.length ? ` — no image for ${missing.join(" ")}` : ""}.` });
    const ass = path.join(tmp, "subs.ass");
    fs.writeFileSync(ass, buildAss({ hook: clip.hook, captions: captionGroups, cta: ctaText, ctaFrom, duration, style, accent: accentOf(brand), language: r.language, overlays: { placed, layout } }));
    const final = path.join(tmp, "final.mp4");
    // Sound design (opt-in per brief): effects on the overlays' own times, voice-ducked game audio.
    const sound = c.brief.soundDesign ? { events: sfxEvents(placed, layout, stickers).filter((e) => e.at < duration - 0.1) } : undefined;
    await compose({ video: joined, ass, voice: voicePath, duration, out: final, fontsDir: await prepareFonts(tmp, brand), workDir: tmp, stickers, sound });

    step(r, "rendering", "Uploading the video"); // the last point a cancel takes effect
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
      text: p.o.kind === "emoji" ? p.o.emoji ?? "" : p.o.kind === "comment" ? `${p.o.user ? `@${p.o.user}: ` : ""}${p.o.text ?? ""}` : (p.o.text ?? ""),
      start: round(p.start),
      end: round(p.end),
      tier: p.o.tier,
    }));
    // As burned in: long captions are broken into two lines or split in time.
    editParts.captions = fitCaptionsFor(captionGroups, style, { width: W, height: H }, r.language).map((g) => ({ text: g.text, start: round(g.start), end: round(g.end), words: g.words.map((w) => ({ text: w.text, start: round(w.start), end: round(w.end) })) }));

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
    // Learn this voice's pace, so plans for it are timed better next time.
    // Only from a fresh, word-timed take, measured first word to last (a reused
    // take was learned from when it was recorded; leading silence isn't speech).
    if (voicePath && r.voice !== "none" && freshTake && timed?.length) {
      const doc = getDoc();
      const rate = calibrate(doc.voiceRates?.[r.voice], speechLoad(said), timed[timed.length - 1].end - timed[0].start);
      if (rate) doc.voiceRates = { ...doc.voiceRates, [r.voice]: rate };
    }
    fresh.qa = checkClip(fresh, c.brief);
    recordUsage("renders", 1);
    recordUsage("renderSec", duration);
    log({ campaignId: c.id, kind: "clip", message: `Rendered "${fresh.title}" (${Math.round(duration)}s${r.voice !== "none" ? `, ${r.voice} voice` : ", no voice"}).`, cost: r.cost || undefined });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export const queueLength = () => pendingCount("render");

/** Stop a clip's render: drop it from the queue, or abort it where it is. False if it isn't rendering. */
export function cancelRender(clip: Clip): boolean {
  if (cancelWaiting(clip.id)) {
    if (clip.render) Object.assign(clip.render, { status: "failed", step: "Failed", error: "Cancelled", finishedAt: now() });
    if (clip.status === "rendering") clip.status = "approved";
    return true;
  }
  return cancelJob(clip.id);
}
