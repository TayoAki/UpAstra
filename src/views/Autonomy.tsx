import { useEffect, useState } from "react";
import { fmtPct, fmtUSD } from "../../shared/economics";
import type { AuditEntry, AutonomyPolicy, Channel, Checkpoint } from "../../shared/types";
import { api } from "../api";
import { Frame, Panel, SideHeader, SideItem, Tabs, timeAgo } from "../components/ui";
import { go, useAction, useApp } from "../store";

const SECTIONS = [
  ["spend", "Spending limits"],
  ["repair", "Repair limits"],
  ["models", "Allowed models"],
  ["messages", "Client messages"],
  ["gates", "Approval gates"],
  ["fees", "Channel fees"],
  ["agents", "Agent access (MCP)"],
] as const;

const AGENT_KINDS: { kind: Checkpoint["kind"]; label: string }[] = [
  { kind: "client-questions", label: "Send clarifying questions" },
  { kind: "accept-job", label: "Accept or decline jobs" },
  { kind: "start-production", label: "Approve production spend" },
  { kind: "qa-escalation", label: "Decide QA escalations" },
  { kind: "client-message", label: "Send client replies" },
  { kind: "budget-limit", label: "Raise a job's spend cap" },
  { kind: "scope-change", label: "Accept scope changes & re-pricing" },
];

function Num({ label, value, onChange, step = 0.01, suffix, hint }: { label: string; value: number; onChange: (n: number) => void; step?: number; suffix?: string; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <div className="row gap">
        <input className="input" type="number" min={0} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
        {suffix && <span className="muted small">{suffix}</span>}
      </div>
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

export function AutonomyView() {
  const { boot, setPolicy } = useApp();
  const { busy, run } = useAction();
  const [p, setP] = useState<AutonomyPolicy | null>(null);
  const [tab, setTab] = useState<"policy" | "audit">("policy");
  const [log, setLog] = useState<AuditEntry[]>([]);
  useEffect(() => {
    if (boot && !p) setP(structuredClone(boot.policy));
  }, [boot, p]);
  useEffect(() => {
    if (tab === "audit") api.audit().then(setLog);
  }, [tab]);
  if (!p || !boot) return null;

  const families = [...new Set(boot.catalog.map((m) => m.family))].sort();
  const origins = [...new Set(boot.catalog.map((m) => m.origin))].sort();
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const save = () => run(() => api.savePolicy(p), "Policy saved — open jobs re-routed").then((r) => r && (setPolicy(r), setP(structuredClone(r))));
  const reset = () => run(() => api.resetPolicy(), "Policy reset").then((r) => r && (setPolicy(r), setP(structuredClone(r))));

  return (
    <Frame
      sidebar={
        <>
          <SideHeader>Controls</SideHeader>
          <div className="side-list">
            {SECTIONS.map(([id, label]) => (
              <SideItem
                key={id}
                title={label}
                onClick={() => {
                  setTab("policy");
                  setTimeout(() => document.getElementById(`sec-${id}`)?.scrollIntoView({ behavior: "smooth" }), 0);
                }}
              />
            ))}
          </div>
        </>
      }
      tabs={
        <Tabs
          value={tab}
          onChange={setTab}
          options={[
            { id: "policy", label: "Autonomy policy" },
            { id: "audit", label: "Firm audit log" },
          ]}
        />
      }
      right={
        <>
          <h4 className="right-title">Astra may, on its own</h4>
          <ul className="bullets small">
            <li>
              <span className="dot ok" />
              Start production under {fmtUSD(p.autoStartBelowCost)} at ≥ {fmtPct(p.minGrossMargin)} margin
            </li>
            <li>
              <span className="dot ok" />
              Repair up to {p.maxAttemptsPerStep} attempts, {fmtUSD(p.maxRepairCostPerAttempt)} each, {fmtUSD(p.maxRepairSpendPerJob)} per job
            </li>
            <li>
              <span className="dot ok" />
              Interpret routine feedback and re-run the affected step
            </li>
            <li>
              <span className={`dot ${p.clientMessages === "auto-send-routine" ? "ok" : "warn"}`} />
              {p.clientMessages === "auto-send-routine" ? "Send routine client replies" : "Draft client replies (you send)"}
            </li>
          </ul>
          <h4 className="right-title">Always comes back to you</h4>
          <ul className="bullets small">
            {p.requireApproval.acceptJob && (
              <li>
                <span className="dot warn" />
                Accepting a job
              </li>
            )}
            {p.requireApproval.scopeChange && (
              <li>
                <span className="dot warn" />
                Major scope changes & re-pricing
              </li>
            )}
            <li>
              <span className="dot warn" />
              Spend over {fmtUSD(p.maxSpendPerJob)} per job
            </li>
            <li>
              <span className="dot warn" />
              QA escalations
            </li>
            <li>
              <span className="dot warn" />
              Final delivery
            </li>
          </ul>
        </>
      }
    >
      {tab === "policy" ? (
        <>
          <header className="page-head">
            <div>
              <h1>Autonomy controls</h1>
              <p className="muted">The rules that let a semi-autonomous firm keep moving safely. Saving re-routes every open job against the new rules.</p>
            </div>
            <div className="row gap">
              <button className="btn" disabled={busy} onClick={reset}>
                Reset
              </button>
              <button className="btn primary" disabled={busy} onClick={save}>
                Save policy
              </button>
            </div>
          </header>
          <Panel title={<span id="sec-spend">Spending limits</span>}>
            <div className="grid3">
              <Num label="Max spend per job" value={p.maxSpendPerJob} onChange={(v) => setP({ ...p, maxSpendPerJob: v })} hint="Generation pauses for a human at this cap." />
              <Num label="Auto-start production below" value={p.autoStartBelowCost} onChange={(v) => setP({ ...p, autoStartBelowCost: v })} hint="Larger estimates need approval." />
              <Num
                label="Minimum gross margin"
                value={Math.round(p.minGrossMargin * 100)}
                step={1}
                suffix="%"
                onChange={(v) => setP({ ...p, minGrossMargin: v / 100 })}
                hint="Jobs below this never start automatically."
              />
              <Num label="Repair reserve" value={Math.round(p.repairReservePct * 100)} step={1} suffix="% of estimate" onChange={(v) => setP({ ...p, repairReservePct: v / 100 })} />
            </div>
          </Panel>
          <Panel title={<span id="sec-repair">Repair limits</span>}>
            <div className="grid3">
              <Num label="Max attempts per step" value={p.maxAttemptsPerStep} step={1} onChange={(v) => setP({ ...p, maxAttemptsPerStep: Math.max(1, Math.round(v)) })} />
              <Num label="Max cost per repair" value={p.maxRepairCostPerAttempt} onChange={(v) => setP({ ...p, maxRepairCostPerAttempt: v })} />
              <Num label="Max repair spend per job" value={p.maxRepairSpendPerJob} onChange={(v) => setP({ ...p, maxRepairSpendPerJob: v })} />
            </div>
          </Panel>
          <Panel title={<span id="sec-models">Allowed models</span>}>
            <p className="small muted">Block a model family or every model from a country of origin. The router falls back to the next best allowed model and says so.</p>
            <h4>Families</h4>
            <div className="toggles">
              {families.map((f) => (
                <button key={f} className={`toggle ${p.blockedFamilies.includes(f) ? "off" : "on"}`} onClick={() => setP({ ...p, blockedFamilies: toggle(p.blockedFamilies, f) })}>
                  {p.blockedFamilies.includes(f) ? "✗" : "✓"} {f}
                </button>
              ))}
            </div>
            <h4>Origins</h4>
            <div className="toggles">
              {origins.map((o) => (
                <button key={o} className={`toggle ${p.blockedOrigins.includes(o) ? "off" : "on"}`} onClick={() => setP({ ...p, blockedOrigins: toggle(p.blockedOrigins, o) })}>
                  {p.blockedOrigins.includes(o) ? "✗" : "✓"} {o}
                </button>
              ))}
            </div>
          </Panel>
          <Panel title={<span id="sec-messages">Client messages</span>}>
            <label className="radio">
              <input type="radio" checked={p.clientMessages === "draft-only"} onChange={() => setP({ ...p, clientMessages: "draft-only" })} />
              Astra drafts every reply; I send.
            </label>
            <label className="radio">
              <input type="radio" checked={p.clientMessages === "auto-send-routine"} onChange={() => setP({ ...p, clientMessages: "auto-send-routine" })} />
              Astra sends routine replies (small revisions, thanks); I approve scope changes, questions and delivery.
            </label>
          </Panel>
          <Panel title={<span id="sec-gates">Approval gates</span>}>
            <label className="radio">
              <input type="checkbox" checked={p.requireApproval.acceptJob} onChange={(e) => setP({ ...p, requireApproval: { ...p.requireApproval, acceptJob: e.target.checked } })} />
              Require my approval to accept every job (otherwise Astra auto-accepts clean briefs that clear the margin floor)
            </label>
            <label className="radio">
              <input type="checkbox" checked={p.requireApproval.scopeChange} onChange={(e) => setP({ ...p, requireApproval: { ...p.requireApproval, scopeChange: e.target.checked } })} />
              Require my approval for scope changes
            </label>
            <label className="radio disabled">
              <input type="checkbox" checked disabled />
              Final delivery always comes back to a human
            </label>
          </Panel>
          <Panel title={<span id="sec-fees">Channel fees</span>}>
            <div className="grid3">
              {(Object.keys(p.channelFees) as Channel[]).map((c) => (
                <Num
                  key={c}
                  label={c}
                  value={Math.round(p.channelFees[c] * 1000) / 10}
                  step={0.5}
                  suffix="%"
                  onChange={(v) => setP({ ...p, channelFees: { ...p.channelFees, [c]: v / 100 } })}
                />
              ))}
            </div>
          </Panel>
          <Panel title={<span id="sec-agents">Agent access (MCP)</span>}>
            <p className="small muted">
              Claude, Astra or any MCP client can run the firm through the Studio Operator MCP server (<code>npm run mcp</code>, or <code>/mcp</code> with <code>MCP_TOKEN</code>). Its
              actions are logged as <span className="actor actor-agent">agent</span>. Choose which decisions an agent may make on its own; everything else waits for you. Agents can
              read this policy but never change it.
            </p>
            {AGENT_KINDS.map(({ kind, label }) => (
              <label key={kind} className="radio">
                <input
                  type="checkbox"
                  checked={p.agentMayResolve.includes(kind)}
                  onChange={(e) => setP({ ...p, agentMayResolve: e.target.checked ? [...p.agentMayResolve, kind] : p.agentMayResolve.filter((k) => k !== kind) })}
                />
                {label}
              </label>
            ))}
            <label className="radio disabled">
              <input type="checkbox" checked={false} disabled />
              Approve final delivery — always a human
            </label>
          </Panel>
        </>
      ) : (
        <>
          <header className="page-head">
            <div>
              <h1>Firm audit log</h1>
              <p className="muted">Every decision, generation, cost, change and repair — so any mistake can be traced back.</p>
            </div>
          </header>
          <Panel>
            <ul className="audit">
              {log.map((a) => (
                <li key={a.id} className={a.jobId ? "clickable" : ""} onClick={() => a.jobId && go(`/job/${a.jobId}/activity`)}>
                  <span className="muted small">{timeAgo(a.at)}</span>
                  <span className={`actor actor-${a.actor}`}>{a.actor}</span>
                  <span className="chip">{a.type}</span>
                  <span className="grow">{a.message}</span>
                  {a.cost !== undefined && <span className="num small">{fmtUSD(a.cost)}</span>}
                </li>
              ))}
            </ul>
          </Panel>
        </>
      )}
    </Frame>
  );
}
