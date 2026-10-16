import { useRef, useState } from "react";

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * Hover a bar to see any moment of a video: a muted second player, loaded
 * only on first hover, seeks to where the pointer is.
 */
export function HoverScrub({ src, duration }: { src: string; duration?: number }) {
  const v = useRef<HTMLVideoElement>(null);
  const [on, setOn] = useState(false);
  const [at, setAt] = useState<{ x: number; t: number } | null>(null);
  const move = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const d = v.current?.duration || duration || 0;
    const t = frac * d;
    setOn(true);
    setAt({ x: e.clientX - r.left, t });
    if (v.current && Number.isFinite(t) && v.current.readyState > 0) v.current.currentTime = t;
  };
  return (
    <div className="scrub" onMouseMove={move} onMouseLeave={() => setAt(null)} title="Hover to scrub">
      <div className="scrub-pop" style={{ left: at ? at.x : 0, visibility: at ? "visible" : "hidden" }}>
        <video ref={v} src={on ? src : undefined} muted playsInline preload="metadata" />
        {at && <span>{clock(at.t)}</span>}
      </div>
    </div>
  );
}

interface Board {
  interval: number;
  count: number;
  cols: number;
  rows: number;
  tileW: number;
  tileH: number;
  image: string;
}

/** Hover a footage file's bar to scrub its storyboard (one cached atlas image). */
export function StoryboardScrub({ url }: { url: string }) {
  const [board, setBoard] = useState<Board | null | "error">(null);
  const [at, setAt] = useState<{ x: number; i: number } | null>(null);
  const load = () => {
    if (board) return;
    fetch(url, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setBoard)
      .catch(() => setBoard("error"));
  };
  const move = (e: React.MouseEvent<HTMLDivElement>) => {
    load();
    if (!board || board === "error") return;
    const r = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(0.9999, Math.max(0, (e.clientX - r.left) / r.width));
    setAt({ x: e.clientX - r.left, i: Math.floor(frac * board.count) });
  };
  if (board === "error") return null;
  const b = board;
  return (
    <div className="scrub" onMouseEnter={load} onMouseMove={move} onMouseLeave={() => setAt(null)} title="Hover to scrub">
      {b && at && (
        <div className="scrub-pop" style={{ left: at.x }}>
          <div
            style={{
              width: b.tileW,
              height: b.tileH,
              backgroundImage: `url("${b.image}")`,
              backgroundPosition: `-${(at.i % b.cols) * b.tileW}px -${Math.floor(at.i / b.cols) * b.tileH}px`,
            }}
          />
          <span>{clock(at.i * b.interval)}</span>
        </div>
      )}
    </div>
  );
}
