import type { Campaign, Clip } from "../shared/types";
import { HttpError } from "./db";
import { aiLive, chatJSON } from "./llm";
import { briefForModel, PLANNER_PROMPT, toDraft } from "./scripts";

const REVISE = `${PLANNER_PROMPT}

This time you are revising ONE existing clip plan from a reviewer's comments. Each comment may say when in the video it applies ("at" seconds) and what is being said then. Make the changes the comments ask for and keep everything else as it is (same angle and footage unless a comment says otherwise). Still follow every campaign rule. Return JSON {"clips":[ one revised clip in the same shape ]}.`;

/** What's said around a moment of the last render (for a comment pinned there). */
function saidAt(clip: Clip, at: number | undefined): string | undefined {
  const words = clip.render?.parts?.timing?.words;
  if (at === undefined || !words?.length) return undefined;
  return words.filter((w) => w.end >= at - 1.5 && w.start <= at + 1.5).map((w) => w.text).join(" ") || undefined;
}

/** A revised plan for `clip` that answers its open review comments. */
export async function reviseFromComments(c: Campaign, clip: Clip) {
  const open = (clip.comments ?? []).filter((x) => !x.resolved);
  if (!open.length) throw new HttpError(409, "This clip has no open comments");
  if (!aiLive() || process.env.CLIP_SIMULATE) throw new HttpError(503, "Applying comments needs the AI planner (OPENROUTER_API_KEY)");
  const footage = c.footage.filter((f) => f.kind === "video").map((f) => (f.moments?.length ? { name: f.name, moments: f.moments.slice(0, 8).map((m) => `${m.type}: ${m.description}`) } : f.name));
  const r = await chatJSON<{ clips?: Record<string, unknown>[] }>(
    "script",
    REVISE,
    {
      campaign: briefForModel(c),
      footage,
      clip: { title: clip.title, angle: clip.angle, hook: clip.hook, narration: clip.narration, onScreenText: clip.onScreenText, cta: clip.cta, shots: clip.shots.map((s) => ({ footageName: s.footageName, moment: s.moment, seconds: s.seconds, phrase: s.phrase })), lengthSec: clip.lengthSec, caption: clip.caption, hashtags: clip.hashtags, overlays: clip.overlays },
      comments: open.map((x) => ({ at: x.at, saidThen: saidAt(clip, x.at), comment: x.text })),
    },
    3000,
  );
  const raw = r.json.clips?.[0];
  if (!raw) throw new HttpError(502, "The planner didn't return a revised plan; try again");
  return { draft: toDraft(raw, c), applied: open.map((x) => x.id), cost: r.cost, model: r.model };
}
