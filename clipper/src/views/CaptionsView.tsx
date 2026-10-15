import { useEffect, useMemo, useRef, useState } from "react";
import { Captions, Copy, Download, Link2, Loader2, RotateCcw, Trash2, Upload } from "lucide-react";
import { CAPTION_STYLES, groupWords, resolveCaptionStyle, type CaptionOverrides } from "../../shared/caption-styles";
import { LANGUAGES, languageName } from "../../shared/languages";
import type { CaptionJob } from "../../shared/types";
import { api, type State } from "../api";
import { CaptionPreview, useBrandFonts } from "../components/CaptionPreview";
import { uploadFile } from "../components/Upload";
import { ago, Empty, Panel } from "../components/ui";
import { go, useApp } from "../store";

const STATUS_LABEL: Record<CaptionJob["status"], string> = { uploaded: "Uploaded", transcribing: "Transcribing", ready: "Ready to style", rendering: "Rendering", done: "Captioned", failed: "Failed" };
const TONE: Record<CaptionJob["status"], string> = { uploaded: "", transcribing: "warn", ready: "info", rendering: "warn", done: "ok", failed: "bad" };
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}.${Math.floor((s % 1) * 10)}`;

function LanguageSelect({ value, onChange, auto = true }: { value: string; onChange: (v: string) => void; auto?: boolean }) {
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      {auto && <option value="auto">Detect automatically</option>}
      {[...LANGUAGES].sort((a, b) => a[1].localeCompare(b[1])).map(([c, n]) => (
        <option key={c} value={c}>
          {n}
        </option>
      ))}
    </select>
  );
}

export function CaptionsView({ id }: { id?: string }) {
  return id ? <CaptionJobView id={id} /> : <CaptionsHome />;
}

function CaptionsHome() {
  const { state, setState, toast, run, busy } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [language, setLanguage] = useState("auto");
  const [glossary, setGlossary] = useState("");
  const [url, setUrl] = useState("");
  const [pct, setPct] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);
  if (!state) return <div className="content muted">Loading…</div>;
  const off = state.status.captions === false;

  const upload = async (file?: File) => {
    if (!file) return;
    setPct(0);
    try {
      const q = `?language=${encodeURIComponent(language)}${glossary.trim() ? `&glossary=${encodeURIComponent(glossary)}` : ""}`;
      const r = await uploadFile<{ job: CaptionJob; state: State }>(`/api/captions${q}`, file, setPct);
      setState(r.state);
      go(`/captions/${r.job.id}`);
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
          <h1>Captions</h1>
          <p className="muted" style={{ margin: 0 }}>
            Word-perfect, brand-styled captions for any video with speech. The language is detected automatically (about 99 supported); fix any word, pick a style, and render.
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
          <Captions size={28} className="faint" />
          <div>
            <strong>Drop a video here</strong> <span className="muted">or</span>{" "}
            <button className="btn sm primary" disabled={off || pct !== null} onClick={() => input.current?.click()}>
              <Upload size={14} /> {pct !== null ? `Uploading ${pct}%` : "Choose a file"}
            </button>
          </div>
          <div className="small faint">MP4, MOV, WebM or MKV. Captions keep the video's own shape (vertical, square or wide).</div>
          <input ref={input} type="file" accept="video/*" hidden onChange={(e) => upload(e.target.files?.[0])} />
        </div>
        <div className="form-grid mt">
          <label className="field">
            Spoken language
            <LanguageSelect value={language} onChange={setLanguage} />
          </label>
          <label className="field">
            Names to spell right <span className="faint small">(optional)</span>
            <input className="input" placeholder="Car League, Duel Pad" value={glossary} onChange={(e) => setGlossary(e.target.value)} />
          </label>
          <label className="field">
            Or a link to a video file
            <span className="row">
              <input className="input" placeholder="https://…/video.mp4" value={url} onChange={(e) => setUrl(e.target.value)} />
              <button
                className="btn"
                disabled={off || busy || !/^https?:\/\//.test(url)}
                onClick={() => run(() => api.captionFromUrl({ url, language, glossary })).then((r) => r && (setUrl(""), go(`/captions/${r.job.id}`)))}
              >
                <Link2 size={14} /> Add
              </button>
            </span>
          </label>
        </div>
        {off && <p className="small neg">Transcription isn't installed on this server.</p>}
      </Panel>

      <Panel title="Your videos">
        {state.captionJobs.length ? (
          <table className="table">
            <tbody>
              {state.captionJobs.map((j) => (
                <tr key={j.id} className="clickable" onClick={() => go(`/captions/${j.id}`)}>
                  <td>
                    <strong>{j.name}</strong>
                    <div className="small faint">
                      {j.durationSec ? `${Math.round(j.durationSec)}s · ` : ""}
                      {j.language ? `${languageName(j.language)} · ` : ""}
                      {j.wordCount ? `${j.wordCount} words · ` : ""}
                      {ago(j.createdAt)}
                    </div>
                  </td>
                  <td className="num">
                    <span className={`badge ${TONE[j.status]}`}>{STATUS_LABEL[j.status]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No videos yet. Upload one above.</Empty>
        )}
      </Panel>
    </div>
  );
}

function CaptionJobView({ id }: { id: string }) {
  const { state, run, toast, busy } = useApp();
  const meta = state?.captionJobs.find((j) => j.id === id);
  const [job, setJob] = useState<CaptionJob>();
  const [texts, setTexts] = useState<Record<number, string>>({});
  const [lang, setLang] = useState("auto");
  const brand = state?.brand;
  useBrandFonts(brand);

  // Full transcript (the shared state carries jobs without their words).
  const stamp = `${meta?.status}:${meta?.updatedAt}`;
  useEffect(() => {
    if (!meta) return;
    api.captionJob(id).then(setJob, () => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, stamp]);

  const style = resolveCaptionStyle(brand, job?.captions ?? meta?.captions);
  const caps = useMemo(() => groupWords(job?.words ?? [], style.wordsPerCaption), [job?.words, style.wordsPerCaption]);
  if (!state) return <div className="content muted">Loading…</div>;
  if (!meta) return <div className="content"><Empty>That video isn't here any more.</Empty></div>;

  const working = meta.status === "transcribing" || meta.status === "rendering";
  const edits = Object.entries(texts)
    .map(([first, text]) => {
      const g = caps.find((c) => c.first === Number(first));
      return g && text.trim() !== g.words.map((w) => w.text).join(" ") ? { index: g.first, count: g.words.length, text } : undefined;
    })
    .filter((e): e is { index: number; count: number; text: string } => !!e);
  const setCaptions = async (c: CaptionOverrides) => {
    const r = await run(() => api.updateCaptionJob(id, { captions: c }));
    if (r) setJob(r);
  };
  const saveEdits = async () => {
    if (!edits.length) return true;
    const r = await run(() => api.updateCaptionJob(id, { edits }), `${edits.length} caption(s) updated`);
    if (r) {
      setJob(r);
      setTexts({});
    }
    return !!r;
  };
  const render = async () => {
    if (!(await saveEdits())) return;
    await run(() => api.renderCaptions(id), "Rendering captions");
  };
  const share = async () => {
    try {
      const r = await fetch(`/api/captions/${id}/link`).then((x) => x.json());
      await navigator.clipboard?.writeText(r.url);
      toast("Share link copied (valid 7 days)");
    } catch {
      toast("Couldn't make a link", true);
    }
  };
  const done = meta.status === "done" && meta.outputKey;
  const src = done ? api.captionVideoUrl(id, "output", meta.outputKey) : api.captionVideoUrl(id, "source");

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <button className="btn sm ghost" onClick={() => go("/captions")}>
            ← All videos
          </button>
          <h1 style={{ marginTop: 6 }}>{meta.name}</h1>
          <p className="muted" style={{ margin: 0 }}>
            <span className={`badge ${TONE[meta.status]}`}>{STATUS_LABEL[meta.status]}</span>{" "}
            {meta.language && `${languageName(meta.language)} · `}
            {meta.durationSec ? `${Math.round(meta.durationSec)}s · ` : ""}
            {job ? `${job.words.length} words` : ""}
          </p>
        </div>
        <button className="btn sm ghost danger" title="Delete" onClick={() => confirm("Delete this video and its captions?") && run(() => api.deleteCaptionJob(id), "Deleted").then((r) => r && go("/captions"))}>
          <Trash2 size={14} />
        </button>
      </div>

      {working && (
        <p className="row">
          <Loader2 size={16} className="spin" /> <strong>{meta.step ?? "Working"}…</strong>
        </p>
      )}
      {meta.error && <p className="small neg">{meta.error}</p>}

      <div className="cap-layout">
        <div>
          <video key={src} className="cap-video" src={src} controls playsInline preload="metadata" />
          {done && (
            <div className="row wrap mt">
              <a className="btn sm primary" href={api.captionVideoUrl(id, "output", meta.outputKey, true)}>
                <Download size={14} /> Download
              </a>
              <button className="btn sm" onClick={share}>
                <Copy size={14} /> Copy share link
              </button>
            </div>
          )}
        </div>

        <div className="col grow" style={{ minWidth: 0 }}>
          <Panel title="Style">
            <div className="row wrap" style={{ alignItems: "flex-start", gap: 14 }}>
              <div style={{ width: 220 }}>
                <CaptionPreview style={style} height={100} words={caps[0]?.words.map((w) => w.text)} />
              </div>
              <div className="form-grid grow">
                <label className="field">
                  Style
                  <select className="select" value={job?.captions.style ?? ""} disabled={working} onChange={(e) => setCaptions({ ...job?.captions, style: e.target.value || undefined })}>
                    <option value="">Brand default ({resolveCaptionStyle(brand).name})</option>
                    {CAPTION_STYLES.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Words per caption
                  <select className="select" value={job?.captions.wordsPerCaption ?? ""} disabled={working} onChange={(e) => setCaptions({ ...job?.captions, wordsPerCaption: e.target.value ? Number(e.target.value) : undefined })}>
                    <option value="">Style default ({resolveCaptionStyle(brand, { style: job?.captions.style }).wordsPerCaption})</option>
                    {[1, 2, 3, 4, 5, 6, 8].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Position <span className="small faint">{Math.round(style.position * 100)}% down</span>
                  <input type="range" min={10} max={92} key={`p${style.position}`} defaultValue={Math.round(style.position * 100)} onPointerUp={(e) => setCaptions({ ...job?.captions, position: Number(e.currentTarget.value) / 100 })} />
                </label>
                <label className="field">
                  Size
                  <input type="range" min={30} max={180} key={`s${style.size}`} defaultValue={style.size} onPointerUp={(e) => setCaptions({ ...job?.captions, size: Number(e.currentTarget.value) })} />
                </label>
              </div>
            </div>
            <div className="row wrap mt">
              <button className="btn primary" disabled={busy || working || !job?.words.length} onClick={render}>
                <Captions size={14} /> {done ? "Render again" : "Render captions"}
              </button>
              <span className="small faint">Brand fonts and colours from Settings → Brand & captions apply.</span>
            </div>
          </Panel>

          <Panel
            title="Transcript"
            aside={
              <span className="row">
                <LanguageSelect value={lang} onChange={setLang} />
                <button className="btn sm" disabled={busy || working} onClick={() => run(() => api.retranscribe(id, lang), "Transcribing again")} title="Transcribe again in this language">
                  <RotateCcw size={13} /> Redo
                </button>
              </span>
            }
          >
            {caps.length ? (
              <>
                <div className="transcript">
                  {caps.map((g) => (
                    <label key={g.first} className="tline">
                      <span className="small faint num">{fmtTime(g.start)}</span>
                      <input className="input" value={texts[g.first] ?? g.words.map((w) => w.text).join(" ")} disabled={working} onChange={(e) => setTexts({ ...texts, [g.first]: e.target.value })} />
                    </label>
                  ))}
                </div>
                <div className="row mt">
                  <button className="btn sm" disabled={busy || !edits.length} onClick={saveEdits}>
                    Save {edits.length ? `${edits.length} change${edits.length > 1 ? "s" : ""}` : "changes"}
                  </button>
                  <span className="small faint">Each line keeps its timing; changed words share the line's time.</span>
                </div>
              </>
            ) : (
              <Empty>{working ? "Transcribing…" : meta.status === "failed" ? "No transcript. Try again with the spoken language set." : "No words yet."}</Empty>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
