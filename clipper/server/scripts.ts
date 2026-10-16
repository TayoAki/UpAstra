import { checkClip, speechSeconds, WORDS_PER_SECOND } from "../shared/rules";
import { spokenText } from "../shared/markup";
import { getDoc } from "./db";
import { classifyHook, formatOf } from "../shared/learning";
import type { Campaign, Clip, FootageFile, HookStyle, Playbook } from "../shared/types";
import { HOOK_STYLES } from "../shared/types";
import { cueInScript, sanitizeOverlays } from "../shared/overlays";
import { newId, now } from "./db";
import { aiLive, chatJSON } from "./llm";

// Clip plans: for each clip, a hook, a voiceover, on-screen text and the shots
// to cut from the campaign's footage. Every plan is checked against the brief
// before anyone sees it; a failing plan gets one rewrite with the failures.

export const PLANNER_PROMPT = `You are a short-form video producer making clips for a paid "clipping" campaign (TikTok, Reels, Shorts).
Write clip plans a video editor can execute from the campaign's own footage. Each clip must:
- open with a scroll-stopping hook (max 12 words) — vary the angle across clips, don't reuse the brief's examples word for word;
- have a voiceover that says every required phrase out loud and ends with the call to action in the final line;
- only state facts from keyFacts — never invent features, rewards, codes, partnerships or results, and never break bannedClaims;
- fit the length: about ${WORDS_PER_SECOND} spoken words per second;
- list 2-5 shots, each naming an exact footage file from the list and the moment to cut (e.g. "last-second goal"), and a "phrase": the exact narration words where that shot starts (shot 1 starts with the narration). Pick footage that shows what those words claim (visual evidence), not just a picture of a noun in them;
- name its hook style, one of: ${HOOK_STYLES.filter((h) => h.id !== "other").map((h) => h.id).join(", ")};
- where a voice could misread a number or name, write <shown|said> in the narration, e.g. <$5|five dollars>; mark a beat overlays should land on with @{name} and cue them with "@name";
- optionally add 0-4 animated overlays that land on exact words of the voiceover ("cue" must be words copied from the narration): "comment" (a viewer comment the clip answers: {"kind":"comment","cue","user","text"}), "emoji" ({"kind":"emoji","cue","emoji"}) on a punchline, "text" (one big word or number: {"kind":"text","cue","text"}), or "tier" for ranking clips (one per ranked item: {"kind":"tier","cue","text","tier":"S|A|B|C|D"}). Use overlays only where they add something; never put a fact in an overlay that isn't in keyFacts.
When "learning" is given, it is what this creator's past posts showed. Plans marked "proven" lean on what worked (proven traits, the style of the winning hooks — never copy them word for word) and avoid what underperformed. Plans marked "test" each try one untested option from the list instead, so the system keeps learning.
When "format" is given, write every clip in that format: follow its recipe, beats, pacing, hook style and overlay pattern, adapted to this campaign's product, facts and footage (never copy the reference's words or claims).
Return JSON {"clips":[{"title","angle","hookStyle","hook","narration","onScreenText":[...],"cta","shots":[{"footageName","moment","seconds","phrase"}],"lengthSec","caption","hashtags":[...],"overlays":[...]}]}.`;

/** This workspace's voices' learned pace (syllables a second), averaged; the default until a voice is measured. */
export function pace(): number | undefined {
  try {
    const rates = Object.values(getDoc().voiceRates ?? {});
    return rates.length ? rates.reduce((n, r) => n + r.unitsPerSec, 0) / rates.length : undefined;
  } catch {
    return undefined; // outside a workspace (scripts, tests)
  }
}

type Draft = Omit<Clip, "id" | "campaignId" | "status" | "qa" | "model" | "cost" | "createdAt" | "updatedAt"> & { hookStyle?: HookStyle };

/** What the learning system hands the planner: the playbook, and how many of the plans should be tests. */
export interface PlanGuide {
  playbook: Playbook;
  tests: number;
  basedOnPosts: number;
}

const toStr = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const toList = (v: unknown) => (Array.isArray(v) ? v.map(toStr).filter(Boolean) : []);

function matchFootage(name: string, footage: FootageFile[]): FootageFile | undefined {
  const n = name.toLowerCase().replace(/\.\w{2,4}$/, "").trim();
  return footage.find((f) => f.name.toLowerCase().replace(/\.\w{2,4}$/, "").trim() === n) ?? footage.find((f) => n && f.name.toLowerCase().includes(n));
}

export function toDraft(raw: Record<string, unknown>, c: Campaign): Draft {
  const video = c.footage.filter((f) => f.kind === "video");
  const shots = (Array.isArray(raw.shots) ? raw.shots : []).map((s: Record<string, unknown>) => {
    const f = matchFootage(toStr(s.footageName), video);
    // A phrase is kept only if the narration really says it.
    const phrase = toStr(s.phrase).slice(0, 80);
    return { footageId: f?.id, footageName: f?.name ?? (toStr(s.footageName) || undefined), moment: toStr(s.moment), seconds: Math.max(1, Math.round(Number(s.seconds) || 4)), ...(phrase && cueInScript(phrase, toStr(raw.narration)) ? { phrase } : {}) };
  });
  const narration = toStr(raw.narration);
  const lengthSec = Math.round(Number(raw.lengthSec) || Math.max(c.brief.lengthSec.min, Math.ceil(speechSeconds(spokenText(narration), pace())) + 2));
  const style = toStr(raw.hookStyle) as HookStyle;
  return {
    hookStyle: HOOK_STYLES.some((h) => h.id === style) ? style : undefined,
    title: toStr(raw.title) || toStr(raw.hook).slice(0, 60),
    angle: toStr(raw.angle),
    hook: toStr(raw.hook),
    narration,
    onScreenText: toList(raw.onScreenText),
    cta: toStr(raw.cta) || c.brief.cta.text,
    shots,
    lengthSec,
    caption: toStr(raw.caption),
    hashtags: toList(raw.hashtags).map((h) => (h.startsWith("#") ? h : `#${h}`)),
    // Overlays must land on spoken words; ones cued to words that aren't in the voiceover are dropped.
    overlays: sanitizeOverlays(raw.overlays, narration, () => newId("ov")),
  };
}

export function briefForModel(c: Campaign) {
  const b = c.brief;
  return {
    product: b.product,
    goal: b.goal,
    requiredPhrases: b.requiredPhrases,
    callToAction: b.cta,
    lengthSec: b.lengthSec,
    keyFacts: b.keyFacts,
    hookExamples: b.hookExamples,
    contentIdeas: b.contentIdeas,
    dos: b.dos,
    donts: b.donts,
    bannedClaims: b.bannedClaims,
    platforms: b.platforms,
  };
}

// ---------------------------------------------------------------------------
// Without AI: plans assembled from the brief's own hooks, facts and footage.

const ANGLES = [
  { angle: "Surprise reveal", line: (p: string) => `Wait — this is actually ${p}.` },
  { angle: "Big moment", line: (p: string) => `This might be the cleanest play I've seen in ${p}.` },
  { angle: "Challenge", line: (p: string) => `I tried ${p} for the first time. Here's how it went.` },
  { angle: "How it works", line: (p: string) => `How to win your first match in ${p}.` },
  { angle: "Underrated pick", line: (p: string) => `Nobody is talking about ${p}, and that's a mistake.` },
  { angle: "Question", line: (p: string) => `Can you actually score from the wall in ${p}?` },
  { angle: "POV", line: (p: string) => `POV: you just found ${p}.` },
  { angle: "Comeback story", line: (p: string) => `I was down three goals in ${p}, then this happened.` },
  { angle: "Quick list", line: (p: string) => `3 things nobody tells you about ${p}.` },
  { angle: "1v1", line: (p: string) => `I challenged a random player to a 1v1 in ${p}.` },
  { angle: "Dare", line: (p: string) => `My friend said I couldn't win a match in ${p}. Challenge accepted.` },
  { angle: "Bold take", line: (p: string) => `${p} is the most underrated game you're not playing.` },
  { angle: "First-timer POV", line: (p: string) => `POV: your first goal in ${p}.` },
];

/** Hook candidates for plan `i`, ordered by what the playbook wants for it. */
function hookFor(i: number, product: string, examples: string[], used: Set<string>, want?: { prefer: Set<string>; avoid: Set<string> }) {
  const all = [
    ...examples.map((h) => ({ angle: "From the brief", hook: h.replace(/\.+$/, "") })),
    ...ANGLES.map((a) => ({ angle: a.angle, hook: a.line(product) })),
  ];
  // Rotate so consecutive plans don't share a hook.
  const rotated = all.map((_, k) => all[(i + k) % all.length]);
  if (!want) return rotated[0];
  const fresh = (x: { hook: string }) => !used.has(x.hook);
  const preferred = rotated.filter((x) => want.prefer.has(classifyHook(x.hook)));
  const allowed = rotated.filter((x) => !want.avoid.has(classifyHook(x.hook)));
  return preferred.find(fresh) ?? preferred[0] ?? allowed.find(fresh) ?? allowed[0] ?? rotated[0];
}

function simulatedDrafts(c: Campaign, n: number, offset: number, plan?: (k: number) => { prefer: Set<string>; avoid: Set<string> } | undefined): Draft[] {
  const b = c.brief;
  const product = b.product || b.requiredPhrases[0] || "this";
  const video = c.footage.filter((f) => f.kind === "video");
  const facts = b.keyFacts.filter((f) => f.length < 140 && !/^you do not need/i.test(f));
  const used = new Set<string>();
  return Array.from({ length: n }, (_, k) => {
    const i = offset + k;
    const { angle, hook } = hookFor(i, product, b.hookExamples, used, plan?.(k));
    used.add(hook);
    const a = { angle };
    const f1 = facts[i % Math.max(facts.length, 1)] ?? `${product} is built for quick, competitive matches.`;
    const f2 = facts[(i + 1) % Math.max(facts.length, 1)] ?? "";
    const missing = b.requiredPhrases.filter((p) => !`${hook} ${f1} ${f2}`.toLowerCase().includes(p.toLowerCase()));
    const narration = [/[.!?…]$/.test(hook) ? hook : `${hook}.`, missing.length ? `It's called ${missing.join(" and ")}.` : "", f1.replace(/\.?$/, "."), f2 ? f2.replace(/\.?$/, ".") : "", b.cta.text ? `${b.cta.text.replace(/[.!]+$/, "")} — link in bio.` : ""]
      .filter(Boolean)
      .join(" ");
    const shots = [0, 1, 2].map((s) => {
      const f = video[(i * 3 + s) % Math.max(video.length, 1)];
      return { footageId: f?.id, footageName: f?.name, moment: ["Strongest moment for the hook", "Gameplay that shows the feature", "Big finish under the call to action"][s], seconds: s === 1 ? 10 : 6 };
    });
    const lengthSec = Math.min(b.lengthSec.max, Math.max(b.lengthSec.min, Math.ceil(speechSeconds(spokenText(narration), pace())) + 3));
    return {
      title: `${a.angle}: ${product}`,
      angle: a.angle,
      hook,
      narration,
      onScreenText: [hook, b.cta.text].filter(Boolean),
      cta: b.cta.text,
      shots,
      lengthSec,
      caption: `${hook} ${b.cta.text ? `👉 ${b.cta.text}` : ""}`.trim(),
      hashtags: [`#${product.replace(/\W+/g, "").toLowerCase()}`, ...(/roblox/i.test(`${b.productUrl} ${b.summary}`) ? ["#roblox", "#robloxgames"] : [])],
    };
  });
}

/** Output room for `n` plans (a full plan runs ~900 tokens; a cut-off reply is unusable JSON). */
const tokensFor = (n: number) => Math.min(16_000, 1_500 + 1_300 * n);

/** Write `n` new clip plans for a campaign, each QA-checked against the brief. */
export async function planClips(c: Campaign, n: number, existing: Clip[], guide?: PlanGuide, format?: { id: string; plan: Record<string, unknown> }): Promise<{ clips: Clip[]; cost: number; model: string }> {
  // The first plans repeat what's proven; the last `tests` try something new.
  const tests = guide ? Math.min(n, guide.tests) : n;
  const strategyOf = (i: number): "proven" | "test" => (i < n - tests ? "proven" : "test");
  const learning = guide && guide.basedOnPosts > 0
    ? {
        basedOnPosts: guide.basedOnPosts,
        proven: guide.playbook.proven.map((p) => `${p.label} (${p.lift}× normal views over ${p.posts} posts)`),
        avoid: guide.playbook.weak.map((p) => `${p.label} (${p.lift}× normal views over ${p.posts} posts)`),
        winningHooks: guide.playbook.winningHooks,
        untested: guide.playbook.untested.map((u) => u.label),
        plans: Array.from({ length: n }, (_, i) => strategyOf(i)),
      }
    : undefined;
  let drafts: Draft[];
  let model = "rules";
  let cost = 0;
  if (aiLive() && !process.env.CLIP_SIMULATE) {
    // Analyzed files come with their logged moments, so shots can ask for real ones.
    const footage = c.footage
      .filter((f) => f.kind === "video")
      .map((f) => (f.moments?.length ? { name: f.name, moments: f.moments.slice(0, 8).map((m) => `${m.type}: ${m.description}`) } : f.name));
    const r = await chatJSON<{ clips?: Record<string, unknown>[] }>("script", PLANNER_PROMPT, {
      campaign: briefForModel(c),
      footage,
      count: n,
      avoidAngles: existing.map((x) => `${x.angle}: ${x.hook}`).slice(-20),
      learning,
      format: format?.plan,
    }, tokensFor(n));
    model = r.model;
    cost = r.cost;
    drafts = (r.json.clips ?? []).slice(0, n).map((x) => toDraft(x, c));
    // One rewrite for plans that break the brief, with the exact failures.
    const failing = drafts.map((d, i) => ({ i, qa: checkClip(d, c.brief) })).filter((x) => !x.qa.pass);
    if (failing.length) {
      const fix = await chatJSON<{ clips?: Record<string, unknown>[] }>("script", PLANNER_PROMPT, {
        campaign: briefForModel(c),
        footage,
        count: failing.length,
        format: format?.plan,
        rewrite: failing.map((f) => ({ plan: drafts[f.i], failedChecks: f.qa.checks.filter((x) => !x.pass) })),
        instruction: "Rewrite each plan so every failed check passes. Keep the angle, hook and hookStyle.",
      }, tokensFor(failing.length));
      cost += fix.cost;
      (fix.json.clips ?? []).forEach((x, k) => {
        if (failing[k]) drafts[failing[k].i] = toDraft(x, c);
      });
    }
  } else {
    // Without AI the playbook still steers which hooks get used.
    const pb = guide?.playbook;
    const hookSet = (xs: { dimension: string; value: string }[] = []) => new Set(xs.filter((x) => x.dimension === "hookStyle").map((x) => x.value));
    drafts = simulatedDrafts(c, n, existing.length, learning && pb ? (k) => ({ prefer: strategyOf(k) === "proven" ? hookSet(pb.proven) : hookSet(pb.untested), avoid: hookSet(pb.weak) }) : undefined);
  }
  const at = now();
  const clips = drafts.map<Clip>(({ hookStyle, ...d }, i) => ({
    ...d,
    traits: { hookStyle: hookStyle ?? classifyHook(d.hook), format: formatOf(d), strategy: learning ? strategyOf(i) : undefined },
    formatId: format?.id,
    id: newId("clip"),
    campaignId: c.id,
    status: "draft",
    qa: checkClip(d, c.brief),
    model,
    cost: drafts.length ? cost / drafts.length : 0,
    createdAt: at,
    updatedAt: at,
  }));
  return { clips, cost, model };
}
