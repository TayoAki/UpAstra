import { useState } from "react";
import { Plus, X } from "lucide-react";
import { cueInScript } from "../../shared/overlays";
import { OVERLAY_KINDS, TIERS, type Clip, type Overlay, type OverlayKind } from "../../shared/types";
import { api } from "../api";
import { useApp } from "../store";

const ICON: Record<OverlayKind, string> = { comment: "💬", emoji: "😀", text: "🅰️", tier: "🏆" };
const EMOJI_PICKS = ["🔥", "😂", "😱", "🤯", "💀", "👀", "😬", "🏆", "💯", "🚀", "❤️", "👏"];

function describe(o: Overlay) {
  if (o.kind === "comment") return `@${o.user}: “${o.text}”`;
  if (o.kind === "emoji") return o.emoji ?? "";
  if (o.kind === "tier") return `${o.text} → ${o.tier} tier`;
  return `“${o.text}”`;
}

/** Overlays timed to words of the voiceover: list, remove, add. */
export function OverlayEditor({ clip }: { clip: Clip }) {
  const { run, busy } = useApp();
  const overlays = clip.overlays ?? [];
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState<{ kind: OverlayKind; cue: string; text: string; user: string; emoji: string; tier: string }>({ kind: "emoji", cue: "", text: "", user: "", emoji: "🔥", tier: "S" });
  const save = (next: Overlay[], msg: string) => run(() => api.updateClip(clip.id, { overlays: next }), `${msg}${clip.render?.status === "done" ? " — render again to see it" : ""}`);
  const cueOk = !f.cue.trim() || cueInScript(f.cue, clip.narration);
  const ready = f.cue.trim() && cueOk && (f.kind === "emoji" ? !!f.emoji : !!f.text.trim());

  const add = () =>
    save([...overlays, { id: Math.random().toString(36).slice(2, 10), kind: f.kind, cue: f.cue.trim(), text: f.text.trim() || undefined, user: f.kind === "comment" ? f.user.trim() || "viewer" : undefined, emoji: f.kind === "emoji" ? f.emoji : undefined, tier: f.kind === "tier" ? (f.tier as Overlay["tier"]) : undefined }], "Overlay added").then(
      (r) => r && (setAdding(false), setF({ ...f, cue: "", text: "" })),
    );

  return (
    <div className="overlays mt">
      <div className="row between">
        <h3 style={{ margin: 0 }}>Overlays</h3>
        {!adding && (
          <button className="btn sm ghost" onClick={() => setAdding(true)}>
            <Plus size={14} /> Add
          </button>
        )}
      </div>
      {!overlays.length && !adding && <p className="small faint" style={{ margin: "4px 0 0" }}>Comment bubbles, emoji, pop-up words and tier lists, timed to words in the voiceover.</p>}
      {overlays.map((o) => {
        const missing = o.cue && !cueInScript(o.cue, clip.narration) && o.at === undefined;
        return (
          <div key={o.id} className="overlay-row">
            <span aria-hidden>{ICON[o.kind]}</span>
            <span className="grow small ellipsis">
              {describe(o)} <span className="faint">on “{o.cue ?? `${o.at}s`}”</span>
              {missing && <span className="neg"> · those words aren't in the voiceover</span>}
            </span>
            <button className="btn sm ghost" title="Remove" disabled={busy} onClick={() => save(overlays.filter((x) => x.id !== o.id), "Overlay removed")}>
              <X size={13} />
            </button>
          </div>
        );
      })}
      {adding && (
        <div className="overlay-form">
          <div className="chips">
            {OVERLAY_KINDS.map((k) => (
              <button key={k.id} className={`chip ${f.kind === k.id ? "on" : ""}`} title={k.hint} onClick={() => setF({ ...f, kind: k.id })}>
                {ICON[k.id]} {k.label}
              </button>
            ))}
          </div>
          <label className="field">
            Appears on the words
            <input className="input" placeholder="e.g. no question" value={f.cue} onChange={(e) => setF({ ...f, cue: e.target.value })} />
            {!cueOk && <span className="small neg">Those words aren't in the voiceover — copy them exactly.</span>}
          </label>
          {f.kind === "emoji" && (
            <div className="chips">
              {EMOJI_PICKS.map((e) => (
                <button key={e} className={`chip ${f.emoji === e ? "on" : ""}`} onClick={() => setF({ ...f, emoji: e })}>
                  {e}
                </button>
              ))}
              <input className="input" style={{ width: 70 }} aria-label="Other emoji" value={f.emoji} onChange={(e) => setF({ ...f, emoji: e.target.value })} />
            </div>
          )}
          {f.kind === "comment" && (
            <div className="form-grid">
              <label className="field">
                From
                <input className="input" placeholder="viewer" value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} />
              </label>
              <label className="field">
                Comment
                <input className="input" maxLength={140} placeholder="is this game actually free??" value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} />
              </label>
            </div>
          )}
          {(f.kind === "text" || f.kind === "tier") && (
            <div className="form-grid">
              <label className="field">
                {f.kind === "tier" ? "Item" : "Text"}
                <input className="input" maxLength={f.kind === "tier" ? 24 : 40} placeholder={f.kind === "tier" ? "Octane" : "100% FREE"} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} />
              </label>
              {f.kind === "tier" && (
                <label className="field">
                  Tier
                  <select className="select" value={f.tier} onChange={(e) => setF({ ...f, tier: e.target.value })}>
                    {TIERS.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}
          <div className="row">
            <button className="btn sm primary" disabled={busy || !ready} onClick={add}>
              Add overlay
            </button>
            <button className="btn sm" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
