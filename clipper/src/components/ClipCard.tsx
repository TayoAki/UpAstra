import { useState } from "react";
import { Check, Copy, GitBranch, Pencil, Send, Trash2, Trophy, X } from "lucide-react";
import { fmtNum } from "../../shared/rules";
import { speechSeconds } from "../../shared/rules";
import type { Campaign, Clip } from "../../shared/types";
import { api } from "../api";
import { go, useApp } from "../store";
import { Checks, ClipBadge } from "./ui";
import { PostForm } from "./PostForm";
import { OverlayEditor } from "./OverlayEditor";
import { RenderPanel } from "./RenderPanel";

export function ClipCard({ clip, campaign, showCampaign }: { clip: Clip; campaign: Campaign; showCampaign?: boolean }) {
  const { state, run, busy, toast } = useApp();
  const [variants, setVariants] = useState<{ n: number; cta: boolean } | null>(null);
  const [edit, setEdit] = useState(false);
  const [posting, setPosting] = useState(false);
  const [d, setD] = useState({ hook: clip.hook, narration: clip.narration, onScreenText: clip.onScreenText.join("\n"), caption: clip.caption, lengthSec: clip.lengthSec });
  const failing = clip.qa.checks.filter((c) => !c.pass).length;
  const footage = (id?: string) => campaign.footage.find((f) => f.id === id);

  const save = () =>
    run(
      () => api.updateClip(clip.id, { hook: d.hook, narration: d.narration, onScreenText: d.onScreenText.split("\n").map((s) => s.trim()).filter(Boolean), caption: d.caption, lengthSec: Number(d.lengthSec) }),
      "Saved — rules re-checked",
    ).then((r) => r && setEdit(false));
  const approve = () => {
    if (!clip.qa.pass && !confirm(`This plan fails ${failing} rule(s). Approve anyway?`)) return;
    void run(() => api.updateClip(clip.id, { status: "approved", override: !clip.qa.pass }), "Approved");
  };
  const copyScript = () => {
    const text = [`HOOK: ${clip.hook}`, "", "VOICEOVER:", clip.narration, "", "ON SCREEN:", ...clip.onScreenText, "", "SHOTS:", ...clip.shots.map((s, i) => `${i + 1}. ${s.footageName ?? "?"} — ${s.moment} (${s.seconds}s)`), "", "CAPTION:", `${clip.caption} ${clip.hashtags.join(" ")}`].join("\n");
    navigator.clipboard?.writeText(text).then(() => toast("Script copied"));
  };

  return (
    <div className="clip">
      <div className="row between wrap">
        <div className="row wrap">
          <ClipBadge status={clip.status} />
          {clip.qa.pass ? <span className="badge ok">Follows the brief</span> : <span className="badge bad">{failing} rule(s) failing</span>}
          {clip.traits?.strategy && (
            <span className={`badge ${clip.traits.strategy === "test" ? "warn" : "info"}`} title={clip.traits.strategy === "test" ? "Tries something untested, so the system keeps learning" : "Leans on what has worked in your posts"}>
              {clip.traits.strategy === "test" ? "Test" : "Proven pattern"}
            </span>
          )}
          {clip.formatId && (
            <button className="badge info clickable-text" title="Written in a format cloned from a reference video" onClick={() => go(`/formats/${clip.formatId}`)}>
              Format: {state?.formats?.find((f) => f.id === clip.formatId)?.name ?? "deleted"}
            </button>
          )}
          {clip.variantLabel && (
            <span className="badge info" title="A/B variant: same clip, different opening">
              Variant {clip.variantLabel}
            </span>
          )}
          <span className="small muted">
            {clip.angle} · {clip.lengthSec}s{showCampaign ? ` · ${campaign.name}` : ""}
          </span>
        </div>
        <div className="row">
          <button className="btn sm ghost" title="A/B variants: same clip, new hooks" onClick={() => setVariants(variants ? null : { n: 3, cta: false })}>
            <GitBranch size={14} />
          </button>
          <button className="btn sm ghost" title="Copy script" onClick={copyScript}>
            <Copy size={14} />
          </button>
          {!edit && (
            <button className="btn sm ghost" title="Edit" onClick={() => setEdit(true)}>
              <Pencil size={14} />
            </button>
          )}
          <button className="btn sm ghost danger" title="Delete" onClick={() => confirm("Delete this clip plan?") && run(() => api.deleteClip(clip.id), "Deleted")}>
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {variants && (
        <div className="variant-form mt">
          <span className="small">Write</span>
          <select className="select sm" value={variants.n} onChange={(e) => setVariants({ ...variants, n: Number(e.target.value) })}>
            {[2, 3, 4, 5].map((x) => (
              <option key={x} value={x}>
                {x} variants
              </option>
            ))}
          </select>
          <span className="small">with new hooks</span>
          <label className="row small">
            <input type="checkbox" checked={variants.cta} onChange={(e) => setVariants({ ...variants, cta: e.target.checked })} /> and new call-to-action lines
          </label>
          <button className="btn sm primary" disabled={busy} onClick={() => run(() => api.makeVariants(clip.id, variants.n, variants.cta), `${variants.n} variants written — post them side by side`).then((r) => r && setVariants(null))}>
            <GitBranch size={14} /> {busy ? "Writing…" : "Write variants"}
          </button>
        </div>
      )}
      <VariantResults clip={clip} />

      {edit ? (
        <div className="col mt">
          <label className="field">
            Hook
            <input className="input" value={d.hook} onChange={(e) => setD({ ...d, hook: e.target.value })} />
          </label>
          <label className="field">
            Voiceover <span className="faint">(~{Math.round(speechSeconds(d.narration))}s spoken)</span>
            <textarea className="textarea" value={d.narration} onChange={(e) => setD({ ...d, narration: e.target.value })} />
          </label>
          <div className="form-grid">
            <label className="field">
              On-screen text (one per line)
              <textarea className="textarea" style={{ minHeight: 70 }} value={d.onScreenText} onChange={(e) => setD({ ...d, onScreenText: e.target.value })} />
            </label>
            <label className="field">
              Caption
              <textarea className="textarea" style={{ minHeight: 70 }} value={d.caption} onChange={(e) => setD({ ...d, caption: e.target.value })} />
            </label>
            <label className="field">
              Length (s)
              <input className="input" type="number" min={5} value={d.lengthSec} onChange={(e) => setD({ ...d, lengthSec: Number(e.target.value) })} />
            </label>
          </div>
          <div className="row">
            <button className="btn primary sm" disabled={busy} onClick={save}>
              Save
            </button>
            <button className="btn sm" onClick={() => setEdit(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="hook">“{clip.hook}”</div>
          <div className="narr">{clip.narration}</div>
          {clip.onScreenText.length > 0 && (
            <p className="small" style={{ marginBottom: 0 }}>
              <span className="muted">On screen:</span> {clip.onScreenText.join(" · ")}
            </p>
          )}
        </>
      )}

      {clip.shots.length > 0 && (
        <>
          <h3 className="mt">Shots</h3>
          <div className="shots">
            {clip.shots.map((s, i) => {
              const f = footage(s.footageId);
              return (
                <a key={i} className="shot" href={f?.viewUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "none", color: "inherit" }}>
                  <span className="thumb" style={f?.thumbUrl ? { backgroundImage: `url("${f.thumbUrl}")` } : undefined} />
                  <span className="grow">
                    <div className="ellipsis" style={{ fontWeight: 600 }}>
                      {i + 1}. {s.moment}
                    </div>
                    <div className="ellipsis faint">
                      {s.footageName ?? "No footage matched"} · {s.seconds}s
                    </div>
                  </span>
                </a>
              );
            })}
          </div>
        </>
      )}

      {clip.status !== "rejected" && <OverlayEditor clip={clip} />}

      <p className="small" style={{ marginBottom: 6 }}>
        <span className="muted">Caption:</span> {clip.caption} <span className="info">{clip.hashtags.join(" ")}</span>
      </p>

      <details>
        <summary className="small muted" style={{ cursor: "pointer" }}>
          Rule check ({clip.qa.checks.filter((c) => c.pass).length}/{clip.qa.checks.length} pass)
        </summary>
        <Checks checks={clip.qa.checks} />
      </details>

      {clip.status !== "rejected" && (clip.status !== "draft" || clip.render) && <RenderPanel clip={clip} />}

      <div className="row wrap mt">
        {clip.status === "draft" && (
          <button className="btn sm primary" disabled={busy} onClick={approve}>
            <Check size={14} /> Approve
          </button>
        )}
        {clip.status !== "posted" && clip.status !== "rejected" && (
          <button className="btn sm" onClick={() => setPosting(true)}>
            <Send size={14} /> Log a post
          </button>
        )}
        {clip.status === "draft" && (
          <button className="btn sm ghost" onClick={() => run(() => api.updateClip(clip.id, { status: "rejected" }), "Rejected")}>
            <X size={14} /> Reject
          </button>
        )}
        {clip.status === "rejected" && (
          <button className="btn sm" onClick={() => run(() => api.updateClip(clip.id, { status: "draft" }))}>
            Restore
          </button>
        )}
        {clip.cost > 0 && <span className="small faint">${clip.cost.toFixed(3)} to write</span>}
      </div>
      {posting && <PostForm campaign={campaign} clip={clip} onClose={() => setPosting(false)} />}
    </div>
  );
}

/** How each variant of this clip's group is doing (views from logged or synced posts). */
function VariantResults({ clip }: { clip: Clip }) {
  const { state } = useApp();
  if (!clip.variantGroup || !state) return null;
  const group = state.clips.filter((x) => x.variantGroup === clip.variantGroup).sort((a, b) => (a.variantLabel ?? "").localeCompare(b.variantLabel ?? ""));
  if (group.length < 2 || group[0].id !== clip.id) return null; // shown once, on the first variant
  const views = (id: string) => state.posts.filter((p) => p.clipId === id && p.status !== "rejected" && p.status !== "scheduled" && p.status !== "failed").reduce((s, p) => s + p.metrics.views, 0);
  const rows = group.map((x) => ({ x, v: views(x.id), posted: state.posts.some((p) => p.clipId === x.id) }));
  const best = Math.max(...rows.map((r) => r.v));
  return (
    <div className="variant-results mt">
      <div className="small muted">A/B test · {group.length} variants</div>
      {rows.map(({ x, v, posted }) => (
        <div key={x.id} className="variant-row">
          <strong>{x.variantLabel}</strong>
          <span className="grow ellipsis small">“{x.hook}”</span>
          <span className="small">{posted ? `${fmtNum(v)} views` : <span className="faint">not posted</span>}</span>
          {best > 0 && v === best && <Trophy size={14} className="pos" aria-label="Most views" />}
        </div>
      ))}
    </div>
  );
}
