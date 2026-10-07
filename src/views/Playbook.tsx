import { stepCost } from "../../shared/catalog";
import { fmtUSD } from "../../shared/economics";
import { modelBlockReason } from "../../shared/router";
import type { Lane } from "../../shared/types";
import { Frame, Panel, SideHeader, SideItem, Tabs } from "../components/ui";
import { go, useApp } from "../store";

const LANES: { lane: Lane; title: string; when: string }[] = [
  { lane: "people", title: "People with taste", when: "Fashion, editorial, founder shoots" },
  { lane: "product", title: "Product scenes", when: "One clean reference into lifestyle or campaign worlds" },
  { lane: "typography", title: "Words & layout", when: "Posters, covers, local promos where text is the product" },
  { lane: "repair", title: "Repair shop", when: "Image is close — fix a label, one object, a headline" },
  { lane: "explore-image", title: "Cheap still exploration", when: "Many directions quickly" },
  { lane: "explore-video", title: "Cheap video exploration", when: "Test hooks, openings and camera ideas" },
  { lane: "cinematic", title: "Longer cinematic scenes", when: "Multiple references, a developing sequence, native audio" },
  { lane: "hero-video", title: "Hero shot", when: "Camera movement and physical realism the customer notices" },
  { lane: "speech", title: "Speaking", when: "Spokesperson and localized performances" },
  { lane: "motion-transfer", title: "Copy a performance", when: "You already have the exact movement" },
  { lane: "finishing", title: "Finishing", when: "Upscale, lip sync, captions, export" },
  { lane: "copy", title: "Copywriting", when: "Cold email, ad copy, grant narratives — cheap drafts, pro finals" },
  { lane: "copy-edit", title: "Copy editing", when: "Copy is close — trim, fix a CTA, a merge tag or a claim" },
];

export function PlaybookView({ tab, item }: { tab?: string; item?: string }) {
  const { boot } = useApp();
  if (!boot) return null;
  const current = tab === "models" ? "models" : "templates";
  const template = boot.templates.find((t) => t.id === item) ?? boot.templates[0];

  return (
    <Frame
      sidebar={
        <>
          <SideHeader>{current === "templates" ? "Service templates" : "Production lanes"}</SideHeader>
          <div className="side-list">
            {current === "templates"
              ? boot.templates.map((t) => (
                  <SideItem key={t.id} active={t.id === template.id} title={t.name} sub={`${t.buyer} · from ${fmtUSD(t.basePrice)}`} onClick={() => go(`/playbook/templates/${t.id}`)} />
                ))
              : LANES.map((l) => (
                  <SideItem key={l.lane} title={l.title} sub={l.when} onClick={() => document.getElementById(`lane-${l.lane}`)?.scrollIntoView({ behavior: "smooth" })} />
                ))}
          </div>
        </>
      }
      tabs={
        <Tabs
          value={current}
          onChange={(t) => go(`/playbook/${t}`)}
          options={[
            { id: "templates", label: "Service templates" },
            { id: "models", label: "Model router primer" },
          ]}
        />
      }
      right={
        <>
          <h4 className="right-title">Four questions before choosing a model</h4>
          <ol className="small steps-list">
            <li>Still image, video, or speech?</li>
            <li>Creating something new, or repairing an asset that's close?</li>
            <li>Exploring cheaply, or making the final version?</li>
            <li>What absolutely cannot change — product, person, words, or movement?</li>
          </ol>
          <h4 className="right-title">Four filters for a template</h4>
          <ol className="small steps-list">
            <li>Someone already pays for this work.</li>
            <li>The unit is obvious (one SKU pack, one localized campaign).</li>
            <li>The work repeats.</li>
            <li>There is a concrete definition of correct.</li>
          </ol>
        </>
      }
    >
      {current === "templates" ? (
        <>
          <header className="page-head">
            <div>
              <h1>{template.name}</h1>
              <p className="muted">
                {template.description} Buyer: {template.buyer}. From {fmtUSD(template.basePrice)}, {template.turnaroundDays}-day turnaround.
              </p>
            </div>
          </header>
          <div className="cards three">
            {template.deliverables.map((d) => (
              <div key={d.id} className="card static">
                <div className="card-img">
                  <span className="placeholder-img" aria-hidden />
                </div>
                <div className="card-body">
                  <div className="card-title">
                    {d.quantity}× {d.label}
                  </div>
                  <div className="muted small">
                    {d.copy
                      ? `${d.copy.platform ? `${d.copy.platform} · ` : ""}${d.copy.fields.map((f) => `${f.label}${f.maxChars ? ` ≤${f.maxChars} chars` : f.maxWords ? ` ≤${f.maxWords} words` : ""}`).join(" · ")}`
                      : `${d.kind} · ${d.aspect} · ${d.format}${d.durationSec ? ` · ${d.durationSec}s` : ""}`}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <Panel title="Production recipe">
            <ol className="recipe">
              {template.recipe.map((r) => (
                <li key={r.id}>
                  <strong>{r.label}</strong>{" "}
                  <span className="chips inline">
                    <span className="chip">{r.kind}</span>
                    <span className="chip">{r.intent}</span>
                    <span className="chip">lane: {r.lane}</span>
                    {r.preserve !== "none" && <span className="chip">preserve: {r.preserve}</span>}
                  </span>
                </li>
              ))}
            </ol>
          </Panel>
          <div className="grid2">
            <Panel title="Rulebook (definition of correct)">
              <ul className="bullets">
                {template.rulebook.map((r) => (
                  <li key={r}>
                    <span className="dot ok" />
                    {r}
                  </li>
                ))}
              </ul>
            </Panel>
            <Panel title="Approval points">
              <ul className="bullets">
                {template.approvalPoints.map((r) => (
                  <li key={r}>
                    <span className="dot warn" />
                    {r}
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        </>
      ) : (
        <>
          <header className="page-head">
            <div>
              <h1>Model router primer</h1>
              <p className="muted">
                One Higgsfield key for every visual lane; copy lanes run on the Astra endpoint. Prices shown are list estimates per unit. Models blocked by your autonomy policy are marked and never routed.
              </p>
            </div>
          </header>
          {LANES.map((l) => {
            const models = boot.catalog.filter((m) => m.lanes.includes(l.lane));
            return (
              <Panel key={l.lane} title={<span id={`lane-${l.lane}`}>{l.title}</span>} aside={<span className="muted small">{l.when}</span>}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Vendor</th>
                      <th>Strengths</th>
                      <th>Watch out</th>
                      <th className="num">Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {models.map((m) => {
                      const blocked = modelBlockReason(m, boot.policy);
                      return (
                        <tr key={m.id} className={blocked ? "blocked-row" : ""}>
                          <td>
                            <strong>{m.name}</strong>
                            {blocked && <div className="neg small">blocked</div>}
                          </td>
                          <td className="small">
                            {m.vendor} · {m.origin}
                          </td>
                          <td className="small">{m.strengths}</td>
                          <td className="small muted">{m.watchOuts}</td>
                          <td className="num small">
                            {fmtUSD(stepCost(m, 1))}/{m.unit === "second" ? "sec" : m.unit === "ktok" ? "1k tokens" : m.unit}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Panel>
            );
          })}
        </>
      )}
    </Frame>
  );
}
