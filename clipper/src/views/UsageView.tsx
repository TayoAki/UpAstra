import { useEffect, useState } from "react";
import { fmtNum, fmtUSD } from "../../shared/rules";
import type { AdminUsage, AIKind, UsageReport } from "../../shared/types";
import { api } from "../api";
import { Empty, Panel, Stat } from "../components/ui";
import { useApp } from "../store";

const KIND_LABEL: Record<AIKind, string> = {
  extract: "Reading briefs",
  script: "Writing clip plans",
  moments: "Watching footage",
  voice: "Voiceovers",
  agent: "Clipping Agent",
  editor: "Editor AI chat",
  format: "Breaking down reference videos",
};

const usd = (n: number) => (n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : fmtUSD(Math.round(n * 100) / 100));
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });

/** What this workspace used and what it cost us. */
export function UsageView() {
  const { me, toast } = useApp();
  const [r, setR] = useState<UsageReport>();
  const [admin, setAdmin] = useState<AdminUsage>();
  useEffect(() => {
    api.usage().then(setR, (e: Error) => toast(e.message, true));
    if (me.user.admin) api.adminUsage().then(setAdmin, (e: Error) => toast(e.message, true));
  }, [me.user.admin, toast]);
  if (!r) return <p className="muted">Loading…</p>;
  const [cur, ...past] = r.months;
  const m = cur.usage;
  const kinds = (Object.keys(KIND_LABEL) as AIKind[]).filter((k) => m.ai[k]);
  const pct = r.today.budget > 0 ? Math.min(100, (r.today.usd / r.today.budget) * 100) : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Usage</h1>
          <p className="muted" style={{ margin: 0 }}>
            What this workspace used in {monthName(cur.month)}. AI is what the provider billed; compute and posting are estimates.
          </p>
        </div>
      </div>

      <div className="grid stats">
        <Stat label="Cost this month" value={usd(cur.cost.total)} hint={`AI ${usd(cur.cost.ai)} · compute ${usd(cur.cost.compute)} · posting ${usd(cur.cost.posts)}`} />
        <Stat label="Clips rendered" value={fmtNum(m.renders)} hint={`${Math.round(m.renderSec / 60)} min of video${m.renders ? ` · ${usd(cur.cost.total / m.renders)} per clip` : ""}`} />
        <Stat label="Videos captioned" value={fmtNum(m.captionJobs)} hint={`${Math.round(m.captionSec / 60)} min`} />
        <Stat label="Posts published" value={fmtNum(m.posts)} hint="through connected accounts" />
      </div>

      <Panel title="Today's AI budget">
        <div className="usage-bar" role="meter" aria-valuemin={0} aria-valuemax={r.today.budget} aria-valuenow={r.today.usd}>
          <span style={{ width: `${pct}%` }} className={pct >= 90 ? "hot" : ""} />
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          {usd(r.today.usd)} of {usd(r.today.budget)} · {r.today.calls} of {r.today.callLimit} AI calls. Resets at midnight UTC.
        </p>
      </Panel>

      <Panel title="AI by task">
        {kinds.length ? (
          <table className="table">
            <tbody>
              {kinds.map((k) => (
                <tr key={k}>
                  <td>{KIND_LABEL[k]}</td>
                  <td className="num small faint">{fmtNum(m.ai[k]!.calls)} calls</td>
                  <td className="num">{usd(m.ai[k]!.usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No AI used yet this month.</Empty>
        )}
      </Panel>

      {past.length > 0 && (
        <Panel title="Earlier months">
          <table className="table">
            <tbody>
              {past.map((p) => (
                <tr key={p.month}>
                  <td>{monthName(p.month)}</td>
                  <td className="num small faint">
                    {fmtNum(p.usage.renders)} clips · {fmtNum(p.usage.posts)} posts
                  </td>
                  <td className="num">{usd(p.cost.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {admin && (
        <Panel title={`All workspaces · ${monthName(admin.month)}`} aside={<strong>{usd(admin.total.total)}</strong>}>
          <p className="small muted" style={{ marginTop: 0 }}>
            Operator view. AI {usd(admin.total.ai)} · compute {usd(admin.total.compute)} · posting {usd(admin.total.posts)} across {admin.workspaces.length} workspace{admin.workspaces.length === 1 ? "" : "s"}.
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Workspace</th>
                <th className="num">Clips</th>
                <th className="num">Posts</th>
                <th className="num">AI</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {admin.workspaces.map((w) => (
                <tr key={w.id}>
                  <td>
                    <strong>{w.name}</strong>
                    <div className="small faint">{w.email}</div>
                  </td>
                  <td className="num">{fmtNum(w.usage.renders)}</td>
                  <td className="num">{fmtNum(w.usage.posts)}</td>
                  <td className="num">{usd(w.cost.ai)}</td>
                  <td className="num">{usd(w.cost.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </>
  );
}
