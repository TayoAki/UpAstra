import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CampaignBrief, FootageFile, Moment } from "../shared/types";
import { now } from "./db";
import { chatJSON, mediaLive } from "./llm";
import { footageSource } from "./footage-cache";
import { buildProxy, probe } from "./media";

// Finding the moments worth clipping: a vision model (Gemini through
// OpenRouter) watches a 1 fps preview of the footage and returns timestamped
// highlights. Results are cached on the footage file.

const SYSTEM = `You watch footage for a short-form clipping campaign and log the moments worth cutting into clips.
Every frame shows its real timestamp in the top-left corner (white text on a black box). Read times ONLY from that printed timestamp and ignore any clock, countdown or score timer inside the footage itself.
Return JSON {"moments":[{"start":"MM:SS","end":"MM:SS","type":"goal|save|near-miss|boost|funny|reveal|menu|other","description":string,"score":1-10}]}.
- 5 to 15 seconds each, no overlaps, in time order.
- "reveal" = something visually impressive or new; "menu" = lobby, shop, garage, settings or other non-gameplay screens.
- description says exactly what happens on screen in one line.
- score = how strong it is as a hook for a short clip.`;

export function parseTime(v: unknown): number {
  if (typeof v === "number") return v;
  const s = String(v ?? "").trim();
  const parts = s.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const TYPES = new Set(["goal", "save", "near-miss", "boost", "funny", "reveal", "menu", "other"]);

export function cleanMoments(raw: unknown, duration: number): Moment[] {
  const list = Array.isArray((raw as { moments?: unknown })?.moments) ? (raw as { moments: Record<string, unknown>[] }).moments : [];
  const out: Moment[] = [];
  for (const m of list) {
    let start = parseTime(m.start);
    let end = parseTime(m.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (end < start) [start, end] = [end, start];
    // Times past the end of the footage are hallucinated, not clipped.
    if (duration && start >= duration - 1) continue;
    end = Math.min(end, duration || end);
    if (end - start < 2) end = Math.min(start + 6, duration || start + 6);
    out.push({
      start: Math.max(0, start),
      end,
      type: (TYPES.has(String(m.type)) ? m.type : "other") as Moment["type"],
      description: String(m.description ?? "").slice(0, 200),
      score: Math.max(1, Math.min(10, Number(m.score) || 5)),
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Analyze one footage file (duration, audio, moments). Mutates and returns it. */
export async function analyzeFootage(f: FootageFile, brief: CampaignBrief): Promise<{ cost: number }> {
  const url = await footageSource(f);
  const info = await probe(url);
  f.durationSec = Math.round(info.duration * 10) / 10;
  f.hasAudio = info.hasAudio;
  if (!info.duration) throw new Error("Couldn't read the video's length");
  if (!mediaLive()) {
    f.moments = [];
    f.analyzedAt = now();
    f.analysisError = "No AI key: clips will use evenly spaced cuts";
    return { cost: 0 };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-"));
  try {
    const proxy = path.join(tmp, "proxy.mp4");
    await buildProxy(url, proxy, info.duration);
    const data = fs.readFileSync(proxy).toString("base64");
    const r = await chatJSON<unknown>(
      "moments",
      SYSTEM,
      {
        product: brief.product,
        whatToLookFor: [...brief.keyFacts.slice(0, 6), ...brief.contentIdeas.slice(0, 3)],
        file: f.name,
        durationSec: Math.round(info.duration),
        instruction: `Log up to ${Math.min(14, Math.max(4, Math.round(info.duration / 40)))} moments.`,
      },
      3000,
      [{ type: "video_url", video_url: { url: `data:video/mp4;base64,${data}` } }],
    );
    f.moments = cleanMoments(r.json, info.duration);
    f.analyzedAt = now();
    f.analysisError = f.moments.length ? undefined : "No usable moments found";
    return { cost: r.cost };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const SYNONYMS: Record<Moment["type"], RegExp> = {
  goal: /\b(goal|score[sd]?|scoring|net|shot|finish|winner|last-second)\b/,
  save: /\b(save[sd]?|block(?:ed)?|defen[cs]e|stop)\b/,
  "near-miss": /\b(miss(?:ed)?|close|almost|near)\b/,
  boost: /\b(boost(?:ing)?|speed|fast|flip|aerial|wall|jump)\b/,
  funny: /\b(funny|fail|collide|crash|stuck|chaos|demo(?:lish(?:ed)?)?)\b/,
  reveal: /\b(reveal|show|look|new|map|car)\b/,
  menu: /\b(lobby|menu|shop|garage|settings|crate|pad|queue|trade|trading|task|tutorial|leaderboard)\b/,
  other: /$^/,
};

/** Pick the moment that best fits what a shot asks for, avoiding reuse. */
export function pickMoment(shot: string, moments: Moment[], used: Set<string>): Moment | undefined {
  const want = shot.toLowerCase();
  const words = new Set(want.split(/\W+/).filter((w) => w.length > 3));
  let best: { m: Moment; s: number } | undefined;
  for (const m of moments) {
    const key = `${m.start}-${m.end}`;
    if (used.has(key)) continue;
    let s = m.score / 10;
    if (SYNONYMS[m.type].test(want)) s += 2;
    s += m.description
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => words.has(w)).length * 0.4;
    if (!best || s > best.s) best = { m, s };
  }
  return best?.m;
}
