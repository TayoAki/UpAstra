import { useEffect, useState } from "react";
import { fmtUSD } from "../../shared/economics";
import type { PortalAddOn, PortalConfig, PortalPackage, PortalQuestion } from "../../shared/types";
import { api, type PortalInfo } from "../api";
import { Empty, Frame, ListEditor, Panel, SideHeader, SideItem, Tabs, timeAgo } from "../components/ui";
import { go, useAction, useApp } from "../store";

type Tab = "setup" | "packages" | "clients" | "share";

export function PortalView({ tab: initialTab, pkgId }: { tab?: string; pkgId?: string }) {
  const { toast } = useApp();
  const { busy, run } = useAction();
  const [info, setInfo] = useState<PortalInfo | null>(null);
  const [cfg, setCfg] = useState<PortalConfig | null>(null);
  const [newTemplate, setNewTemplate] = useState("");
  const [originsText, setOriginsText] = useState("");
  const tab = (["setup", "packages", "clients", "share"].includes(initialTab ?? "") ? initialTab : "setup") as Tab;

  const adopt = (i: PortalInfo) => {
    setInfo(i);
    setCfg(structuredClone(i.config));
    setOriginsText(i.config.embedOrigins.join("\n"));
  };
  useEffect(() => {
    api.portal().then(adopt);
  }, []);
  if (!info || !cfg) return <Frame><Empty>Loading…</Empty></Frame>;

  const dirty = JSON.stringify(cfg) !== JSON.stringify(info.config) || originsText !== info.config.embedOrigins.join("\n");
  const save = (patch: Partial<PortalConfig> = {}) =>
    run(() => api.savePortal({ ...cfg, embedOrigins: originsText.split(/\s+/).filter(Boolean), ...patch }), "Portal saved").then((i) => i && adopt(i));
  const copy = (t: string) =>
    navigator.clipboard.writeText(t).then(
      () => toast("Copied"),
      () => toast("Clipboard unavailable", "err"),
    );
  const selected = cfg.packages.find((p) => p.id === pkgId) ?? cfg.packages[0];
  const setPkg = (p: PortalPackage) => setCfg({ ...cfg, packages: cfg.packages.map((x) => (x.id === p.id ? p : x)) });

  return (
    <Frame
      sidebar={
        tab === "packages" ? (
          <>
            <SideHeader>Packages</SideHeader>
            <div className="side-list">
              {cfg.packages.map((p) => (
                <SideItem
                  key={p.id}
                  active={p.id === selected?.id}
                  title={p.name}
                  sub={`${fmtUSD(p.price)} · ${p.active ? "on sale" : "hidden"}`}
                  dot={p.active ? "var(--c-ok)" : "var(--line)"}
                  onClick={() => go(`/portal/packages/${p.id}`)}
                />
              ))}
            </div>
            <div className="pad form">
              <select className="input" value={newTemplate} onChange={(e) => setNewTemplate(e.target.value)} aria-label="Service for new package">
                <option value="">New package from…</option>
                {info.templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <button
                className="btn sm wide"
                disabled={!newTemplate || busy}
                onClick={() =>
                  run(() => api.defaultPackage(newTemplate)).then((p) => {
                    if (!p) return;
                    setCfg({ ...cfg, packages: [...cfg.packages, { ...p, name: `${p.name} (copy)` }] });
                    setNewTemplate("");
                    go(`/portal/packages/${p.id}`);
                  })
                }
              >
                + Add package
              </button>
            </div>
          </>
        ) : (
          <>
            <SideHeader>Client portal</SideHeader>
            <div className="side-list">
              <SideItem title={cfg.enabled ? "Open to clients" : "Closed"} sub={info.urls.path.replace(/^https?:\/\//, "")} dot={cfg.enabled ? "var(--c-ok)" : "var(--c-muted)"} onClick={() => go("/portal")} />
              <SideItem title="Packages" sub={`${cfg.packages.filter((p) => p.active).length} on sale`} onClick={() => go("/portal/packages")} />
              <SideItem title="Clients" sub={`${info.clients.length} accounts`} onClick={() => go("/portal/clients")} />
              <SideItem title="Share, embed & domains" sub="Links, widget, custom domain" onClick={() => go("/portal/share")} />
            </div>
          </>
        )
      }
      tabs={
        <Tabs
          value={tab}
          onChange={(t) => go(`/portal/${t === "setup" ? "" : t}`)}
          options={[
            { id: "setup", label: "Setup" },
            { id: "packages", label: "Packages", count: cfg.packages.filter((p) => p.active).length },
            { id: "clients", label: "Clients", count: info.clients.length },
            { id: "share", label: "Share & embed" },
          ]}
        />
      }
      right={
        <>
          <h4 className="right-title">Your portal</h4>
          <div className="right-box small">
            <div className="row between">
              <span>Status</span>
              <span className={cfg.enabled ? "pos" : "muted"}>{info.config.enabled ? "Open" : "Closed"}</span>
            </div>
            <div className="row between">
              <span>Requests</span>
              <span>{info.config.autoAccept ? "Auto-accepted when Astra agrees" : "You accept each one"}</span>
            </div>
          </div>
          <a className="btn wide top-gap" href={info.urls.path} target="_blank" rel="noreferrer">
            Open portal ↗
          </a>
          <p className="small muted top-gap">
            Clients pick a package, answer the guided brief and upload files. Each request lands in your job list with channel "portal" and goes through intake, pricing and
            your approval gates. Clients only see work after you approve delivery.
          </p>
          {dirty && (
            <button className="btn primary wide top-gap" disabled={busy} onClick={() => save()}>
              Save changes
            </button>
          )}
        </>
      }
    >
      {tab === "setup" && (
        <>
          <header className="page-head">
            <div>
              <h1>Client portal</h1>
              <p className="muted">A branded page where your clients request work, answer your questions and approve deliveries.</p>
            </div>
            <button className={`btn ${cfg.enabled ? "" : "primary"}`} disabled={busy} onClick={() => save({ enabled: !info.config.enabled })}>
              {info.config.enabled ? "Close portal" : "Open portal"}
            </button>
          </header>
          <div className="form">
            <Panel title="Address">
              <div className="row gap wrap">
                <span className="muted small">{info.urls.path.replace(/\/p\/.*$/, "/p/")}</span>
                <input className="input" style={{ maxWidth: 260 }} value={cfg.slug} onChange={(e) => setCfg({ ...cfg, slug: e.target.value.toLowerCase() })} aria-label="Portal address" />
              </div>
            </Panel>
            <Panel title="Branding">
              <label className="field">
                <span>Headline</span>
                <input className="input" value={cfg.headline} onChange={(e) => setCfg({ ...cfg, headline: e.target.value })} />
              </label>
              <label className="field">
                <span>Intro</span>
                <textarea className="input" rows={3} value={cfg.intro} onChange={(e) => setCfg({ ...cfg, intro: e.target.value })} />
              </label>
              <div className="grid2">
                <label className="field">
                  <span>Accent color</span>
                  <div className="row gap">
                    <input type="color" value={cfg.accentColor} onChange={(e) => setCfg({ ...cfg, accentColor: e.target.value })} aria-label="Accent color" />
                    <input className="input" value={cfg.accentColor} onChange={(e) => setCfg({ ...cfg, accentColor: e.target.value })} />
                  </div>
                </label>
                <label className="field">
                  <span>Logo URL (https)</span>
                  <input className="input" placeholder="https://…/logo.png" value={cfg.logoUrl} onChange={(e) => setCfg({ ...cfg, logoUrl: e.target.value })} />
                </label>
              </div>
              <p className="small muted">The studio name comes from Settings → Firm profile.</p>
            </Panel>
            <Panel title="Requests">
              <label className="radio">
                <input type="checkbox" checked={cfg.autoAccept} onChange={(e) => setCfg({ ...cfg, autoAccept: e.target.checked })} />
                Accept portal requests automatically when Astra recommends them and the margin clears your floor (others still wait for you)
              </label>
            </Panel>
          </div>
        </>
      )}

      {tab === "packages" && selected && <PackageEditor key={selected.id} pkg={selected} onChange={setPkg} onRemove={() => setCfg({ ...cfg, packages: cfg.packages.filter((p) => p.id !== selected.id) })} />}

      {tab === "clients" && (
        <>
          <header className="page-head">
            <div>
              <h1>Portal clients</h1>
              <p className="muted">People with a client account on your portal. Each is linked to a client record, so their brand memory carries into every job.</p>
            </div>
          </header>
          {info.clients.length ? (
            <Panel>
              <table className="table">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>Company</th>
                    <th>Requests</th>
                    <th>Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {info.clients.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <strong>{c.name}</strong>
                        <div className="small muted">{c.email}</div>
                      </td>
                      <td>
                        <button className="link" onClick={() => go(`/memory/${c.clientId}`)}>
                          {c.company || "—"}
                        </button>
                      </td>
                      <td>{c.requests}</td>
                      <td className="small">{timeAgo(c.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          ) : (
            <Empty>No client accounts yet. Share your portal link to get started.</Empty>
          )}
        </>
      )}

      {tab === "share" && (
        <>
          <header className="page-head">
            <div>
              <h1>Share, embed & domains</h1>
              <p className="muted">Send clients the link, put a "Request work" button on your website, or serve the portal from your own domain.</p>
            </div>
          </header>
          <Panel title="Links">
            {[info.urls.path, info.urls.subdomain, info.urls.custom].filter(Boolean).map((u) => (
              <div key={u} className="code-box top-gap">
                <code>{u}</code>
                <button className="btn sm" onClick={() => copy(u!)}>
                  Copy
                </button>
              </div>
            ))}
          </Panel>
          <Panel title="Website widget">
            <p className="small muted">Paste before &lt;/body&gt; on your site. It adds a floating "Request work" button that opens your portal in a window.</p>
            <div className="code-box">
              <code>{info.urls.embed}</code>
              <button className="btn sm" onClick={() => copy(info.urls.embed)}>
                Copy
              </button>
            </div>
            <label className="field top-gap">
              <span>Sites allowed to embed the portal (one per line, empty = any site)</span>
              <textarea className="input mono small" rows={3} placeholder="https://www.yourstudio.com" value={originsText} onChange={(e) => setOriginsText(e.target.value)} />
            </label>
          </Panel>
          <Panel title="Custom domain">
            <div className="row gap">
              <input className="input" placeholder="work.yourstudio.com" value={cfg.customDomain} onChange={(e) => setCfg({ ...cfg, customDomain: e.target.value })} aria-label="Custom domain" />
              <button className="btn" disabled={busy || cfg.customDomain === info.config.customDomain} onClick={() => save()}>
                Connect
              </button>
            </div>
            <ol className="small steps-list top-gap">
              <li>
                At your DNS provider, add a <strong>CNAME</strong> record for <code>{cfg.customDomain || "work.yourstudio.com"}</code> pointing to <code>{info.urls.cnameTarget}</code>.
              </li>
              <li>The platform operator adds the same domain to the app's hosting (Railway → service → Settings → Networking → Custom domain) so it gets an HTTPS certificate.</li>
              <li>Once DNS has propagated, the domain serves your portal — clients never see the Studio Operator address.</li>
            </ol>
          </Panel>
        </>
      )}
    </Frame>
  );
}

function PackageEditor({ pkg, onChange, onRemove }: { pkg: PortalPackage; onChange: (p: PortalPackage) => void; onRemove: () => void }) {
  const set = (patch: Partial<PortalPackage>) => onChange({ ...pkg, ...patch });
  const setAddOn = (i: number, patch: Partial<PortalAddOn>) => set({ addOns: pkg.addOns.map((a, j) => (j === i ? { ...a, ...patch } : a)) });
  const setQ = (i: number, patch: Partial<PortalQuestion>) => set({ questions: pkg.questions.map((q, j) => (j === i ? { ...q, ...patch } : q)) });
  const move = (i: number, d: number) => {
    const qs = [...pkg.questions];
    const [x] = qs.splice(i, 1);
    qs.splice(Math.max(0, Math.min(qs.length, i + d)), 0, x);
    set({ questions: qs });
  };
  return (
    <>
      <header className="page-head">
        <div>
          <h1>{pkg.name}</h1>
          <p className="muted">Produced with the "{pkg.templateId}" service recipe. Changes save with "Save changes".</p>
        </div>
        <div className="row gap">
          <label className="radio">
            <input type="checkbox" checked={pkg.active} onChange={(e) => set({ active: e.target.checked })} />
            On sale
          </label>
          <button className="btn sm" onClick={() => confirm(`Remove "${pkg.name}" from the portal?`) && onRemove()}>
            Remove
          </button>
        </div>
      </header>
      <div className="form">
        <Panel title="Offer">
          <label className="field">
            <span>Name</span>
            <input className="input" value={pkg.name} onChange={(e) => set({ name: e.target.value })} />
          </label>
          <label className="field">
            <span>Description</span>
            <textarea className="input" rows={2} value={pkg.description} onChange={(e) => set({ description: e.target.value })} />
          </label>
          <div className="grid2">
            <label className="field">
              <span>Price (USD)</span>
              <input className="input" type="number" min={0} step="1" value={pkg.price} onChange={(e) => set({ price: Number(e.target.value) })} />
            </label>
            <label className="field">
              <span>Turnaround (days)</span>
              <input className="input" type="number" min={1} value={pkg.turnaroundDays} onChange={(e) => set({ turnaroundDays: Number(e.target.value) })} />
            </label>
          </div>
          <ListEditor label="What's included" value={pkg.includes} onChange={(v) => set({ includes: v })} />
        </Panel>
        <Panel title="Add-ons">
          <table className="table">
            <tbody>
              {pkg.addOns.map((a, i) => (
                <tr key={i}>
                  <td>
                    <input className="input" value={a.label} onChange={(e) => setAddOn(i, { label: e.target.value })} aria-label="Add-on label" />
                  </td>
                  <td style={{ width: 110 }}>
                    <input className="input" type="number" min={0} value={a.price} onChange={(e) => setAddOn(i, { price: Number(e.target.value) })} aria-label="Add-on price" />
                  </td>
                  <td style={{ width: 150 }}>
                    <select className="input" value={a.kind} onChange={(e) => setAddOn(i, { kind: e.target.value as PortalAddOn["kind"] })} aria-label="Add-on type">
                      <option value="extra-units">Extra units</option>
                      <option value="rush">Rush</option>
                      <option value="revision">Extra revision</option>
                      <option value="custom">Other</option>
                    </select>
                  </td>
                  <td style={{ width: 80 }}>
                    {a.kind === "extra-units" && <input className="input" type="number" min={1} value={a.value ?? 1} onChange={(e) => setAddOn(i, { value: Number(e.target.value) })} aria-label="Units added" />}
                  </td>
                  <td className="num">
                    <button className="btn sm" onClick={() => set({ addOns: pkg.addOns.filter((_, j) => j !== i) })}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="btn sm" onClick={() => set({ addOns: [...pkg.addOns, { id: `addon${Date.now().toString(36)}`, label: "New option", price: 0, kind: "custom" }] })}>
            + Add-on
          </button>
        </Panel>
        <Panel title="Guided brief">
          <p className="small muted">Questions the client answers when requesting. Asking up front means fewer clarifying rounds later.</p>
          {pkg.questions.map((q, i) => (
            <div key={i} className="question-row">
              <div className="row gap wrap">
                <input className="input grow" value={q.label} onChange={(e) => setQ(i, { label: e.target.value })} aria-label="Question" />
                <select className="input" value={q.type} onChange={(e) => setQ(i, { type: e.target.value as PortalQuestion["type"] })} aria-label="Answer type">
                  <option value="text">Short text</option>
                  <option value="textarea">Long text</option>
                  <option value="select">Choice</option>
                  <option value="files">File upload</option>
                </select>
                <label className="radio small">
                  <input type="checkbox" checked={q.required} onChange={(e) => setQ(i, { required: e.target.checked })} /> Required
                </label>
                <button className="btn sm" onClick={() => move(i, -1)} aria-label="Move up" disabled={i === 0}>
                  ↑
                </button>
                <button className="btn sm" onClick={() => move(i, 1)} aria-label="Move down" disabled={i === pkg.questions.length - 1}>
                  ↓
                </button>
                <button className="btn sm" onClick={() => set({ questions: pkg.questions.filter((_, j) => j !== i) })} aria-label="Remove question">
                  ✕
                </button>
              </div>
              {q.type === "select" && (
                <input
                  className="input top-gap"
                  placeholder="Options, separated by commas"
                  value={(q.options ?? []).join(", ")}
                  onChange={(e) => setQ(i, { options: e.target.value.split(",").map((s) => s.trim()) })}
                  aria-label="Options"
                />
              )}
              <input className="input top-gap small" placeholder="Help text (optional)" value={q.help ?? ""} onChange={(e) => setQ(i, { help: e.target.value })} aria-label="Help text" />
            </div>
          ))}
          <button className="btn sm" onClick={() => set({ questions: [...pkg.questions, { id: `q${Date.now().toString(36)}`, label: "New question", type: "text", required: false }] })}>
            + Question
          </button>
        </Panel>
      </div>
    </>
  );
}
