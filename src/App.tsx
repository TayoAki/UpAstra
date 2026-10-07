import { Bell, BookOpen, Home, Search, Settings, Users } from "lucide-react";
import { fmtUSD } from "../shared/economics";
import { useApp, useRoute } from "./store";
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
  { id: "approvals", icon: Bell, label: "Approvals" },
  { id: "memory", icon: Users, label: "Client memory" },
  { id: "playbook", icon: BookOpen, label: "Playbook: templates & models" },
  { id: "autonomy", icon: Settings, label: "Autonomy controls" },
];

export function App() {
  const [route, go] = useRoute();
  const { stats, boot } = useApp();
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
        <div className="rail-avatar" title="Operator (you)">
          You
        </div>
      </nav>
      <div className="body">{view}</div>
      <footer className="bottombar">
        <span>
          <span className={`mode-dot ${boot?.providers.astra.mode}`} /> Astra {boot?.providers.astra.mode ?? "…"}
          {boot?.providers.astra.mode === "live" ? ` (${boot.providers.astra.model})` : ""}
          <span className="sep">·</span>
          <span className={`mode-dot ${boot?.providers.higgsfield.mode}`} /> Higgsfield {boot?.providers.higgsfield.mode ?? "…"}
        </span>
        <span>
          {stats && (
            <>
              Spend to date {fmtUSD(stats.spendToDate)}
              <span className="sep">·</span>Delivered {fmtUSD(stats.deliveredRevenue)}
              <span className="sep">·</span>
            </>
          )}
          Studio Operator v0.1
        </span>
      </footer>
    </div>
  );
}
