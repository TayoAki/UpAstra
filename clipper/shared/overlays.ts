import { OVERLAY_KINDS, TIERS, type Overlay, type Tier } from "./types";

// Overlay validation shared by the server (plans, edits) and the UI (warnings).

export const MAX_OVERLAYS = 12;

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Whether a cue's words are spoken, in order, in the voiceover. */
export const cueInScript = (cue: string, script: string) => {
  const c = norm(cue);
  return !!c && ` ${norm(script)} `.includes(` ${c} `);
};

const EMOJI = /\p{Extended_Pictographic}/u;

/**
 * Clean overlays from a model or an edit: known kinds only, short texts, one
 * real emoji, a tier from S–D. With `script`, overlays whose cue isn't spoken
 * (and have no fallback time) are dropped.
 */
export function sanitizeOverlays(raw: unknown, script?: string, makeId: () => string = () => Math.random().toString(36).slice(2, 10)): Overlay[] {
  if (!Array.isArray(raw)) return [];
  const out: Overlay[] = [];
  for (const r of raw.slice(0, MAX_OVERLAYS * 2)) {
    if (!r || typeof r !== "object") continue;
    const x = r as Record<string, unknown>;
    const kind = OVERLAY_KINDS.find((k) => k.id === x.kind)?.id;
    if (!kind) continue;
    const str = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
    const o: Overlay = { id: str(x.id, 24) || makeId(), kind };
    const cue = str(x.cue, 60);
    if (cue) o.cue = cue;
    const at = Number(x.at);
    if (x.at !== undefined && x.at !== null && x.at !== "" && Number.isFinite(at) && at >= 0 && at <= 600) o.at = Math.round(at * 10) / 10;
    const hold = Number(x.hold);
    if (Number.isFinite(hold) && hold > 0) o.hold = Math.min(8, Math.max(0.4, Math.round(hold * 10) / 10));
    if (kind === "emoji") {
      const e = str(x.emoji, 16);
      if (!EMOJI.test(e)) continue;
      // One emoji (a single grapheme), not a string of them.
      o.emoji = typeof Intl !== "undefined" && "Segmenter" in Intl ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(e)][0].segment : e;
    } else {
      const text = str(x.text, kind === "comment" ? 140 : kind === "tier" ? 24 : 40);
      if (!text) continue;
      o.text = text;
    }
    if (kind === "comment") o.user = str(x.user, 24).replace(/^@/, "").replace(/[^\w.]/g, "") || "viewer";
    if (kind === "tier") o.tier = (TIERS as readonly string[]).includes(str(x.tier, 1).toUpperCase()) ? (str(x.tier, 1).toUpperCase() as Tier) : "C";
    if (!o.cue && o.at === undefined) continue;
    if (script && o.cue && !cueInScript(o.cue, script) && o.at === undefined) continue;
    out.push(o);
    if (out.length >= MAX_OVERLAYS) break;
  }
  return out;
}
