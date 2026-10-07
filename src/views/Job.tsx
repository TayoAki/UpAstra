import { useCallback, useEffect, useState } from "react";
import { getModel } from "../../shared/catalog";
import { fmtPct, fmtUSD } from "../../shared/economics";
import { routeStep } from "../../shared/router";
import type { Checkpoint, CopySpec, Generation, Job } from "../../shared/types";
import { AngleList, CopyDeliverable } from "../components/CopyView";
import { api, type JobDetail } from "../api";
import { CheckpointCard } from "../components/Checkpoints";
import { JobList } from "../components/JobList";
import { EconomicsList, Empty, Frame, Panel, StageBadge, Tabs, VerdictBadge, timeAgo } from "../components/ui";
import { go, useAction, useApp } from "../store";

type Tab = "brief" | "production" | "delivery" | "activity";

// The decision that unblocks the most work goes first.
const PRIORITY: Checkpoint["kind"][] = ["accept-job", "start-production", "budget-limit", "qa-escalation", "scope-change", "final-delivery", "client-questions", "client-message"];

export function JobView({ id, tab }: { id: string; tab?: string }) {
  const { boot } = useApp();
  const [d, setD] = useState<JobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = (["brief", "production", "delivery", "activity"].includes(tab ?? "") ? tab : "brief") as Tab;

  const load = useCallback(() => api.job(id).then(setD, (e) => setError(e.message)), [id]);
  useEffect(() => {
    setD(null);
    setError(null);
    load();
  }, [load]);
  const live = !!d && (d.job.running || ["production", "revision"].includes(d.job.stage));
  useEffect(() => {
    const t = setInterval(load, live ? 1200 : 5000);
    return () => clearInterval(t);
  }, [load, live]);

  if (error) return <Frame sidebar={<JobList activeId={id} />}><Empty>{error}</Empty></Frame>;
  if (!d || !boot) return <Frame sidebar={<JobList activeId={id} />}><Empty>Loading…</Empty></Frame>;

  const { job, economics, client } = d;
  const open = job.checkpoints.filter((c) => c.status === "open").sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind));
  const finalGens = d.generations.filter((g) => g.deliverableId && g.status === "completed");
  const latest = finalGens[finalGens.length - 1];

  return (
    <Frame
      sidebar={<JobList activeId={id} />}
      tabs={
        <Tabs
          value={current}
          onChange={(t) => go(`/job/${id}/${t}`)}
          options={[
            { id: "brief", label: "Brief & intake" },
            { id: "production", label: "Production route", count: job.steps.length },
            { id: "delivery", label: "QA & delivery", count: finalGens.length },
            { id: "activity", label: "Activity" },
          ]}
        />
      }
      right={
        <>
          <h4 className="right-title">Job economics</h4>
          <div className="right-box">
            <EconomicsList e={economics} minMargin={boot.policy.minGrossMargin} />
          </div>
          <h4 className="right-title">Human checkpoints {open.length ? <span className="count-pill">{open.length}</span> : null}</h4>
          {open.length ? (
            open.map((cp) => <CheckpointCard key={cp.id} jobId={job.id} cp={cp} onDone={setD} compact />)
          ) : (
            <p className="muted small">No open checkpoints.</p>
          )}
          {latest?.outputUrl && (
            <>
              <h4 className="right-title">Latest output</h4>
              <img className="right-img" src={latest.outputUrl} alt="Latest output" />
            </>
          )}
          {client && (
            <>
              <h4 className="right-title">Client memory</h4>
              <div className="right-box">
                <button className="link" onClick={() => go(`/memory/${client.id}`)}>
                  {client.name}
                </button>
                <div className="swatches">
                  {client.colors.map((c) => (
                    <span key={c} className="swatch" style={{ background: c }} title={c} />
                  ))}
                </div>
                {client.likes.slice(0, 3).map((l) => (
                  <div key={l} className="small">
                    <span className="dot ok" /> {l}
                  </div>
                ))}
                {client.rejectedStyles.slice(0, 2).map((l) => (
                  <div key={l} className="small">
                    <span className="dot bad" /> {l}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      }
    >
      <header className="page-head">
        <div>
          <h1>{job.title}</h1>
          <p className="muted">
            {client?.name} · {d.template.name} · {job.channel}
            {job.sourceUrl && (
              <>
                {" · "}
                <a href={job.sourceUrl} target="_blank" rel="noreferrer">
                  source listing
                </a>
              </>
            )}
            {job.deadline && ` · due ${job.deadline.replace(/^(by|before|within|due)\s+/i, "")}`}
          </p>
        </div>
        <StageBadge stage={job.stage} running={job.running} />
      </header>

      {current === "brief" && <BriefTab d={d} setD={setD} />}
      {current === "production" && <ProductionTab d={d} setD={setD} />}
      {current === "delivery" && <DeliveryTab d={d} setD={setD} />}
      {current === "activity" && <ActivityTab d={d} />}

      {open[0] && current !== "activity" && (
        <div className="next-action">
          <span className="next-avatar">A</span>
          <div className="grow">
            <CheckpointCard jobId={job.id} cp={open[0]} onDone={setD} />
          </div>
        </div>
      )}
    </Frame>
  );
}

function copySummary(c: CopySpec): string {
  const bits = [c.platform, c.funder && `to ${c.funder}`, c.ask, c.fields.map((f) => `${f.label}${f.maxChars ? ` ≤${f.maxChars}c` : f.maxWords ? ` ≤${f.maxWords}w` : ""}`).join(", ")];
  return bits.filter(Boolean).join(" · ");
}

type TabProps = { d: JobDetail; setD: (d: JobDetail) => void };

function List({ items, empty, tone }: { items: string[]; empty: string; tone?: "warn" | "bad" | "ok" }) {
  if (!items.length) return <p className="muted small">{empty}</p>;
  return (
    <ul className="bullets">
      {items.map((x) => (
        <li key={x}>
          <span className={`dot ${tone ?? ""}`} />
          {x}
        </li>
      ))}
    </ul>
  );
}

function BriefTab({ d, setD }: TabProps) {
  const { job } = d;
  const a = job.analysis;
  const { busy, run } = useAction();
  const [price, setPrice] = useState(String(job.price));
  useEffect(() => setPrice(String(job.price)), [job.price]);

  return (
    <>
      <div className="cards three">
        <div className="card static">
          <div className="card-body">
            <div className="card-title">Client brief</div>
            <p className="brief-text">{job.rawBrief}</p>
          </div>
        </div>
        <div className="card static">
          <div className="card-body">
            <div className="card-title">Reference assets</div>
            {job.referenceAssets.length ? (
              <div className="chips">
                {job.referenceAssets.map((r) => (
                  <span key={r} className="chip">
                    {r}
                  </span>
                ))}
              </div>
            ) : (
              <p className="muted small">None supplied.</p>
            )}
          </div>
        </div>
        <div className="card static">
          <div className="card-body">
            <div className="card-title">Client notes & price</div>
            <p className="small">{job.clientNotes || <span className="muted">No notes.</span>}</p>
            <div className="row gap">
              <label className="inline-field">
                $
                <input className="input" type="number" min={0} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
              </label>
              <button className="btn sm" disabled={busy || Number(price) === job.price} onClick={() => run(() => api.price(job.id, Number(price)), "Price updated").then((r) => r && setD(r))}>
                Update
              </button>
            </div>
          </div>
        </div>
      </div>

      {a ? (
        <Panel
          title={
            <>
              Astra's read of the brief <span className="muted small">({a.source})</span>
            </>
          }
          aside={<span className={`badge rec-${a.recommendation}`}>Recommends {a.recommendation}</span>}
        >
          <p>{a.summary}</p>
          <p className="muted small">{a.reasoning}</p>
          <table className="table">
            <thead>
              <tr>
                <th>Deliverable</th>
                <th>Qty</th>
                <th>Format</th>
                <th>Spec</th>
                <th>Duration</th>
                <th>Exact copy</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {job.deliverables.map((x) => (
                <tr key={x.id}>
                  <td>{x.label}</td>
                  <td>{x.quantity}</td>
                  <td>{x.format.toUpperCase()}</td>
                  <td className="small">{x.copy ? copySummary(x.copy) : x.aspect}</td>
                  <td>{x.durationSec ? `${x.durationSec}s` : "—"}</td>
                  <td className="small">{x.exactCopy ? `“${x.exactCopy}”` : "—"}</td>
                  <td>
                    <span className={`badge del-${x.status}`}>{x.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="grid2">
            <div>
              <h4>Missing inputs</h4>
              <List items={a.missingInputs} empty="Nothing missing." tone="warn" />
              <h4>Questions for the client</h4>
              <List items={a.clientQuestions} empty="No questions needed." />
              <h4>Supplied assets</h4>
              <List items={a.suppliedAssets} empty="None detected." tone="ok" />
            </div>
            <div>
              <h4>Risks</h4>
              <List items={a.risks} empty="No risks flagged." tone="bad" />
              <h4>Likely revision problems</h4>
              <List items={a.revisionRisks} empty="None expected." tone="warn" />
              <h4>Exact copy</h4>
              <List items={a.exactCopy.map((c) => `“${c}”`)} empty="No verbatim copy in brief." />
            </div>
          </div>
        </Panel>
      ) : (
        <Empty>Astra is reading the brief…</Empty>
      )}
    </>
  );
}

function ProductionTab({ d, setD }: TabProps) {
  const { boot } = useApp();
  const { job, economics } = d;
  const { busy, run } = useAction();
  if (!boot) return null;
  const gensByStep = (stepId: string) => d.generations.filter((g) => g.stepId === stepId);
  const canStart = job.stage === "planned";

  return (
    <>
      <div className="row between wrap gap">
        <p className="muted small">
          Est. production <strong>{fmtUSD(economics.productionEstimate)}</strong> + {fmtUSD(economics.repairReserve)} reserve → expected margin{" "}
          <strong className={economics.meetsMinimum ? "pos" : "neg"}>{fmtPct(economics.expectedMargin)}</strong>. Override any pending step and the economics update immediately.
        </p>
        {canStart && (
          <button className="btn primary" disabled={busy} onClick={() => run(() => api.start(job.id), "Production started").then((r) => r && setD(r))}>
            Start production
          </button>
        )}
      </div>
      <div className="steps">
        {job.steps.map((s, i) => {
          const decision = routeStep(s, boot.policy);
          const model = getModel(s.modelId);
          const editable = s.status === "pending" || s.status === "blocked";
          const gens = gensByStep(s.id);
          return (
            <div key={s.id} className={`step step-${s.status}`}>
              <div className="step-num">{i + 1}</div>
              <div className="step-main">
                <div className="row between wrap gap">
                  <div>
                    <strong>{s.label}</strong>
                    <div className="chips">
                      <span className="chip">{s.kind}</span>
                      <span className="chip">{s.intent}</span>
                      <span className="chip">lane: {s.lane}</span>
                      {s.preserve !== "none" && <span className="chip">preserve: {s.preserve}</span>}
                      <span className="chip">
        {s.units} {model?.unit === "second" ? "sec" : model?.unit === "job" ? "job" : model?.unit === "ktok" ? "k tokens" : "img"}
                      </span>
                    </div>
                  </div>
                  <div className="row gap">
                    <select
                      className="input"
                      value={s.modelId}
                      disabled={!editable || busy}
                      aria-label={`Model for ${s.label}`}
                      onChange={(e) => run(() => api.route(job.id, s.id, e.target.value === "__astra" ? null : e.target.value)).then((r) => r && setD(r))}
                    >
                      {!s.modelId && <option value="">— no model —</option>}
                      {decision.options.map((o) => (
                        <option key={o.modelId} value={o.modelId} disabled={!!o.blocked}>
                          {o.name} · {fmtUSD(o.cost)}
                          {o.modelId === decision.modelId ? " · Astra's pick" : ""}
                          {!o.inLane ? " · fallback" : ""}
                          {o.blocked ? " · blocked" : ""}
                        </option>
                      ))}
                      {s.routedBy === "human" && <option value="__astra">↺ Reset to Astra's pick</option>}
                    </select>
                    <span className="num step-cost">{model ? fmtUSD(model.unit === "job" ? model.price : model.price * s.units) : "—"}</span>
                    <span className={`badge status-${s.status}`}>{s.status}</span>
                  </div>
                </div>
                <p className="small muted rationale">
                  <span className={`actor actor-${s.routedBy === "human" ? "human" : "astra"}`}>{s.routedBy}</span> {s.rationale}
                </p>
                {s.feedback && <p className="small">Revision feedback: “{s.feedback}”</p>}
                {gens.length > 0 && (
                  <div className="mini-gens">
                    {gens.map((g) => (
                      <img key={g.id} src={g.outputUrl} alt="" title={`${getModel(g.modelId)?.name} · v${g.attempt} · ${g.purpose}`} className={g.qa ? `qa-${g.qa.verdict}` : ""} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function GenCard({ g, accepted }: { g: Generation; accepted: boolean }) {
  const [open, setOpen] = useState(false);
  const model = getModel(g.modelId);
  return (
    <div className={`gen ${accepted ? "accepted" : ""}`}>
      {g.outputUrl ? (
        <a href={g.outputUrl} target="_blank" rel="noreferrer" className="gen-img">
          <img src={g.outputUrl} alt={`${model?.name} output`} />
        </a>
      ) : (
        <div className="gen-img placeholder">{g.status === "failed" ? "Failed" : "Rendering…"}</div>
      )}
      <div className="gen-meta">
        <div className="row between">
          <span className="small">
            v{g.attempt} · {g.purpose} · {model?.name}
          </span>
          {g.qa && <VerdictBadge verdict={g.qa.verdict} />}
        </div>
        <div className="row between small muted">
          <span>{fmtUSD(g.actualCost ?? g.estimatedCost)}</span>
          {g.qa && (
            <button className="link small" onClick={() => setOpen(!open)}>
              QA {g.qa.score} {open ? "▴" : "▾"}
            </button>
          )}
          {accepted && <span className="pos">{g.qa?.verdict === "ready" ? "✓ accepted" : "✓ accepted by you"}</span>}
        </div>
        {open && g.qa && (
          <ul className="checks">
            {g.qa.checks.map((c) => (
              <li key={c.rule} className={c.pass ? "pos" : "neg"}>
                {c.pass ? "✓" : "✗"} {c.rule}
                {c.note && <div className="muted">{c.note}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function DeliveryTab({ d, setD }: TabProps) {
  const { job } = d;
  const internal = d.generations.filter((g) => !g.deliverableId);
  return (
    <>
      {job.deliverables.map((del) => {
        const gens = d.generations.filter((g) => g.deliverableId === del.id);
        return (
          <Panel
            key={del.id}
            title={
              <>
                {del.copy?.format === "grant-proposal" ? "" : `${del.quantity}× `}
                {del.label}{" "}
                <span className="muted small">
                  {del.copy ? copySummary(del.copy) : `${del.aspect} ${del.format}`}
                  {del.durationSec ? ` · ${del.durationSec}s` : ""}
                </span>
              </>
            }
            aside={<span className={`badge del-${del.status}`}>{del.status}</span>}
          >
            {del.kind === "text" ? (
              <CopyDeliverable jobTitle={job.title} d={del} gens={gens} />
            ) : gens.length ? (
              <div className="gens">
                {gens.map((g) => (
                  <GenCard key={g.id} g={g} accepted={del.outputIds.includes(g.id)} />
                ))}
              </div>
            ) : (
              <p className="muted small">No outputs yet.</p>
            )}
          </Panel>
        );
      })}
      {internal.length > 0 && (
        <Panel title="Exploration & finishing (internal)">
          {internal.some((g) => !g.copy) && (
            <div className="gens small-gens">
              {internal
                .filter((g) => !g.copy)
                .map((g) => (
                  <GenCard key={g.id} g={g} accepted={false} />
                ))}
            </div>
          )}
          {internal
            .filter((g) => g.copy)
            .map((g) => (
              <div key={g.id}>
                <h4>
                  {d.job.steps.find((s) => s.id === g.stepId)?.label} · {getModel(g.modelId)?.name} · {fmtUSD(g.actualCost ?? g.estimatedCost)}
                </h4>
                <AngleList g={g} />
              </div>
            ))}
        </Panel>
      )}
      <ClientThread job={job} setD={setD} />
    </>
  );
}

function ClientThread({ job, setD }: { job: Job; setD: (d: JobDetail) => void }) {
  const [body, setBody] = useState("");
  const { busy, run } = useAction();
  return (
    <Panel title="Client thread">
      <div className="thread">
        {job.messages.map((m) => (
          <div key={m.id} className={`msg ${m.direction} ${m.status}`}>
            <div className="msg-meta small muted">
              {m.direction === "inbound" ? "Client" : "Studio"} · {m.status}
              {m.classification ? ` · ${m.classification}` : ""} · {timeAgo(m.at)}
            </div>
            <div className="msg-body">{m.body}</div>
          </div>
        ))}
      </div>
      <div className="composer">
        <textarea className="input" rows={2} placeholder="Paste the client's reply — Astra classifies it (routine revision, scope change, question, approval)…" value={body} onChange={(e) => setBody(e.target.value)} />
        <button
          className="btn"
          disabled={busy || !body.trim()}
          onClick={() =>
            run(() => api.message(job.id, body), "Message logged").then((r) => {
              if (r) {
                setD(r);
                setBody("");
              }
            })
          }
        >
          Log client message
        </button>
      </div>
    </Panel>
  );
}

function ActivityTab({ d }: { d: JobDetail }) {
  return (
    <>
      <Panel title="Audit log">
        <ul className="audit">
          {[...d.audit].reverse().map((a) => (
            <li key={a.id}>
              <span className="muted small mono">{new Date(a.at).toLocaleTimeString()}</span>
              <span className={`actor actor-${a.actor}`}>{a.actor}</span>
              <span className="chip">{a.type}</span>
              <span className="grow">{a.message}</span>
              {a.cost !== undefined && <span className="num small">{fmtUSD(a.cost)}</span>}
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title="Generations">
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Step</th>
              <th>Model</th>
              <th>Purpose</th>
              <th>Status</th>
              <th>QA</th>
              <th className="num">Est.</th>
              <th className="num">Actual</th>
            </tr>
          </thead>
          <tbody>
            {d.generations.map((g) => (
              <tr key={g.id}>
                <td className="small">{timeAgo(g.createdAt)}</td>
                <td className="small">{d.job.steps.find((s) => s.id === g.stepId)?.label}</td>
                <td className="small">{getModel(g.modelId)?.name}</td>
                <td className="small">
                  {g.purpose} v{g.attempt}
                </td>
                <td className="small">{g.status}</td>
                <td>{g.qa ? <VerdictBadge verdict={g.qa.verdict} /> : "—"}</td>
                <td className="num small">{fmtUSD(g.estimatedCost)}</td>
                <td className="num small">{g.actualCost !== undefined ? fmtUSD(g.actualCost) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
