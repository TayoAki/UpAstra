import { useEffect, useRef, useState } from "react";
import { Loader2, Wand2 } from "lucide-react";
import type { Clip } from "../../shared/types";
import { api } from "../api";
import { useApp } from "../store";

interface Preview {
  proxyUrl: string;
  ass: string;
  fonts: Record<string, string>;
  duration: number;
  missed: string[];
}

/**
 * The last render's picture with the captions, hook, CTA and overlays drawn
 * live in the browser (libass), from the current caption style and overlays:
 * edits show here at once, without rendering. "Apply to video" recomposes
 * from the stored steps (nothing is charged).
 */
export default function ClipPreview({ clip, styleKey }: { clip: Clip; styleKey: string }) {
  const { run, busy } = useApp();
  const video = useRef<HTMLVideoElement>(null);
  const [p, setP] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const sig = `${clip.id}|${clip.revision ?? 0}|${styleKey}|${clip.render?.finishedAt ?? ""}`;

  useEffect(() => {
    let live = true;
    api
      .preview(clip.id)
      .then((x) => live && (setP(x), setError("")))
      .catch((e: Error) => live && setError(e.message));
    return () => void (live = false);
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!p || !video.current) return;
    let r: { destroy: () => Promise<void> } | undefined;
    let gone = false;
    // libass in a worker, loaded only when a preview is opened.
    void import("jassub").then(({ default: JASSUB }) => {
      if (gone || !video.current) return;
      const abs = (u: string) => new URL(u, location.origin).href;
      r = new JASSUB({ video: video.current, subContent: p.ass, availableFonts: Object.fromEntries(Object.entries(p.fonts).map(([k, v]) => [k.toLowerCase(), abs(v)])) });
    });
    return () => {
      gone = true;
      void r?.destroy();
    };
  }, [p]);

  if (error) return <p className="small muted">{error}</p>;
  if (!p)
    return (
      <p className="small muted">
        <Loader2 size={13} className="spin" /> Loading the preview…
      </p>
    );
  return (
    <div className="col">
      <div className="preview-frame">
        <video ref={video} className="clip-video" src={p.proxyUrl} controls playsInline preload="metadata" />
      </div>
      {p.missed.length > 0 && <p className="small warn-text">Not placed (cue words not in the voiceover): {p.missed.join(", ")}</p>}
      <div className="row wrap">
        <button className="btn sm primary" disabled={busy} onClick={() => void run(() => api.recompose(clip.id), "Applying — only the captions and overlays are redone")}>
          <Wand2 size={14} /> Apply to video
        </button>
        <span className="small faint">Preview: emoji stickers and sound effects show in the video, not here.</span>
      </div>
    </div>
  );
}
