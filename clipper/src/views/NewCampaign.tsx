import { useState } from "react";
import { FileText, Link2, Sparkles } from "lucide-react";
import { api } from "../api";
import { Tabs } from "../App";
import { Panel } from "../components/ui";
import { go, useApp } from "../store";

export function NewCampaign() {
  const { run, busy, state } = useApp();
  const [mode, setMode] = useState<"link" | "text">("link");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");

  const submit = async () => {
    const r = await run(() => api.createCampaign(mode === "link" ? { url: url.trim() } : { text }), "Campaign added — check the rules it found");
    if (r) go(`/c/${r.campaign.id}/brief`);
  };
  const ready = mode === "link" ? /^https?:\/\/\S+/.test(url.trim()) : text.trim().length > 40;

  return (
    <>
      <Tabs
        tabs={[
          { id: "link", label: "From a link" },
          { id: "text", label: "Paste the brief" },
        ]}
        active={mode}
        onPick={(m) => setMode(m as "link" | "text")}
      />
      <div className="content">
        <div className="page-head">
          <div>
            <h1>New campaign</h1>
            <p className="muted" style={{ margin: 0 }}>
              Drop in the brief exactly as the campaign shared it. {state?.status.ai === "live" ? "AI" : "The rules reader"} pulls out the payout, required phrases, call to action, banned claims and footage links.
            </p>
          </div>
        </div>
        <Panel>
          {mode === "link" ? (
            <div className="col">
              <label className="field">
                Brief link
                <div className="row">
                  <Link2 size={16} className="faint" />
                  <input className="input" placeholder="https://docs.google.com/document/d/…" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ready && !busy && submit()} autoFocus />
                </div>
              </label>
              <p className="small muted" style={{ margin: 0 }}>
                Google Docs need sharing set to “Anyone with the link can view”. Footage in public Google Drive folders is listed automatically.
              </p>
            </div>
          ) : (
            <label className="field">
              Brief text
              <textarea className="textarea" style={{ minHeight: 320 }} placeholder="Paste the whole brief: requirements, payout, hooks, footage links…" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
            </label>
          )}
          <div className="row mt">
            <button className="btn primary" disabled={!ready || busy} onClick={submit}>
              <Sparkles size={15} /> {busy ? "Reading the brief…" : "Read brief & create campaign"}
            </button>
            <span className="small muted">
              <FileText size={13} style={{ verticalAlign: -2 }} /> You can edit everything it extracts afterwards.
            </span>
          </div>
        </Panel>
      </div>
    </>
  );
}
