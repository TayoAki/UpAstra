import { spawn, spawnSync } from "node:child_process";

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

export function run(cmd: "ffmpeg" | "ffprobe", args: string[], timeoutMs = 20 * 60_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr = (stderr + d).slice(-8000)));
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("error", (e) => (clearTimeout(timer), reject(e)));
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} failed (${code}): ${stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`));
    });
  });
}

/** Public Google Drive file → a direct, range-capable download URL. */
export const driveDownloadUrl = (fileId: string) => `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`;

export async function probe(url: string): Promise<{ duration: number; hasAudio: boolean; width: number; height: number }> {
  const { stdout } = await run("ffprobe", [...netArgs(url), "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", url], 120_000);
  const j = JSON.parse(stdout);
  const v = (j.streams ?? []).find((s: { codec_type: string }) => s.codec_type === "video") ?? {};
  return { duration: Number(j.format?.duration) || 0, hasAudio: (j.streams ?? []).some((s: { codec_type: string }) => s.codec_type === "audio"), width: v.width ?? 0, height: v.height ?? 0 };
}

/**
 * A small preview for the vision model: keyframes only (fast even for long
 * 60 fps HEVC), resampled to a steady 1 fps with the real timestamp burned
 * into each frame — models read printed time far more reliably than they
 * track it.
 */
export async function buildProxy(url: string, out: string, durationSec: number) {
  const fps = durationSec > 1500 ? 0.5 : 1;
  const width = durationSec > 1500 ? 360 : 480;
  await run("ffmpeg", [
    ...netArgs(url),
    "-v", "error", "-y",
    "-skip_frame", "nokey",
    "-i", url,
    "-an",
    "-vf", `fps=${fps},scale=${width}:-2,drawtext=text='%{pts\\:hms}':x=8:y=8:fontsize=${Math.round(width / 22)}:fontcolor=white:box=1:boxcolor=black@0.7`,
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "32",
    out,
  ], 30 * 60_000);
}

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
export async function cutSegment(url: string, start: number, seconds: number, hasAudio: boolean, out: string) {
  const fg = `scale=${Math.round(W * 1.25)}:${VIDEO_H}:force_original_aspect_ratio=increase,crop=${W}:${VIDEO_H}`;
  const filter = [
    `[0:v]split[a][b]`,
    `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=28,eq=brightness=-0.12[bg]`,
    `[b]${fg}[fg]`,
    `[bg][fg]overlay=0:${VIDEO_TOP},fps=${FPS},format=yuv420p,setsar=1[v]`,
    hasAudio ? `[0:a]aresample=44100,aformat=channel_layouts=stereo,apad[a1]` : `anullsrc=r=44100:cl=stereo[a1]`,
  ].join(";");
  await run("ffmpeg", [
    ...netArgs(url),
    "-v", "error", "-y",
    "-ss", start.toFixed(2),
    "-i", url,
    "-filter_complex", filter,
    "-map", "[v]", "-map", "[a1]",
    "-t", seconds.toFixed(2),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac", "-b:a", "160k",
    out,
  ]);
}

export async function concat(listFile: string, out: string) {
  await run("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", out]);
}

/** Burn captions, lay the voiceover over ducked game audio, and finish for upload. */
export async function compose(opts: { video: string; ass: string; voice?: string; duration: number; out: string; fontsDir?: string }) {
  const assEsc = opts.ass.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
  const fonts = opts.fontsDir ? `:fontsdir=${opts.fontsDir.replace(/:/g, "\\:")}` : "";
  const filter = [
    `[0:v]ass='${assEsc}'${fonts}[v]`,
    opts.voice
      ? `[0:a]volume=0.22[g];[1:a]aresample=44100,aformat=channel_layouts=stereo,volume=1.6[vo];[g][vo]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=44100[a]`
      : `[0:a]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=44100[a]`,
  ].join(";");
  await run("ffmpeg", [
    "-v", "error", "-y",
    "-i", opts.video,
    ...(opts.voice ? ["-i", opts.voice] : []),
    "-filter_complex", filter,
    "-map", "[v]", "-map", "[a]",
    "-t", opts.duration.toFixed(2),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
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
