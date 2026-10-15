import { useEffect, useState } from "react";
import { AlertTriangle, Link2, RefreshCw, Unplug } from "lucide-react";
import { PLATFORM_LABEL } from "../../shared/types";
import { api } from "../api";
import { go, hashQuery, useApp } from "../store";
import { Modal, Panel } from "./ui";

const NETWORKS = [
  { id: "tiktok", label: "TikTok" },
  { id: "instagram", label: "Instagram" },
  { id: "youtube", label: "YouTube" },
  { id: "facebook", label: "Facebook" },
  { id: "x", label: "X" },
  { id: "threads", label: "Threads" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "bluesky", label: "Bluesky" },
];

/** Connect social accounts through Outstand so clips can be posted and scheduled from here. */
export function ConnectAccounts() {
  const { state, run, busy, toast } = useApp();
  const [pending, setPending] = useState<{ session: string; pages: { id: string; name: string; network?: string; picture?: string }[] }>();
  const [picked, setPicked] = useState<string[]>([]);
  const on = !!state?.status.publishing;
  const connected = (state?.accounts ?? []).filter((a) => a.outstandId);

  // Back from a network's sign-in.
  useEffect(() => {
    const q = hashQuery();
    if (q.get("connected")) toast("Account connected");
    if (q.get("connect_error")) toast(q.get("connect_error")!, true);
    const session = q.get("pending");
    if (session) api.pendingPages(session).then((r) => (setPending({ session, pages: r.pages }), setPicked(r.pages.map((p) => p.id))), (e: Error) => toast(e.message, true));
    if (q.toString()) go("/settings/accounts");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = async (network: string) => {
    const r = await run(() => api.connectSocial(network));
    if (r) window.location.href = r.url;
  };

  if (!on)
    return (
      <Panel title="Post and schedule from here">
        <p className="small muted" style={{ margin: 0 }}>
          Publishing isn't connected on this server yet. With an <a href="https://www.outstand.so/" target="_blank" rel="noreferrer">Outstand</a> API key (<code>OUTSTAND_API_KEY</code>), you can connect TikTok, Instagram, YouTube and more, schedule clips, and have views tracked automatically.
        </p>
      </Panel>
    );

  return (
    <>
      <Panel title="Connected accounts" aside={<button className="btn sm ghost" disabled={busy} onClick={() => run(() => api.syncSocial(), "Accounts refreshed")}><RefreshCw size={13} /> Refresh</button>}>
        <p className="small muted" style={{ marginTop: 0 }}>
          Clips can be posted and scheduled to these accounts, and their views are tracked automatically.
        </p>
        <div className="row wrap">
          {NETWORKS.map((n) => (
            <button key={n.id} className="btn sm" disabled={busy} onClick={() => connect(n.id)}>
              <Link2 size={13} /> {n.label}
            </button>
          ))}
        </div>
        {connected.length > 0 && (
          <table className="table mt">
            <tbody>
              {connected.map((a) => (
                <tr key={a.id}>
                  <td style={{ width: 40 }}>{a.avatarUrl ? <img src={a.avatarUrl} alt="" className="avatar-sm" /> : <span className="avatar-sm" />}</td>
                  <td>
                    <strong>@{a.handle}</strong>
                    <div className="small faint">{PLATFORM_LABEL[a.platform]}</div>
                  </td>
                  <td>
                    {a.needsReconnect ? (
                      <span className="badge bad">
                        <AlertTriangle size={11} /> Reconnect
                      </span>
                    ) : (
                      <span className="badge ok">Connected</span>
                    )}
                  </td>
                  <td className="num">
                    {a.needsReconnect && (
                      <button className="btn sm" onClick={() => connect(a.platform === "youtube" ? "youtube" : a.platform)}>
                        Reconnect
                      </button>
                    )}
                    <button className="btn sm ghost danger" title="Disconnect" onClick={() => confirm(`Disconnect @${a.handle}?`) && run(() => api.disconnectSocial(a.id), "Disconnected")}>
                      <Unplug size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {pending && (
        <Modal title="Which pages?" onClose={() => setPending(undefined)}>
          <p className="small muted" style={{ marginTop: 0 }}>
            Pick the pages Clip Operator may post to.
          </p>
          {pending.pages.map((p) => (
            <label key={p.id} className="row" style={{ padding: "6px 0" }}>
              <input type="checkbox" checked={picked.includes(p.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, p.id] : picked.filter((x) => x !== p.id))} />
              {p.picture && <img src={p.picture} alt="" className="avatar-sm" />}
              <span>{p.name}</span>
            </label>
          ))}
          <button className="btn primary mt" disabled={busy || !picked.length} onClick={() => run(() => api.finalizePages(pending.session, picked), "Pages connected").then((r) => r && setPending(undefined))}>
            Connect {picked.length} page{picked.length === 1 ? "" : "s"}
          </button>
        </Modal>
      )}
    </>
  );
}
