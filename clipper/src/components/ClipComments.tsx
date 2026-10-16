import { useState } from "react";
import { Check, MessageSquarePlus, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import type { Clip } from "../../shared/types";
import { api } from "../api";
import { useApp } from "../store";

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Review notes pinned to moments of the video; the agent (or "Apply") acts on the open ones. */
export function ClipComments({ clip }: { clip: Clip }) {
  const { run, busy, state } = useApp();
  const [text, setText] = useState("");
  const [at, setAt] = useState("");
  const [showDone, setShowDone] = useState(false);
  const all = clip.comments ?? [];
  const open = all.filter((c) => !c.resolved);
  const shown = showDone ? all : open;
  const parseAt = (v: string) => {
    const m = v.trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
    return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : undefined;
  };
  const add = () =>
    run(() => api.addComment(clip.id, text.trim(), at.trim() ? parseAt(at) : undefined), "Comment added").then((r) => r && (setText(""), setAt("")));

  return (
    <div className="mt">
      <div className="row between">
        <h3 style={{ margin: 0 }}>Review comments {open.length > 0 && <span className="faint">({open.length} open)</span>}</h3>
        <div className="row">
          {all.length > open.length && (
            <button className="btn sm ghost" onClick={() => setShowDone(!showDone)}>
              {showDone ? "Hide resolved" : `Show resolved (${all.length - open.length})`}
            </button>
          )}
          {open.length > 0 && state?.status.ai === "live" && (
            <button className="btn sm" disabled={busy} title="Re-plan this clip from its open comments (one AI call)" onClick={() => void run(() => api.applyComments(clip.id), "Comments applied — check the plan, then render again")}>
              <Sparkles size={14} /> Apply comments
            </button>
          )}
        </div>
      </div>
      {shown.map((c) => (
        <div key={c.id} className={`row small ${c.resolved ? "faint" : ""}`} style={{ alignItems: "flex-start" }}>
          <span className="badge">{c.at !== undefined ? clock(c.at) : "clip"}</span>
          <span className="grow">
            {c.text} {c.author === "agent" && <span className="faint">(agent)</span>}
          </span>
          <button className="btn sm ghost" disabled={busy} title={c.resolved ? "Reopen" : "Resolve"} onClick={() => void run(() => api.updateComment(clip.id, c.id, { resolved: !c.resolved }))}>
            {c.resolved ? <RotateCcw size={13} /> : <Check size={13} />}
          </button>
          <button className="btn sm ghost" disabled={busy} title="Delete" onClick={() => void run(() => api.deleteComment(clip.id, c.id))}>
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <div className="row wrap">
        <input className="input" style={{ width: 70 }} placeholder="0:05" value={at} onChange={(e) => setAt(e.target.value)} aria-label="At (m:ss, optional)" />
        <input className="input grow" placeholder="Note for this moment, e.g. “cut to the goal sooner”" value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && text.trim() && void add()} />
        <button className="btn sm" disabled={busy || !text.trim() || (!!at.trim() && parseAt(at) === undefined)} onClick={() => void add()}>
          <MessageSquarePlus size={14} /> Add
        </button>
      </div>
    </div>
  );
}
