import { Clapperboard, Plus } from "lucide-react";
import { engagementRate, fmtNum, fmtPct, fmtUSD } from "../../shared/rules";
import { PLATFORM_LABEL } from "../../shared/types";
import { Tabs } from "../App";
import { ago, Empty, Panel, Stat } from "../components/ui";
import { go, useApp } from "../store";

export function Overview({ tab }: { tab: string }) {
  const { state } = useApp();
  if (!state) return <div className="content muted">Loading…</div>;
  const active = state.campaigns.filter((c) => c.status === "active");
  const t = state.campaigns.reduce(
    (a, c) => ({ views: a.views + c.stats.views, earned: a.earned + c.stats.estimatedEarnings, paid: a.paid + c.stats.paid }),
    { views: 0, earned: 0, paid: 0 },
  );
  const stale = state.posts.filter((p) => p.status !== "rejected" && p.status !== "paid" && (!p.metricsUpdatedAt || Date.now() - Date.parse(p.metricsUpdatedAt) > 24 * 3600_000));
  const lowEng = state.posts.filter((p) => {
    const c = state.campaigns.find((x) => x.id === p.campaignId);
    return c?.brief.minEngagementRate && p.metrics.views >= 500 && engagementRate(p.metrics) < c.brief.minEngagementRate;
  });

  return (
    <>
      <Tabs
        tabs={[
          { id: "campaigns", label: "Overview" },
          { id: "activity", label: "Activity", n: state.activity.length },
        ]}
        active={tab}
        onPick={(id) => go(id === "campaigns" ? "/" : `/${id}`)}
      />
      <div className="content">
        {tab === "activity" ? (
          <Panel title="Activity">
            {state.activity.length ? (
              <table className="table">
                <tbody>
                  {state.activity.map((a) => (
                    <tr key={a.id}>
                      <td className="small faint" style={{ width: 90 }}>
                        {ago(a.at)}
                      </td>
                      <td>
                        {a.actor === "agent" && <span className="badge info">agent</span>} {a.message}
                      </td>
                      <td className="num small faint">{a.cost ? `$${a.cost.toFixed(3)}` : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty>Nothing yet.</Empty>
            )}
          </Panel>
        ) : (
          <>
            <div className="page-head">
              <div>
                <h1>Your clipping campaigns</h1>
                <p className="muted" style={{ margin: 0 }}>
                  Every brief, clip and post in one place, and what each campaign owes you.
                </p>
              </div>
              <button className="btn primary" onClick={() => go("/new")}>
                <Plus size={15} /> New campaign
              </button>
            </div>
            <div className="grid stats">
              <Stat label="Active campaigns" value={active.length} />
              <Stat label="Clips planned" value={state.clips.length} hint={`${state.clips.filter((c) => c.status === "draft").length} to review`} />
              <Stat label="Posts" value={state.posts.length} />
              <Stat label="Views" value={fmtNum(t.views)} />
              <Stat label="Estimated earnings" value={fmtUSD(t.earned)} hint={t.paid ? `${fmtUSD(t.paid)} paid` : undefined} />
            </div>

            <h2 className="mt">Campaigns</h2>
            {state.campaigns.length ? (
              <div className="grid cards">
                {state.campaigns.map((c) => {
                  const thumb = c.footage.find((f) => f.thumbUrl)?.thumbUrl;
                  return (
                    <button key={c.id} className="card" onClick={() => go(`/c/${c.id}/brief`)}>
                      <div className="img" style={thumb ? { backgroundImage: `url("${thumb}")` } : undefined}>
                        {!thumb && <Clapperboard size={28} />}
                      </div>
                      <div className="body">
                        <div className="row between">
                          <strong className="ellipsis">{c.name}</strong>
                          <span className={`badge ${c.status === "active" ? "ok" : c.status === "paused" ? "warn" : ""}`}>{c.status}</span>
                        </div>
                        <div className="small muted">
                          {c.brief.payout.cpm ? `${fmtUSD(c.brief.payout.cpm)} CPM` : "CPM not set"}
                          {c.brief.payout.maxPerSubmission ? ` · max ${fmtUSD(c.brief.payout.maxPerSubmission)}/post` : ""}
                        </div>
                        <div className="small">
                          {c.stats.clips} clips · {c.stats.posts} posts · {fmtNum(c.stats.views)} views · <strong>{fmtUSD(c.stats.estimatedEarnings)}</strong>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <Empty>
                <p>No campaigns yet.</p>
                <button className="btn primary" onClick={() => go("/new")}>
                  <Plus size={15} /> Paste your first brief
                </button>
              </Empty>
            )}

            {(stale.length > 0 || lowEng.length > 0) && (
              <div className="mt">
                <Panel title="Needs attention">
                  {stale.length > 0 && (
                    <p className="small">
                      <strong>{stale.length}</strong> post(s) haven't had their numbers updated in over a day.{" "}
                      <button className="btn sm" onClick={() => go("/posts")}>
                        Update views
                      </button>
                    </p>
                  )}
                  {lowEng.map((p) => (
                    <p key={p.id} className="small">
                      <span className="badge bad">{fmtPct(engagementRate(p.metrics))} engagement</span> {PLATFORM_LABEL[p.platform]} post @{p.account} is under the campaign's minimum — it may not pay out.
                    </p>
                  ))}
                </Panel>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

export function OverviewRight() {
  const { state } = useApp();
  if (!state) return null;
  const top = [...state.campaigns].sort((a, b) => b.stats.estimatedEarnings - a.stats.estimatedEarnings).slice(0, 5);
  return (
    <>
      <div>
        <h3>Top earners</h3>
        {top.length ? (
          <dl className="kv">
            {top.map((c) => (
              <div key={c.id} style={{ display: "contents" }}>
                <dt className="ellipsis">{c.name}</dt>
                <dd>{fmtUSD(c.stats.estimatedEarnings)}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="small muted">Earnings show up once you log posts.</p>
        )}
      </div>
      <div>
        <h3>How it works</h3>
        <ol className="small" style={{ paddingLeft: 18, margin: 0 }}>
          <li>Paste a brief (Google Doc link, page link or text).</li>
          <li>Check the rules it pulled out and the footage it found.</li>
          <li>Write clip plans — each one is checked against the brief.</li>
          <li>Approve, edit and post them from your accounts.</li>
          <li>Log each post and update views to track earnings.</li>
        </ol>
      </div>
      <div>
        <h3>Recent activity</h3>
        {state.activity.slice(0, 8).map((a) => (
          <div key={a.id} className="small" style={{ marginBottom: 8 }}>
            <div>
              {a.actor === "agent" && <span className="badge info">agent</span>} {a.message}
            </div>
            <div className="faint">{ago(a.at)}</div>
          </div>
        ))}
        {!state.activity.length && <p className="small muted">Nothing yet.</p>}
      </div>
    </>
  );
}
