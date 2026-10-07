# Studio Operator

A cockpit for a **semi-autonomous, AI-native creative service firm**. Paid demand comes in from Upwork, Fiverr, Contra or direct leads. **Astra** (the orchestrator model) runs each job. **Higgsfield** gives access to every creative model through one API. One person handles taste, rights and approvals.

```
brief ─▶ Astra intake ─▶ model router + pricing ─▶ Higgsfield generations ─▶ QA & repair ─▶ human approval ─▶ delivery ─▶ lessons
```

## Quick start

```bash
npm install
npm run dev        # API on :8787, UI on http://localhost:5173
```

The first boot seeds a demo firm: 6 clients and 8 jobs, each at a different stage. With no API keys set, both layers run as **free deterministic simulators**. The bottom bar shows whether each layer is `simulated` or `live`.

| Command | What it does |
| --- | --- |
| `npm run dev` | API (tsx watch) and Vite UI |
| `npm test` | Unit and pipeline tests (vitest) |
| `npm run typecheck` | TypeScript check |
| `npm run build && npm start` | Production build, served by the API on `:8787` |
| `npm run reset-data` | Delete `data/db.json` (the next boot re-seeds) |

### Going live

Copy `.env.example` to `.env`:

- `OPENAI_API_KEY`, `ASTRA_MODEL`, `OPENAI_BASE_URL`: Astra's judgment calls (intake, QA, client messages) go to an OpenAI-compatible chat completions endpoint and use JSON output. If a call fails, it falls back to the rules engine and logs a warning.
- `HIGGSFIELD_API_KEY`, `HIGGSFIELD_BASE_URL`: the production layer. The key stays on the server. **Check the endpoint paths and field names in `server/higgsfield.ts` (`ENDPOINTS`, `submit`, `check`) against Higgsfield's current API reference before you spend credits.** They are kept in one place so you can change them in one spot.
- Seeding and tests never call live services.

## The six layers (one per build prompt)

| # | Layer | Where |
| --- | --- | --- |
| 1 | **The firm**: service templates, job inbox, stages, clients, deliverables, costs, margins, approvals, revisions, delivery | `shared/types.ts`, `shared/templates.ts`, `server/store.ts` |
| 2 | **Intake**: turns a messy brief into deliverables, formats, exact copy, deadline, supplied and missing inputs, risks, revision risks, the smallest set of client questions, and an accept, review or reject call | `server/astra.ts` (`analyzeBrief`) |
| 3 | **Production layer**: one Higgsfield key, submit, check and download, actual charges attached to the job | `server/higgsfield.ts` |
| 4 | **Model router**: picks a model for each step from the four questions, explains why, can be overridden, and re-prices instantly | `shared/router.ts`, `shared/catalog.ts` |
| 5 | **QA & repair**: checks each output against the brief, the template rulebook and client memory, then decides `ready`, `edit` (controlled repair via Qwen), `regenerate` or `human` | `server/astra.ts` (`qaOutput`), `server/pipeline.ts` (`produceItem`) |
| 6 | **Autonomy controls**: spend caps, repair limits, max attempts, blocked families and origins, client message rules, approval gates, and a full audit log | `server/pipeline.ts`, Autonomy screen |

Prices and margins are always plain code (`shared/economics.ts`), never model judgment.

## Layout

The UI follows the wireframe: **left rail** (Jobs, Intake, Approvals, Client memory, Playbook, Autonomy), **sidebar** (contextual list), **tabs**, **main content**, **right sidebar** (economics, checkpoints, client memory), and a **bottom bar** (provider modes, spend).

- **Jobs**: KPIs (active jobs, pipeline value, estimated gross profit, jobs needing attention) and job cards.
- **Job**: four tabs: *Brief & intake*, *Production route* (override a model and the economics update), *QA & delivery* (every generation with its QA checks, plus the client thread), and *Activity* (audit log and generation ledger).
- **Approvals**: every open human checkpoint across all jobs.
- **Client memory**: logo, colors, fonts, likes, rejected styles and approved claims, plus the firm's **lessons** (the self-improvement loop: missing inputs that predicted revisions, which models needed repairs, realized margins).
- **Playbook**: service templates (buyer, deliverables, recipe, rulebook, approval points) and the model primer by lane.
- **Autonomy**: the policy. Saving it re-routes every open job.

## Adding a new firm

Add an entry to `shared/templates.ts`: buyer, deliverables, recipe steps (each with a lane, an intent and what must be preserved), a rulebook, and approval points. The interface stays the same. The template changes the buyer, the deliverables, the production recipe and the QA definition of "correct". The three startup ideas from the video ship as templates: *Always-On Ad Pack*, *Franchise Localization Desk* and *Industrial SKU Sales Pack*.

## Notes

- Model prices in `shared/catalog.ts` are illustrative list prices used for estimates. Actual charges come from the provider's response.
- Marketplace listings usually require a login, so URL import is best-effort. If it fails, paste the brief text.
- Data is stored in a single JSON file, `data/db.json` (git-ignored).
