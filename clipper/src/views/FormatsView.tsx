import { useEffect, useRef, useState } from "react";
import { Copy, Link2, Loader2, RotateCcw, Sparkles, Trash2, Upload } from "lucide-react";
import { CAPTION_STYLES } from "../../shared/caption-styles";
import { HOOK_STYLES, OVERLAY_KINDS, type ReferenceFormat } from "../../shared/types";
import { api, type State } from "../api";
import { uploadFile } from "../components/Upload";
import { ago, Empty, Panel } from "../components/ui";
import { go, useApp } from "../store";

const STATUS: Record<ReferenceFormat["status"], [string, string]> = { uploaded: ["Uploaded", ""], analyzing: ["Breaking down", "warn"], ready: ["Ready", "ok"], failed: ["Failed", "bad"] };
const BEAT_COLORS = ["#E5484D", "#2B59C3", "#18794E", "#A35200", "#8E4EC6", "#0E7C86"];
const secs = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

export function FormatsView({ id }: { id?: string }) {
  return id ? <FormatDetail id={id} /> : <FormatsHome />;
}

function FormatsHome() {
  const { state, setState, toast, run, busy } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [pct, setPct] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);
  if (!state) return <div className="content muted">Loading…</div>;
  const aiOff = state.status.voice !== "live"; // video understanding needs the OpenRouter key

  const upload = async (file?: File) => {
    if (!file) return;
    setPct(0);
    try {
      const r = await uploadFile<{ format: ReferenceFormat; state: State }>("/api/formats", file, setPct);
      setState(r.state);
      go(`/formats/${r.format.id}`);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setPct(null);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>Formats</h1>
          <p className="muted" style={{ margin: 0 }}>
            Clone what works: drop in a viral short and get its format — hook, beats, pacing, captions, overlays — as a recipe. Then write clip plans in that format for any campaign. Only the structure is reused, never the video's words or footage.
          </p>
        </div>
      </div>

      <Panel>
        <div
          className={`drop ${drag ? "on" : ""}`}
          onDragOver={(e) => (e.preventDefault(), setDrag(true))}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            void upload(e.dataTransfer.files?.[0]);
          }}
        >
          <Copy size={28} className="faint" />
          <div>
            <strong>Drop a reference video</strong> <span className="muted">or</span>{" "}
            <button className="btn sm primary" disabled={aiOff || pct !== null} onClick={() => input.current?.click()}>
              <Upload size={14} /> {pct !== null ? `Uploading ${pct}%` : "Choose a file"}
            </button>
          </div>
          <div className="small faint">A short up to 3 minutes. Download it from TikTok, Reels or Shorts first (links to those pages can't be read).</div>
          <input ref={input} type="file" accept="video/*" hidden onChange={(e) => upload(e.target.files?.[0])} />
        </div>
        <label className="field mt">
          Or a link to a video file
          <span className="row">
            <input className="input" placeholder="https://…/video.mp4" value={url} onChange={(e) => setUrl(e.target.value)} />
            <button className="btn" disabled={aiOff || busy || !/^https?:\/\//.test(url)} onClick={() => run(() => api.formatFromUrl(url)).then((r) => r && (setUrl(""), go(`/formats/${r.format.id}`)))}>
              <Link2 size={14} /> Add
            </button>
          </span>
        </label>
        {aiOff && <p className="small neg">Breaking down videos needs the AI key on the server.</p>}
      </Panel>

      <Panel title="Your formats">
        {state.formats.length ? (
          <table className="table">
            <tbody>
              {state.formats.map((f) => (
                <tr key={f.id} className="clickable" onClick={() => go(`/formats/${f.id}`)}>
                  <td>
                    <strong>{f.name}</strong>
                    <div className="small faint ellipsis" style={{ maxWidth: 560 }}>
                      {f.breakdown?.summary ?? f.step ?? f.error ?? ""}
                    </div>
                  </td>
                  <td className="num small faint">{f.durationSec ? `${Math.round(f.durationSec)}s · ` : ""}{ago(f.createdAt)}</td>
                  <td className="num">
                    <span className={`badge ${STATUS[f.status][1]}`}>{STATUS[f.status][0]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No formats yet. Add a short that's doing numbers.</Empty>
        )}
      </Panel>
    </div>
  );
}

function FormatDetail({ id }: { id: string }) {
  const { state, run, busy } = useApp();
  const meta = state?.formats.find((f) => f.id === id);
  const [full, setFull] = useState<ReferenceFormat>();
  const [recipe, setRecipe] = useState<string>();
  const [use, setUse] = useState({ campaign: "", n: 3 });
  const stamp = `${meta?.status}:${meta?.updatedAt}`;
  useEffect(() => {
    if (meta) api.getFormat(id).then(setFull, () => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, stamp]);
  if (!state) return <div className="content muted">Loading…</div>;
  if (!meta) return <div className="content muted">This format was deleted.</div>;
  const b = meta.breakdown;
  const active = state.campaigns.filter((c) => c.status !== "ended");
  const campaign = use.campaign || active[0]?.id || "";
  const dur = meta.durationSec || b?.lengthSec || 1;

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>{meta.name}</h1>
          <p className="muted" style={{ margin: 0 }}>
            <span className={`badge ${STATUS[meta.status][1]}`}>{STATUS[meta.status][0]}</span> {meta.durationSec ? `${Math.round(meta.durationSec)}s` : ""} {meta.cutCount ? `· ${meta.cutCount} cuts` : ""}{" "}
            {meta.cost ? `· $${meta.cost.toFixed(3)} to break down` : ""}
          </p>
        </div>
        <div className="row">
          {meta.status === "failed" && (
            <button className="btn sm" disabled={busy} onClick={() => run(() => api.analyzeFormat(id), "Trying again")}>
              <RotateCcw size={14} /> Try again
            </button>
          )}
          <button className="btn sm ghost danger" title="Delete" onClick={() => confirm("Delete this format and its reference video?") && run(() => api.deleteFormat(id), "Deleted").then((r) => r && go("/formats"))}>
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div className="format-grid">
        <div>
          <video className="format-video" src={`/api/formats/${id}/video`} controls playsInline preload="metadata" />
        </div>
        <div className="col" style={{ gap: 12, minWidth: 0 }}>
          {meta.status === "analyzing" && (
            <Panel>
              <p className="row" style={{ margin: 0 }}>
                <Loader2 size={16} className="spin" /> {meta.step ?? "Working…"}
              </p>
            </Panel>
          )}
          {meta.status === "failed" && (
            <Panel>
              <p className="neg" style={{ margin: 0 }}>{meta.error}</p>
            </Panel>
          )}
          {b && (
            <>
              <Panel title="The format">
                <p style={{ marginTop: 0 }}>{b.summary}</p>
                {b.whyItWorks.length > 0 && (
                  <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                    {b.whyItWorks.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
              </Panel>

              <Panel title="Use this format">
                {active.length ? (
                  <div className="row wrap">
                    <select className="select" style={{ width: "auto" }} value={campaign} onChange={(e) => setUse({ ...use, campaign: e.target.value })}>
                      {active.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <select className="select" style={{ width: "auto" }} value={use.n} onChange={(e) => setUse({ ...use, n: Number(e.target.value) })}>
                      {[1, 3, 5].map((x) => (
                        <option key={x} value={x}>
                          {x} clip{x > 1 ? "s" : ""}
                        </option>
                      ))}
                    </select>
                    <button className="btn primary" disabled={busy || !campaign} onClick={() => run(() => api.planClips(campaign, use.n, id), `${use.n} plan(s) written in this format`).then((r) => r && go(`/c/${campaign}/clips`))}>
                      <Sparkles size={15} /> {busy ? "Writing…" : "Write clip plans"}
                    </button>
                  </div>
                ) : (
                  <p className="small muted" style={{ margin: 0 }}>
                    Add a campaign first, then write its clips in this format.
                  </p>
                )}
                <p className="small faint" style={{ marginBottom: 0 }}>
                  Plans follow the recipe below with the campaign's own footage, facts and rules — and are checked against the brief like any plan.
                </p>
              </Panel>
            </>
          )}
        </div>
      </div>

      {b && (
        <>
          <Panel title="Beats">
            <div className="beat-bar" aria-hidden>
              {b.beats.map((x, i) => (
                <span key={i} title={`${x.purpose} (${secs(x.start)}–${secs(x.end)})`} style={{ left: `${(x.start / dur) * 100}%`, width: `${Math.max(1, ((x.end - x.start) / dur) * 100)}%`, background: BEAT_COLORS[i % BEAT_COLORS.length] }} />
              ))}
            </div>
            <table className="table mt">
              <tbody>
                {b.beats.map((x, i) => (
                  <tr key={i}>
                    <td className="small faint" style={{ width: 90 }}>
                      <span className="dot-sw" style={{ background: BEAT_COLORS[i % BEAT_COLORS.length] }} /> {secs(x.start)}–{secs(x.end)}
                    </td>
                    <td>
                      <strong>{x.purpose}</strong> <span className="small muted">{x.visual}</span>
                      {(x.onScreenText || x.narration) && (
                        <div className="small faint">
                          {x.onScreenText && <>On screen: “{x.onScreenText}” </>}
                          {x.narration && <>Says: “{x.narration}”</>}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          <div className="grid cards">
            <Panel title="Hook">
              <p style={{ marginTop: 0 }}>“{b.hook.text}”</p>
              <p className="small muted" style={{ margin: 0 }}>
                {HOOK_STYLES.find((h) => h.id === b.hook.style)?.label ?? "Other"} · {b.hook.seconds}s · {b.hook.visual}
              </p>
            </Panel>
            <Panel title="Pacing">
              <p className="small" style={{ margin: 0 }}>
                {b.pacing.cuts} cuts · a shot every {b.pacing.avgShotSec}s · {b.lengthSec}s long
              </p>
              <p className="small muted" style={{ marginBottom: 0 }}>{b.pacing.notes}</p>
            </Panel>
            <Panel title="Captions & voice">
              <p className="small" style={{ margin: 0 }}>
                Closest style: <strong>{CAPTION_STYLES.find((s) => s.id === b.captions.style)?.name ?? b.captions.style}</strong>, {b.captions.wordsPerCaption} word{b.captions.wordsPerCaption > 1 ? "s" : ""} at a time. {b.captions.notes}
              </p>
              <p className="small muted" style={{ marginBottom: 0 }}>
                {b.voice.type === "voiceover" ? "Voiceover" : b.voice.type === "on-camera" ? "On camera" : b.voice.type === "text-only" ? "Text only" : "No voice"} · {b.voice.tone}
              </p>
            </Panel>
            <Panel title="Overlays">
              {b.overlays.length ? (
                <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                  {b.overlays.map((o, i) => (
                    <li key={i}>
                      <strong>{OVERLAY_KINDS.find((k) => k.id === o.kind)?.label}</strong> at {secs(o.atSec)} — {o.description}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small muted" style={{ margin: 0 }}>None.</p>
              )}
            </Panel>
          </div>

          <Panel title="Recipe" aside={<span className="small faint">What the planner follows — edit it to taste</span>}>
            <textarea className="textarea" style={{ minHeight: 160 }} value={recipe ?? b.recipe} onChange={(e) => setRecipe(e.target.value)} />
            {recipe !== undefined && recipe !== b.recipe && (
              <button className="btn sm primary mt" disabled={busy} onClick={() => run(() => api.updateFormat(id, { recipe }), "Recipe saved").then((r) => r && setRecipe(undefined))}>
                Save recipe
              </button>
            )}
          </Panel>

          {full?.transcript && (
            <Panel title="Transcript">
              <p className="small muted" style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                {full.transcript}
              </p>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
