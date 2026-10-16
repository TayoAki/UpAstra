import { displayText, momentNames } from "./markup";
import { BOARD_KINDS, OVERLAY_KINDS, TIERS, type Overlay, type Tier } from "./types";

// Overlay validation shared by the server (plans, edits) and the UI (warnings).

export const MAX_OVERLAYS = 12;

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Characters of scripts written without spaces between words. */
export const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

/** Whether a cue's words are in the narration, in order, as shown in the captions. */
export const cueInScript = (cue: string, script: string) => {
  // "@name" cues a moment marked in the narration with @{name}.
  if (cue.trim().startsWith("@")) return momentNames(script).includes(cue.trim().slice(1));
  const c = norm(cue);
  // Cues and phrases are found in the shown words (what render matches them
  // against): with <$5|five dollars>, cue "$5", not "five dollars".
  if (!c) return false;
  const shown = norm(displayText(script));
  // Unspaced scripts (Chinese, Japanese, Thai) have no word gaps to match on.
  if (UNSPACED.test(c)) return shown.replace(/ /g, "").includes(c.replace(/ /g, ""));
  return ` ${shown} `.includes(` ${c} `);
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
    } else if (kind === "quiz") {
      const answers = (Array.isArray(x.answers) ? x.answers : []).map((a) => str(a, 32)).filter(Boolean).slice(0, 4);
      if (answers.length < 2) continue;
      o.answers = answers;
      const q = str(x.text, 60);
      if (q) o.text = q;
      const k = Number(x.correct);
      if (Number.isInteger(k) && k >= 0 && k < answers.length) o.correct = k;
      const rc = str(x.revealCue, 60);
      if (rc && o.correct !== undefined && (!script || cueInScript(rc, script))) o.revealCue = rc;
    } else {
      const text = str(x.text, kind === "comment" ? 140 : kind === "tier" || kind === "rank" || kind === "podium" ? 24 : 40);
      if (!text) continue;
      o.text = text;
    }
    if (kind === "comment") {
      // Only a commenter the plan or editor named; never a made-up one.
      const user = str(x.user, 24).replace(/^@/, "").replace(/[^\w.]/g, "");
      if (user) o.user = user;
    }
    if (kind === "rank" || kind === "podium") {
      const n = Math.round(Number(x.rank));
      const max = kind === "podium" ? 3 : 10;
      if (!(n >= 1 && n <= max)) continue;
      o.rank = n;
    }
    if (kind === "tier") o.tier = (TIERS as readonly string[]).includes(str(x.tier, 1).toUpperCase()) ? (str(x.tier, 1).toUpperCase() as Tier) : "C";
    if (!o.cue && o.at === undefined) continue;
    if (script && o.cue && !cueInScript(o.cue, script) && o.at === undefined) continue;
    // One board a clip: a tier list, a Top-N or a podium (they'd cover each other).
    const board = out.find((y) => BOARD_KINDS.includes(y.kind))?.kind;
    if (board && BOARD_KINDS.includes(o.kind) && o.kind !== board) continue;
    out.push(o);
    if (out.length >= MAX_OVERLAYS) break;
  }
  return out;
}
