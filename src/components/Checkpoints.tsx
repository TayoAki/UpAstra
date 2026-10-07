import { useState } from "react";
import type { Checkpoint } from "../../shared/types";
import { api, type JobDetail } from "../api";
import { useAction } from "../store";

const LABELS: Record<Checkpoint["kind"], [string, string]> = {
  "accept-job": ["Accept", "Decline"],
  "client-questions": ["Send", "Discard"],
  "start-production": ["Start", "Hold"],
  "budget-limit": ["Raise cap", "Stop"],
  "scope-change": ["Accept & re-price", "Decline"],
  "final-delivery": ["Approve delivery", "Send back"],
  "qa-escalation": ["Accept output", "Regenerate"],
  "client-message": ["Send", "Discard"],
};

export function CheckpointCard({ jobId, cp, onDone, compact }: { jobId: string; cp: Checkpoint; onDone?: (d: JobDetail) => void; compact?: boolean }) {
  const { busy, run } = useAction();
  const [note, setNote] = useState("");
  const [yes, no] = LABELS[cp.kind];
  const act = (decision: "approved" | "rejected") =>
    run(() => api.resolve(jobId, cp.id, decision, note || undefined), decision === "approved" ? `${yes}: done` : `${no}: done`).then((d) => d && onDone?.(d));

  return (
    <div className={`checkpoint ${cp.status} ${compact ? "compact" : ""}`}>
      <div className="checkpoint-title">
        <span className="checkpoint-kind">{cp.kind.replace(/-/g, " ")}</span>
        {cp.title}
      </div>
      <p className="checkpoint-detail">{cp.detail}</p>
      {cp.status === "open" ? (
        <>
          {!compact && ["qa-escalation", "final-delivery", "accept-job"].includes(cp.kind) && (
            <input className="input" placeholder="Note (optional — becomes revision feedback when sending back)" value={note} onChange={(e) => setNote(e.target.value)} />
          )}
          <div className="row gap">
            <button className="btn primary sm" disabled={busy} onClick={() => act("approved")}>
              {yes}
            </button>
            <button className="btn sm" disabled={busy} onClick={() => act("rejected")}>
              {no}
            </button>
          </div>
        </>
      ) : (
        <span className={`small ${cp.status === "approved" ? "pos" : "neg"}`}>{cp.status}</span>
      )}
    </div>
  );
}
