import { useState } from "react";
import { Tabs } from "../App";
import { ClipCard } from "../components/ClipCard";
import { Empty } from "../components/ui";
import { useApp } from "../store";

export function Review() {
  const { state } = useApp();
  const [tab, setTab] = useState("draft");
  if (!state) return <div className="content muted">Loading…</div>;
  const camp = (id: string) => state.campaigns.find((c) => c.id === id)!;
  const drafts = state.clips.filter((c) => c.status === "draft");
  const approved = state.clips.filter((c) => c.status === "approved" || c.status === "ready");
  const list = (tab === "draft" ? drafts : approved).slice().sort((a, b) => Number(a.qa.pass) - Number(b.qa.pass));
  return (
    <>
      <Tabs
        tabs={[
          { id: "draft", label: "To review", n: drafts.length },
          { id: "approved", label: "Approved, not posted", n: approved.length },
        ]}
        active={tab}
        onPick={setTab}
      />
      <div className="content">
        <div className="page-head">
          <div>
            <h1>{tab === "draft" ? "Clips to review" : "Ready to post"}</h1>
            <p className="muted" style={{ margin: 0 }}>
              {tab === "draft" ? "Plans that break a rule are listed first. Approve, edit or reject each one." : "Approved plans waiting to be produced and posted."}
            </p>
          </div>
        </div>
        {list.length ? list.map((c) => <ClipCard key={c.id} clip={c} campaign={camp(c.campaignId)} showCampaign />) : <Empty>Nothing here right now.</Empty>}
      </div>
    </>
  );
}
