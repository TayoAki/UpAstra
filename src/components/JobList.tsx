import { useState } from "react";
import { fmtUSD } from "../../shared/economics";
import type { JobStage } from "../../shared/types";
import { go, useApp } from "../store";
import { STAGE_LABEL, SideItem } from "./ui";

const FILTERS: { id: string; label: string; stages?: JobStage[] }[] = [
  { id: "active", label: "Active jobs", stages: ["intake", "review", "planned", "production", "qa", "approval", "revision"] },
  { id: "attention", label: "Needs attention" },
  { id: "delivered", label: "Delivered", stages: ["delivered"] },
  { id: "all", label: "All jobs" },
];

const STAGE_COLOR: Record<JobStage, string> = {
  intake: "var(--c-muted)",
  review: "var(--c-warn)",
  planned: "var(--c-info)",
  production: "var(--c-accent)",
  qa: "var(--c-warn)",
  approval: "var(--c-ok)",
  revision: "var(--c-accent)",
  delivered: "var(--c-ok-soft)",
  rejected: "var(--c-bad)",
};

export function JobList({ activeId }: { activeId?: string }) {
  const { jobs } = useApp();
  const [filter, setFilter] = useState("active");
  const f = FILTERS.find((x) => x.id === filter)!;
  const list = jobs.filter((j) => (f.id === "attention" ? j.openCheckpoints > 0 : f.stages ? f.stages.includes(j.stage) : true));

  return (
    <>
      <label className="side-select">
        <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter jobs">
          {FILTERS.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </select>
        <span aria-hidden>›</span>
      </label>
      <div className="side-list">
        {list.map((j) => (
          <SideItem
            key={j.id}
            active={j.id === activeId}
            onClick={() => go(`/job/${j.id}`)}
            title={j.title}
            img={j.thumb}
            dot={STAGE_COLOR[j.stage]}
            sub={
              <>
                {j.clientName} · {STAGE_LABEL[j.stage]} · {fmtUSD(j.price)}
              </>
            }
            badge={j.openCheckpoints ? <span className="count-pill" title="Open human checkpoints">{j.openCheckpoints}</span> : j.running ? <span className="pulse" /> : null}
          />
        ))}
        {!list.length && <p className="muted small pad">No jobs here.</p>}
      </div>
    </>
  );
}
