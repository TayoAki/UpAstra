import { useState, type ReactNode } from "react";
import { CheckCircle2, Plus, X, XCircle } from "lucide-react";
import type { ClipStatus, PostStatus, QACheck } from "../../shared/types";

export function Panel({ title, aside, children }: { title?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      {(title || aside) && (
        <div className="row between" style={{ marginBottom: 10 }}>
          {title ? <h2 style={{ margin: 0 }}>{title}</h2> : <span />}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export const Stat = ({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) => (
  <div className="stat">
    <div className="v">{value}</div>
    <div className="l">{label}</div>
    {hint && <div className="small faint">{hint}</div>}
  </div>
);

export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

const CLIP_TONE: Record<ClipStatus, string> = { draft: "", approved: "info", rendering: "warn", ready: "ok", posted: "accent", rejected: "bad" };
export const ClipBadge = ({ status }: { status: ClipStatus }) => <span className={`badge ${CLIP_TONE[status]}`}>{status}</span>;
const POST_TONE: Record<PostStatus, string> = { scheduled: "", live: "info", submitted: "warn", approved: "ok", rejected: "bad", paid: "accent", failed: "bad" };
export const PostBadge = ({ status }: { status: PostStatus }) => <span className={`badge ${POST_TONE[status]}`}>{status}</span>;

export function Checks({ checks }: { checks: QACheck[] }) {
  return (
    <div>
      {checks.map((c) => (
        <div key={c.rule} className="check">
          {c.pass ? <CheckCircle2 size={15} className="pos" /> : <XCircle size={15} className="neg" />}
          <span>
            {c.rule}
            {c.note && <span className="faint"> — {c.note}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Edit a list of short strings in place. */
export function ListEdit({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    if (!draft.trim()) return;
    onChange([...value, draft.trim()]);
    setDraft("");
  };
  return (
    <div className="list-edit">
      {value.map((v, i) => (
        <div className="item" key={i}>
          <input className="input" value={v} onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value : x)))} />
          <button className="btn sm ghost" title="Remove" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <X size={14} />
          </button>
        </div>
      ))}
      <div className="item">
        <input className="input" value={draft} placeholder={placeholder ?? "Add…"} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button className="btn sm" onClick={add}>
          <Plus size={14} />
        </button>
      </div>
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <div className="row between" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="btn sm ghost" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export const ago = (iso?: string) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};
