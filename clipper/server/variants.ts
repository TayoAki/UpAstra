import { checkClip, words, WORDS_PER_SECOND } from "../shared/rules";
import { classifyHook } from "../shared/learning";
import type { Campaign, Clip, HookStyle } from "../shared/types";
import { HOOK_STYLES } from "../shared/types";
import { newId, now } from "./db";
import { aiLive, chatJSON } from "./llm";
import { sentences } from "./captions";

// A/B variants: the same clip (shots, body of the voiceover, overlays) with a
// different hook — and optionally a different call-to-action line — so the
// creator can post them side by side and see which opening wins.

export const LABELS = "ABCDEFGHIJ".split("");
const MAX_VARIANTS = 6;

const SYSTEM = `You write alternative openings for a short-form clip so the creator can A/B test them.
Each variant gets a new hook (max 12 words) in a hook style the clip hasn't used yet, one of: ${HOOK_STYLES.filter((h) => h.id !== "other").map((h) => h.id).join(", ")}.
Hooks must stop the scroll in the first second, be about as long as the original hook (the clip's length is fixed), fit the rest of the voiceover that follows them, keep every required phrase the original opening contained, and only state facts from keyFacts (never break bannedClaims).
If "newCta" is true, also write a fresh final call-to-action line that still says the campaign's call to action, no longer than the original last line.
Return JSON {"variants":[{"hookStyle","hook","title","ctaLine"}]}.`;

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Swap the clip's opening (and maybe its last line) for a variant's. */
export function applyVariant(base: Clip, v: { hook: string; title?: string; ctaLine?: string; hookStyle?: HookStyle }): Omit<Clip, "id" | "qa" | "createdAt" | "updatedAt"> {
  const sents = sentences(base.narration);
  // The voiceover usually opens by saying the hook; replace that sentence. Otherwise lead with the new hook.
  const opensWithHook = sents.length > 0 && (norm(sents[0]).includes(norm(base.hook)) || norm(base.hook).includes(norm(sents[0])));
  const hookLine = /[.!?…]$/.test(v.hook) ? v.hook : `${v.hook}.`;
  let body = opensWithHook ? sents.slice(1) : sents;
  if (v.ctaLine && body.length > 1) body = [...body.slice(0, -1), /[.!?…]$/.test(v.ctaLine) ? v.ctaLine : `${v.ctaLine}.`];
  const narration = [hookLine, ...body].join(" ");
  return {
    ...base,
    title: v.title || v.hook.slice(0, 60),
    hook: v.hook,
    narration,
    onScreenText: base.onScreenText.map((t) => (norm(t) === norm(base.hook) ? v.hook : t)),
    caption: base.caption.startsWith(base.hook) ? v.hook + base.caption.slice(base.hook.length) : base.caption,
    status: "draft",
    render: undefined,
    traits: base.traits ? { ...base.traits, hookStyle: v.hookStyle ?? classifyHook(v.hook), opening: undefined, voice: undefined } : undefined,
    // Overlays cued on the old hook's words won't be found; keep the rest.
    overlays: base.overlays?.filter((o) => !o.cue || norm(narration).includes(norm(o.cue))),
  };
}

/** Write `n` variants of a clip. The original becomes variant A of the group. */
export async function makeVariants(c: Campaign, base: Clip, siblings: Clip[], n: number, newCta = false): Promise<{ clips: Clip[]; cost: number; model: string }> {
  n = Math.max(1, Math.min(MAX_VARIANTS, n));
  const usedStyles = new Set([base, ...siblings].map((x) => x.traits?.hookStyle ?? classifyHook(x.hook)));
  const usedHooks = new Set([base, ...siblings].map((x) => norm(x.hook)));
  let raw: { hookStyle?: string; hook?: string; title?: string; ctaLine?: string }[] = [];
  let cost = 0;
  let model = "rules";
  if (aiLive() && !process.env.CLIP_SIMULATE) {
    const r = await chatJSON<{ variants?: typeof raw }>(
      "script",
      SYSTEM,
      {
        count: n,
        newCta,
        clip: { hook: base.hook, hookStyle: base.traits?.hookStyle, voiceover: base.narration, lengthSec: base.lengthSec },
        stylesAlreadyTried: [...usedStyles],
        hooksAlreadyUsed: [base, ...siblings].map((x) => x.hook),
        campaign: { product: c.brief.product, requiredPhrases: c.brief.requiredPhrases, callToAction: c.brief.cta, keyFacts: c.brief.keyFacts, bannedClaims: c.brief.bannedClaims, hookExamples: c.brief.hookExamples },
      },
      400 + 250 * n,
    );
    raw = r.json.variants ?? [];
    cost = r.cost;
    model = r.model;
  } else {
    // Without AI: openings from the brief's examples and stock angles, one per untried style.
    const p = c.brief.product || c.brief.requiredPhrases[0] || "this";
    const stock: [HookStyle, string][] = [
      ["question", `Can you actually win in ${p}?`],
      ["pov", `POV: you just found ${p}`],
      ["challenge", `I challenged my friend to ${p}`],
      ["bold-claim", `${p} is the most underrated game right now`],
      ["reveal", `Nobody is talking about ${p}…`],
      ["number", `3 things nobody tells you about ${p}`],
      ["story", `I was losing badly in ${p}, then this happened`],
      ["how-to", `How to win your first match in ${p}`],
    ];
    raw = [...c.brief.hookExamples.map((h) => ({ hook: h, hookStyle: undefined as string | undefined })), ...stock.map(([hookStyle, hook]) => ({ hookStyle, hook }))].filter((x) => !usedHooks.has(norm(x.hook)) && !(x.hookStyle && usedStyles.has(x.hookStyle as HookStyle)));
  }
  const fresh = raw.filter((v) => v.hook?.trim() && !usedHooks.has(norm(v.hook))).slice(0, n);
  const taken = new Set([base, ...siblings].map((x) => x.variantLabel).filter(Boolean));
  const group = base.variantGroup ?? base.id;
  const at = now();
  const clips = fresh.map<Clip>((v, i) => {
    const style = HOOK_STYLES.some((h) => h.id === v.hookStyle) ? (v.hookStyle as HookStyle) : undefined;
    const d = applyVariant(base, { hook: v.hook!.trim(), title: v.title?.trim(), ctaLine: newCta ? v.ctaLine?.trim() : undefined, hookStyle: style });
    // A longer opening needs a little more time, within the brief's limit.
    d.lengthSec = Math.min(c.brief.lengthSec.max || 600, Math.max(d.lengthSec, Math.ceil(words(d.narration) / WORDS_PER_SECOND) + 2));
    const label = LABELS.find((l) => !taken.has(l) && l !== "A") ?? `#${i + 2}`;
    taken.add(label);
    return { ...d, id: newId("clip"), variantGroup: group, variantLabel: label, qa: checkClip(d, c.brief), model, cost: fresh.length ? cost / fresh.length : 0, createdAt: at, updatedAt: at };
  });
  return { clips, cost, model };
}
