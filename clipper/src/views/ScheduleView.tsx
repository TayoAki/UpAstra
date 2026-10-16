import { CalendarClock, ExternalLink, RefreshCw, X } from "lucide-react";
import { fmtNum } from "../../shared/rules";
import { PLATFORM_LABEL, type Post } from "../../shared/types";
import { api } from "../api";
import { ago, Empty, Panel, PostBadge } from "../components/ui";
import { go, useApp } from "../store";

const dayKey = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** What's going out, what went out, and what failed — for posts made through Outstand. */
export function ScheduleView() {
  const { state, run, busy } = useApp();
  if (!state) return <div className="content muted">Loading…</div>;
  const ours = state.posts.filter((p) => p.outstand);
  const upcoming = ours.filter((p) => p.status === "scheduled").sort((a, b) => a.postedAt.localeCompare(b.postedAt));
  const failed = ours.filter((p) => p.status === "failed");
  const published = ours.filter((p) => p.status !== "scheduled" && p.status !== "failed").sort((a, b) => b.postedAt.localeCompare(a.postedAt)).slice(0, 50);
  const clip = (p: Post) => state.clips.find((c) => c.id === p.clipId);
  const camp = (p: Post) => state.campaigns.find((c) => c.id === p.campaignId);
  const byDay = upcoming.reduce<Record<string, Post[]>>((m, p) => ((m[dayKey(p.postedAt)] ??= []).push(p), m), {});

  const row = (p: Post, extra?: React.ReactNode) => (
    <tr key={p.id}>
      <td className="small faint" style={{ width: 80 }}>
        {p.status === "scheduled" ? time(p.postedAt) : ago(p.postedAt)}
      </td>
      <td>
        <strong className="clickable-text" onClick={() => go(`/c/${p.campaignId}/clips`)}>
          {clip(p)?.title ?? "Clip"}
        </strong>
        <div className="small faint">
          {PLATFORM_LABEL[p.platform]} @{p.account} · {camp(p)?.name}
        </div>
        {p.notes && <div className="small muted">{p.notes}</div>}
        {p.outstand?.error && <div className="small neg">{p.outstand.error}</div>}
      </td>
      <td className="num">{extra}</td>
    </tr>
  );

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>Schedule</h1>
          <p className="muted" style={{ margin: 0 }}>
            Clips posted and scheduled through your connected accounts. Views sync back every 30 minutes and feed earnings and What's working.
          </p>
        </div>
        {state.status.publishing && (
          <button className="btn sm" disabled={busy} onClick={() => run(() => api.syncMetrics(), "Views synced")}>
            <RefreshCw size={13} /> Sync views now
          </button>
        )}
      </div>

      {!state.status.publishing && (
        <Panel>
          <p className="small muted" style={{ margin: 0 }}>
            Publishing isn't connected on this server yet. Add an Outstand API key, then connect accounts in Settings → Posting accounts.
          </p>
        </Panel>
      )}

      <Panel title={`Coming up (${upcoming.length})`}>
        {upcoming.length ? (
          Object.entries(byDay).map(([day, posts]) => (
            <div key={day} className="mt">
              <div className="side-group" style={{ padding: "0 0 4px" }}>
                {day}
              </div>
              <table className="table">
                <tbody>
                  {posts.map((p) =>
                    row(
                      p,
                      <button className="btn sm ghost danger" title="Cancel" disabled={busy} onClick={() => confirm("Cancel this scheduled post on every account it was going to?") && run(() => api.cancelPost(p.id), "Cancelled")}>
                        <X size={13} /> Cancel
                      </button>,
                    ),
                  )}
                </tbody>
              </table>
            </div>
          ))
        ) : (
          <Empty>
            <CalendarClock size={16} /> Nothing scheduled. Use “Post / schedule” on a rendered clip.
          </Empty>
        )}
      </Panel>

      {failed.length > 0 && (
        <Panel title={`Didn't go out (${failed.length})`}>
          <table className="table">
            <tbody>{failed.map((p) => row(p))}</tbody>
          </table>
        </Panel>
      )}

      <Panel title="Published">
        {published.length ? (
          <table className="table">
            <tbody>
              {published.map((p) =>
                row(
                  p,
                  <span className="row" style={{ justifyContent: "flex-end" }}>
                    <PostBadge status={p.status} />
                    <span className="small">{fmtNum(p.metrics.views)} views</span>
                    {p.url && (
                      <a className="btn sm ghost" href={p.url} target="_blank" rel="noreferrer" title="Open post">
                        <ExternalLink size={13} />
                      </a>
                    )}
                  </span>,
                ),
              )}
            </tbody>
          </table>
        ) : (
          <Empty>Nothing published through UGCMediaClips yet.</Empty>
        )}
      </Panel>
    </div>
  );
}
