import { useEffect, useState } from "react";
import type { FirmProfile } from "../../shared/types";
import { api, type WorkspaceInfo } from "../api";
import { Frame, ListEditor, Panel, SideHeader, SideItem, Tabs } from "../components/ui";
import { useAction, useApp, useSession } from "../store";

type Tab = "workspace" | "profile" | "team" | "agents";

export function SettingsView({ tab: initial }: { tab?: string }) {
  const { boot, toast } = useApp();
  const { me, refreshMe, switchWorkspace, workspaceId } = useSession();
  const { busy, run } = useAction();
  const [tab, setTab] = useState<Tab>((["workspace", "profile", "team", "agents"].includes(initial ?? "") ? initial : "workspace") as Tab);
  const [ws, setWs] = useState<WorkspaceInfo | null>(null);
  const [name, setName] = useState("");
  const [profile, setProfile] = useState<FirmProfile | null>(null);
  const [invite, setInvite] = useState<string>("");
  const [token, setToken] = useState<string>("");
  const [newWs, setNewWs] = useState({ name: "", demo: false });

  const load = () =>
    api.workspace().then((w) => {
      setWs(w);
      setName(w.name);
      setProfile(w.profile);
    });
  useEffect(() => {
    load();
  }, []);
  const admin = ws?.role === "owner" || ws?.role === "admin";
  const origin = window.location.origin;
  const copy = (t: string) =>
    navigator.clipboard.writeText(t).then(
      () => toast("Copied"),
      () => toast("Clipboard unavailable", "err"),
    );

  return (
    <Frame
      sidebar={
        <>
          <SideHeader>Your workspaces</SideHeader>
          <div className="side-list">
            {me.workspaces.map((w) => (
              <SideItem key={w.id} active={w.id === workspaceId} title={w.name} sub={w.role} onClick={() => w.id !== workspaceId && switchWorkspace(w.id)} />
            ))}
          </div>
          <div className="pad form">
            <input className="input" placeholder="New workspace name" value={newWs.name} onChange={(e) => setNewWs({ ...newWs, name: e.target.value })} />
            <label className="radio small">
              <input type="checkbox" checked={newWs.demo} onChange={(e) => setNewWs({ ...newWs, demo: e.target.checked })} />
              Include demo data
            </label>
            <button
              className="btn sm wide"
              disabled={busy || !newWs.name.trim()}
              onClick={() =>
                run(() => api.createWorkspace(newWs.name, newWs.demo), "Workspace created").then(async (r) => {
                  if (r) {
                    await refreshMe();
                    switchWorkspace(r.workspace.id);
                  }
                })
              }
            >
              + Create workspace
            </button>
          </div>
        </>
      }
      tabs={
        <Tabs
          value={tab}
          onChange={setTab}
          options={[
            { id: "workspace", label: "Workspace" },
            { id: "profile", label: "Firm profile" },
            { id: "team", label: "Team", count: ws?.members.length },
            { id: "agents", label: "Agent access (MCP)" },
          ]}
        />
      }
      right={
        <>
          <h4 className="right-title">Integrations</h4>
          <div className="right-box small">
            <div className="row between">
              <span>Built-in AI</span>
              <span className={boot?.providers.astra.mode === "live" ? "pos" : "muted"}>{boot?.providers.astra.mode === "live" ? `${boot.providers.ai} · ${boot.providers.astra.model}` : "simulated"}</span>
            </div>
            <div className="row between">
              <span>Higgsfield</span>
              <span className={boot?.providers.higgsfield.mode === "live" ? "pos" : "muted"}>{boot?.providers.higgsfield.mode}</span>
            </div>
            <div className="row between">
              <span>Apify (radar)</span>
              <span className={boot?.providers.apify === "live" ? "pos" : "muted"}>{boot?.providers.apify}</span>
            </div>
          </div>
          <p className="small muted top-gap">Keys are set by the platform operator as environment variables; they never reach the browser.</p>
        </>
      }
    >
      {!ws ? null : tab === "workspace" ? (
        <>
          <header className="page-head">
            <div>
              <h1>Workspace</h1>
              <p className="muted">Everything in a workspace — jobs, clients, policy, radar — is private to its members.</p>
            </div>
          </header>
          <Panel title="Name">
            <div className="row gap">
              <input className="input" value={name} disabled={!admin} onChange={(e) => setName(e.target.value)} />
              <button className="btn" disabled={!admin || busy || name === ws.name} onClick={() => run(() => api.renameWorkspace(name), "Renamed").then(() => refreshMe())}>
                Save
              </button>
            </div>
            <p className="small muted top-gap">You are {ws.role === "owner" ? "the owner" : `a${ws.role === "admin" ? "n" : ""} ${ws.role}`} of this workspace.</p>
          </Panel>
        </>
      ) : tab === "profile" && profile ? (
        <>
          <header className="page-head">
            <div>
              <h1>Firm profile</h1>
              <p className="muted">How your studio introduces itself. The radar uses this in every proposal — it never invents proof you didn't list here.</p>
            </div>
            <button className="btn primary" disabled={busy} onClick={() => run(() => api.saveProfile(profile), "Profile saved").then((p) => p && setProfile(p))}>
              Save profile
            </button>
          </header>
          <div className="form">
            <div className="grid2">
              <label className="field">
                <span>Studio name</span>
                <input className="input" value={profile.firmName} onChange={(e) => setProfile({ ...profile, firmName: e.target.value })} />
              </label>
              <label className="field">
                <span>Tone</span>
                <input className="input" value={profile.tone} onChange={(e) => setProfile({ ...profile, tone: e.target.value })} />
              </label>
            </div>
            <label className="field">
              <span>Positioning</span>
              <textarea className="input" rows={3} value={profile.positioning} onChange={(e) => setProfile({ ...profile, positioning: e.target.value })} />
            </label>
            <div className="grid2">
              <ListEditor label="Services" value={profile.services} onChange={(v) => setProfile({ ...profile, services: v })} />
              <ListEditor label="Proof points (real results only)" value={profile.proofPoints} onChange={(v) => setProfile({ ...profile, proofPoints: v })} />
              <ListEditor label="Portfolio links" value={profile.portfolio} onChange={(v) => setProfile({ ...profile, portfolio: v })} />
              <label className="field">
                <span>Signature</span>
                <textarea className="input" rows={3} value={profile.signature} onChange={(e) => setProfile({ ...profile, signature: e.target.value })} />
              </label>
            </div>
          </div>
        </>
      ) : tab === "team" ? (
        <>
          <header className="page-head">
            <div>
              <h1>Team</h1>
              <p className="muted">Invite teammates with a one-time code (valid 7 days).</p>
            </div>
          </header>
          <Panel title="Members">
            <table className="table">
              <tbody>
                {ws.members.map((m) => (
                  <tr key={m.userId}>
                    <td>
                      <strong>{m.name}</strong>
                      <div className="small muted">{m.email}</div>
                    </td>
                    <td className="small">{m.role}</td>
                    <td className="num">
                      {admin && m.role !== "owner" && m.userId !== me.user.id && (
                        <button className="btn sm" disabled={busy} onClick={() => confirm(`Remove ${m.email}?`) && run(() => api.removeMember(m.userId), "Removed").then(load)}>
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          {admin && (
            <Panel title="Invite">
              <div className="row gap">
                <button className="btn" disabled={busy} onClick={() => run(() => api.invite("member")).then((r) => r && setInvite(r.code))}>
                  New member invite
                </button>
                <button className="btn" disabled={busy} onClick={() => run(() => api.invite("admin")).then((r) => r && setInvite(r.code))}>
                  New admin invite
                </button>
              </div>
              {invite && (
                <div className="code-box top-gap">
                  <code>{`${origin}/?invite=${invite}`}</code>
                  <button className="btn sm" onClick={() => copy(`${origin}/?invite=${invite}`)}>
                    Copy link
                  </button>
                </div>
              )}
            </Panel>
          )}
        </>
      ) : (
        <>
          <header className="page-head">
            <div>
              <h1>Agent access (MCP)</h1>
              <p className="muted">
                Let Claude, Astra or any MCP client run this workspace. The agent token only reaches this workspace, its actions are logged as "agent", and the autonomy policy decides
                what it may approve. Final delivery always stays with a human.
              </p>
            </div>
          </header>
          <Panel title="Agent token" aside={<span className={ws.hasAgentToken || token ? "pos small" : "muted small"}>{ws.hasAgentToken || token ? "active" : "none"}</span>}>
            {token ? (
              <div className="code-box">
                <code>{token}</code>
                <button className="btn sm" onClick={() => copy(token)}>
                  Copy
                </button>
              </div>
            ) : (
              <p className="small muted">Tokens are shown once. Creating a new one revokes the old one.</p>
            )}
            {admin && (
              <div className="row gap top-gap">
                <button className="btn primary" disabled={busy} onClick={() => run(() => api.createAgentToken(), "Token created").then((r) => r && (setToken(r.token), load()))}>
                  {ws.hasAgentToken ? "Rotate token" : "Create token"}
                </button>
                {ws.hasAgentToken && (
                  <button className="btn" disabled={busy} onClick={() => confirm("Revoke the agent token? Connected agents stop working.") && run(() => api.revokeAgentToken(), "Revoked").then(() => (setToken(""), load()))}>
                    Revoke
                  </button>
                )}
              </div>
            )}
          </Panel>
          <Panel title="Claude Code">
            <pre className="code">{`claude mcp add studio-operator \\
  -e STUDIO_API_URL=${origin} \\
  -e STUDIO_API_TOKEN=${token || "so_agent_…"} \\
  -- npx -y tsx /path/to/UpAstra/server/mcp-stdio.ts`}</pre>
          </Panel>
          <Panel title="Remote MCP (Astra / OpenAI, Claude API, other platforms)">
            <pre className="code">{`URL:    ${origin}/mcp
Header: Authorization: Bearer ${token || "so_agent_…"}`}</pre>
            <p className="small muted">Streamable HTTP transport. Check your platform's MCP connector docs for where the URL and header go.</p>
          </Panel>
        </>
      )}
    </Frame>
  );
}
