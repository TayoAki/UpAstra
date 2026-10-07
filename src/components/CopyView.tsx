import { useState } from "react";
import { getModel } from "../../shared/catalog";
import { copyToMarkdown, words } from "../../shared/copy";
import { fmtUSD } from "../../shared/economics";
import type { CopyPiece, CopySpec, Deliverable, Generation } from "../../shared/types";
import { useApp } from "../store";
import { VerdictBadge } from "./ui";

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

const pieceLabel = (spec: CopySpec, i: number) => (spec.format === "cold-email" ? `Email ${i + 1}` : spec.format === "grant-proposal" ? "Proposal" : `Variant ${i + 1}`);

function Field({ label, value, maxChars, maxWords, minWords, long }: { label: string; value: string; maxChars?: number; maxWords?: number; minWords?: number; long?: boolean }) {
  const n = maxChars ? value.length : words(value);
  const max = maxChars ?? maxWords;
  const over = (max && n > max) || (minWords && n < minWords);
  return (
    <div className="copy-field">
      <div className="row between small muted">
        <span className="copy-label">{label}</span>
        {max && (
          <span className={over ? "neg" : ""}>
            {n}/{max} {maxChars ? "chars" : "words"}
          </span>
        )}
      </div>
      <div className={`copy-value ${long ? "long" : ""}`}>{value || <span className="muted">—</span>}</div>
    </div>
  );
}

export function CopyPieces({ spec, pieces }: { spec: CopySpec; pieces: CopyPiece[] }) {
  if (spec.format === "grant-proposal") {
    return (
      <div className="copy-doc">
        {spec.fields.map((f) => (
          <section key={f.key}>
            <Field label={f.label} value={pieces[0]?.[f.key] ?? ""} maxWords={f.maxWords} minWords={f.minWords} maxChars={f.maxChars} long />
          </section>
        ))}
      </div>
    );
  }
  return (
    <div className={`copy-grid ${spec.format}`}>
      {pieces.map((p, i) => (
        <div key={i} className="copy-piece">
          <div className="copy-piece-title">{pieceLabel(spec, i)}</div>
          {spec.fields.map((f) => (
            <Field key={f.key} label={f.label} value={p[f.key] ?? ""} maxChars={f.maxChars} maxWords={f.maxWords} minWords={f.minWords} long={f.key === "body"} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function CopyDeliverable({ jobTitle, d, gens }: { jobTitle: string; d: Deliverable; gens: Generation[] }) {
  const { toast } = useApp();
  const versions = gens.filter((g) => g.copy);
  const acceptedId = d.outputIds[d.outputIds.length - 1];
  const [pick, setPick] = useState<string | null>(null);
  const current = versions.find((g) => g.id === pick) ?? versions.find((g) => g.id === acceptedId) ?? versions[versions.length - 1];
  if (!d.copy) return null;
  if (!current) return <p className="muted small">Not written yet.</p>;
  const md = copyToMarkdown(jobTitle, d.label, d.copy, current.copy ?? []);

  return (
    <>
      <div className="row between wrap gap">
        <div className="versions" role="tablist" aria-label="Versions">
          {versions.map((g) => (
            <button key={g.id} role="tab" aria-selected={g.id === current.id} className={`version ${g.id === current.id ? "active" : ""}`} onClick={() => setPick(g.id)}>
              v{g.attempt} · {g.purpose}
              {g.qa && <VerdictBadge verdict={g.qa.verdict} />}
              {g.id === acceptedId && <span className="pos small">✓</span>}
            </button>
          ))}
        </div>
        <div className="row gap">
          <span className="small muted">
            {getModel(current.modelId)?.name} · {fmtUSD(current.actualCost ?? current.estimatedCost)}
          </span>
          <button
            className="btn sm"
            onClick={() =>
              navigator.clipboard.writeText(md).then(
                () => toast("Copied as Markdown"),
                () => toast("Clipboard unavailable", "err"),
              )
            }
          >
            Copy
          </button>
          <button className="btn sm" onClick={() => download(`${jobTitle.replace(/[^\w]+/g, "-").toLowerCase()}.md`, md)}>
            Download .md
          </button>
        </div>
      </div>
      {current.qa && current.qa.verdict !== "ready" && (
        <div className="qa-banner">
          <VerdictBadge verdict={current.qa.verdict} /> {current.qa.summary}
        </div>
      )}
      <CopyPieces spec={d.copy} pieces={current.copy ?? []} />
      {current.qa && (
        <details className="qa-details">
          <summary className="small">
            QA {current.qa.score} · {current.qa.checks.filter((c) => c.pass).length}/{current.qa.checks.length} rules pass
          </summary>
          <ul className="checks">
            {current.qa.checks.map((c) => (
              <li key={c.rule} className={c.pass ? "pos" : "neg"}>
                {c.pass ? "✓" : "✗"} {c.rule}
                {c.note && <div className="muted">{c.note}</div>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/** Exploration output for text steps: angles and hooks. */
export function AngleList({ g }: { g: Generation }) {
  return (
    <ul className="bullets small">
      {(g.copy ?? []).map((p, i) => (
        <li key={i}>
          <span className="dot" />
          <span>
            <strong>{p.angle ?? Object.values(p)[0]}</strong>
            {p.why && <span className="muted"> — {p.why}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
