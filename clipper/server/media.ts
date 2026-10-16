import { spawn, spawnSync } from "node:child_process";
import { abortReason, currentSignal } from "./jobs";
import { stickerGraph, type Sticker } from "./overlays";
import { sfxFiles, SFX_GAIN, type SfxEvent } from "./sfx";

// ffmpeg plumbing. Footage is read straight from its public link: ffmpeg
// seeks with HTTP range requests, so a 1.5 GB source never lands on disk —
// only the seconds a clip uses are fetched.

let available: boolean | null = null;
export function ffmpegAvailable(): boolean {
  if (available === null) available = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
  return available;
}

/** Network options for http(s) inputs (a proxy and CA bundle when the environment needs them). */
export function netArgs(url: string): string[] {
  if (!/^https?:/.test(url)) return [];
  const out = ["-rw_timeout", "60000000", "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"];
  const proxy = process.env.FFMPEG_HTTP_PROXY ?? process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (proxy) out.push("-http_proxy", proxy);
  if (process.env.FFMPEG_CA_FILE) out.push("-ca_file", process.env.FFMPEG_CA_FILE);
  return out;
}

// Inputs are uploads and downloads we don't control. ffmpeg picks a demuxer
// from a file's contents, and some formats (playlists, for example) make it
// open further files or URLs. So every input may only be a real audio/video
// container, read from a local file or (for our own storage's signed links)
// over HTTP(S), and never anything it points to.
const FORMATS = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,flv,mpegts,wav,mp3,aac,ogg,flac,s16le,concat,image2,png_pipe";
// httpproxy: https inputs tunnel through -http_proxy when one is configured.
const protocolsFor = (input: string) => (/^https?:/.test(input) ? "https,http,httpproxy,tls,tcp,crypto" : "file");

const SOLID_COLOUR = /^color=c=\w+:s=\d+x\d+(:r=\d+)?:d=[\d.]+$/;

/** Add input restrictions in front of every ffmpeg `-i` (and ffprobe's input). */
export function hardenInputs(cmd: string, args: string[]): string[] {
  const guard = (input: string) => ["-protocol_whitelist", protocolsFor(input), "-format_whitelist", FORMATS];
  if (cmd === "ffprobe") return [...guard(args[args.length - 1] ?? ""), ...args];
  if (cmd !== "ffmpeg") return args;
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    // A plain colour background is the one generated input allowed (lavfi can otherwise open files).
    if (args[i] === "-i" && args[i - 2] === "-f" && args[i - 1] === "lavfi" && SOLID_COLOUR.test(args[i + 1] ?? "")) {
      out.push("-format_whitelist", "lavfi", args[i]);
      continue;
    }
    if (args[i] === "-i" && i + 1 < args.length) out.push(...guard(args[i + 1]));
    out.push(args[i]);
  }
  return out;
}

// ffmpeg, ffprobe and whisper get only what they need to run, never the
// server's keys. The proxy itself reaches ffmpeg as an argument (netArgs);
// ffmpeg still reads no_proxy (and http_proxy) from the environment.
const CHILD_ENV = ["PATH", "HOME", "XDG_CACHE_HOME", "LANG", "LC_ALL", "TMPDIR", "TZ", "SSL_CERT_FILE", "LD_LIBRARY_PATH", "OMP_NUM_THREADS", "FONTCONFIG_FILE", "FONTCONFIG_PATH", "no_proxy", "NO_PROXY", "http_proxy"];
export function childEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of CHILD_ENV) if (env[k] !== undefined) out[k] = env[k]!;
  return out;
}

// Children run in their own process groups (so a timeout kills everything
// they started), which also means they'd outlive the server: kill them on exit.
const live = new Set<number>();
export const liveChildren = () => live.size;
process.once("exit", () => {
  for (const pid of live)
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
});

export function run(cmd: string, args: string[], timeoutMs = 20 * 60_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Its own process group, so a timeout also kills anything it started.
    const p = spawn(cmd, hardenInputs(cmd, args), { stdio: ["ignore", "pipe", "pipe"], env: childEnv(), detached: true });
    const pid = p.pid;
    if (pid) live.add(pid);
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr = (stderr + d).slice(-8000)));
    const kill = () => {
      try {
        process.kill(-p.pid!, "SIGKILL");
      } catch {
        p.kill("SIGKILL");
      }
    };
    const timer = setTimeout(kill, timeoutMs);
    // A cancelled job takes its processes with it.
    const signal = currentSignal();
    let cancelled = false;
    const onAbort = () => ((cancelled = true), kill());
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    p.on("error", (e) => (clearTimeout(timer), pid && live.delete(pid), reject(e)));
    p.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (pid) live.delete(pid);
      if (cancelled) return reject(new Error(signal ? abortReason(signal) : "Cancelled"));
      if (code === 0) resolve({ stdout, stderr });
      else {
        console.error(`[ffmpeg] ${cmd} ${args.filter((a) => !/^https?:/.test(a)).join(" ").slice(0, 600)}\n${stderr.trim().split("\n").slice(-12).join("\n")}`);
        reject(new Error(`${cmd} failed (${code}): ${stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`));
      }
    });
  });
}

/** Public Google Drive file → a direct, range-capable download URL. */
export const driveDownloadUrl = (fileId: string) => `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`;

export async function probe(url: string): Promise<{ duration: number; hasAudio: boolean; width: number; height: number; colorSpace?: string }> {
  const { stdout } = await run("ffprobe", [...netArgs(url), "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,color_space", "-of", "json", url], 120_000);
  const j = JSON.parse(stdout);
  const v = (j.streams ?? []).find((s: { codec_type: string }) => s.codec_type === "video") ?? {};
  return { duration: Number(j.format?.duration) || 0, hasAudio: (j.streams ?? []).some((s: { codec_type: string }) => s.codec_type === "audio"), width: v.width ?? 0, height: v.height ?? 0, colorSpace: v.color_space && v.color_space !== "unknown" ? v.color_space : undefined };
}

/** The YUV matrix a video was encoded with: its tag, else what players assume for its size. */
export const yuvMatrix = (colorSpace: string | undefined, height: number): "bt601" | "bt709" =>
  colorSpace ? (/bt470bg|smpte170m|bt601|fcc/.test(colorSpace) ? "bt601" : "bt709") : height >= 720 ? "bt709" : "bt601";

const escPath = (p: string) => p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");

/**
 * Burn an ASS file onto a video read with its own YUV matrix: drawn in RGB,
 * converted once to BT.709 (tag the output with BT709), so neither the
 * captions nor the footage shift colour.
 */
export const burnFilter = (ass: string, fontsDir: string | undefined, matrix: "bt601" | "bt709") =>
  `scale=in_color_matrix=${matrix}:in_range=tv,format=rgb24,ass='${escPath(ass)}'${fontsDir ? `:fontsdir='${escPath(fontsDir)}'` : ""},scale=out_color_matrix=bt709:out_range=tv,format=yuv420p`;

/**
 * A small preview for the vision model: keyframes only (fast even for long
 * 60 fps HEVC; a full decode measured 5.6× slower), capped at a steady 1 fps,
 * with each picture's real timestamp burned in — models read printed time far
 * more reliably than they track it. The label is drawn before fps= because
 * fps= re-stamps frames with their slot time, which ran late by up to a whole
 * keyframe interval; eof_action=pass keeps the last keyframe.
 */
export function proxyFilter(durationSec: number, width: number): string {
  const fps = durationSec > 1500 ? 0.5 : 1;
  return `scale=${width}:-2,drawtext=text='%{pts\\:hms}':x=8:y=8:fontsize=${Math.round(width / 22)}:fontcolor=white:box=1:boxcolor=black@0.7,fps=${fps}:eof_action=pass`;
}

export async function buildProxy(url: string, out: string, durationSec: number) {
  const width = durationSec > 1500 ? 360 : 480;
  await run("ffmpeg", [
    ...netArgs(url),
    "-v", "error", "-y",
    "-skip_frame", "nokey",
    "-i", url,
    "-an",
    "-vf", proxyFilter(durationSec, width),
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "32",
    out,
  ], 30 * 60_000);
}

/** Output tags for BT.709 limited-range video. */
export const BT709 = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];

export const W = 1080;
export const H = 1920;
export const FPS = 30;
/** Where the footage sits in the 9:16 frame (between the hook and the captions). */
export const VIDEO_TOP = 560;
export const VIDEO_H = 844;

/**
 * One shot: cut `seconds` from `url` at `start`, frame it for 9:16 (blurred
 * fill behind a slightly zoomed landscape shot), normalized audio.
 */
const cutFilter = (hasAudio: boolean) =>
  [
    `[0:v]split[a][b]`,
    `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=28,eq=brightness=-0.12[bg]`,
    `[b]scale=${Math.round(W * 1.25)}:${VIDEO_H}:force_original_aspect_ratio=increase,crop=${W}:${VIDEO_H}[fg]`,
    `[bg][fg]overlay=0:${VIDEO_TOP},fps=${FPS},format=yuv420p,setsar=1[v]`,
    hasAudio ? `[0:a]aresample=44100,aformat=channel_layouts=stereo,apad[a1]` : `anullsrc=r=44100:cl=stereo[a1]`,
  ].join(";");
const CUT_ENCODE = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", ...BT709, "-c:a", "aac", "-b:a", "160k"];

/** Everything about how a shot is cut, so a stored cut is reused only while it would come out the same. */
export const cutSignature = () => `${cutFilter(true)}|${CUT_ENCODE.join(" ")}`;

export async function cutSegment(url: string, start: number, seconds: number, hasAudio: boolean, out: string) {
  const filter = cutFilter(hasAudio);
  await run("ffmpeg", [
    ...netArgs(url),
    "-v", "error", "-y",
    "-ss", start.toFixed(2),
    "-i", url,
    "-filter_complex", filter,
    "-map", "[v]", "-map", "[a1]",
    "-t", seconds.toFixed(2),
    ...CUT_ENCODE,
    out,
  ]);
}

/**
 * The scene cut nearest `t` within ±0.4 s, or `t` itself if there isn't one:
 * shots start on a cut instead of a few frames before or after it. Only the
 * 0.8 s around `t` is decoded, at 64 px wide.
 */
export async function sceneCutNear(src: string, t: number, radius = 0.4, earlierOnly = false): Promise<number> {
  const from = Math.max(0, t - radius);
  try {
    const { stderr } = await run("ffmpeg", [...netArgs(src), "-v", "info", "-ss", from.toFixed(3), "-t", (t + radius - from).toFixed(3), "-i", src, "-an", "-vf", "scale=64:-2,select='gt(scene,0.25)',showinfo", "-f", "null", "-"], 60_000);
    const cuts = [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => from + Number(m[1])).filter((c) => Math.abs(c - t) <= radius && (!earlierOnly || c <= t));
    if (!cuts.length) return t;
    return Math.round(cuts.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a)) * 1000) / 1000;
  } catch {
    return t; // snapping is a nicety; never fail a cut over it
  }
}

export async function concat(listFile: string, out: string) {
  await run("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", out]);
}

/**
 * Burn captions, lay the voiceover over ducked game audio, and finish for
 * upload. Audio is mixed in its own pass from plain 44.1 kHz stereo WAVs, so
 * the final encode never sees mismatched audio formats (older ffmpeg builds
 * refuse to change filter inputs mid-stream).
 */
/**
 * The audio mix: game audio under the voiceover, normalised to -14 LUFS.
 * With sound design, game audio ducks under the voice (sidechain) instead of
 * sitting at a flat level, and effects (inputs 2…) are mixed in at their times.
 */
export function mixFilter(o: { voice: boolean; sound?: { events: SfxEvent[] } }): string {
  const norm = "loudnorm=I=-14:TP=-1.5:LRA=11,aresample=44100[a]";
  if (!o.sound) return o.voice ? `[0:a]volume=0.22[g];[1:a]volume=1.6,apad[v];[g][v]amix=inputs=2:duration=first:dropout_transition=0,volume=2,${norm}` : `[0:a]${norm}`;
  const first = o.voice ? 2 : 1;
  const parts: string[] = [];
  const mix: string[] = [];
  if (o.voice) {
    parts.push("[0:a]volume=0.5[g0]", "[1:a]volume=1.6,apad,asplit=2[v][vk]", "[g0][vk]sidechaincompress=threshold=0.02:ratio=8:attack=15:release=350[g]");
    mix.push("[g]", "[v]");
  } else mix.push("[0:a]");
  o.sound.events.forEach((e, i) => {
    const ms = Math.max(0, Math.round(e.at * 1000));
    parts.push(`[${first + i}:a]adelay=${ms}|${ms},volume=${SFX_GAIN[e.kind]}[s${i}]`);
    mix.push(`[s${i}]`);
  });
  // Normalised separately, in two passes (see compose): dense effects made one-pass loudnorm undershoot.
  return `${parts.join(";")}${parts.length ? ";" : ""}${mix.join("")}amix=inputs=${mix.length}:duration=first:dropout_transition=0:normalize=0[a]`;
}

/** Normalise to -14 LUFS from a measurement of the whole file (a linear gain), not on the fly. */
async function loudnormTwoPass(input: string, out: string) {
  // TP -2.5: the AAC encode adds up to ~1 dB on sharp effect peaks, so the file stays under -1.5 dBTP.
  const target = "I=-14:TP=-2.5:LRA=11";
  const { stderr } = await run("ffmpeg", ["-v", "info", "-i", input, "-af", `loudnorm=${target}:print_format=json`, "-f", "null", "-"]);
  const m = JSON.parse(stderr.slice(stderr.lastIndexOf("{"), stderr.lastIndexOf("}") + 1)) as Record<string, string>;
  const measured = `measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}`;
  await run("ffmpeg", ["-v", "error", "-y", "-i", input, "-af", `loudnorm=${target}:${measured}:linear=true,aresample=44100`, "-ac", "2", "-c:a", "pcm_s16le", out]);
}

export async function compose(opts: { video: string; ass: string; voice?: string; duration: number; out: string; fontsDir?: string; workDir: string; stickers?: Sticker[]; sound?: { events: SfxEvent[] } }) {
  const wav = (name: string) => `${opts.workDir}/${name}.wav`;
  const pcm = ["-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le"];
  await run("ffmpeg", ["-v", "error", "-y", "-i", opts.video, ...pcm, "-t", opts.duration.toFixed(2), wav("game")]);
  if (opts.voice) await run("ffmpeg", ["-v", "error", "-y", "-i", opts.voice, ...pcm, wav("voice")]);
  const files = opts.sound ? sfxFiles(opts.workDir) : undefined;
  await run("ffmpeg", [
    "-v", "error", "-y",
    "-i", wav("game"),
    ...(opts.voice ? ["-i", wav("voice")] : []),
    ...(opts.sound?.events ?? []).flatMap((e) => ["-i", files![e.kind]]),
    "-filter_complex", mixFilter({ voice: !!opts.voice, sound: opts.sound }),
    "-map", "[a]", "-ac", "2", "-c:a", "pcm_s16le", wav(opts.sound ? "premix" : "mix"),
  ]);
  if (opts.sound) await loudnormTwoPass(wav("premix"), wav("mix"));
  const assEsc = opts.ass.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
  const fonts = opts.fontsDir ? `:fontsdir=${opts.fontsDir.replace(/:/g, "\\:")}` : "";
  // Emoji stickers are images laid over the subtitled video, each with its own pop.
  const st = stickerGraph(opts.stickers ?? [], 2, "sub", "v");
  await run("ffmpeg", [
    "-v", "error", "-y",
    "-i", opts.video,
    "-i", wav("mix"),
    ...st.inputs,
    // Captions and stickers are drawn in RGB over the footage (read as BT.709),
    // then the frame is converted to BT.709 once and tagged as such. Without
    // this, overlay colours shifted by up to ~25 levels on phones.
    "-filter_complex", `[0:v]scale=in_color_matrix=bt709:in_range=tv,format=rgb24,ass='${assEsc}'${fonts}[sub];${st.graph};[v]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[vo]`,
    "-map", "[vo]", "-map", "1:a",
    "-t", opts.duration.toFixed(2),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", ...BT709,
    "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart",
    opts.out,
  ]);
}

/** Spoken stretches in a voiceover (gaps of ≥ 0.25 s split them). */
export async function speechSpans(wav: string, total: number): Promise<{ start: number; end: number }[]> {
  const { stderr } = await run("ffmpeg", ["-v", "info", "-i", wav, "-af", "silencedetect=noise=-35dB:d=0.25", "-f", "null", "-"]);
  const spans: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const m of stderr.matchAll(/silence_(start|end): ([\d.]+)/g)) {
    const t = Number(m[2]);
    if (m[1] === "start") {
      if (t - cursor > 0.15) spans.push({ start: cursor, end: t });
    } else cursor = t;
  }
  if (total - cursor > 0.15) spans.push({ start: cursor, end: total });
  return spans;
}

/** Stretches of (near) black in a video — game transitions, fades, loading screens. */
export async function blackSpans(file: string): Promise<{ start: number; end: number }[]> {
  const { stderr } = await run("ffmpeg", ["-v", "info", "-i", file, "-an", "-vf", "blackdetect=d=0.25:pix_th=0.10", "-f", "null", "-"]);
  return [...stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => ({ start: Number(m[1]), end: Number(m[2]) }));
}
