import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { fmtUSD } from "../../shared/economics";
import type { ClientRequestView, FileRef, PortalPublic, PortalQuestion } from "../../shared/types";
import { portalApi, type PortalClient } from "./portalApi";
import "./portal.css";

// The client-facing portal. Lives at /p/<slug>, on a studio's custom domain or
// subdomain, or inside the embeddable widget (?embed=1).

type Route = { name: "store" } | { name: "package"; id: string } | { name: "requests" } | { name: "request"; id: string };

function parseHash(): Route {
  const [a, b] = window.location.hash.replace(/^#\/?/, "").split("/");
  if (a === "package" && b) return { name: "package", id: b };
  if (a === "requests") return { name: "requests" };
  if (a === "request" && b) return { name: "request", id: b };
  return { name: "store" };
}
const nav = (path: string) => (window.location.hash = path);

export function PortalApp({ slug }: { slug: string }) {
  const api = useMemo(() => portalApi(slug), [slug]);
  const [portal, setPortal] = useState<PortalPublic | null>(null);
  const [error, setError] = useState("");
  const [route, setRoute] = useState<Route>(parseHash);
  const [me, setMe] = useState<PortalClient | null>(null);
  const embed = new URLSearchParams(window.location.search).has("embed");

  useEffect(() => {
    api.portal().then(
      (p) => {
        setPortal(p);
        document.title = `${p.studio.name} — ${p.studio.headline}`;
      },
      (e) => setError(e.message),
    );
    if (api.signedIn()) api.me().then((r) => setMe(r.user), () => setMe(null));
    const on = () => setRoute(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, [api]);

  if (error) return <div className="pt-center">{error}</div>;
  if (!portal) return <div className="pt-center pt-muted">Loading…</div>;

  const style = { "--pt-accent": portal.studio.accentColor } as CSSProperties;
  const signOut = () => {
    api.signOut();
    setMe(null);
    nav("/");
  };

  return (
    <div className={`pt ${embed ? "pt-embed" : ""}`} style={style}>
      <header className="pt-header">
        <button className="pt-brand" onClick={() => nav("/")}>
          {portal.studio.logoUrl ? <img src={portal.studio.logoUrl} alt="" /> : <span className="pt-mark">{portal.studio.name.slice(0, 1)}</span>}
          <span>{portal.studio.name}</span>
        </button>
        <nav className="pt-nav">
          <button onClick={() => nav("/")}>Services</button>
          {me ? (
            <>
              <button onClick={() => nav("/requests")}>My requests</button>
              <button className="pt-ghost" onClick={signOut} title={me.email}>
                Sign out
              </button>
            </>
          ) : (
            <button onClick={() => nav("/requests")}>Sign in</button>
          )}
        </nav>
      </header>
      <main className="pt-main">
        {route.name === "store" && <Storefront portal={portal} />}
        {route.name === "package" && <PackagePage portal={portal} id={route.id} api={api} me={me} onSignedIn={setMe} />}
        {route.name === "requests" && (me ? <Requests api={api} /> : <AuthCard api={api} onSignedIn={(u) => (setMe(u), nav("/requests"))} />)}
        {route.name === "request" && (me ? <RequestPage api={api} id={route.id} /> : <AuthCard api={api} onSignedIn={setMe} />)}
      </main>
      {!embed && <footer className="pt-footer">Powered by Studio Operator</footer>}
    </div>
  );
}

function Storefront({ portal }: { portal: PortalPublic }) {
  return (
    <>
      <section className="pt-hero">
        <h1>{portal.studio.headline}</h1>
        <p>{portal.studio.intro}</p>
      </section>
      <section className="pt-grid">
        {portal.packages.map((p) => (
          <article key={p.id} className="pt-card">
            <h2>{p.name}</h2>
            <p className="pt-muted">{p.description}</p>
            <div className="pt-price">
              {fmtUSD(p.price)} <span className="pt-muted">· {p.turnaroundDays}-day turnaround</span>
            </div>
            <ul className="pt-includes">
              {p.includes.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
            <button className="pt-btn" onClick={() => nav(`/package/${p.id}`)}>
              Choose {p.name}
            </button>
          </article>
        ))}
        {!portal.packages.length && <p className="pt-muted">No services are open right now.</p>}
      </section>
    </>
  );
}

function AuthCard({ api, onSignedIn, compact }: { api: ReturnType<typeof portalApi>; onSignedIn: (u: PortalClient) => void; compact?: boolean }) {
  const [mode, setMode] = useState<"signup" | "login">("signup");
  const [f, setF] = useState({ email: "", password: "", name: "", company: "", website: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      onSignedIn(mode === "signup" ? await api.signup(f) : await api.login(f.email, f.password));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className={`pt-panel ${compact ? "" : "pt-narrow"}`} onSubmit={submit}>
      <h2>{mode === "signup" ? "Create your client account" : "Welcome back"}</h2>
      <p className="pt-muted">{mode === "signup" ? "So you can track your request and get your files." : "Sign in to see your requests."}</p>
      {mode === "signup" && (
        <div className="pt-row2">
          <label>
            Your name
            <input autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
          </label>
          <label>
            Company / organization
            <input autoComplete="organization" value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} />
          </label>
        </div>
      )}
      <label>
        Email
        <input type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
      </label>
      <label>
        Password
        <input type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} minLength={mode === "signup" ? 8 : undefined} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required />
      </label>
      {/* Honeypot: real people never see or fill this. */}
      <input className="pt-hp" tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} aria-hidden />
      {err && <p className="pt-error">{err}</p>}
      <button className="pt-btn" disabled={busy}>
        {busy ? "One moment…" : mode === "signup" ? "Create account" : "Sign in"}
      </button>
      <button type="button" className="pt-link" onClick={() => setMode(mode === "signup" ? "login" : "signup")}>
        {mode === "signup" ? "Already have an account? Sign in" : "New here? Create an account"}
      </button>
    </form>
  );
}

function Uploader({ api, value, onChange }: { api: ReturnType<typeof portalApi>; value: FileRef[]; onChange: (f: FileRef[]) => void }) {
  const [busy, setBusy] = useState(0);
  const [err, setErr] = useState("");
  const add = async (files: FileList | null) => {
    if (!files) return;
    setErr("");
    const list = [...files];
    setBusy(list.length);
    const done: FileRef[] = [];
    for (const f of list) {
      try {
        done.push(await api.upload(f));
      } catch (e) {
        setErr(`${f.name}: ${(e as Error).message}`);
      }
      setBusy((n) => n - 1);
    }
    onChange([...value, ...done]);
  };
  return (
    <div className="pt-upload">
      <label className="pt-drop">
        <input type="file" multiple onChange={(e) => add(e.target.files)} />
        {busy ? `Uploading ${busy} file${busy === 1 ? "" : "s"}…` : "Choose files or drop them here"}
      </label>
      {value.map((f) => (
        <div key={f.key} className="pt-file">
          <span>{f.name}</span>
          <span className="pt-muted">{Math.max(1, Math.round(f.size / 1024))} KB</span>
          <button type="button" className="pt-link" onClick={() => onChange(value.filter((x) => x.key !== f.key))}>
            Remove
          </button>
        </div>
      ))}
      {err && <p className="pt-error">{err}</p>}
    </div>
  );
}

function Question({ q, value, onChange }: { q: PortalQuestion; value: string; onChange: (v: string) => void }) {
  const label = (
    <span>
      {q.label}
      {q.required && <span className="pt-req"> *</span>}
    </span>
  );
  return (
    <label>
      {label}
      {q.type === "textarea" ? (
        <textarea rows={4} value={value} onChange={(e) => onChange(e.target.value)} required={q.required} />
      ) : q.type === "select" ? (
        <select value={value} onChange={(e) => onChange(e.target.value)} required={q.required}>
          <option value="">Choose…</option>
          {q.options?.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      ) : (
        <input value={value} onChange={(e) => onChange(e.target.value)} required={q.required} />
      )}
      {q.help && <small className="pt-muted">{q.help}</small>}
    </label>
  );
}

function PackagePage({ portal, id, api, me, onSignedIn }: { portal: PortalPublic; id: string; api: ReturnType<typeof portalApi>; me: PortalClient | null; onSignedIn: (u: PortalClient) => void }) {
  const pkg = portal.packages.find((p) => p.id === id);
  const [addOns, setAddOns] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<Record<string, FileRef[]>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!pkg) return <p className="pt-muted">That service isn't available.</p>;
  const total = pkg.price + pkg.addOns.filter((a) => addOns.includes(a.id)).reduce((n, a) => n + a.price, 0);
  const rush = pkg.addOns.some((a) => a.kind === "rush" && addOns.includes(a.id));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const missingFile = pkg.questions.find((q) => q.type === "files" && q.required && !(files[q.id]?.length));
    if (missingFile) return setErr(`Please upload: ${missingFile.label}`);
    setBusy(true);
    setErr("");
    try {
      const r = await api.submit({ packageId: pkg.id, addOnIds: addOns, answers, files });
      nav(`/request/${r.id}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pt-split">
      <div>
        <button className="pt-link" onClick={() => nav("/")}>
          ← All services
        </button>
        <h1>{pkg.name}</h1>
        <p className="pt-muted">{pkg.description}</p>
        {!me ? (
          <AuthCard api={api} onSignedIn={onSignedIn} compact />
        ) : (
          <form className="pt-panel" onSubmit={submit}>
            {pkg.addOns.length > 0 && (
              <fieldset>
                <legend>Options</legend>
                {pkg.addOns.map((a) => (
                  <label key={a.id} className="pt-check">
                    <input type="checkbox" checked={addOns.includes(a.id)} onChange={(e) => setAddOns(e.target.checked ? [...addOns, a.id] : addOns.filter((x) => x !== a.id))} />
                    <span>{a.label}</span>
                    <span className="pt-muted">+{fmtUSD(a.price)}</span>
                  </label>
                ))}
              </fieldset>
            )}
            <fieldset>
              <legend>Your brief</legend>
              {pkg.questions.map((q) =>
                q.type === "files" ? (
                  <div key={q.id} className="pt-field">
                    <span>
                      {q.label}
                      {q.required && <span className="pt-req"> *</span>}
                    </span>
                    {q.help && <small className="pt-muted">{q.help}</small>}
                    <Uploader api={api} value={files[q.id] ?? []} onChange={(v) => setFiles({ ...files, [q.id]: v })} />
                  </div>
                ) : (
                  <Question key={q.id} q={q} value={answers[q.id] ?? ""} onChange={(v) => setAnswers({ ...answers, [q.id]: v })} />
                ),
              )}
            </fieldset>
            {err && <p className="pt-error">{err}</p>}
            <button className="pt-btn" disabled={busy}>
              {busy ? "Sending…" : `Send request · ${fmtUSD(total)}`}
            </button>
            <p className="pt-muted pt-small">No payment is taken here — the studio confirms your request and arranges payment with you.</p>
          </form>
        )}
      </div>
      <aside className="pt-summary">
        <h3>Summary</h3>
        <div className="pt-sum-row">
          <span>{pkg.name}</span>
          <span>{fmtUSD(pkg.price)}</span>
        </div>
        {pkg.addOns
          .filter((a) => addOns.includes(a.id))
          .map((a) => (
            <div key={a.id} className="pt-sum-row">
              <span>{a.label}</span>
              <span>+{fmtUSD(a.price)}</span>
            </div>
          ))}
        <div className="pt-sum-row pt-total">
          <span>Total</span>
          <span>{fmtUSD(total)}</span>
        </div>
        <p className="pt-muted pt-small">Delivered in about {rush ? Math.max(1, Math.ceil(pkg.turnaroundDays / 2)) : pkg.turnaroundDays} days.</p>
        <ul className="pt-includes">
          {pkg.includes.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

const STATUS_STEPS = [
  { key: "received", label: "Received" },
  { key: "in-progress", label: "In production" },
  { key: "ready", label: "Ready for review" },
  { key: "completed", label: "Completed" },
];
const stepIndex = (s: ClientRequestView["status"]) =>
  s === "received" || s === "questions" ? 0 : s === "in-progress" || s === "revising" ? 1 : s === "ready" ? 2 : s === "completed" ? 3 : -1;

function Requests({ api }: { api: ReturnType<typeof portalApi> }) {
  const [list, setList] = useState<ClientRequestView[] | null>(null);
  useEffect(() => {
    api.me().then((r) => setList(r.requests));
  }, [api]);
  if (!list) return <p className="pt-muted">Loading…</p>;
  return (
    <>
      <h1>My requests</h1>
      {list.length ? (
        <div className="pt-list">
          {list.map((r) => (
            <button key={r.id} className="pt-item" onClick={() => nav(`/request/${r.id}`)}>
              <div>
                <strong>{r.title}</strong>
                <div className="pt-muted pt-small">
                  {r.packageName} · {fmtUSD(r.price)} · sent {new Date(r.submittedAt).toLocaleDateString()}
                </div>
              </div>
              <span className={`pt-status s-${r.status}`}>{r.statusLabel}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="pt-muted">
          No requests yet. <button className="pt-link" onClick={() => nav("/")}>Browse services</button>
        </p>
      )}
    </>
  );
}

function RequestPage({ api, id }: { api: ReturnType<typeof portalApi>; id: string }) {
  const [r, setR] = useState<ClientRequestView | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.request(id).then(setR, (e) => setErr(e.message)), [api, id]);
  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);
  if (err) return <p className="pt-error">{err}</p>;
  if (!r) return <p className="pt-muted">Loading…</p>;
  const idx = stepIndex(r.status);
  const act = async (fn: () => Promise<ClientRequestView>) => {
    setBusy(true);
    try {
      setR(await fn());
      setMsg("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const downloadMd = (md: string, name: string) => {
    const url = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
    Object.assign(document.createElement("a"), { href: url, download: `${name.replace(/[^\w]+/g, "-").toLowerCase()}.md` }).click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <button className="pt-link" onClick={() => nav("/requests")}>
        ← My requests
      </button>
      <div className="pt-head">
        <div>
          <h1>{r.title}</h1>
          <p className="pt-muted">
            {r.packageName} · {fmtUSD(r.price)}
          </p>
        </div>
        <span className={`pt-status s-${r.status}`}>{r.statusLabel}</span>
      </div>

      {r.status === "declined" ? (
        <p className="pt-panel">The studio couldn't take on this request. Check the messages below for details.</p>
      ) : (
        <ol className="pt-steps">
          {STATUS_STEPS.map((s, i) => (
            <li key={s.key} className={i < idx ? "done" : i === idx ? "now" : ""}>
              {s.label}
            </li>
          ))}
        </ol>
      )}

      {r.deliverables.length > 0 && (
        <section className="pt-panel">
          <h2>Your files</h2>
          {r.deliverables.map((d) => (
            <div key={d.label} className="pt-deliverable">
              <h3>{d.label}</h3>
              {d.kind === "text" ? (
                d.items.map((it, i) => (
                  <div key={i}>
                    <pre className="pt-copy">{it.markdown}</pre>
                    <div className="pt-actions">
                      <button className="pt-btn pt-secondary" onClick={() => navigator.clipboard.writeText(it.markdown ?? "")}>
                        Copy
                      </button>
                      <button className="pt-btn pt-secondary" onClick={() => downloadMd(it.markdown ?? "", d.label)}>
                        Download
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <div className="pt-gallery">
                  {d.items.map((it, i) => (
                    <a key={i} href={it.url} target="_blank" rel="noreferrer" download={`${d.label}-${i + 1}`}>
                      <img src={it.url} alt={`${d.label} ${i + 1}`} />
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
          {r.canApprove && (
            <div className="pt-actions">
              <button className="pt-btn" disabled={busy} onClick={() => act(() => api.approve(r.id))}>
                Approve — this is perfect
              </button>
              <span className="pt-muted pt-small">or ask for changes below</span>
            </div>
          )}
        </section>
      )}

      <section className="pt-panel">
        <h2>Messages</h2>
        <div className="pt-thread">
          {r.messages.map((m) => (
            <div key={m.id} className={`pt-msg ${m.from}`}>
              <div className="pt-small pt-muted">
                {m.from === "you" ? "You" : "Studio"} · {new Date(m.at).toLocaleString()}
              </div>
              <div>{m.body}</div>
            </div>
          ))}
          {!r.messages.length && <p className="pt-muted">No messages yet. We'll post questions and updates here.</p>}
        </div>
        <form
          className="pt-composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (msg.trim()) act(() => api.message(r.id, msg));
          }}
        >
          <textarea rows={3} placeholder={r.canRequestChanges ? "Ask a question or describe the changes you'd like…" : "Add details or answer a question…"} value={msg} onChange={(e) => setMsg(e.target.value)} />
          <button className="pt-btn" disabled={busy || !msg.trim()}>
            Send
          </button>
        </form>
      </section>

      <section className="pt-panel">
        <h2>Your brief</h2>
        <dl className="pt-answers">
          {r.answers.map((a) => (
            <div key={a.questionId}>
              <dt>{a.label}</dt>
              <dd>{a.value}</dd>
            </div>
          ))}
        </dl>
        {r.files.length > 0 && (
          <div className="pt-actions">
            {r.files.map((f) => (
              <button key={f.key} className="pt-btn pt-secondary" onClick={() => api.download(f)}>
                {f.name}
              </button>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
