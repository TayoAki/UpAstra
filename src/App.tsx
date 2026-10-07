import { useState } from "react";
import { Bell, BookOpen, Home, LogOut, Radar, Search, Settings, SlidersHorizontal, Users } from "lucide-react";
import { fmtUSD } from "../shared/economics";
import { useApp, useRoute, useSession } from "./store";
import { RadarView } from "./views/Radar";
import { SettingsView } from "./views/Settings";
import { HomeView } from "./views/Home";
import { JobView } from "./views/Job";
import { IntakeView } from "./views/Intake";
import { ApprovalsView } from "./views/Approvals";
import { MemoryView } from "./views/Memory";
import { PlaybookView } from "./views/Playbook";
import { AutonomyView } from "./views/Autonomy";

const RAIL = [
  { id: "", icon: Home, label: "Jobs" },
  { id: "intake", icon: Search, label: "New job / intake" },
  { id: "radar", icon: Radar, label: "Job Radar — find & pitch jobs" },
  { id: "approvals", icon: Bell, label: "Approvals" },
  { id: "memory", icon: Users, label: "Client memory" },
  { id: "playbook", icon: BookOpen, label: "Playbook: templates & models" },
  { id: "autonomy", icon: SlidersHorizontal, label: "Autonomy controls" },
  { id: "settings", icon: Settings, label: "Workspace settings" },
];

export function App() {
  const [route, go] = useRoute();
  const { stats, boot } = useApp();
  const { me, workspaceId, logout } = useSession();
  const [menu, setMenu] = useState(false);
  const wsName = me.workspaces.find((w) => w.id === workspaceId)?.name ?? "";
  const section = route[0] ?? "";
  const railActive = section === "job" ? "" : section;

  let view;
  switch (section) {
    case "job":
      view = <JobView id={route[1]} tab={route[2]} />;
      break;
    case "intake":
      view = <IntakeView />;
      break;
    case "approvals":
      view = <ApprovalsView />;
      break;
    case "memory":
      view = <MemoryView clientId={route[1]} />;
      break;
    case "playbook":
      view = <PlaybookView tab={route[1]} item={route[2]} />;
      break;
    case "autonomy":
      view = <AutonomyView />;
      break;
    case "radar":
      view = <RadarView searchId={route[1] === "search" ? route[2] : undefined} leadId={route[1] === "lead" ? route[2] : undefined} />;
      break;
    case "settings":
      view = <SettingsView tab={route[1]} />;
      break;
    default:
      view = <HomeView tab={route[0] === "home" ? route[1] : undefined} />;
  }

  return (
    <div className="app">
      <nav className="rail" aria-label="Primary">
        <div className="rail-logo" title="Studio Operator">
          SO
        </div>
        {RAIL.map((r) => (
          <button key={r.id} className={`rail-btn ${railActive === r.id ? "active" : ""}`} title={r.label} aria-label={r.label} onClick={() => go(`/${r.id}`)}>
            <r.icon size={20} strokeWidth={1.7} />
            {r.id === "approvals" && stats && stats.needsAttention > 0 && <span className="rail-badge">{stats.needsAttention}</span>}
          </button>
        ))}
        <div className="rail-spacer" />
        <div className="rail-menu-wrap">
          <button className="rail-avatar" title={`${me.user.name} · ${wsName}`} aria-label="Account menu" onClick={() => setMenu(!menu)}>
            {me.user.name.slice(0, 2).toUpperCase()}
          </button>
          {menu && (
            <div className="rail-menu" onMouseLeave={() => setMenu(false)}>
              <div className="small">
                <strong>{me.user.name}</strong>
                <div className="muted">{me.user.email}</div>
              </div>
              <button className="menu-item" onClick={() => (setMenu(false), go("/settings"))}>
                <Settings size={14} /> {wsName}
              </button>
              <button className="menu-item" onClick={() => logout()}>
                <LogOut size={14} /> Sign out
              </button>
            </div>
          )}
        </div>
      </nav>
      <div className="body">{view}</div>
      <footer className="bottombar">
        <span>
          <strong>{wsName}</strong>
          <span className="sep">·</span>
          <span className={`mode-dot ${boot?.providers.astra.mode}`} /> Astra {boot?.providers.astra.mode ?? "…"}
          {boot?.providers.astra.mode === "live" ? ` (${boot.providers.astra.model})` : ""}
          <span className="sep">·</span>
          <span className={`mode-dot ${boot?.providers.higgsfield.mode}`} /> Higgsfield {boot?.providers.higgsfield.mode ?? "…"}
          <span className="sep">·</span>
          <span className={`mode-dot ${boot?.providers.apify}`} /> Apify {boot?.providers.apify ?? "…"}
        </span>
        <span>
          {stats && (
            <>
              Spend to date {fmtUSD(stats.spendToDate)}
              <span className="sep">·</span>Delivered {fmtUSD(stats.deliveredRevenue)}
              <span className="sep">·</span>
            </>
          )}
          Studio Operator v0.3
        </span>
      </footer>
    </div>
  );
}
