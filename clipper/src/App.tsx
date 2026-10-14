import { useState, type ReactNode } from "react";
import { BarChart3, Clapperboard, Home, Inbox, Lightbulb, LogOut, Play, Plus, Settings, ChevronRight, Search } from "lucide-react";
import { fmtNum, fmtUSD } from "../shared/rules";
import { api } from "./api";
import { go, useApp, useRoute } from "./store";
import { CampaignView, CampaignRight } from "./views/Campaign";
import { NewCampaign } from "./views/NewCampaign";
import { LearningView } from "./views/Learning";
import { Overview, OverviewRight } from "./views/Overview";
import { PostsView } from "./views/Posts";
import { Review } from "./views/Review";
import { SettingsView } from "./views/Settings";

export function Tabs({ tabs, active, onPick }: { tabs: { id: string; label: string; n?: number }[]; active: string; onPick: (id: string) => void }) {
  return (
    <nav className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={t.id === active} className={`tab ${t.id === active ? "on" : ""}`} onClick={() => onPick(t.id)}>
          {t.label}
          {t.n !== undefined && <span className="n">{t.n}</span>}
        </button>
      ))}
    </nav>
  );
}

export function App() {
  const { me, setMe, state } = useApp();
  const [route] = useRoute();
  const [menu, setMenu] = useState(false);
  const [filter, setFilter] = useState("");
  const [page, id, sub] = route;

  const toReview = state?.clips.filter((c) => c.status === "draft").length ?? 0;
  const campaigns = (state?.campaigns ?? []).filter((c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase()));
  const totals = (state?.campaigns ?? []).reduce((t, c) => ({ views: t.views + c.stats.views, earned: t.earned + c.stats.estimatedEarnings }), { views: 0, earned: 0 });

  let view: ReactNode;
  let right: ReactNode = null;
  if (page === "new") view = <NewCampaign />;
  else if (page === "c" && id) {
    view = <CampaignView id={id} tab={sub ?? "brief"} />;
    right = <CampaignRight id={id} />;
  } else if (page === "review") view = <Review />;
  else if (page === "posts") view = <PostsView />;
  else if (page === "learn") view = <LearningView scope={id ?? "all"} />;
  else if (page === "settings") view = <SettingsView tab={id ?? "workspace"} />;
  else {
    view = <Overview tab={id ?? "campaigns"} />;
    right = <OverviewRight />;
  }

  const railBtn = (to: string, on: boolean, icon: ReactNode, label: string, dot?: number) => (
    <button className={`rail-btn ${on ? "on" : ""}`} title={label} aria-label={label} onClick={() => go(to)}>
      {icon}
      {!!dot && <span className="dot">{dot}</span>}
    </button>
  );
  const group = (label: string, list: typeof campaigns) =>
    list.length > 0 && (
      <>
        <div className="side-group">{label}</div>
        {list.map((c) => {
          const thumb = c.footage.find((f) => f.thumbUrl)?.thumbUrl;
          return (
            <button key={c.id} className={`side-item ${page === "c" && id === c.id ? "on" : ""}`} onClick={() => go(`/c/${c.id}/${sub && page === "c" ? sub : "brief"}`)}>
              <span className="side-thumb" style={thumb ? { backgroundImage: `url("${thumb}")` } : undefined}>
                {!thumb && <Clapperboard size={15} />}
              </span>
              <span className="grow">
                <div className="t ellipsis">{c.name}</div>
                <div className="s ellipsis">
                  {c.brief.payout.cpm ? `${fmtUSD(c.brief.payout.cpm)} CPM` : "No CPM"} · {fmtNum(c.stats.views)} views · {fmtUSD(c.stats.estimatedEarnings)}
                </div>
              </span>
            </button>
          );
        })}
      </>
    );

  return (
    <div className={`shell ${right ? "" : "no-right"}`}>
      <nav className="rail" aria-label="Main">
        <div className="logo">
          <Play size={16} fill="#fff" />
        </div>
        {railBtn("/", !page, <Home size={19} />, "Overview")}
        {railBtn("/new", page === "new", <Plus size={19} />, "New campaign")}
        {railBtn("/review", page === "review", <Inbox size={19} />, "Clips to review", toReview)}
        {railBtn("/posts", page === "posts", <BarChart3 size={19} />, "Posts & earnings")}
        {railBtn("/learn", page === "learn", <Lightbulb size={19} />, "What's working")}
        {railBtn("/settings", page === "settings", <Settings size={19} />, "Settings")}
        <div className="spacer" />
        <div style={{ position: "relative" }}>
          <button className="avatar" onClick={() => setMenu(!menu)} aria-label="Account menu">
            {(me.user.name || me.user.email)[0].toUpperCase()}
          </button>
          {menu && (
            <div className="menu" onMouseLeave={() => setMenu(false)}>
              <div style={{ padding: "6px 10px" }}>
                <strong>{me.user.name}</strong>
                <div className="small muted">{me.user.email}</div>
              </div>
              <button onClick={() => (setMenu(false), go("/settings/account"))}>Account settings</button>
              <button onClick={() => api.logout().then(() => setMe(null))}>
                <span className="row">
                  <LogOut size={14} /> Sign out
                </span>
              </button>
            </div>
          )}
        </div>
      </nav>

      <aside className="side" aria-label="Campaigns">
        <div className="side-head">
          <button className="new-btn" onClick={() => go("/new")}>
            <span className="row">
              <Plus size={15} /> New campaign
            </span>
            <ChevronRight size={15} />
          </button>
          {(state?.campaigns.length ?? 0) > 5 && (
            <div className="row" style={{ position: "relative" }}>
              <Search size={14} style={{ position: "absolute", left: 9 }} className="faint" />
              <input className="input" style={{ paddingLeft: 28 }} placeholder="Find a campaign" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
          )}
        </div>
        <div className="side-list">
          {state && !state.campaigns.length && <p className="small muted" style={{ padding: 8 }}>No campaigns yet. Paste a brief to add your first.</p>}
          {group("Active", campaigns.filter((c) => c.status === "active"))}
          {group("Paused", campaigns.filter((c) => c.status === "paused"))}
          {group("Ended", campaigns.filter((c) => c.status === "ended"))}
        </div>
      </aside>

      <main className="main">{view}</main>
      {right && <aside className="right">{right}</aside>}

      <footer className="bottom">
        <span className="seg">
          <strong>{me.workspace.name}</strong>
          <span className="sep">|</span>
          <span className={`led ${state?.status.ai === "live" ? "live" : "off"}`} /> AI {state?.status.ai === "live" ? state.status.aiModel : "rules only"}
          <span className="sep hide-sm">|</span>
          <span className="hide-sm seg">
            <span className={`led ${state?.status.render === "connected" ? "live" : "off"}`} /> Render {state?.status.render === "connected" ? "connected" : "not connected"}
          </span>
        </span>
        <span className="seg">
          {state?.campaigns.length ?? 0} campaigns<span className="sep">|</span>
          {fmtNum(totals.views)} views<span className="sep">|</span>
          <strong>{fmtUSD(totals.earned)}</strong> est. earned
        </span>
      </footer>
    </div>
  );
}
