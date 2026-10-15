import { useState } from "react";
import { Trash2 } from "lucide-react";
import { PLATFORM_LABEL, PLATFORMS, type Platform } from "../../shared/types";
import { api } from "../api";
import { Tabs } from "../App";
import { AgentAccess } from "./AgentAccess";
import { BrandCaptions } from "./BrandCaptions";
import { ConnectAccounts } from "../components/ConnectAccounts";
import { Empty, Panel } from "../components/ui";
import { go, useApp } from "../store";

export function SettingsView({ tab }: { tab: string }) {
  const { me, setMe, state, run, busy } = useApp();
  const [ws, setWs] = useState(me.workspace.name);
  const [acct, setAcct] = useState({ platform: "tiktok" as Platform, handle: "", niche: "", followers: "" });
  const [pw, setPw] = useState("");

  return (
    <>
      <Tabs
        tabs={[
          { id: "workspace", label: "Workspace" },
          { id: "brand", label: "Brand & captions" },
          { id: "accounts", label: "Posting accounts", n: state?.accounts.length },
          { id: "agent", label: "Agent access" },
          { id: "account", label: "Your account" },
        ]}
        active={tab}
        onPick={(t) => go(`/settings/${t}`)}
      />
      <div className="content">
        {tab === "brand" ? (
          <BrandCaptions />
        ) : tab === "agent" ? (
          <AgentAccess />
        ) : tab === "accounts" ? (
          <>
            <div className="page-head">
              <div>
                <h1>Posting accounts</h1>
                <p className="muted" style={{ margin: 0 }}>
                  The accounts you post clips from. Campaigns often limit who may upload (for example, only Roblox-focused accounts), so note each account's niche.
                </p>
              </div>
            </div>
            <ConnectAccounts />
            <Panel title="Add an account by hand">
              <div className="form-grid">
                <label className="field">
                  Platform
                  <select className="select" value={acct.platform} onChange={(e) => setAcct({ ...acct, platform: e.target.value as Platform })}>
                    {PLATFORMS.map((p) => (
                      <option key={p} value={p}>
                        {PLATFORM_LABEL[p]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Handle
                  <input className="input" placeholder="@handle" value={acct.handle} onChange={(e) => setAcct({ ...acct, handle: e.target.value })} />
                </label>
                <label className="field">
                  Niche
                  <input className="input" placeholder="e.g. Roblox gaming" value={acct.niche} onChange={(e) => setAcct({ ...acct, niche: e.target.value })} />
                </label>
                <label className="field">
                  Followers
                  <input className="input" type="number" min={0} value={acct.followers} onChange={(e) => setAcct({ ...acct, followers: e.target.value })} />
                </label>
              </div>
              <button
                className="btn primary mt"
                disabled={busy || !acct.handle.trim()}
                onClick={() => run(() => api.addAccount({ ...acct, followers: Number(acct.followers) || undefined }), "Account added").then((r) => r && setAcct({ ...acct, handle: "", followers: "" }))}
              >
                Add account
              </button>
            </Panel>
            <Panel title="Accounts added by hand">
              {state?.accounts.some((a) => !a.outstandId) ? (
                <table className="table">
                  <tbody>
                    {state.accounts.filter((a) => !a.outstandId).map((a) => (
                      <tr key={a.id}>
                        <td>{PLATFORM_LABEL[a.platform]}</td>
                        <td>
                          <strong>@{a.handle}</strong>
                        </td>
                        <td className="muted">{a.niche}</td>
                        <td className="num">{a.followers?.toLocaleString() ?? ""}</td>
                        <td className="num">
                          <button className="btn sm ghost danger" onClick={() => run(() => api.deleteAccount2(a.id), "Removed")}>
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <Empty>No accounts yet.</Empty>
              )}
            </Panel>
          </>
        ) : tab === "account" ? (
          <>
            <div className="page-head">
              <div>
                <h1>Your account</h1>
                <p className="muted" style={{ margin: 0 }}>
                  Signed in as {me.user.email}.
                </p>
              </div>
            </div>
            <Panel title="Delete account">
              <p className="small muted" style={{ marginTop: 0 }}>
                Deletes your account, your workspace, and every campaign, clip plan and post in it. This can't be undone.
              </p>
              <div className="row wrap">
                <input className="input" style={{ maxWidth: 260 }} type="password" placeholder="Your password" value={pw} onChange={(e) => setPw(e.target.value)} />
                <button
                  className="btn danger"
                  disabled={busy || pw.length < 8}
                  onClick={() => confirm("Delete your account and everything in it?") && run(() => api.deleteAccount(pw)).then((r) => r && setMe(null))}
                >
                  <Trash2 size={14} /> Delete my account
                </button>
              </div>
            </Panel>
          </>
        ) : (
          <>
            <div className="page-head">
              <div>
                <h1>Workspace</h1>
              </div>
            </div>
            <Panel title="Name">
              <div className="row">
                <input className="input" style={{ maxWidth: 320 }} value={ws} onChange={(e) => setWs(e.target.value)} />
                <button className="btn primary" disabled={busy || !ws.trim() || ws === me.workspace.name} onClick={() => run(() => api.renameWorkspace(ws.trim()), "Renamed").then((m) => m && setMe(m))}>
                  Save
                </button>
              </div>
            </Panel>
            <Panel title="Services">
              <dl className="kv" style={{ maxWidth: 460 }}>
                <dt>Brief reading & scripts</dt>
                <dd className={state?.status.ai === "live" ? "pos" : "muted"}>{state?.status.ai === "live" ? state.status.aiModel : "rules only (no AI key)"}</dd>
                <dt>Video rendering</dt>
                <dd className="muted">{state?.status.render === "connected" ? "connected" : "not connected yet"}</dd>
                <dt>Storage</dt>
                <dd>{state?.status.storage}</dd>
              </dl>
            </Panel>
          </>
        )}
      </div>
    </>
  );
}
