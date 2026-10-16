import { useState } from "react";
import { Copy, KeyRound } from "lucide-react";
import { api } from "../api";
import { Panel } from "../components/ui";
import { useApp } from "../store";

/** Settings → Agent access: the workspace key for MCP clients and the API, with copy-paste setup. */
export function AgentAccess() {
  const { me, setMe, run, busy, toast } = useApp();
  const [key, setKey] = useState<string>();
  const has = !!me.workspace.hasAgentKey;
  const shown = key ?? "co_agent_YOUR_KEY";
  const mcpUrl = `${window.location.origin}/mcp`;
  const copy = (t: string) => navigator.clipboard?.writeText(t).then(() => toast("Copied"));

  const create = () =>
    (!has || confirm("Make a new key? The current one stops working right away.")) &&
    run(() => api.createAgentKey()).then((r) => {
      if (!r) return;
      setKey(r.key);
      setMe(r.me);
    });
  const revoke = () => confirm("Revoke the agent key? Anything using it stops working.") && run(() => api.revokeAgentKey(), "Key revoked").then((m) => m && (setKey(undefined), setMe(m)));

  const snippets = [
    { title: "Claude Code", body: `claude mcp add --transport http ugcmediaclips ${mcpUrl} --header "Authorization: Bearer ${shown}"` },
    { title: "Cursor, Windsurf and other MCP clients (JSON config)", body: JSON.stringify({ mcpServers: { "ugcmediaclips": { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${shown}` } } } }, null, 2) },
    { title: "Claude Desktop (via mcp-remote)", body: JSON.stringify({ mcpServers: { "ugcmediaclips": { command: "npx", args: ["-y", "mcp-remote", mcpUrl, "--header", `Authorization: Bearer ${shown}`] } } }, null, 2) },
    { title: "Plain HTTP API (scripts, n8n, Zapier)", body: `curl -H "Authorization: Bearer ${shown}" ${window.location.origin}/api/state` },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Agent access</h1>
          <p className="muted" style={{ margin: 0 }}>
            Run UGCMediaClips without the dashboard: an AI agent (Claude, Cursor…) or a script can add briefs, write and render clips, log posts and read what's working — with the same brief checks and limits as here.
          </p>
        </div>
      </div>
      <Panel
        title={
          <span className="row">
            <KeyRound size={16} /> Agent key
          </span>
        }
      >
        {key ? (
          <>
            <p className="small" style={{ marginTop: 0 }}>
              Copy it now — it's shown only once. Treat it like a password: it can do anything in this workspace except change your account.
            </p>
            <div className="row">
              <code className="key-box grow">{key}</code>
              <button className="btn sm" onClick={() => copy(key)}>
                <Copy size={14} /> Copy
              </button>
            </div>
          </>
        ) : (
          <p className="small muted" style={{ marginTop: 0 }}>
            {has ? "A key is active. Keys are stored hashed, so it can't be shown again — make a new one if you lost it." : "No key yet."}
          </p>
        )}
        <div className="row mt">
          <button className="btn primary" disabled={busy} onClick={create}>
            {has ? "Make a new key" : "Create key"}
          </button>
          {has && (
            <button className="btn danger" disabled={busy} onClick={revoke}>
              Revoke
            </button>
          )}
        </div>
      </Panel>
      <Panel title="Connect">
        <p className="small muted" style={{ marginTop: 0 }}>
          MCP server: <code>{mcpUrl}</code> (Streamable HTTP, key in the Authorization header). Then ask your agent something like “Make 3 shorts from this brief: &lt;link&gt;”.
        </p>
        {snippets.map((s) => (
          <div key={s.title} className="mt">
            <div className="row between">
              <strong className="small">{s.title}</strong>
              <button className="btn sm ghost" onClick={() => copy(s.body)} title="Copy">
                <Copy size={13} />
              </button>
            </div>
            <pre className="snippet">{s.body}</pre>
          </div>
        ))}
      </Panel>
      <Panel title="What an agent can do">
        <ul className="tight small">
          <li>
            <strong>brief_to_shorts</strong> — brief link or text in, rendered videos out (plans that break a rule wait for review)
          </li>
          <li>
            <strong>add_campaign, plan_clips, edit_clip, review_clip, render_clip, wait_for_renders</strong> — the same steps one at a time
          </li>
          <li>
            <strong>find_moments</strong> — log highlights in the footage so cuts land on real goals and saves
          </li>
          <li>
            <strong>log_post, update_post_metrics, list_posts</strong> — track posts and earnings
          </li>
          <li>
            <strong>whats_working</strong> — the learning report and playbook
          </li>
        </ul>
        <p className="small faint" style={{ marginBottom: 0 }}>
          Agents can't post to social accounts for you, change your account, or manage keys. Everything they do shows in Activity, marked “agent”.
        </p>
      </Panel>
    </>
  );
}
