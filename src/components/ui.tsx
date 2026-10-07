import type { ReactNode } from "react";
import { fmtPct, fmtUSD } from "../../shared/economics";
import type { Economics, JobStage, QAVerdict } from "../../shared/types";

export const STAGE_LABEL: Record<JobStage, string> = {
  intake: "Intake",
  review: "Review",
  planned: "Planned",
  production: "Production",
  qa: "QA",
  approval: "Awaiting approval",
  revision: "Revision",
  delivered: "Delivered",
  rejected: "Rejected",
};

export function StageBadge({ stage, running }: { stage: JobStage; running?: boolean }) {
  return (
    <span className={`badge stage-${stage}`}>
      {running && <span className="pulse" aria-hidden />}
      {STAGE_LABEL[stage]}
    </span>
  );
}

export function VerdictBadge({ verdict }: { verdict: QAVerdict }) {
  const label = { ready: "Ready", edit: "Edit", regenerate: "Regenerate", human: "Human" }[verdict];
  return <span className={`badge verdict-${verdict}`}>{label}</span>;
}

export const Money = ({ v }: { v: number }) => <span className="num">{fmtUSD(v)}</span>;

export function Frame(props: { sidebar?: ReactNode; tabs?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <>
      {props.sidebar && <aside className="sidebar">{props.sidebar}</aside>}
      <section className="center">
        {props.tabs && <nav className="tabs">{props.tabs}</nav>}
        <main className="main">{props.children}</main>
      </section>
      {props.right && <aside className="rightbar">{props.right}</aside>}
    </>
  );
}

export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string; count?: number }[]; onChange: (v: T) => void }) {
  return (
    <>
      {options.map((o) => (
        <button key={o.id} role="tab" aria-selected={value === o.id} className={`tab ${value === o.id ? "active" : ""}`} onClick={() => onChange(o.id)}>
          {o.label}
          {o.count ? <span className="tab-count">{o.count}</span> : null}
        </button>
      ))}
    </>
  );
}

export function SideHeader({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="side-header">
      <span>{children}</span>
      {action}
    </div>
  );
}

export function SideItem(props: { active?: boolean; onClick: () => void; title: string; sub?: ReactNode; dot?: string; img?: string; badge?: ReactNode }) {
  return (
    <button className={`side-item ${props.active ? "active" : ""}`} onClick={props.onClick}>
      <span className="side-dot" style={{ background: props.img ? `center/cover url("${props.img}")` : props.dot ?? "var(--line)" }} />
      <span className="side-text">
        <span className="side-title">{props.title}</span>
        {props.sub && <span className="side-sub">{props.sub}</span>}
      </span>
      {props.badge}
    </button>
  );
}

export function Panel({ title, children, aside }: { title?: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="panel">
      {title && (
        <div className="panel-head">
          <h3>{title}</h3>
          {aside}
        </div>
      )}
      {children}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function EconomicsList({ e, minMargin }: { e: Economics; minMargin: number }) {
  return (
    <ul className="kv">
      <li>
        <span>Client price</span>
        <Money v={e.price} />
      </li>
      <li>
        <span>Channel fee ({fmtPct(e.channelFeePct)})</span>
        <span className="num neg">−{fmtUSD(e.channelFee)}</span>
      </li>
      <li>
        <span>Production estimate</span>
        <span className="num neg">−{fmtUSD(e.productionEstimate)}</span>
      </li>
      <li>
        <span>Repair reserve</span>
        <span className="num neg">−{fmtUSD(e.repairReserve)}</span>
      </li>
      <li>
        <span>Spent so far</span>
        <Money v={e.actualSpend} />
      </li>
      <li className="kv-total">
        <span>Expected profit</span>
        <Money v={e.expectedProfit} />
      </li>
      <li className="kv-total">
        <span>Gross margin</span>
        <span className={`num ${e.meetsMinimum ? "pos" : "neg"}`}>{fmtPct(e.expectedMargin)}</span>
      </li>
      <li className="muted small">
        <span>Policy minimum {fmtPct(minMargin)}</span>
        <span>{e.meetsMinimum ? "✓ meets" : "✗ below"}</span>
      </li>
    </ul>
  );
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

export function timeAgo(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function ListEditor({ label, value, onChange, placeholder }: { label: string; value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea rows={Math.max(2, value.length + 1)} value={value.join("\n")} placeholder={placeholder ?? "One per line"} onChange={(e) => onChange(e.target.value.split("\n"))} />
    </label>
  );
}
