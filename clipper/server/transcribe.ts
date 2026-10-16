import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { netArgs, run } from "./media";

// Speech to words with timestamps, on the server's CPU: whisper.cpp (MIT) with
// a multilingual Whisper model — about 99 languages, detected automatically.
// Used for word-perfect captions: our own voiceovers (aligned to the script,
// see align.ts) and any uploaded video with speech.

export interface Word {
  text: string;
  start: number;
  end: number;
  /** The recogniser's confidence in this word (0–1), when it reports one. */
  p?: number;
}

export interface Transcript {
  language: string;
  words: Word[];
  /** How words join back into text: "" for scripts written without spaces (Chinese, Japanese, Thai…). */
  joiner: "" | " ";
}

const bin = () => process.env.WHISPER_BIN ?? "whisper-cli";
export const whisperModel = () => process.env.WHISPER_MODEL ?? path.resolve(process.cwd(), "models/ggml-base.bin");

let available: boolean | null = null;
export function transcriptionAvailable(): boolean {
  if (available === null) available = fs.existsSync(whisperModel()) && spawnSync(bin(), ["--help"], { stdio: "ignore" }).status === 0;
  return available;
}

/** Languages written without spaces between words. */
export const NO_SPACES = new Set(["zh", "ja", "th", "lo", "km", "my", "yue"]);

/**
 * Transcribe a media file or URL. `language` is an ISO 639-1 code or "auto".
 * `glossary` (brand and product names) is passed to Whisper as a hint so it
 * spells them the way the brief does.
 */
export async function transcribe(input: string, opts: { language?: string; glossary?: string[] } = {}): Promise<Transcript> {
  if (!transcriptionAvailable()) throw new Error("Transcription isn't installed on this server");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asr-"));
  try {
    const wav = path.join(dir, "audio.wav");
    await run("ffmpeg", [...netArgs(input), "-v", "error", "-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], 20 * 60_000);
    const prompt = (opts.glossary ?? []).filter(Boolean).slice(0, 20).join(", ");
    const args = ["-m", whisperModel(), "-f", wav, "-l", opts.language || "auto", "-ml", "1", "-sow", "-ojf", "-of", path.join(dir, "out"), "-np", "-t", String(Math.max(1, Math.min(8, os.cpus().length)))];
    if (prompt) args.push("--prompt", prompt);
    await run(bin(), args, 30 * 60_000);
    const json = JSON.parse(fs.readFileSync(path.join(dir, "out.json"), "utf8"));
    const language: string = json.result?.language ?? opts.language ?? "en";
    return { language, words: wordsFrom(json.transcription ?? [], language), joiner: NO_SPACES.has(language) ? "" : " " };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** whisper.cpp's one-word segments → words, gluing stray punctuation onto the word before. */
export function wordsFrom(segments: { text: string; offsets: { from: number; to: number }; tokens?: { text: string; p?: number }[] }[], language = "en"): Word[] {
  const out: Word[] = [];
  for (const s of segments) {
    const raw = s.text.replace(/\[_[^\]]*\]/g, "");
    const text = raw.trim();
    if (!text || /^\[.*\]$|^\(.*\)$/.test(text)) continue; // [Music], (laughs)
    const start = s.offsets.from / 1000;
    const end = Math.max(start + 0.05, s.offsets.to / 1000);
    // Confidence: the mean of the word's text tokens (special [_…] tokens left out).
    const ps = (s.tokens ?? []).filter((t) => typeof t.p === "number" && !/^\[_/.test(t.text.trim())).map((t) => t.p!);
    const p = ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : undefined;
    const prev = out[out.length - 1];
    if (prev && (/^[\p{P}]+$/u.test(text) || (!/^\s/.test(raw) && !NO_SPACES.has(language)))) {
      prev.text += text;
      prev.end = Math.max(prev.end, end);
    } else out.push({ text, start, end, ...(p !== undefined ? { p } : {}) });
  }
  return out;
}
