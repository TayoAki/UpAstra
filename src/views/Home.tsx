import { useEffect, useState } from "react";
import { fmtPct, fmtUSD } from "../../shared/economics";
import type { AuditEntry } from "../../shared/types";
import { api } from "../api";
import { JobList } from "../components/JobList";
import { Empty, Frame, Money, StageBadge, Tabs, timeAgo } from "../components/ui";
import { go, useApp } from "../store";

type Tab = "pipeline" | "attention" | "delivered";

export function HomeView({ tab: initial }: { tab?: string }) {
  const { jobs, stats } = useApp();
  const [tab, setTab] = useState<Tab>((initial as Tab) ?? "pipeline");
  const [activity, setActivity] = useState<AuditEntry[]>([]);

  useEffect(() => {
    const load = () => api.audit().then((a) => setActivity(a.slice(0, 12)));
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const active = jobs.filter((j) => !["delivered", "rejected"].includes(j.stage));
  const list = tab === "pipeline" ? active : tab === "attention" ? jobs.filter((j) => j.openCheckpoints > 0) : jobs.filter((j) => j.stage === "delivered");
  const attention = jobs.filter((j) => j.openCheckpoints > 0);
  const avgMargin = active.length ? active.reduce((n, j) => n + j.economics.expectedMargin, 0) / active.length : 0;

  return (
    <Frame
      sidebar={<JobList />}
      tabs={
        <Tabs
          value={tab}
          onChange={setTab}
          options={[
            { id: "pipeline", label: "Pipeline", count: active.length },
            { id: "attention", label: "Needs attention", count: attention.length },
            { id: "delivered", label: "Delivered" },
          ]}
        />
      }
      right={
        <>
          <h4 className="right-title">Firm economics</h4>
          <div className="right-box">
            <ul className="kv dots">
              <li>
                <span>Pipeline value</span>
                <Money v={stats?.pipelineValue ?? 0} />
              </li>
              <li>
                <span>Est. gross profit</span>
                <Money v={stats?.estimatedGrossProfit ?? 0} />
              </li>
              <li>
                <span>Avg. expected margin</span>
                <span className="num">{fmtPct(avgMargin)}</span>
              </li>
            </ul>
          </div>
          <h4 className="right-title">Recent activity</h4>
          <ul className="activity">
            {activity.map((a) => (
              <li key={a.id} onClick={() => a.jobId && go(`/job/${a.jobId}/activity`)} className={a.jobId ? "clickable" : ""}>
                <span className={`actor actor-${a.actor}`}>{a.actor}</span>
                <span className="activity-msg">{a.message}</span>
                <span className="muted small">{timeAgo(a.at)}</span>
              </li>
            ))}
          </ul>
        </>
      }
    >
      <header className="page-head">
        <div>
          <h1>Studio Operator</h1>
          <p className="muted">Your cockpit for AI-native creative service work — Astra runs the jobs, Higgsfield models do the production, you hold taste, rights and approvals.</p>
        </div>
        <button className="btn primary" onClick={() => go("/intake")}>
          + New job
        </button>
      </header>

      <div className="kpis">
        <div className="kpi">
          <span>Active jobs</span>
          <strong>{stats?.activeJobs ?? "—"}</strong>
        </div>
        <div className="kpi">
          <span>Pipeline value</span>
          <strong>{fmtUSD(stats?.pipelineValue ?? 0)}</strong>
        </div>
        <div className="kpi">
          <span>Est. gross profit</span>
          <strong>{fmtUSD(stats?.estimatedGrossProfit ?? 0)}</strong>
        </div>
        <div className="kpi warn">
          <span>Need your attention</span>
          <strong>{stats?.needsAttention ?? "—"}</strong>
        </div>
      </div>

      <div className="cards">
        {list.map((j) => (
          <button key={j.id} className="card" onClick={() => go(`/job/${j.id}`)}>
            <div className="card-img" style={j.thumb ? { backgroundImage: `url("${j.thumb}")` } : undefined}>
              {!j.thumb && <span className="placeholder-img" aria-hidden />}
            </div>
            <div className="card-body">
              <div className="card-title">{j.title}</div>
              <div className="muted small">
                {j.clientName} · {j.templateName} · {j.channel}
              </div>
              <div className="card-foot">
                <StageBadge stage={j.stage} running={j.running} />
                <span className="small">
                  {fmtUSD(j.price)} · <span className={j.economics.meetsMinimum ? "pos" : "neg"}>{fmtPct(j.economics.expectedMargin)}</span>
                </span>
              </div>
            </div>
          </button>
        ))}
        {!list.length && <Empty>Nothing here yet.</Empty>}
      </div>

      <h2 className="section-title">How work moves through the firm</h2>
      <p className="prose muted">
        Paste a marketplace listing or direct lead → Astra extracts deliverables, missing inputs, risks and the smallest useful set of client questions → the router picks a model per
        step and code prices the job against your margin floor → Higgsfield runs generations → QA checks every output against the brief and repairs inside your limits → you approve
        delivery. Every decision, generation and cost lands in the audit log, and every delivered job leaves lessons behind.
      </p>

      <div className="next-action">
        <span className="next-avatar">A</span>
        <div>
          <strong>{attention.length ? `${attention.length} job${attention.length === 1 ? "" : "s"} waiting on you` : "Nothing waiting on you"}</strong>
          <p className="muted small">
            {attention.length ? attention.slice(0, 3).map((j) => j.title).join(" · ") : "Astra will open a checkpoint when a decision needs a person."}
          </p>
        </div>
        <button className="btn primary" disabled={!attention.length} onClick={() => go("/approvals")}>
          Review approvals
        </button>
      </div>
    </Frame>
  );
}
