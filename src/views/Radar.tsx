import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtPct, fmtUSD } from "../../shared/economics";
import type { Lead, RadarState, SavedSearch } from "../../shared/types";
import { api } from "../api";
import { Empty, Frame, Panel, SideHeader, SideItem, Tabs, timeAgo } from "../components/ui";
import { go, useAction, useApp } from "../store";

type Tab = "good" | "all" | "shortlisted" | "applied" | "dismissed";

const budgetText = (l: Lead) => {
  const b = l.budget;
  if (!b) return "No budget";
  const r = b.min !== undefined && b.max !== undefined && b.min !== b.max ? `${fmtUSD(b.min)}–${fmtUSD(b.max)}` : fmtUSD(b.max ?? b.min ?? 0);
  return b.type === "hourly" ? `${r}/hr` : r;
};

function ScoreRing({ score, verdict }: { score: number; verdict: string }) {
  return (
    <span className={`score-ring v-${verdict}`} title={`Fit score ${score}/100`}>
      {score}
    </span>
  );
}

export function RadarView({ searchId, leadId }: { searchId?: string; leadId?: string }) {
  const { boot } = useApp();
  const { busy, run } = useAction();
  const [radar, setRadar] = useState<RadarState | null>(null);
  const [tab, setTab] = useState<Tab>("good");

  const load = useCallback(() => api.radar().then(setRadar), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const search = radar?.searches.find((s) => s.id === searchId);
  const lead = radar?.leads.find((l) => l.id === leadId);
  const scoped = useMemo(() => (radar?.leads ?? []).filter((l) => !searchId || l.searchId === searchId), [radar, searchId]);
  const byTab: Record<Tab, Lead[]> = {
    good: scoped.filter((l) => l.fit?.verdict === "good" && ["new", "shortlisted"].includes(l.status)),
    all: scoped.filter((l) => l.status !== "dismissed"),
    shortlisted: scoped.filter((l) => l.status === "shortlisted"),
    applied: scoped.filter((l) => ["applied", "won", "lost"].includes(l.status)),
    dismissed: scoped.filter((l) => l.status === "dismissed"),
  };
  const list = [...byTab[tab]].sort((a, b) => (b.fit?.score ?? 0) - (a.fit?.score ?? 0));

  const replaceLead = (l: Lead) => setRadar((r) => (r ? { ...r, leads: r.leads.map((x) => (x.id === l.id ? l : x)) } : r));
  const newSearch = () =>
    run(() => api.createSearch({ name: "New search", source: "upwork", query: "", schedule: "daily" }), "Search created").then((s) => {
      if (s) {
        load();
        go(`/radar/search/${s.id}`);
      }
    });

  return (
    <Frame
      sidebar={
        <>
          <SideHeader
            action={
              <button className="btn sm" onClick={newSearch} disabled={busy}>
                + New
              </button>
            }
          >
            Saved searches
          </SideHeader>
          <div className="side-list">
            <SideItem active={!searchId && !leadId} title="All searches" sub={`${radar?.leads.length ?? 0} leads`} onClick={() => go("/radar")} />
            {radar?.searches.map((s) => (
              <SideItem
                key={s.id}
                active={s.id === searchId}
                title={s.name}
                sub={`${s.source} · ${s.schedule}${s.lastRunAt ? ` · ran ${timeAgo(s.lastRunAt)}` : " · never run"}`}
                dot={s.lastRunStatus?.startsWith("Failed") ? "var(--c-bad)" : "var(--c-accent)"}
                onClick={() => go(`/radar/search/${s.id}`)}
              />
            ))}
          </div>
        </>
      }
      tabs={
        !lead && (
          <Tabs
            value={tab}
            onChange={setTab}
            options={[
              { id: "good", label: "Good fits", count: byTab.good.length },
              { id: "all", label: "All leads", count: byTab.all.length },
              { id: "shortlisted", label: "Shortlisted", count: byTab.shortlisted.length },
              { id: "applied", label: "Applied & won", count: byTab.applied.length },
              { id: "dismissed", label: "Dismissed" },
            ]}
          />
        )
      }
      right={
        search ? (
          <SearchEditor key={search.id} search={search} onChange={load} apify={boot?.providers.apify ?? "simulated"} />
        ) : (
          <>
            <h4 className="right-title">How the radar works</h4>
            <ol className="small steps-list">
              <li>Saved searches scrape marketplaces through Apify on a schedule.</li>
              <li>Each job is scored 0–100: service fit, budget vs. your margin floor, client quality, brief clarity, competition.</li>
              <li>Scams, rights risks and off-service work are skipped automatically.</li>
              <li>Good fits get a proposal draft, checked before you see it. You review and send it yourself.</li>
              <li>Won the job? Convert it — intake, pricing and production take over.</li>
            </ol>
            <div className="right-box small">
              <div className="row between">
                <span>Scraping</span>
                <span className={boot?.providers.apify === "live" ? "pos" : "muted"}>{boot?.providers.apify === "live" ? "Apify (live)" : "Simulated"}</span>
              </div>
              <div className="row between">
                <span>Proposal writer</span>
                <span className={boot?.providers.astra.mode === "live" ? "pos" : "muted"}>{boot?.providers.astra.mode === "live" ? boot.providers.ai : "Simulated"}</span>
              </div>
            </div>
          </>
        )
      }
    >
      {lead ? (
        <LeadDetail lead={lead} onChange={replaceLead} />
      ) : (
        <>
          <header className="page-head">
            <div>
              <h1>{search?.name ?? "Job Radar"}</h1>
              <p className="muted">{search ? search.lastRunStatus ?? "Not run yet." : "Marketplace jobs scored against your services, margins and policy — with proposals ready to send."}</p>
            </div>
            {search && (
              <button className="btn primary" disabled={busy} onClick={() => run(() => api.runSearch(search.id)).then((r) => r && (setRadar(r.radar), setTab("good")))}>
                {busy ? "Scanning…" : "Run now"}
              </button>
            )}
          </header>
          <div className="leads">
            {list.map((l) => (
              <button key={l.id} className="lead" onClick={() => go(`/radar/lead/${l.id}`)}>
                <ScoreRing score={l.fit?.score ?? 0} verdict={l.fit?.verdict ?? "skip"} />
                <div className="grow">
                  <div className="row between gap">
                    <strong className="lead-title">{l.title}</strong>
                    <span className="small num">{budgetText(l)}</span>
                  </div>
                  <div className="small muted">
                    {l.source} · {l.fit?.templateName ?? "—"}
                    {l.postedAt ? ` · posted ${timeAgo(l.postedAt)}` : ""}
                    {l.proposalsCount !== undefined ? ` · ${l.proposalsCount} proposals` : ""}
                    {l.client?.paymentVerified ? " · ✓ payment verified" : ""}
                  </div>
                  <div className="small lead-why">
                    {l.fit?.redFlags[0] ? <span className="neg">⚑ {l.fit.redFlags[0]}</span> : <span className="pos">{l.fit?.reasons[0]}</span>}
                  </div>
                </div>
                <div className="lead-tags">
                  <span className={`badge verdict-${l.fit?.verdict === "good" ? "ready" : l.fit?.verdict === "maybe" ? "edit" : "regenerate"}`}>{l.fit?.verdict}</span>
                  {l.proposal && <span className="chip">proposal {l.proposal.status}</span>}
                  {l.status !== "new" && <span className="chip">{l.status}</span>}
                </div>
              </button>
            ))}
            {!list.length && <Empty>{radar?.searches.length ? "No leads in this view yet. Run a search." : "Create a saved search to start scanning marketplaces."}</Empty>}
          </div>
        </>
      )}
    </Frame>
  );
}

function SearchEditor({ search, onChange, apify }: { search: SavedSearch; onChange: () => void; apify: "live" | "simulated" }) {
  const { busy, run } = useAction();
  const [s, setS] = useState(search);
  const [inputText, setInputText] = useState(JSON.stringify(search.input, null, 2));
  const save = () => {
    let input: Record<string, unknown>;
    try {
      input = inputText.trim() ? JSON.parse(inputText) : {};
    } catch {
      return run(async () => {
        throw new Error("Actor input must be valid JSON");
      });
    }
    return run(() => api.updateSearch(s.id, { ...s, input }), "Search saved").then(() => onChange());
  };
  return (
    <div className="form">
      <h4 className="right-title">Search settings</h4>
      <label className="field">
        <span>Name</span>
        <input className="input" value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} />
      </label>
      <div className="grid2">
        <label className="field">
          <span>Source</span>
          <select className="input" value={s.source} onChange={(e) => setS({ ...s, source: e.target.value as SavedSearch["source"] })}>
            {["upwork", "fiverr", "contra", "linkedin", "custom"].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Schedule</span>
          <select className="input" value={s.schedule} onChange={(e) => setS({ ...s, schedule: e.target.value as SavedSearch["schedule"] })}>
            <option value="manual">Manual</option>
            <option value="6h">Every 6h</option>
            <option value="12h">Every 12h</option>
            <option value="daily">Daily</option>
          </select>
        </label>
      </div>
      <label className="field">
        <span>Search query</span>
        <input className="input" value={s.query} placeholder="e.g. cold email copywriting" onChange={(e) => setS({ ...s, query: e.target.value })} />
      </label>
      <label className="field">
        <span>Apify actor</span>
        <input className="input" value={s.actorId} placeholder="username~actor-name (or platform default)" onChange={(e) => setS({ ...s, actorId: e.target.value })} />
      </label>
      <label className="field">
        <span>Actor input (JSON)</span>
        <textarea className="input mono small" rows={5} value={inputText} placeholder='{"query": "{{query}}", "maxItems": "{{maxItems}}"}' onChange={(e) => setInputText(e.target.value)} />
        <small className="muted">{"{{query}}"} and {"{{maxItems}}"} are filled in. Leave empty for a generic input.</small>
      </label>
      <div className="grid2">
        <label className="field">
          <span>Max items</span>
          <input className="input" type="number" min={1} max={200} value={s.maxItems} onChange={(e) => setS({ ...s, maxItems: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>Min score</span>
          <input className="input" type="number" min={0} max={100} value={s.minScore} onChange={(e) => setS({ ...s, minScore: Number(e.target.value) })} />
        </label>
      </div>
      <label className="radio">
        <input type="checkbox" checked={s.autoDraft} onChange={(e) => setS({ ...s, autoDraft: e.target.checked })} />
        Auto-draft proposals for good fits
      </label>
      <p className="small muted">{apify === "live" ? "Runs on Apify." : "APIFY_TOKEN isn't set — runs return simulated sample jobs."}</p>
      <div className="row gap">
        <button className="btn primary sm" disabled={busy} onClick={save}>
          Save
        </button>
        <button
          className="btn sm"
          disabled={busy}
          onClick={() =>
            confirm(`Delete "${s.name}"? Its leads stay.`) &&
            run(() => api.deleteSearch(s.id), "Search deleted").then(() => {
              onChange();
              go("/radar");
            })
          }
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function LeadDetail({ lead, onChange }: { lead: Lead; onChange: (l: Lead) => void }) {
  const { busy, run } = useAction();
  const { toast } = useApp();
  const [text, setText] = useState(lead.proposal?.text ?? "");
  useEffect(() => setText(lead.proposal?.text ?? ""), [lead.proposal?.text]);
  const fit = lead.fit;
  const update = (b: Parameters<typeof api.updateLead>[1], ok?: string) => run(() => api.updateLead(lead.id, b), ok).then((l) => l && onChange(l));

  return (
    <>
      <header className="page-head">
        <div>
          <button className="link small" onClick={() => go(lead.searchId ? `/radar/search/${lead.searchId}` : "/radar")}>
            ← Back to leads
          </button>
          <h1>{lead.title}</h1>
          <p className="muted">
            {lead.source} · {budgetText(lead)}
            {lead.postedAt ? ` · posted ${timeAgo(lead.postedAt)}` : ""}
            {lead.proposalsCount !== undefined ? ` · ${lead.proposalsCount} proposals` : ""}
            {lead.url && (
              <>
                {" · "}
                <a href={lead.url} target="_blank" rel="noreferrer">
                  open listing
                </a>
              </>
            )}
          </p>
        </div>
        {fit && <ScoreRing score={fit.score} verdict={fit.verdict} />}
      </header>

      <div className="row gap wrap">
        {lead.status !== "shortlisted" && (
          <button className="btn sm" disabled={busy} onClick={() => update({ status: "shortlisted" }, "Shortlisted")}>
            Shortlist
          </button>
        )}
        {lead.status !== "dismissed" && (
          <button className="btn sm" disabled={busy} onClick={() => update({ status: "dismissed" }, "Dismissed")}>
            Dismiss
          </button>
        )}
        {lead.jobId ? (
          <button className="btn sm primary" onClick={() => go(`/job/${lead.jobId}`)}>
            Open job →
          </button>
        ) : (
          <button className="btn sm primary" disabled={busy} onClick={() => run(() => api.convertLead(lead.id), "Converted to a job").then((d) => d && go(`/job/${d.job.id}`))}>
            Won it — convert to job
          </button>
        )}
      </div>

      {fit && (
        <div className="grid2 top-gap">
          <Panel title={`Fit: ${fit.verdict} · ${fit.templateName}`}>
            {fit.breakdown.map((b) => (
              <div key={b.label} className="bar-row">
                <span className="small">{b.label}</span>
                <span className="bar">
                  <span style={{ width: `${(b.points / b.max) * 100}%` }} />
                </span>
                <span className="small num">
                  {b.points}/{b.max}
                </span>
              </div>
            ))}
            <ul className="kv top-gap">
              <li>
                <span>Suggested price</span>
                <span className="num">{fmtUSD(fit.suggestedPrice)}</span>
              </li>
              <li>
                <span>Est. production cost</span>
                <span className="num">{fmtUSD(fit.estimatedCost)}</span>
              </li>
              <li className="kv-total">
                <span>Expected margin</span>
                <span className="num">{fmtPct(fit.expectedMargin)}</span>
              </li>
            </ul>
          </Panel>
          <Panel title="Why">
            <ul className="bullets">
              {fit.reasons.map((r) => (
                <li key={r}>
                  <span className="dot ok" />
                  {r}
                </li>
              ))}
              {fit.redFlags.map((r) => (
                <li key={r}>
                  <span className="dot bad" />
                  {r}
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      )}

      <Panel
        title="Proposal"
        aside={
          lead.proposal && (
            <span className="small muted">
              {lead.proposal.source === "astra" ? lead.proposal.model : "simulated"} · {timeAgo(lead.proposal.generatedAt)}
            </span>
          )
        }
      >
        {lead.proposal ? (
          <>
            <textarea className="input proposal-text" rows={14} value={text} onChange={(e) => setText(e.target.value)} />
            <ul className="checks top-gap">
              {lead.proposal.checks.map((c) => (
                <li key={c.rule} className={c.pass ? "pos" : "neg"}>
                  {c.pass ? "✓" : "✗"} {c.rule}
                  {c.note && <span className="muted"> — {c.note}</span>}
                </li>
              ))}
            </ul>
            <div className="row gap wrap top-gap">
              <button className="btn sm" disabled={busy || text === lead.proposal.text} onClick={() => update({ proposalText: text }, "Proposal saved")}>
                Save edits
              </button>
              <button
                className="btn sm"
                onClick={() =>
                  navigator.clipboard.writeText(text).then(
                    () => toast("Proposal copied"),
                    () => toast("Clipboard unavailable", "err"),
                  )
                }
              >
                Copy
              </button>
              <button className="btn sm" disabled={busy} onClick={() => run(() => api.draftProposal(lead.id), "Redrafted").then((l) => l && onChange(l))}>
                Redraft
              </button>
              <button className="btn sm primary" disabled={busy || lead.status === "applied"} onClick={() => update({ status: "applied", proposalStatus: "applied" }, "Marked as applied")}>
                I sent it — mark applied
              </button>
            </div>
            <p className="small muted top-gap">Studio Operator never submits proposals for you — copy it into the marketplace and send it yourself.</p>
          </>
        ) : (
          <button className="btn primary" disabled={busy} onClick={() => run(() => api.draftProposal(lead.id), "Proposal drafted").then((l) => l && onChange(l))}>
            {busy ? "Drafting…" : "Draft proposal"}
          </button>
        )}
      </Panel>

      <Panel title="Job post">
        <p className="brief-text full">{lead.description}</p>
        {lead.skills.length > 0 && (
          <div className="chips">
            {lead.skills.map((s) => (
              <span key={s} className="chip">
                {s}
              </span>
            ))}
          </div>
        )}
      </Panel>
    </>
  );
}
