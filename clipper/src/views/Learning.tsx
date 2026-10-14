import { FlaskConical, Sparkles, ThumbsDown, TrendingUp } from "lucide-react";
import { analyze, CHECKPOINT_H, MIN_AGE_H } from "../../shared/learning";
import { fmtNum } from "../../shared/rules";
import { PLATFORM_LABEL, type Confidence, type TraitStat } from "../../shared/types";
import { api } from "../api";
import { ago, Empty, Panel, Stat } from "../components/ui";
import { go, useApp } from "../store";

const CONF: Record<Confidence, { label: string; tone: string }> = {
  "too-early": { label: "too early", tone: "" },
  "early-signal": { label: "early signal", tone: "warn" },
  solid: { label: "solid", tone: "ok" },
};

const pct = (lift: number) => (Math.abs(lift - 1) < 0.005 ? "normal" : `${lift > 1 ? "+" : "−"}${Math.round(Math.abs(lift - 1) * 100)}%`);

/** One trait value as a bar around "normal": right of center = more views than the account usually gets. */
function LiftRow({ s }: { s: TraitStat }) {
  // Log scale, ±1 doubling fills half the track.
  const x = Math.max(-1, Math.min(1, Math.log2(s.lift)));
  // Within ±3% of normal is noise: show it neutral.
  const tone = s.confidence === "too-early" || Math.abs(s.lift - 1) < 0.03 ? "var(--faint)" : x >= 0 ? "var(--ok)" : "var(--bad)";
  return (
    <div className="lift-row">
      <div className="ellipsis" title={s.label}>
        {s.label}
      </div>
      <div className="lift-track" aria-hidden>
        <span className="lift-mid" />
        <span className="lift-bar" style={{ background: tone, left: x >= 0 ? "50%" : `${50 + x * 50}%`, width: `${Math.abs(x) * 50}%` }} />
      </div>
      <div className="num" style={{ color: tone, fontWeight: 600 }}>
        {pct(s.lift)}
      </div>
      <div className="small faint num">
        {s.posts} post{s.posts === 1 ? "" : "s"} · {fmtNum(s.medianViews)}
      </div>
      <span className={`badge ${CONF[s.confidence].tone}`}>{CONF[s.confidence].label}</span>
    </div>
  );
}

export function LearningView({ scope }: { scope: string }) {
  const { state, run, refresh, busy } = useApp();
  if (!state) return <div className="content muted">Loading…</div>;
  const report = analyze(state, scope);
  const insights = state.insights[scope];
  const camp = (id: string) => state.campaigns.find((c) => c.id === id);
  const planned = state.clips.filter((c) => (scope === "all" || c.campaignId === scope) && c.traits?.strategy);
  const stale = insights && insights.basedOnPosts !== report.maturePosts;
  const write = () => run(() => api.writeInsights(scope), "Findings updated").then((r) => r && refresh());

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>What's working</h1>
          <p className="muted" style={{ margin: 0 }}>
            Every posted clip is compared with its account's normal views at about {CHECKPOINT_H / 24} days old. New clip plans lean on what wins and keep testing the rest.
          </p>
        </div>
        <select className="input" style={{ width: "auto" }} value={scope} onChange={(e) => go(e.target.value === "all" ? "/learn" : `/learn/${e.target.value}`)} aria-label="Scope">
          <option value="all">All campaigns</option>
          {state.campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div className="grid stats">
        <Stat label="Posts tracked" value={report.posts} />
        <Stat label="Old enough to compare" value={report.maturePosts} hint={`${MIN_AGE_H}h+ after posting`} />
        <Stat label="Proven patterns" value={report.playbook.proven.length} />
        <Stat label="Plans testing something new" value={planned.filter((c) => c.traits?.strategy === "test").length} hint={`of ${planned.length} planned with learning`} />
      </div>

      {report.maturePosts < 20 && (
        <p className="small muted" style={{ margin: "12px 0" }}>
          {report.maturePosts === 0
            ? "Nothing to learn from yet. Log each post with its link and update its views a day or two later (Posts tab) — the more posts, the sharper this gets."
            : `Based on ${report.maturePosts} post${report.maturePosts === 1 ? "" : "s"}. Views on short-form are noisy: treat anything marked “early signal” as a hint until you have 20–30 posts.`}
        </p>
      )}

      <Panel
        title={
          <span className="row">
            <Sparkles size={16} /> Findings
          </span>
        }
        aside={
          <button className="btn sm" disabled={busy || !report.maturePosts} onClick={write}>
            {insights ? "Refresh" : "Write findings"}
          </button>
        }
      >
        {insights ? (
          <>
            <p className="small faint" style={{ marginTop: 0 }}>
              From {insights.basedOnPosts} posts, {ago(insights.generatedAt)} ({insights.model}){stale ? " — new data since, refresh to update." : ""}
            </p>
            {insights.findings.length > 0 && (
              <ul className="tight">
                {insights.findings.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            )}
            <div className="grid cards" style={{ marginTop: 8 }}>
              {(
                [
                  ["Do more", TrendingUp, insights.doMore, "pos"],
                  ["Stop doing", ThumbsDown, insights.stopDoing, "neg"],
                  ["Test next", FlaskConical, insights.testNext, ""],
                ] as const
              ).map(([title, Icon, items, cls]) => (
                <div key={title}>
                  <strong className={`row ${cls}`}>
                    <Icon size={15} /> {title}
                  </strong>
                  {items.length ? (
                    <ul className="tight small">
                      {items.map((x) => (
                        <li key={x}>{x}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="small faint">Nothing clear yet.</p>
                  )}
                </div>
              ))}
            </div>
          </>
        ) : (
          <Empty>{report.maturePosts ? "Write findings to get a plain-language summary of these numbers." : "Findings appear once posts are a day old and have views logged."}</Empty>
        )}
      </Panel>

      <Panel title="Playbook for new clips">
        <div className="grid cards">
          <div>
            <strong className="pos">Lean on</strong>
            {report.playbook.proven.length ? (
              <ul className="tight small">
                {report.playbook.proven.map((p) => (
                  <li key={p.label}>
                    {p.label} <span className="faint">({pct(p.lift)}, {p.posts} posts)</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small faint">Nothing proven yet — every new plan is a test.</p>
            )}
          </div>
          <div>
            <strong className="neg">Avoid</strong>
            {report.playbook.weak.length ? (
              <ul className="tight small">
                {report.playbook.weak.map((p) => (
                  <li key={p.label}>
                    {p.label} <span className="faint">({pct(p.lift)}, {p.posts} posts)</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small faint">Nothing clearly underperforming.</p>
            )}
          </div>
          <div>
            <strong>Still untested</strong>
            {report.playbook.untested.length ? (
              <ul className="tight small">
                {report.playbook.untested.slice(0, 6).map((u) => (
                  <li key={u.label}>{u.label}</li>
                ))}
              </ul>
            ) : (
              <p className="small faint">Every hook style and format has been tried.</p>
            )}
          </div>
        </div>
        <p className="small faint" style={{ marginBottom: 0 }}>
          About 30% of new plans test something untested once a pattern is proven, so the system doesn't get stuck on its first winner.
        </p>
      </Panel>

      {report.dimensions.map((d) => (
        <Panel key={d.id} title={d.label}>
          {d.stats.map((s) => (
            <LiftRow key={s.value} s={s} />
          ))}
        </Panel>
      ))}

      <Panel title="Best hooks">
        {report.topHooks.length ? (
          <table className="table">
            <tbody>
              {report.topHooks.map((h) => (
                <tr key={h.postId}>
                  <td>“{h.hook}”</td>
                  <td className="small faint">
                    {PLATFORM_LABEL[h.platform]} · {camp(h.campaignId)?.name}
                  </td>
                  <td className="num">{fmtNum(h.views)}</td>
                  <td className="num" style={{ color: h.lift >= 1 ? "var(--ok)" : "var(--bad)" }}>
                    {pct(h.lift)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>Hooks show up here once posts linked to a clip are a day old.</Empty>
        )}
      </Panel>
    </div>
  );
}
