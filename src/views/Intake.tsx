import { useEffect, useState } from "react";
import { fmtPct, fmtUSD } from "../../shared/economics";
import type { Channel, ClientMemory } from "../../shared/types";
import { api } from "../api";
import { Frame, SideHeader, SideItem, Tabs } from "../components/ui";
import { go, useAction, useApp } from "../store";

const EXAMPLES: { title: string; channel: Channel; price: number; brief: string; assets?: string }[] = [
  {
    title: "Upwork · Amazon listing set",
    channel: "upwork",
    price: 120,
    brief:
      'Need 4 lifestyle images for my Amazon listing, 1:1 png. Product is a stainless steel water bottle — product photos attached. Text on the main image: "Cold for 24 hours". Within 3 days.',
    assets: "bottle-front.jpg, bottle-side.jpg",
  },
  {
    title: "Fiverr · TikTok product video",
    channel: "fiverr",
    price: 85,
    brief: "Looking for a 7 second 9:16 mp4 of our matcha tin on a cafe counter, slow orbit, morning light. Photo attached. Need by Friday.",
    assets: "matcha-tin.png",
  },
  {
    title: "Direct · Real estate open house poster",
    channel: "direct",
    price: 60,
    brief: 'Poster for our open house, 4:5, with the headline "Open House — Sat 11–2" and the address. Something modern. ASAP.',
  },
  {
    title: "Upwork · Vague brief",
    channel: "upwork",
    price: 40,
    brief: "need some cool images for our brand, you decide, unlimited revisions",
  },
];

export function IntakeView() {
  const { boot } = useApp();
  const { busy, run } = useAction();
  const [mode, setMode] = useState<"paste" | "url">("paste");
  const [clients, setClients] = useState<ClientMemory[]>([]);
  const [f, setF] = useState({
    title: "",
    channel: "upwork" as Channel,
    sourceUrl: "",
    rawBrief: "",
    referenceAssets: "",
    clientNotes: "",
    clientId: "",
    newClientName: "",
    price: "100",
    productionBudget: "",
  });
  useEffect(() => {
    api.clients().then(setClients);
  }, []);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const fee = boot?.policy.channelFees[f.channel] ?? 0;

  const submit = () =>
    run(
      () =>
        api.createJob({
          ...f,
          sourceUrl: f.sourceUrl || undefined,
          price: Number(f.price),
          productionBudget: f.productionBudget ? Number(f.productionBudget) : undefined,
          referenceAssets: f.referenceAssets.split(",").map((s) => s.trim()).filter(Boolean),
          clientId: f.clientId || undefined,
        }),
      "Brief analysed by Astra",
    ).then((d) => d && go(`/job/${d.job.id}`));

  return (
    <Frame
      sidebar={
        <>
          <SideHeader>Example briefs</SideHeader>
          <div className="side-list">
            {EXAMPLES.map((x) => (
              <SideItem
                key={x.title}
                title={x.title}
                sub={`${fmtUSD(x.price)} · ${x.brief.slice(0, 40)}…`}
                onClick={() => setF({ ...f, channel: x.channel, price: String(x.price), rawBrief: x.brief, referenceAssets: x.assets ?? "", title: "" })}
              />
            ))}
          </div>
        </>
      }
      tabs={
        <Tabs
          value={mode}
          onChange={setMode}
          options={[
            { id: "paste", label: "Paste brief" },
            { id: "url", label: "Import listing URL" },
          ]}
        />
      }
      right={
        <>
          <h4 className="right-title">What happens next</h4>
          <ol className="small steps-list">
            <li>Astra extracts deliverables, formats, exact copy, deadline, supplied & missing inputs, risks.</li>
            <li>It drafts the smallest useful set of client questions.</li>
            <li>The router proposes a model per step; code prices it against your margin floor.</li>
            <li>It recommends accept, review or reject — you decide.</li>
          </ol>
          <h4 className="right-title">Channel</h4>
          <div className="right-box small">
            <div className="row between">
              <span>{f.channel} fee</span>
              <span className="num">{fmtPct(fee)}</span>
            </div>
            <div className="row between">
              <span>Net after fee</span>
              <span className="num">{fmtUSD(Number(f.price || 0) * (1 - fee))}</span>
            </div>
            <div className="row between muted">
              <span>Margin floor</span>
              <span className="num">{fmtPct(boot?.policy.minGrossMargin ?? 0)}</span>
            </div>
          </div>
        </>
      }
    >
      <header className="page-head">
        <div>
          <h1>New job</h1>
          <p className="muted">Bring validated demand in from Upwork, Fiverr, Contra or a direct lead.</p>
        </div>
      </header>
      <div className="form">
        <div className="grid2">
          <label className="field">
            <span>Channel</span>
            <select className="input" value={f.channel} onChange={set("channel")}>
              <option value="upwork">Upwork</option>
              <option value="fiverr">Fiverr</option>
              <option value="contra">Contra</option>
              <option value="direct">Direct lead</option>
            </select>
          </label>
          <label className="field">
            <span>Job title (optional)</span>
            <input className="input" value={f.title} onChange={set("title")} placeholder="Defaults to the first line of the brief" />
          </label>
        </div>
        {mode === "url" && (
          <label className="field">
            <span>Listing URL</span>
            <input className="input" value={f.sourceUrl} onChange={set("sourceUrl")} placeholder="https://www.upwork.com/jobs/…" />
            <small className="muted">The server tries to read the listing. Marketplaces that require login can't be read — paste the brief text below instead; the URL is kept as the source.</small>
          </label>
        )}
        <label className="field">
          <span>Client brief {mode === "url" && "(optional if the URL is readable)"}</span>
          <textarea className="input" rows={7} value={f.rawBrief} onChange={set("rawBrief")} placeholder="Paste the messy brief exactly as the client wrote it…" />
        </label>
        <div className="grid2">
          <label className="field">
            <span>Reference assets</span>
            <input className="input" value={f.referenceAssets} onChange={set("referenceAssets")} placeholder="Comma-separated file names or https URLs" />
          </label>
          <label className="field">
            <span>Client notes</span>
            <input className="input" value={f.clientNotes} onChange={set("clientNotes")} placeholder="Anything said outside the brief" />
          </label>
        </div>
        <div className="grid2">
          <label className="field">
            <span>Client</span>
            <select className="input" value={f.clientId} onChange={set("clientId")}>
              <option value="">+ New client</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          {!f.clientId && (
            <label className="field">
              <span>New client name</span>
              <input className="input" value={f.newClientName} onChange={set("newClientName")} placeholder="Brand or buyer name" />
            </label>
          )}
        </div>
        <div className="grid2">
          <label className="field">
            <span>Client price (USD)</span>
            <input className="input" type="number" min={0} step="0.01" value={f.price} onChange={set("price")} />
          </label>
          <label className="field">
            <span>Production budget cap (optional)</span>
            <input className="input" type="number" min={0} step="0.01" value={f.productionBudget} onChange={set("productionBudget")} placeholder={`Policy default ${fmtUSD(boot?.policy.maxSpendPerJob ?? 0)}`} />
          </label>
        </div>
        <div className="next-action">
          <span className="next-avatar">A</span>
          <div className="grow">
            <strong>Create the client brief</strong>
            <p className="muted small">Astra reads it, plans the work and prices it before anything is spent.</p>
          </div>
          <button className="btn primary" disabled={busy || (!f.rawBrief.trim() && !f.sourceUrl.trim())} onClick={submit}>
            {busy ? "Analysing…" : "Analyse brief"}
          </button>
        </div>
      </div>
    </Frame>
  );
}
