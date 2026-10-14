import { useEffect, useState } from "react";
import { ExternalLink, Film, Image as ImageIcon, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { engagementRate, fmtNum, fmtPct, fmtUSD, postEarnings } from "../../shared/rules";
import type { CampaignBrief, Platform, Post, PostStatus } from "../../shared/types";
import { PLATFORM_LABEL, PLATFORMS, POST_STATUSES } from "../../shared/types";
import { api, type CampaignWithStats } from "../api";
import { Tabs } from "../App";
import { ClipCard } from "../components/ClipCard";
import { PostForm } from "../components/PostForm";
import { ago, Empty, ListEdit, Panel, PostBadge, Stat } from "../components/ui";
import { go, useApp } from "../store";

export function CampaignView({ id, tab }: { id: string; tab: string }) {
  const { state } = useApp();
  const c = state?.campaigns.find((x) => x.id === id);
  if (!state) return <div className="content muted">Loading…</div>;
  if (!c)
    return (
      <div className="content">
        <Empty>That campaign doesn't exist any more.</Empty>
      </div>
    );
  const clips = state.clips.filter((x) => x.campaignId === id);
  const posts = state.posts.filter((x) => x.campaignId === id);
  return (
    <>
      <Tabs
        tabs={[
          { id: "brief", label: "Brief & rules" },
          { id: "clips", label: "Clips", n: clips.length },
          { id: "posts", label: "Posts & earnings", n: posts.length },
          { id: "footage", label: "Footage", n: c.footage.filter((f) => f.kind !== "folder").length },
        ]}
        active={tab}
        onPick={(t) => go(`/c/${id}/${t}`)}
      />
      <div className="content">
        {tab === "clips" ? <ClipsTab c={c} /> : tab === "posts" ? <PostsTab c={c} posts={posts} /> : tab === "footage" ? <FootageTab c={c} /> : <BriefTab c={c} />}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function BriefTab({ c }: { c: CampaignWithStats }) {
  const { run, busy } = useApp();
  const [b, setB] = useState<CampaignBrief>(c.brief);
  const [name, setName] = useState(c.name);
  useEffect(() => {
    setB(c.brief);
    setName(c.name);
  }, [c.id, c.updatedAt, c.brief, c.name]);
  const dirty = JSON.stringify(b) !== JSON.stringify(c.brief) || name !== c.name;
  const set = <K extends keyof CampaignBrief>(k: K, v: CampaignBrief[K]) => setB({ ...b, [k]: v });
  const num = (v: string) => (v === "" ? undefined : Number(v));

  return (
    <>
      <div className="page-head">
        <div className="grow">
          <input className="input" style={{ fontSize: 20, fontWeight: 700, border: 0, padding: 0, background: "none" }} value={name} onChange={(e) => setName(e.target.value)} aria-label="Campaign name" />
          <p className="small muted" style={{ margin: "4px 0 0" }}>
            Read by {c.extractedBy === "ai" ? c.extractionModel : "the rules reader"} {ago(c.createdAt)}
            {c.source.url && (
              <>
                {" "}
                from{" "}
                <a href={c.source.url} target="_blank" rel="noreferrer">
                  the brief <ExternalLink size={11} />
                </a>
              </>
            )}
            . Check it — clips are written and checked against exactly what's here.
          </p>
        </div>
        <div className="row wrap">
          <select className="select" style={{ width: "auto" }} value={c.status} onChange={(e) => run(() => api.updateCampaign(c.id, { status: e.target.value as "active" }), "Status updated")}>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="ended">Ended</option>
          </select>
          <button className="btn" disabled={busy} onClick={() => confirm("Re-read the brief? Your edits to the rules will be replaced.") && run(() => api.reextract(c.id), "Brief re-read")}>
            <RefreshCw size={14} /> Re-read brief
          </button>
          <button className="btn primary" disabled={!dirty || busy} onClick={() => run(() => api.updateCampaign(c.id, { name, brief: b }), "Saved — clip plans re-checked")}>
            Save changes
          </button>
        </div>
      </div>

      <Panel title="Payout">
        <div className="form-grid">
          <label className="field">
            CPM (USD per 1,000 views)
            <input className="input" type="number" step="0.01" min={0} value={b.payout.cpm ?? ""} onChange={(e) => set("payout", { ...b.payout, cpm: num(e.target.value) })} />
          </label>
          <label className="field">
            Max payout per post
            <input className="input" type="number" min={0} value={b.payout.maxPerSubmission ?? ""} onChange={(e) => set("payout", { ...b.payout, maxPerSubmission: num(e.target.value) })} />
          </label>
          <label className="field">
            Campaign budget
            <input className="input" type="number" min={0} value={b.payout.budget ?? ""} onChange={(e) => set("payout", { ...b.payout, budget: num(e.target.value) })} />
          </label>
          <label className="field">
            Min views to pay
            <input className="input" type="number" min={0} value={b.payout.minViews ?? ""} onChange={(e) => set("payout", { ...b.payout, minViews: num(e.target.value) })} />
          </label>
          <label className="field">
            Min engagement %
            <input className="input" type="number" step="0.1" min={0} value={b.minEngagementRate !== undefined ? +(b.minEngagementRate * 100).toFixed(2) : ""} onChange={(e) => set("minEngagementRate", e.target.value === "" ? undefined : Number(e.target.value) / 100)} />
          </label>
        </div>
      </Panel>

      <Panel title="What every clip must do">
        <div className="form-grid">
          <label className="field">
            Product
            <input className="input" value={b.product} onChange={(e) => set("product", e.target.value)} />
          </label>
          <label className="field">
            Product link
            <input className="input" value={b.productUrl ?? ""} onChange={(e) => set("productUrl", e.target.value)} />
          </label>
          <label className="field">
            Length (s)
            <span className="row">
              <input className="input" type="number" min={1} value={b.lengthSec.min} onChange={(e) => set("lengthSec", { ...b.lengthSec, min: Number(e.target.value) })} />–
              <input className="input" type="number" min={1} value={b.lengthSec.max} onChange={(e) => set("lengthSec", { ...b.lengthSec, max: Number(e.target.value) })} />
            </span>
          </label>
        </div>
        <label className="field mt">
          Call to action
          <span className="row">
            <input className="input grow" value={b.cta.text} onChange={(e) => set("cta", { ...b.cta, text: e.target.value })} />
            <select className="select" style={{ width: "auto" }} value={b.cta.placement} onChange={(e) => set("cta", { ...b.cta, placement: e.target.value as "end" })}>
              <option value="end">at the end</option>
              <option value="anywhere">anywhere</option>
            </select>
          </span>
        </label>
        <div className="mt">
          <div className="field">Platforms</div>
          <div className="chips" style={{ marginTop: 4 }}>
            {PLATFORMS.filter((p) => p !== "other").map((p) => (
              <button key={p} className={`chip ${b.platforms.includes(p) ? "on" : ""}`} onClick={() => set("platforms", b.platforms.includes(p) ? b.platforms.filter((x) => x !== p) : [...b.platforms, p])}>
                {PLATFORM_LABEL[p]}
              </button>
            ))}
          </div>
        </div>
        <div className="grid mt" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
          <div className="field">
            Must be spoken
            <ListEdit value={b.requiredPhrases} onChange={(v) => set("requiredPhrases", v)} placeholder="e.g. the product name" />
          </div>
          <div className="field">
            Banned claims
            <ListEdit value={b.bannedClaims} onChange={(v) => set("bannedClaims", v)} />
          </div>
          <div className="field">
            Account requirements
            <ListEdit value={b.accountRequirements} onChange={(v) => set("accountRequirements", v)} />
          </div>
        </div>
      </Panel>

      <Panel title="Creative direction">
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
          <div className="field">
            Hook examples
            <ListEdit value={b.hookExamples} onChange={(v) => set("hookExamples", v)} />
          </div>
          <div className="field">
            Facts clips may state
            <ListEdit value={b.keyFacts} onChange={(v) => set("keyFacts", v)} />
          </div>
          <div className="field">
            Do
            <ListEdit value={b.dos} onChange={(v) => set("dos", v)} />
          </div>
          <div className="field">
            Don't
            <ListEdit value={b.donts} onChange={(v) => set("donts", v)} />
          </div>
          <div className="field">
            Other ideas
            <ListEdit value={b.contentIdeas} onChange={(v) => set("contentIdeas", v)} />
          </div>
        </div>
      </Panel>

      <Panel title="Links">
        <div className="col">
          {[...b.footage.map((l) => ({ ...l, kind: "Footage" })), ...b.otherLinks.map((l) => ({ ...l, kind: "Link" }))].map((l, i) => (
            <div key={i} className="row small">
              <span className="badge">{l.kind}</span>
              <span className="ellipsis grow">
                {l.label} —{" "}
                <a href={l.url} target="_blank" rel="noreferrer">
                  {l.url}
                </a>
              </span>
            </div>
          ))}
          {!b.footage.length && !b.otherLinks.length && <span className="small muted">No links found in the brief.</span>}
        </div>
      </Panel>

      <Panel title="Notes & original brief">
        <textarea className="textarea" placeholder="Your notes (where you submit, contact, anything else)" defaultValue={c.notes} onBlur={(e) => e.target.value !== c.notes && run(() => api.updateCampaign(c.id, { notes: e.target.value }), "Notes saved")} />
        <details className="mt">
          <summary className="small muted" style={{ cursor: "pointer" }}>
            Original brief text
          </summary>
          <pre className="small" style={{ whiteSpace: "pre-wrap", maxHeight: 400, overflow: "auto" }}>
            {c.source.text}
          </pre>
        </details>
        <div className="row mt">
          <button className="btn sm danger" onClick={() => confirm(`Delete "${c.name}" with all its clips and posts?`) && run(() => api.deleteCampaign(c.id), "Campaign deleted").then((r) => r && go("/"))}>
            <Trash2 size={14} /> Delete campaign
          </button>
        </div>
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------------------

function ClipsTab({ c }: { c: CampaignWithStats }) {
  const { state, run, busy } = useApp();
  const [n, setN] = useState(3);
  const [filter, setFilter] = useState("open");
  const all = state!.clips.filter((x) => x.campaignId === c.id);
  const clips = all.filter((x) => (filter === "open" ? !["posted", "rejected"].includes(x.status) : filter === "all" ? true : x.status === filter));
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Clip plans</h1>
          <p className="muted" style={{ margin: 0 }}>
            Hooks, voiceovers and shot lists cut from this campaign's footage. Each is checked against the rules before you see it.
          </p>
        </div>
        <div className="row">
          <select className="select" style={{ width: "auto" }} value={n} onChange={(e) => setN(Number(e.target.value))}>
            {[1, 3, 5, 10].map((x) => (
              <option key={x} value={x}>
                {x} clip{x > 1 ? "s" : ""}
              </option>
            ))}
          </select>
          <button className="btn primary" disabled={busy} onClick={() => run(() => api.planClips(c.id, n), `${n} clip plan(s) written`)}>
            <Sparkles size={15} /> {busy ? "Writing…" : "Write clip plans"}
          </button>
        </div>
      </div>
      {!c.footage.some((f) => f.kind === "video") && <p className="small badge warn">No video footage found yet — plans won't be able to point at exact files.</p>}
      <div className="chips" style={{ marginBottom: 12 }}>
        {[
          ["open", "Open"],
          ["draft", "To review"],
          ["approved", "Approved"],
          ["posted", "Posted"],
          ["rejected", "Rejected"],
          ["all", "All"],
        ].map(([id, label]) => (
          <button key={id} className={`chip ${filter === id ? "on" : ""}`} onClick={() => setFilter(id)}>
            {label}
          </button>
        ))}
      </div>
      {clips.length ? clips.map((x) => <ClipCard key={x.id} clip={x} campaign={c} />) : <Empty>{all.length ? "Nothing in this filter." : "No clip plans yet. Write a few to get started."}</Empty>}
    </>
  );
}

// ---------------------------------------------------------------------------

function PostsTab({ c, posts }: { c: CampaignWithStats; posts: Post[] }) {
  const [adding, setAdding] = useState(false);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Posts & earnings</h1>
          <p className="muted" style={{ margin: 0 }}>
            Earnings use the campaign's terms: {c.brief.payout.cpm ? `${fmtUSD(c.brief.payout.cpm)} per 1,000 views` : "no CPM set"}
            {c.brief.payout.maxPerSubmission ? `, capped at ${fmtUSD(c.brief.payout.maxPerSubmission)} per post` : ""}
            {c.brief.payout.minViews ? `, from ${fmtNum(c.brief.payout.minViews)} views` : ""}.
          </p>
        </div>
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Plus size={15} /> Log a post
        </button>
      </div>
      <div className="grid stats">
        <Stat label="Posts" value={c.stats.posts} />
        <Stat label="Views" value={fmtNum(c.stats.views)} />
        <Stat label="Engagement" value={fmtPct(c.stats.engagementRate)} hint={c.brief.minEngagementRate ? `minimum ${fmtPct(c.brief.minEngagementRate)}` : undefined} />
        <Stat label="Estimated" value={fmtUSD(c.stats.estimatedEarnings)} />
        <Stat label="Paid" value={fmtUSD(c.stats.paid)} />
      </div>
      <div className="mt">{posts.length ? <PostTable posts={posts} /> : <Empty>No posts logged yet. Log each clip you publish to track its views and earnings.</Empty>}</div>
      {adding && <PostForm campaign={c} onClose={() => setAdding(false)} />}
    </>
  );
}

export function PostTable({ posts, showCampaign }: { posts: Post[]; showCampaign?: boolean }) {
  const { state, run } = useApp();
  const camp = (id: string) => state!.campaigns.find((c) => c.id === id)!;
  const upd = (p: Post, body: Parameters<typeof api.updatePost>[1]) => run(() => api.updatePost(p.id, body));
  const metric = (p: Post, k: keyof Post["metrics"]) => (
    <input
      className="input num"
      type="number"
      min={0}
      defaultValue={p.metrics[k]}
      key={`${p.id}-${k}-${p.metrics[k]}`}
      onBlur={(e) => Number(e.target.value) !== p.metrics[k] && upd(p, { metrics: { [k]: Number(e.target.value) } })}
      aria-label={k}
    />
  );
  return (
    <div className="panel table-wrap" style={{ padding: 0 }}>
      <table className="table">
        <thead>
          <tr>
            {showCampaign && <th>Campaign</th>}
            <th>Post</th>
            <th>Status</th>
            <th className="num">Views</th>
            <th className="num">Likes</th>
            <th className="num">Comments</th>
            <th className="num">Shares</th>
            <th className="num">Eng.</th>
            <th className="num">Earned</th>
            <th>Updated</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {posts.map((p) => {
            const c = camp(p.campaignId);
            const er = engagementRate(p.metrics);
            const low = c.brief.minEngagementRate && p.metrics.views > 0 && er < c.brief.minEngagementRate;
            return (
              <tr key={p.id}>
                {showCampaign && (
                  <td>
                    <a href={`#/c/${c.id}/posts`}>{c.name}</a>
                  </td>
                )}
                <td>
                  <div style={{ fontWeight: 600 }}>
                    {PLATFORM_LABEL[p.platform]} {p.account && <span className="muted">@{p.account.replace(/^@/, "")}</span>}
                  </div>
                  <div className="small faint">
                    {new Date(p.postedAt).toLocaleDateString()}{" "}
                    {p.url && (
                      <a href={p.url} target="_blank" rel="noreferrer">
                        open <ExternalLink size={10} />
                      </a>
                    )}
                  </div>
                </td>
                <td>
                  <select className="select" style={{ width: "auto", padding: "3px 6px" }} value={p.status} onChange={(e) => upd(p, { status: e.target.value as PostStatus })}>
                    {POST_STATUSES.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </td>
                <td className="num">{metric(p, "views")}</td>
                <td className="num">{metric(p, "likes")}</td>
                <td className="num">{metric(p, "comments")}</td>
                <td className="num">{metric(p, "shares")}</td>
                <td className={`num ${low ? "neg" : ""}`} title={low ? "Below the campaign's minimum engagement" : undefined}>
                  {p.metrics.views ? fmtPct(er) : "—"}
                </td>
                <td className="num">
                  <strong>{fmtUSD(postEarnings(p, c.brief.payout))}</strong>
                  {p.status === "paid" && typeof p.paidAmount !== "number" && (
                    <div>
                      <button className="btn sm ghost" onClick={() => {
                        const v = prompt("Amount actually paid (USD)", String(postEarnings(p, c.brief.payout)));
                        if (v !== null && v !== "") void upd(p, { paidAmount: Number(v) });
                      }}>
                        set paid $
                      </button>
                    </div>
                  )}
                </td>
                <td className="small faint">{ago(p.metricsUpdatedAt)}</td>
                <td>
                  <button className="btn sm ghost danger" title="Delete post" onClick={() => confirm("Delete this post?") && run(() => api.deletePost(p.id), "Deleted")}>
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------

function FootageTab({ c }: { c: CampaignWithStats }) {
  const { run, busy } = useApp();
  const files = c.footage.filter((f) => f.kind !== "folder");
  const folders = [...new Set(files.map((f) => f.folderLabel))];
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Footage</h1>
          <p className="muted" style={{ margin: 0 }}>
            Listed from the brief's footage links {c.footageCheckedAt ? ago(c.footageCheckedAt) : ""}. Backup copies of the same file are skipped.
          </p>
        </div>
        <button className="btn" disabled={busy || !c.brief.footage.length} onClick={() => run(() => api.refreshFootage(c.id), "Footage refreshed")}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      {c.footageError && <p className="badge bad">{c.footageError}</p>}
      {!files.length && <Empty>{c.brief.footage.length ? "No files found in the footage links." : "The brief has no footage links. Add one on the Brief tab."}</Empty>}
      {folders.map((folder) => (
        <div key={folder} className="mt">
          <h3>{folder}</h3>
          <div className="grid cards">
            {files
              .filter((f) => f.folderLabel === folder)
              .map((f) => (
                <a key={f.id} className="card footage-card" href={f.viewUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "none", color: "inherit" }}>
                  <div className="img" style={f.thumbUrl ? { backgroundImage: `url("${f.thumbUrl}")` } : undefined}>
                    {!f.thumbUrl && (f.kind === "image" ? <ImageIcon size={24} /> : <Film size={24} />)}
                  </div>
                  <div className="body">
                    <div className="ellipsis" style={{ fontWeight: 600 }}>
                      {f.name}
                    </div>
                    <div className="small muted">{f.kind}</div>
                  </div>
                </a>
              ))}
          </div>
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function CampaignRight({ id }: { id: string }) {
  const { state } = useApp();
  const c = state?.campaigns.find((x) => x.id === id);
  if (!c) return null;
  const b = c.brief;
  const img = c.footage.find((f) => f.kind === "image" && f.thumbUrl) ?? c.footage.find((f) => f.thumbUrl);
  const perPostCapViews = b.payout.cpm && b.payout.maxPerSubmission ? Math.round((b.payout.maxPerSubmission / b.payout.cpm) * 1000) : undefined;
  return (
    <>
      <div>
        <h3>Payout</h3>
        <dl className="kv">
          <dt>CPM</dt>
          <dd>{b.payout.cpm ? fmtUSD(b.payout.cpm) : "—"}</dd>
          <dt>Max per post</dt>
          <dd>{b.payout.maxPerSubmission ? fmtUSD(b.payout.maxPerSubmission) : "—"}</dd>
          <dt>Budget</dt>
          <dd>{b.payout.budget ? fmtUSD(b.payout.budget) : "—"}</dd>
          <dt>Your estimate</dt>
          <dd className="pos">{fmtUSD(c.stats.estimatedEarnings)}</dd>
        </dl>
        {perPostCapViews && <p className="small muted">A post maxes out at {fmtNum(perPostCapViews)} views.</p>}
      </div>
      <div>
        <h3>Every clip must</h3>
        <ul className="small" style={{ paddingLeft: 16, margin: 0 }}>
          {b.requiredPhrases.map((p) => (
            <li key={p}>
              Say <strong>“{p}”</strong> out loud
            </li>
          ))}
          {b.cta.text && (
            <li>
              End with: <strong>{b.cta.text}</strong>
            </li>
          )}
          <li>
            Run {b.lengthSec.min}–{b.lengthSec.max}s
          </li>
          {b.minEngagementRate !== undefined && <li>Keep engagement above {fmtPct(b.minEngagementRate)}</li>}
          {b.bannedClaims.slice(0, 4).map((x) => (
            <li key={x} className="neg">
              {x}
            </li>
          ))}
        </ul>
      </div>
      {b.accountRequirements.length > 0 && (
        <div>
          <h3>Who may post</h3>
          <ul className="small" style={{ paddingLeft: 16, margin: 0 }}>
            {b.accountRequirements.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      )}
      {img && (
        <div>
          <h3>Footage</h3>
          <a href={`#/c/${c.id}/footage`}>
            <div style={{ aspectRatio: "16/9", borderRadius: 8, background: `var(--sunk) url("${img.thumbUrl}") center / cover`, border: "1px solid var(--line)" }} />
          </a>
          <p className="small muted">
            {plural(c.footage.filter((f) => f.kind === "video").length, "video")} · {plural(c.footage.filter((f) => f.kind === "image").length, "image")}
          </p>
        </div>
      )}
      <div>
        <h3>Pipeline</h3>
        <dl className="kv">
          <dt>To review</dt>
          <dd>{c.stats.clipsByStatus.draft}</dd>
          <dt>Approved</dt>
          <dd>{c.stats.clipsByStatus.approved}</dd>
          <dt>Posted</dt>
          <dd>{c.stats.clipsByStatus.posted}</dd>
        </dl>
      </div>
      <div>
        <h3>Platforms</h3>
        <div className="chips">
          {(b.platforms.length ? b.platforms : (["other"] as Platform[])).map((p) => (
            <span key={p} className="badge">
              {PLATFORM_LABEL[p]}
            </span>
          ))}
        </div>
      </div>
      {state!.posts.some((p) => p.campaignId === c.id) && (
        <div>
          <h3>Latest posts</h3>
          {state!.posts
            .filter((p) => p.campaignId === c.id)
            .slice(0, 4)
            .map((p) => (
              <div key={p.id} className="row between small" style={{ marginBottom: 6 }}>
                <span className="ellipsis">
                  {PLATFORM_LABEL[p.platform]} · {fmtNum(p.metrics.views)} views
                </span>
                <PostBadge status={p.status} />
              </div>
            ))}
        </div>
      )}
    </>
  );
}
