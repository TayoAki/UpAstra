// UGCMediaClips ⇄ OpenReel bridge.
//
// Copied into OpenReel's apps/web/src at build time (see ../apply.mjs). When
// the editor is opened as /editor/?co_clip=<id>#/new?…, it:
//   1. loads the clip's "edit pack" from UGCMediaClips (same origin, session cookie),
//   2. imports the shots and voiceover, and lays out the timeline: shots on a
//      video track, voice on an audio track, the hook and call to action as
//      text, word-timed captions as subtitles,
//   3. points OpenReel's AI editor at UGCMediaClips's AI proxy (no API key in
//      the browser), and
//   4. adds a "Save to UGCMediaClips" button that exports the edit and uploads
//      it as the clip's video.
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { getExportEngine } from "@openreel/core";
import { useProjectStore } from "./stores/project-store";
import { useEngineStore } from "./stores/engine-store";
import { useSettingsStore } from "./stores/settings-store";
import { useTimelineStore } from "./stores/timeline-store";
import { ONBOARDING_KEY } from "./components/editor/tour";

interface Word { text: string; start: number; end: number }
interface EditPack {
  clip: { id: string; title: string };
  width: number;
  height: number;
  fps: number;
  duration: number;
  shots: { url: string; name: string; seconds: number }[];
  voice?: { url: string; name: string };
  captions: { text: string; start: number; end: number; words: Word[] }[];
  hook?: { text: string; end: number };
  /** UGCMediaClips's resolved caption style (brand kit + campaign), as used in its renders. */
  captionStyle?: { font: string; size: number; color: string; highlight: string; outline: string; outlineWidth: number; uppercase: boolean; position: number; animation: string; box?: string };
  accent?: string;
  fonts?: { family: string; url: string }[];
  cta?: { text: string; from: number };
  overlays?: { kind: "comment" | "emoji" | "text" | "tier"; text: string; start: number; end: number; tier?: string }[];
  saveUrl: string;
  backUrl: string;
  ai?: { baseUrl: string; model: string };
}

const CLIP_ID = new URLSearchParams(window.location.search).get("co_clip");
const ACCENT = "#e5484d";

/** Break text into lines of about `max` characters (text clips don't wrap on their own). */
const wrap = (text: string, max: number) =>
  text
    .split(/\s+/)
    .reduce<string[]>((lines, w) => {
      const last = lines[lines.length - 1];
      if (last !== undefined && (last + " " + w).length <= max) lines[lines.length - 1] = `${last} ${w}`;
      else lines.push(w);
      return lines;
    }, [])
    .join("\n");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(get: () => T | undefined | null | false, what: string, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
}

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "same-origin" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${r.status}`);
  return data as T;
}

/** Import a file and return the new media item's id (importMedia doesn't return it). */
async function importFrom(url: string, name: string): Promise<string> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`Couldn't load ${name} (${res.status})`);
  const blob = await res.blob();
  const file = new File([blob], name, { type: blob.type || (name.endsWith(".wav") ? "audio/wav" : "video/mp4") });
  const before = new Set(useProjectStore.getState().project.mediaLibrary.items.map((m) => m.id));
  const r = await useProjectStore.getState().importMedia(file);
  if (!r.success) throw new Error(r.error?.message ?? `Couldn't import ${name}`);
  const item = useProjectStore.getState().project.mediaLibrary.items.find((m) => !before.has(m.id));
  if (!item) throw new Error(`Imported ${name} but couldn't find it`);
  return item.id;
}

async function newTrack(type: "video" | "audio", name: string, role?: "captions" | "dialogue", position?: number): Promise<string> {
  const before = new Set(useProjectStore.getState().project.timeline.tracks.map((t) => t.id));
  const r = await useProjectStore.getState().addTrack(type, position, { name, ...(role ? { role } : {}) });
  if (!r.success) throw new Error(r.error?.message ?? `Couldn't add a ${type} track`);
  return useProjectStore.getState().project.timeline.tracks.find((t) => !before.has(t.id))!.id;
}

async function buildTimeline(pack: EditPack, progress: (s: string) => void) {
  const store = () => useProjectStore.getState();
  await until(() => store().hasOpenProject && store().project.settings.width === pack.width, "the project");
  store().renameProject?.(pack.clip.title);

  // Shots, back to back.
  const videoTrack = await newTrack("video", "Shots");
  let t = 0;
  for (const [i, s] of pack.shots.entries()) {
    progress(`Loading shot ${i + 1} of ${pack.shots.length}…`);
    const mediaId = await importFrom(s.url, s.name);
    const r = await store().addClip(videoTrack, mediaId, t);
    if (!r.success) throw new Error(r.error?.message ?? "Couldn't place a shot");
    t += s.seconds;
  }

  if (pack.voice) {
    progress("Loading the voiceover…");
    const audioTrack = await newTrack("audio", "Voiceover", "dialogue");
    const mediaId = await importFrom(pack.voice.url, pack.voice.name);
    await store().addClip(audioTrack, mediaId, 0);
  }

  progress("Adding text and captions…");
  // The brand's fonts, so text renders (and exports) as it does in UGCMediaClips.
  await Promise.all(
    (pack.fonts ?? []).map(async (f) => {
      try {
        if ([...document.fonts].some((x) => x.family === f.family)) return;
        document.fonts.add(await new FontFace(f.family, `url(${f.url})`).load());
      } catch {
        /* the font just falls back */
      }
    }),
  );
  const cs = pack.captionStyle;
  const font = cs?.font ?? "Inter";
  const cased = (t: string) => (cs?.uppercase === false ? t : t.toUpperCase());
  await until(() => useEngineStore.getState().titleEngine, "the title engine");
  // Text sits on a visual row above the shots (OpenReel draws higher rows on top).
  const textTrack = await newTrack("video", "Hook & CTA", undefined, 0);
  const bold = { fontFamily: font, fontWeight: 800 as const, fontStyle: "normal" as const, textAlign: "center" as const, verticalAlign: "middle" as const, lineHeight: 1.15, letterSpacing: 0 };
  if (pack.hook?.text) {
    const c = store().createTextClip(textTrack, 0, wrap(pack.hook.text, 22), pack.hook.end, { ...bold, fontSize: 68, color: "#ffffff", strokeColor: "#000000", strokeWidth: 6 });
    if (c) store().updateTextTransform(c.id, { position: { x: 0.5, y: 0.15 } });
  }
  if (pack.cta?.text) {
    const c = store().createTextClip(textTrack, pack.cta.from, wrap(pack.cta.text, 20), Math.max(0.5, pack.duration - pack.cta.from), { ...bold, fontSize: 64, color: "#ffffff", backgroundColor: pack.accent ?? ACCENT });
    if (c) store().updateTextTransform(c.id, { position: { x: 0.5, y: 0.5 } });
  }
  // Overlays as editable text on their own row (the tier board's coloured rows stay in the render only).
  if (pack.overlays?.length) {
    const ovTrack = await newTrack("video", "Overlays", undefined, 0);
    const tiers = ["S", "A", "B", "C", "D"];
    let emojiSpot = 0;
    for (const o of pack.overlays) {
      const len = Math.max(0.3, o.end - o.start);
      if (o.kind === "comment") {
        const c = store().createTextClip(ovTrack, o.start, wrap(o.text, 30), len, { ...bold, fontWeight: 600, fontSize: 40, color: "#1a1c20", backgroundColor: "#ffffff", textAlign: "left" });
        if (c) store().updateTextTransform(c.id, { position: { x: 0.5, y: 0.36 } });
      } else if (o.kind === "emoji") {
        const c = store().createTextClip(ovTrack, o.start, o.text, len, { ...bold, fontSize: 180, color: "#ffffff" });
        const spots = [{ x: 0.8, y: 0.36 }, { x: 0.2, y: 0.66 }, { x: 0.8, y: 0.66 }, { x: 0.2, y: 0.36 }];
        if (c) store().updateTextTransform(c.id, { position: spots[emojiSpot++ % spots.length] });
      } else if (o.kind === "tier") {
        const row = Math.max(0, tiers.indexOf(o.tier ?? "C"));
        const c = store().createTextClip(ovTrack, o.start, `${o.tier ?? "C"} · ${o.text}`, len, { ...bold, fontSize: 46, color: "#ffffff", strokeColor: "#000000", strokeWidth: 5, textAlign: "left" });
        if (c) store().updateTextTransform(c.id, { position: { x: 0.3, y: 0.33 + row * 0.065 } });
      } else {
        const c = store().createTextClip(ovTrack, o.start, cased(o.text), len, { ...bold, fontSize: 120, color: "#ffffff", strokeColor: pack.accent ?? ACCENT, strokeWidth: 9 });
        if (c) store().updateTextTransform(c.id, { position: { x: 0.5, y: 0.5 } });
      }
    }
  }
  for (const [i, cap] of pack.captions.entries()) {
    await store().addSubtitle({
      id: `co-cap-${i}`,
      text: cased(cap.text),
      startTime: cap.start,
      endTime: cap.end,
      words: cap.words.map((w) => ({ text: cased(w.text), startTime: w.start, endTime: w.end })),
      animationStyle: cs?.animation === "karaoke" ? "word-highlight" : "none",
      style: { fontFamily: font, fontSize: Math.round((cs?.size ?? 92) * 0.8), color: cs?.color ?? "#ffffff", backgroundColor: cs?.box ? cs.box.slice(0, 7) : "transparent", position: "bottom", highlightColor: cs?.highlight ?? "#ffd60a" },
    });
  }
  // Captions go just under the footage band, as in UGCMediaClips's renders.
  const capTrack = store().project.timeline.tracks.find((t) => t.role === "captions");
  for (const c of store().getAllTextClips().filter((x) => x.trackId === capTrack?.id)) {
    store().updateTextTransform(c.id, { position: { x: 0.5, y: cs?.position ?? 0.78 } });
    store().updateTextStyle(c.id, cs?.box ? { fontFamily: font } : { fontFamily: font, strokeColor: cs?.outline ?? "#000000", strokeWidth: cs?.outlineWidth ?? 8 });
  }

  // The full-frame shots go underneath everything else.
  const rows = store().project.timeline.tracks;
  await store().reorderTrack(videoTrack, rows.length - 1);
}

function configureAI(ai: EditPack["ai"]) {
  if (!ai) return;
  const s = useSettingsStore.getState();
  s.setDefaultLlmProvider("openai-compatible");
  s.setLlmBaseUrl(new URL(ai.baseUrl, window.location.origin).toString());
  s.setLlmModel(ai.model);
  // "Configured" means "a key is stored in the browser vault" — there is none:
  // UGCMediaClips's proxy holds the key and authenticates with the session.
  if (s.configuredServices.includes("openai-compatible")) s.removeConfiguredService("openai-compatible");
}

/** An in-memory stand-in for a file on disk: the exporter seeks and writes MP4 chunks into it. */
function memoryFile() {
  let buf = new Uint8Array(8 * 1024 * 1024);
  let size = 0;
  let pos = 0;
  const ensure = (n: number) => {
    if (n <= buf.length) return;
    let cap = buf.length;
    while (cap < n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(buf.subarray(0, size));
    buf = next;
  };
  const toBytes = (data: unknown): Uint8Array =>
    data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(0);
  const file = {
    async seek(p: number) {
      pos = p;
    },
    async write(data: unknown) {
      const chunk = (data as { type?: string })?.type === "write" ? (data as { data: unknown; position?: number }) : undefined;
      if (chunk?.position !== undefined) pos = chunk.position;
      const bytes = toBytes(chunk ? chunk.data : data);
      ensure(pos + bytes.length);
      buf.set(bytes, pos);
      pos += bytes.length;
      size = Math.max(size, pos);
    },
    async truncate(n: number) {
      size = Math.min(size, n);
    },
    async close() {},
    async abort() {},
    blob: () => new Blob([buf.subarray(0, size)], { type: "video/mp4" }),
  };
  return file;
}

async function saveEdit(pack: EditPack, progress: (s: string) => void) {
  const project = useProjectStore.getState().project;
  const engine = getExportEngine();
  await engine.initialize();
  const out = memoryFile();
  const gen = engine.exportVideo(project, { format: "mp4", codec: "h264", width: pack.width, height: pack.height, frameRate: pack.fps }, out as unknown as FileSystemWritableFileStream);
  let result;
  for (;;) {
    const { value, done } = await gen.next();
    if (done) {
      result = value;
      break;
    }
    progress(`Exporting… ${Math.round(value.progress * 100)}%`);
  }
  if (!result?.success) throw new Error(result?.error?.message ?? "Export failed");
  const blob = out.blob();
  if (blob.size < 1000) throw new Error("The export came out empty");
  progress(`Uploading to UGCMediaClips (${(blob.size / 1e6).toFixed(1)} MB)…`);
  const up = await fetch(pack.saveUrl, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "video/mp4" }, body: blob });
  const data = await up.json().catch(() => ({}));
  if (!up.ok) throw new Error((data as { error?: string }).error ?? `Upload failed (${up.status})`);
}

function Bar() {
  const [pack, setPack] = useState<EditPack>();
  const [status, setStatus] = useState("Loading your clip…");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    (async () => {
      try {
        const p = await getJSON<EditPack>(`/api/clips/${encodeURIComponent(CLIP_ID!)}/edit-pack`);
        setPack(p);
        configureAI(p.ai);
        await buildTimeline(p, setStatus);
        setStatus("Ready — edit away, then save.");
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  }, []);

  const save = async () => {
    if (!pack) return;
    setBusy(true);
    setError(undefined);
    try {
      await saveEdit(pack, setStatus);
      setStatus("Saved to UGCMediaClips ✓");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ position: "fixed", left: "50%", bottom: 12, transform: "translateX(-50%)", zIndex: 2147483000, display: "flex", alignItems: "center", gap: 10, padding: "8px 10px 8px 14px", borderRadius: 999, background: "rgba(20,20,22,0.92)", color: "#fff", font: "500 13px/1.2 system-ui, sans-serif", boxShadow: "0 6px 24px rgba(0,0,0,0.35)", maxWidth: "calc(100vw - 24px)" }}>
      <span style={{ width: 8, height: 8, borderRadius: 99, background: error ? "#ff6369" : busy ? "#f5a623" : "#30a46c", flex: "none" }} />
      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        <strong>UGCMediaClips</strong>
        {pack ? ` · ${pack.clip.title}` : ""} — {error ?? status}
      </span>
      <button disabled={busy || !pack} onClick={save} style={{ border: 0, borderRadius: 999, padding: "7px 12px", background: ACCENT, color: "#fff", font: "inherit", cursor: busy ? "default" : "pointer", opacity: busy || !pack ? 0.6 : 1 }}>
        Save to UGCMediaClips
      </button>
      {pack && (
        <a href={pack.backUrl} style={{ color: "#ccc", textDecoration: "none", whiteSpace: "nowrap" }}>
          Back
        </a>
      )}
    </div>
  );
}

if (CLIP_ID) {
  // For checks and debugging from the console or a test: the project, and a way to move the playhead.
  (window as unknown as { __clipOperator: unknown }).__clipOperator = {
    project: () => useProjectStore.getState().project,
    seek: (t: number) => useTimelineStore.getState().seekTo(t),
  };
  // Straight to work: skip OpenReel's first-run tour.
  try {
    localStorage.setItem(ONBOARDING_KEY, "true");
  } catch {
    /* storage blocked: the tour just shows */
  }
  const host = document.createElement("div");
  host.id = "clip-operator-bridge";
  document.body.appendChild(host);
  ReactDOM.createRoot(host).render(<Bar />);
}

/** True when this editor session was opened from UGCMediaClips (skips the recovery prompt). */
export const OPENED_FROM_CLIP_OPERATOR = !!CLIP_ID;
