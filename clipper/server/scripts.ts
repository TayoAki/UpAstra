import { checkClip, words, WORDS_PER_SECOND } from "../shared/rules";
import type { Campaign, Clip, FootageFile } from "../shared/types";
import { newId, now } from "./db";
import { aiLive, chatJSON } from "./llm";

// Clip plans: for each clip, a hook, a voiceover, on-screen text and the shots
// to cut from the campaign's footage. Every plan is checked against the brief
// before anyone sees it; a failing plan gets one rewrite with the failures.

const SYSTEM = `You are a short-form video producer making clips for a paid "clipping" campaign (TikTok, Reels, Shorts).
Write clip plans a video editor can execute from the campaign's own footage. Each clip must:
- open with a scroll-stopping hook (max 12 words) — vary the angle across clips, don't reuse the brief's examples word for word;
- have a voiceover that says every required phrase out loud and ends with the call to action in the final line;
- only state facts from keyFacts — never invent features, rewards, codes, partnerships or results, and never break bannedClaims;
- fit the length: about ${WORDS_PER_SECOND} spoken words per second;
- list 2-5 shots, each naming an exact footage file from the list and the moment to cut (e.g. "last-second goal").
Return JSON {"clips":[{"title","angle","hook","narration","onScreenText":[...],"cta","shots":[{"footageName","moment","seconds"}],"lengthSec","caption","hashtags":[...]}]}.`;

type Draft = Omit<Clip, "id" | "campaignId" | "status" | "qa" | "model" | "cost" | "createdAt" | "updatedAt">;

const toStr = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const toList = (v: unknown) => (Array.isArray(v) ? v.map(toStr).filter(Boolean) : []);

function matchFootage(name: string, footage: FootageFile[]): FootageFile | undefined {
  const n = name.toLowerCase().replace(/\.\w{2,4}$/, "").trim();
  return footage.find((f) => f.name.toLowerCase().replace(/\.\w{2,4}$/, "").trim() === n) ?? footage.find((f) => n && f.name.toLowerCase().includes(n));
}

function toDraft(raw: Record<string, unknown>, c: Campaign): Draft {
  const video = c.footage.filter((f) => f.kind === "video");
  const shots = (Array.isArray(raw.shots) ? raw.shots : []).map((s: Record<string, unknown>) => {
    const f = matchFootage(toStr(s.footageName), video);
    return { footageId: f?.id, footageName: f?.name ?? (toStr(s.footageName) || undefined), moment: toStr(s.moment), seconds: Math.max(1, Math.round(Number(s.seconds) || 4)) };
  });
  const narration = toStr(raw.narration);
  const lengthSec = Math.round(Number(raw.lengthSec) || Math.max(c.brief.lengthSec.min, Math.ceil(words(narration) / WORDS_PER_SECOND) + 2));
  return {
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
  };
}

function briefForModel(c: Campaign) {
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
  { angle: "How it works", line: (p: string) => `Here's ${p} in thirty seconds.` },
  { angle: "Underrated pick", line: (p: string) => `Nobody is talking about ${p}, and that's a mistake.` },
];

function simulatedDrafts(c: Campaign, n: number, offset: number): Draft[] {
  const b = c.brief;
  const product = b.product || b.requiredPhrases[0] || "this";
  const video = c.footage.filter((f) => f.kind === "video");
  const facts = b.keyFacts.filter((f) => f.length < 140 && !/^you do not need/i.test(f));
  return Array.from({ length: n }, (_, k) => {
    const i = offset + k;
    const a = ANGLES[i % ANGLES.length];
    const hook = b.hookExamples.length && i % 2 === 0 ? b.hookExamples[(i / 2) % b.hookExamples.length].replace(/\.+$/, "") : a.line(product);
    const f1 = facts[i % Math.max(facts.length, 1)] ?? `${product} is built for quick, competitive matches.`;
    const f2 = facts[(i + 1) % Math.max(facts.length, 1)] ?? "";
    const missing = b.requiredPhrases.filter((p) => !`${hook} ${f1} ${f2}`.toLowerCase().includes(p.toLowerCase()));
    const narration = [`${hook}.`, missing.length ? `It's called ${missing.join(" and ")}.` : "", f1.replace(/\.?$/, "."), f2 ? f2.replace(/\.?$/, ".") : "", b.cta.text ? `${b.cta.text.replace(/[.!]+$/, "")} — link in bio.` : ""]
      .filter(Boolean)
      .join(" ");
    const shots = [0, 1, 2].map((s) => {
      const f = video[(i * 3 + s) % Math.max(video.length, 1)];
      return { footageId: f?.id, footageName: f?.name, moment: ["Strongest moment for the hook", "Gameplay that shows the feature", "Big finish under the call to action"][s], seconds: s === 1 ? 10 : 6 };
    });
    const lengthSec = Math.min(b.lengthSec.max, Math.max(b.lengthSec.min, Math.ceil(words(narration) / WORDS_PER_SECOND) + 3));
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

/** Write `n` new clip plans for a campaign, each QA-checked against the brief. */
export async function planClips(c: Campaign, n: number, existing: Clip[]): Promise<{ clips: Clip[]; cost: number; model: string }> {
  let drafts: Draft[];
  let model = "rules";
  let cost = 0;
  if (aiLive() && !process.env.CLIP_SIMULATE) {
    // Analyzed files come with their logged moments, so shots can ask for real ones.
    const footage = c.footage
      .filter((f) => f.kind === "video")
      .map((f) => (f.moments?.length ? { name: f.name, moments: f.moments.slice(0, 8).map((m) => `${m.type}: ${m.description}`) } : f.name));
    const r = await chatJSON<{ clips?: Record<string, unknown>[] }>("script", SYSTEM, {
      campaign: briefForModel(c),
      footage,
      count: n,
      avoidAngles: existing.map((x) => `${x.angle}: ${x.hook}`).slice(-20),
    });
    model = r.model;
    cost = r.cost;
    drafts = (r.json.clips ?? []).slice(0, n).map((x) => toDraft(x, c));
    // One rewrite for plans that break the brief, with the exact failures.
    const failing = drafts.map((d, i) => ({ i, qa: checkClip(d, c.brief) })).filter((x) => !x.qa.pass);
    if (failing.length) {
      const fix = await chatJSON<{ clips?: Record<string, unknown>[] }>("script", SYSTEM, {
        campaign: briefForModel(c),
        footage,
        count: failing.length,
        rewrite: failing.map((f) => ({ plan: drafts[f.i], failedChecks: f.qa.checks.filter((x) => !x.pass) })),
        instruction: "Rewrite each plan so every failed check passes. Keep the angle and hook.",
      });
      cost += fix.cost;
      (fix.json.clips ?? []).forEach((x, k) => {
        if (failing[k]) drafts[failing[k].i] = toDraft(x, c);
      });
    }
  } else {
    drafts = simulatedDrafts(c, n, existing.length);
  }
  const at = now();
  const clips = drafts.map<Clip>((d) => ({
    ...d,
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
