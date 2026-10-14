import { useState } from "react";
import { fmtNum, fmtPct, fmtUSD, postEarnings } from "../../shared/rules";
import { PLATFORM_LABEL, type Platform } from "../../shared/types";
import { Tabs } from "../App";
import { Empty, Stat } from "../components/ui";
import { useApp } from "../store";
import { PostTable } from "./Campaign";

export function PostsView() {
  const { state } = useApp();
  const [tab, setTab] = useState("all");
  if (!state) return <div className="content muted">Loading…</div>;
  const camp = (id: string) => state.campaigns.find((c) => c.id === id)!;
  const total = state.campaigns.reduce((t, c) => ({ views: t.views + c.stats.views, est: t.est + c.stats.estimatedEarnings, paid: t.paid + c.stats.paid }), { views: 0, est: 0, paid: 0 });
  const byPlatform = new Map<Platform, { posts: number; views: number; est: number }>();
  for (const p of state.posts) {
    const r = byPlatform.get(p.platform) ?? { posts: 0, views: 0, est: 0 };
    r.posts++;
    r.views += p.metrics.views;
    r.est += postEarnings(p, camp(p.campaignId).brief.payout);
    byPlatform.set(p.platform, r);
  }

  return (
    <>
      <Tabs
        tabs={[
          { id: "all", label: "All posts", n: state.posts.length },
          { id: "campaigns", label: "By campaign" },
          { id: "platforms", label: "By platform" },
        ]}
        active={tab}
        onPick={setTab}
      />
      <div className="content">
        <div className="page-head">
          <div>
            <h1>Posts & earnings</h1>
            <p className="muted" style={{ margin: 0 }}>
              Update views here as they grow. Estimates follow each campaign's CPM and per-post cap until you mark a post paid.
            </p>
          </div>
        </div>
        <div className="grid stats">
          <Stat label="Posts" value={state.posts.length} />
          <Stat label="Views" value={fmtNum(total.views)} />
          <Stat label="Estimated" value={fmtUSD(total.est)} />
          <Stat label="Paid" value={fmtUSD(total.paid)} />
        </div>
        <div className="mt">
          {!state.posts.length ? (
            <Empty>No posts yet. Log one from a campaign's Clips or Posts tab.</Empty>
          ) : tab === "campaigns" ? (
            <div className="panel table-wrap" style={{ padding: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Campaign</th>
                    <th className="num">Posts</th>
                    <th className="num">Views</th>
                    <th className="num">Engagement</th>
                    <th className="num">Estimated</th>
                    <th className="num">Paid</th>
                    <th className="num">Budget</th>
                  </tr>
                </thead>
                <tbody>
                  {state.campaigns.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <a href={`#/c/${c.id}/posts`}>{c.name}</a>
                      </td>
                      <td className="num">{c.stats.posts}</td>
                      <td className="num">{fmtNum(c.stats.views)}</td>
                      <td className="num">{fmtPct(c.stats.engagementRate)}</td>
                      <td className="num">
                        <strong>{fmtUSD(c.stats.estimatedEarnings)}</strong>
                      </td>
                      <td className="num">{fmtUSD(c.stats.paid)}</td>
                      <td className="num faint">{c.brief.payout.budget ? fmtUSD(c.brief.payout.budget) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : tab === "platforms" ? (
            <div className="panel table-wrap" style={{ padding: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Platform</th>
                    <th className="num">Posts</th>
                    <th className="num">Views</th>
                    <th className="num">Views / post</th>
                    <th className="num">Estimated</th>
                  </tr>
                </thead>
                <tbody>
                  {[...byPlatform].map(([p, r]) => (
                    <tr key={p}>
                      <td>{PLATFORM_LABEL[p]}</td>
                      <td className="num">{r.posts}</td>
                      <td className="num">{fmtNum(r.views)}</td>
                      <td className="num">{fmtNum(Math.round(r.views / r.posts))}</td>
                      <td className="num">
                        <strong>{fmtUSD(r.est)}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <PostTable posts={state.posts} showCampaign />
          )}
        </div>
      </div>
    </>
  );
}
