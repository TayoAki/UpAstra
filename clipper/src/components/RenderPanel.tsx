import { useState } from "react";
import { AlertTriangle, Clapperboard, Download, Loader2, RotateCcw, Scissors } from "lucide-react";
import type { Clip, VoiceOption } from "../../shared/types";
import { VOICES } from "../../shared/types";
import { api } from "../api";
import { useApp } from "../store";

const STEPS = ["queued", "analyzing", "voicing", "rendering", "done"] as const;

/** Turn an approved plan into a video, and show the result. */
export function RenderPanel({ clip }: { clip: Clip }) {
  const { run, busy, state } = useApp();
  const [voice, setVoice] = useState<VoiceOption>(clip.render?.voice ?? "ash");
  const r = clip.render;
  const live = r && !["done", "failed"].includes(r.status);
  const canRender = state?.status.render === "connected";
  const voiceOff = state?.status.voice !== "live";

  const start = () => {
    const override = clip.status === "draft";
    if (override && !confirm("This plan isn't approved yet. Render it anyway?")) return;
    void run(() => api.renderClip(clip.id, voice, override), "Render started — this takes a minute or two");
  };

  const controls = (label: string) => (
    <div className="row wrap">
      <select className="select" style={{ width: "auto" }} value={voice} onChange={(e) => setVoice(e.target.value as VoiceOption)} aria-label="Voiceover">
        {VOICES.map((v) => (
          <option key={v.id} value={v.id} disabled={v.id !== "none" && voiceOff}>
            {v.id === "none" ? v.label : `AI voice: ${v.label}`}
          </option>
        ))}
      </select>
      <button className="btn sm primary" disabled={busy || !canRender} onClick={start} title={canRender ? undefined : "Rendering isn't available on this server"}>
        {r ? <RotateCcw size={14} /> : <Clapperboard size={14} />} {label}
      </button>
    </div>
  );

  if (live)
    return (
      <div className="render-box">
        <div className="row">
          <Loader2 size={16} className="spin" />
          <strong>{r.step}</strong>
        </div>
        <div className="render-steps">
          {STEPS.slice(0, 4).map((s) => (
            <span key={s} className={STEPS.indexOf(s) <= STEPS.indexOf(r.status as (typeof STEPS)[number]) ? "on" : ""}>
              {s === "queued" ? "Queued" : s === "analyzing" ? "Watching footage" : s === "voicing" ? "Voiceover" : "Editing"}
            </span>
          ))}
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          The first render of new footage takes longest — each file is fetched once and watched for its best moments.
        </p>
      </div>
    );

  if (r?.status === "done" && r.videoKey)
    return (
      <div className="render-box done">
        <video className="clip-video" src={`${api.videoUrl(clip.id, r.videoKey)}#t=0.8`} controls playsInline preload="metadata" />
        <div className="col grow" style={{ minWidth: 220 }}>
          <div className="small">
            <strong>{Math.round(r.durationSec ?? 0)}s</strong> · {r.voice === "none" ? "no voice (captions only)" : `${r.voice} voice`} · {((r.sizeBytes ?? 0) / 1e6).toFixed(1)} MB
            {r.cost > 0 && <span className="faint"> · ${r.cost.toFixed(3)}</span>}
          </div>
          {r.segments && (
            <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
              {r.segments.map((s, i) => (
                <li key={i}>
                  <span className="muted">
                    {s.footageName} @ {Math.floor(s.start / 60)}:{String(Math.floor(s.start % 60)).padStart(2, "0")}
                  </span>{" "}
                  {s.moment && <>— {s.moment}</>}
                </li>
              ))}
            </ol>
          )}
          {r.voice === "none" && (
            <p className="small warn-text">No voiceover: record the script yourself and lay it over this video — the brief requires the phrase to be spoken.</p>
          )}
          <div className="row wrap">
            <a className="btn sm primary" href={api.videoUrl(clip.id, r.videoKey, true)}>
              <Download size={14} /> Download MP4
            </a>
            {state?.status.editor && r.parts && (
              <a className="btn sm" href={api.editorUrl(clip.id)} target="_blank" rel="noopener" title="Open the shots, voice, captions and text on a timeline (OpenReel)">
                <Scissors size={14} /> Edit in editor
              </a>
            )}
          </div>
          {r.editedAt && <p className="small muted" style={{ margin: 0 }}>Edited in the editor. Rendering again replaces the edit.</p>}
          {controls("Render again")}
        </div>
      </div>
    );

  return (
    <div className="render-box">
      {r?.status === "failed" && (
        <p className="small neg" style={{ margin: 0 }}>
          <AlertTriangle size={13} style={{ verticalAlign: -2 }} /> Last render failed: {r.error}
        </p>
      )}
      {controls(r?.status === "failed" ? "Try again" : "Render video")}
    </div>
  );
}
