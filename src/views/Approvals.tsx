import { useCallback, useEffect, useState } from "react";
import type { AuditEntry } from "../../shared/types";
import { api, type JobDetail } from "../api";
import { CheckpointCard } from "../components/Checkpoints";
import { Empty, Frame, Panel, SideHeader, SideItem, StageBadge, Tabs, timeAgo } from "../components/ui";
import { go, useApp } from "../store";

export function ApprovalsView() {
  const { jobs, stats } = useApp();
  const [tab, setTab] = useState<"open" | "history">("open");
  const [details, setDetails] = useState<JobDetail[]>([]);
  const [history, setHistory] = useState<AuditEntry[]>([]);
  const waiting = jobs.filter((j) => j.openCheckpoints > 0);
  const key = waiting.map((j) => `${j.id}:${j.openCheckpoints}:${j.updatedAt}`).join("|");

  const load = useCallback(() => {
    Promise.all(waiting.map((j) => api.job(j.id))).then(setDetails);
    api.audit().then((a) => setHistory(a.filter((x) => x.type === "approval" && x.actor === "human")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(load, [load]);

  const total = details.reduce((n, d) => n + d.job.checkpoints.filter((c) => c.status === "open").length, 0);

  return (
    <Frame
      sidebar={
        <>
          <SideHeader>Waiting on you</SideHeader>
          <div className="side-list">
            {waiting.map((j) => (
              <SideItem key={j.id} title={j.title} img={j.thumb} sub={`${j.clientName} · ${j.openCheckpoints} open`} onClick={() => go(`/job/${j.id}`)} />
            ))}
            {!waiting.length && <p className="muted small pad">Inbox zero.</p>}
          </div>
        </>
      }
      tabs={
        <Tabs
          value={tab}
          onChange={setTab}
          options={[
            { id: "open", label: "Open checkpoints", count: total },
            { id: "history", label: "Decision history" },
          ]}
        />
      }
      right={
        <>
          <h4 className="right-title">Approval gates</h4>
          <p className="small muted">
            Astra drafts, interprets routine feedback and repairs inside your limits. Accepting jobs, spend over the auto-start limit, scope changes, QA escalations and final delivery
            come back to you. Change the gates in Autonomy.
          </p>
          <div className="right-box small">
            <div className="row between">
              <span>Jobs needing attention</span>
              <strong>{stats?.needsAttention ?? 0}</strong>
            </div>
          </div>
        </>
      }
    >
      <header className="page-head">
        <div>
          <h1>Approvals</h1>
          <p className="muted">Every decision that needs a person, across all jobs.</p>
        </div>
      </header>
      {tab === "open" &&
        (details.length ? (
          details.map((d) => (
            <Panel
              key={d.job.id}
              title={
                <button className="link" onClick={() => go(`/job/${d.job.id}`)}>
                  {d.job.title}
                </button>
              }
              aside={<StageBadge stage={d.job.stage} running={d.job.running} />}
            >
              <div className="checkpoint-grid">
                {d.job.checkpoints
                  .filter((c) => c.status === "open")
                  .map((cp) => (
                    <CheckpointCard key={cp.id} jobId={d.job.id} cp={cp} onDone={load} />
                  ))}
              </div>
            </Panel>
          ))
        ) : (
          <Empty>Nothing waiting on you.</Empty>
        ))}
      {tab === "history" && (
        <Panel>
          <ul className="audit">
            {history.map((a) => (
              <li key={a.id} className={a.jobId ? "clickable" : ""} onClick={() => a.jobId && go(`/job/${a.jobId}/activity`)}>
                <span className="muted small">{timeAgo(a.at)}</span>
                <span className="grow">{a.message}</span>
              </li>
            ))}
            {!history.length && <li className="muted">No decisions yet.</li>}
          </ul>
        </Panel>
      )}
    </Frame>
  );
}
