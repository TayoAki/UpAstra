import { useEffect, useState } from "react";
import type { ClientMemory, Lesson } from "../../shared/types";
import { api } from "../api";
import { Empty, Frame, ListEditor, Panel, SideHeader, SideItem, StageBadge, Tabs, initials, timeAgo } from "../components/ui";
import { go, useAction, useApp } from "../store";

const LIST_FIELDS: { key: "colors" | "fonts" | "likes" | "rejectedStyles" | "approvedClaims"; label: string; hint?: string }[] = [
  { key: "colors", label: "Brand colors", hint: "#hex, one per line" },
  { key: "fonts", label: "Fonts" },
  { key: "likes", label: "What they like" },
  { key: "rejectedStyles", label: "Rejected styles" },
  { key: "approvedClaims", label: "Approved claims & verified facts", hint: "Claims ads/emails may make, and the stats a grant may cite — one per line" },
];

export function MemoryView({ clientId }: { clientId?: string }) {
  const { jobs } = useApp();
  const { busy, run } = useAction();
  const [clients, setClients] = useState<ClientMemory[]>([]);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [tab, setTab] = useState<"brand" | "lessons">(clientId ? "brand" : "brand");
  const [draft, setDraft] = useState<ClientMemory | null>(null);

  useEffect(() => {
    api.clients().then(setClients);
    api.lessons().then(setLessons);
  }, []);
  const selected = clients.find((c) => c.id === clientId) ?? clients[0];
  useEffect(() => setDraft(selected ? structuredClone(selected) : null), [selected]);

  const save = () => {
    if (!draft) return;
    const clean = { ...draft };
    for (const f of LIST_FIELDS) clean[f.key] = clean[f.key].map((s) => s.trim()).filter(Boolean);
    run(() => api.saveClient(clean), "Client memory saved").then((c) => c && setClients((cs) => cs.map((x) => (x.id === c.id ? c : x))));
  };
  const add = () =>
    run(() => api.createClient({ name: "New client" }), "Client added").then((c) => {
      if (c) {
        setClients((cs) => [...cs, c]);
        go(`/memory/${c.id}`);
      }
    });

  const clientJobs = jobs.filter((j) => j.clientId === selected?.id);
  const clientLessons = lessons.filter((l) => l.clientId === selected?.id);

  return (
    <Frame
      sidebar={
        <>
          <SideHeader
            action={
              <button className="btn sm" onClick={add} disabled={busy}>
                + Add
              </button>
            }
          >
            Clients
          </SideHeader>
          <div className="side-list">
            {clients.map((c) => (
              <SideItem
                key={c.id}
                active={c.id === selected?.id}
                title={c.name}
                sub={c.contact || "No contact"}
                dot={c.colors[0] ? `linear-gradient(135deg, ${c.colors.join(",")})` : undefined}
                onClick={() => go(`/memory/${c.id}`)}
              />
            ))}
          </div>
        </>
      }
      tabs={
        <Tabs
          value={tab}
          onChange={setTab}
          options={[
            { id: "brand", label: "Client account memory" },
            { id: "lessons", label: "Firm lessons", count: lessons.length },
          ]}
        />
      }
      right={
        selected && (
          <>
            <h4 className="right-title">{selected.name} jobs</h4>
            <div className="right-box">
              {clientJobs.map((j) => (
                <button key={j.id} className="right-row" onClick={() => go(`/job/${j.id}`)}>
                  <span className="grow">{j.title}</span>
                  <StageBadge stage={j.stage} />
                </button>
              ))}
              {!clientJobs.length && <p className="muted small">No jobs yet.</p>}
            </div>
            <h4 className="right-title">Lessons from this client</h4>
            <ul className="bullets small">
              {clientLessons.slice(0, 8).map((l) => (
                <li key={l.id}>
                  <span className="dot" />
                  {l.text}
                </li>
              ))}
              {!clientLessons.length && <li className="muted">Lessons appear after delivery.</li>}
            </ul>
          </>
        )
      }
    >
      {tab === "brand" &&
        (draft ? (
          <>
            <header className="page-head">
              <div className="row gap">
                <span className="avatar-lg" style={{ background: draft.colors[0] ?? "var(--line)" }}>
                  {initials(draft.name)}
                </span>
                <div>
                  <h1>{draft.name}</h1>
                  <p className="muted">Everything Astra should remember about this account — used in every prompt and QA check.</p>
                </div>
              </div>
              <button className="btn primary" disabled={busy} onClick={save}>
                Save memory
              </button>
            </header>
            <div className="form">
              <div className="grid2">
                <label className="field">
                  <span>Name</span>
                  <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                </label>
                <label className="field">
                  <span>Contact</span>
                  <input className="input" value={draft.contact} onChange={(e) => setDraft({ ...draft, contact: e.target.value })} />
                </label>
              </div>
              <label className="field">
                <span>Logo</span>
                <input className="input" value={draft.logo} onChange={(e) => setDraft({ ...draft, logo: e.target.value })} placeholder="Description or URL of the logo" />
              </label>
              <div className="swatches lg">
                {draft.colors.filter(Boolean).map((c) => (
                  <span key={c} className="swatch" style={{ background: c }} title={c} />
                ))}
              </div>
              <div className="grid2">
                {LIST_FIELDS.map((f) => (
                  <ListEditor key={f.key} label={f.label} placeholder={f.hint} value={draft[f.key]} onChange={(v) => setDraft({ ...draft, [f.key]: v })} />
                ))}
                <label className="field">
                  <span>Notes</span>
                  <textarea className="input" rows={4} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
                </label>
              </div>
            </div>
          </>
        ) : (
          <Empty>No clients yet.</Empty>
        ))}
      {tab === "lessons" && (
        <>
          <header className="page-head">
            <div>
              <h1>Firm lessons</h1>
              <p className="muted">
                The self-improvement loop. Which missing inputs predict revisions, which models preserve the important detail, which routes stay inside the margin. These stay with the firm.
              </p>
            </div>
          </header>
          {(["missing-input", "model", "margin", "qa", "revision"] as const).map((cat) => {
            const items = lessons.filter((l) => l.category === cat);
            if (!items.length) return null;
            return (
              <Panel key={cat} title={cat.replace("-", " ")}>
                <ul className="audit">
                  {items.map((l) => (
                    <li key={l.id}>
                      <span className="muted small">{timeAgo(l.at)}</span>
                      <span className="grow">{l.text}</span>
                    </li>
                  ))}
                </ul>
              </Panel>
            );
          })}
          {!lessons.length && <Empty>Deliver a job to record the first lessons.</Empty>}
        </>
      )}
    </Frame>
  );
}
