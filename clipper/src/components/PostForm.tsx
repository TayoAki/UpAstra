import { useState } from "react";
import type { Campaign, Clip, Platform, PostStatus } from "../../shared/types";
import { PLATFORM_LABEL, PLATFORMS, POST_STATUSES } from "../../shared/types";
import { api } from "../api";
import { useApp } from "../store";
import { Modal } from "./ui";

export function PostForm({ campaign, clip, onClose }: { campaign: Campaign; clip?: Clip; onClose: () => void }) {
  const { run, busy, state } = useApp();
  const firstPlatform = campaign.brief.platforms[0] ?? "tiktok";
  const [f, setF] = useState({
    platform: firstPlatform as Platform,
    account: state?.accounts.find((a) => a.platform === firstPlatform)?.handle ?? "",
    url: "",
    postedAt: new Date().toISOString().slice(0, 10),
    status: "live" as PostStatus,
    views: "",
    likes: "",
    comments: "",
    shares: "",
  });
  const accounts = state?.accounts.filter((a) => a.platform === f.platform) ?? [];
  const submit = () =>
    run(
      () =>
        api.addPost({
          campaignId: campaign.id,
          clipId: clip?.id,
          platform: f.platform,
          account: f.account,
          url: f.url,
          postedAt: f.postedAt,
          status: f.status,
          metrics: { views: Number(f.views) || 0, likes: Number(f.likes) || 0, comments: Number(f.comments) || 0, shares: Number(f.shares) || 0 },
        }),
      "Post logged",
    ).then((r) => r && onClose());

  return (
    <Modal title={clip ? `Log a post: ${clip.title}` : `Log a post — ${campaign.name}`} onClose={onClose}>
      <div className="form-grid">
        <label className="field">
          Platform
          <select className="select" value={f.platform} onChange={(e) => setF({ ...f, platform: e.target.value as Platform })}>
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {PLATFORM_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Account
          <input className="input" list="acct-list" placeholder="@handle" value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })} />
          <datalist id="acct-list">
            {accounts.map((a) => (
              <option key={a.id} value={a.handle} />
            ))}
          </datalist>
        </label>
        <label className="field">
          Posted on
          <input className="input" type="date" value={f.postedAt} onChange={(e) => setF({ ...f, postedAt: e.target.value })} />
        </label>
        <label className="field">
          Status
          <select className="select" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as PostStatus })}>
            {POST_STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="field mt">
        Post link
        <input className="input" placeholder="https://www.tiktok.com/@you/video/…" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />
      </label>
      <div className="form-grid mt">
        {(["views", "likes", "comments", "shares"] as const).map((k) => (
          <label key={k} className="field">
            {k[0].toUpperCase() + k.slice(1)}
            <input className="input" type="number" min={0} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
          </label>
        ))}
      </div>
      {campaign.brief.accountRequirements.length > 0 && <p className="small warn-text muted">Reminder: {campaign.brief.accountRequirements.join(" ")}</p>}
      <div className="row mt">
        <button className="btn primary" disabled={busy || (!!f.url && !/^https?:\/\//.test(f.url))} onClick={submit}>
          Log post
        </button>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
