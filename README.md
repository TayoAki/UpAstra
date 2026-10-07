# Studio Operator

A cockpit for a **semi-autonomous, AI-native creative service firm**: images, video, **copywriting** (cold email, ad copy) and **nonprofit grant writing**. Paid demand comes in from Upwork, Fiverr, Contra or direct leads. **Astra** (the orchestrator model) runs each job. **Higgsfield** gives access to every creative model through one API. One person handles taste, rights and approvals.

```
brief ─▶ Astra intake ─▶ model router + pricing ─▶ Higgsfield generations ─▶ QA & repair ─▶ human approval ─▶ delivery ─▶ lessons
```

## Quick start

```bash
npm install
npm run dev        # API on :8787, UI on http://localhost:5173
```

The first boot seeds a demo firm: 8 clients and 11 jobs across image, video, cold email, ad copy and grant work, each at a different stage. With no API keys set, both layers run as **free deterministic simulators**. The bottom bar shows whether each layer is `simulated` or `live`.

| Command | What it does |
| --- | --- |
| `npm run dev` | API (tsx watch) and Vite UI |
| `npm test` | Unit and pipeline tests (vitest) |
| `npm run typecheck` | TypeScript check |
| `npm run build && npm start` | Production build, served by the API on `:8787` |
| `npm run reset-data` | Delete `data/db.json` (the next boot re-seeds) |
| `npm run mcp` | MCP server over stdio, for Claude Desktop / Claude Code (needs the API running) |

### Going live

Copy `.env.example` to `.env`:

- `OPENAI_API_KEY`, `ASTRA_MODEL`, `OPENAI_BASE_URL`: Astra's judgment calls (intake, QA, client messages) go to an OpenAI-compatible chat completions endpoint and use JSON output. If a call fails, it falls back to the rules engine and logs a warning.
- `HIGGSFIELD_API_KEY`, `HIGGSFIELD_BASE_URL`: the production layer. The key stays on the server. **Check the endpoint paths and field names in `server/higgsfield.ts` (`ENDPOINTS`, `submit`, `check`) against Higgsfield's current API reference before you spend credits.** They are kept in one place so you can change them in one spot.
- `COPY_FAST_MODEL`, `COPY_PRO_MODEL`, `COPY_EDIT_MODEL`: the model IDs behind the three copy tiers. Copy is written through the Astra endpoint, not Higgsfield. Unset tiers use `ASTRA_MODEL`.
- Seeding and tests never call live services.

## The six layers (one per build prompt)

| # | Layer | Where |
| --- | --- | --- |
| 1 | **The firm**: service templates, job inbox, stages, clients, deliverables, costs, margins, approvals, revisions, delivery | `shared/types.ts`, `shared/templates.ts`, `server/store.ts` |
| 2 | **Intake**: turns a messy brief into deliverables, formats, exact copy, deadline, supplied and missing inputs, risks, revision risks, the smallest set of client questions, and an accept, review or reject call | `server/astra.ts` (`analyzeBrief`) |
| 3 | **Production layer**: one Higgsfield key, submit, check and download, actual charges attached to the job | `server/higgsfield.ts` |
| 4 | **Model router**: picks a model for each step from the four questions, explains why, can be overridden, and re-prices instantly | `shared/router.ts`, `shared/catalog.ts` |
| 5 | **QA & repair**: checks each output against the brief, the template rulebook and client memory, then decides `ready`, `edit` (controlled repair via Qwen), `regenerate` or `human` | `server/astra.ts` (`qaOutput`), `server/pipeline.ts` (`produceItem`) |
| 6 | **Autonomy controls**: spend caps, repair limits, max attempts, blocked families and origins, client message rules, approval gates, agent (MCP) permissions, and a full audit log | `server/pipeline.ts`, Autonomy screen |
| + | **Copy & grants**: text deliverables, writer/editor models, rule-based copy QA | `shared/copy.ts`, `server/writer.ts` |
| + | **MCP**: tools for Claude / Astra | `server/mcp.ts`, `server/mcp-stdio.ts` |

Prices and margins are always plain code (`shared/economics.ts`), never model judgment.

## Copywriting and grant writing

Text jobs go through the same pipeline as visual jobs: intake, pricing, the margin floor, gates, QA, repair, approval and lessons. Only the production lane is different.

| Template | Deliverable | Plain-code "definition of correct" |
| --- | --- | --- |
| **Cold Email Sequence** | N emails (subject + body) | Subject ≤ 50 chars, body 40–120 words, one CTA, no spam phrases or ALL CAPS, valid merge tags (`{{first_name}}`, `{{company}}`, `{{title}}`), only approved claims, a different angle per email |
| **Ad Copy Pack** | N variants with per-platform fields | Character limits for Meta, Google Search, LinkedIn or TikTok (detected from the brief), a CTA in each variant, a distinct hook per variant, only approved claims |
| **Nonprofit Grant Proposal** | Full proposal (8 sections) or letter of inquiry (4 sections) | Every section within its word limit (an overall limit in the brief is shared across sections), funder named, requested amount stated, SMART objectives, no overpromising, **every statistic traceable to the org's own data** |

- **Intake** recognizes cold email, ad copy and grant briefs and asks copy questions (ICP, offer, proof points, platform, funder guidelines, requested amount, program data) instead of asking for product photos.
- **Router:** *Astra Writer (fast)* explores angles cheaply, *Astra Writer (pro)* writes finals, and *Astra Editor* makes controlled line edits. They are priced per 1k tokens, so a copy job usually costs cents.
- **QA:** the rules above run in code on every draft. Length, CTA, spam and merge-tag problems are sent to the editor with specific fixes. Repeated hooks trigger a regeneration. **Unapproved claims, and any grant statistic not found in the brief or client facts, go to a human.** With a live key, Astra also reviews voice and persuasiveness.
- **Client memory** holds "approved claims & verified facts". Ads and emails may only make those claims, and grants may only cite those numbers. When a grant needs a number that is missing, the live writer is told to write `[DATA NEEDED]` instead of inventing one.
- **QA & delivery tab:** a copy viewer with field-by-field counters against each limit, versions (v1, v2 …) with their QA verdicts, and *Copy* / *Download .md* buttons.

## MCP: let Claude or Astra run the firm

`server/mcp.ts` exposes Studio Operator as an MCP server. It calls the same HTTP API the UI uses, so there is one source of truth.

**Tools:** `firm_overview`, `list_jobs`, `get_job`, `get_copy`, `create_job`, `resolve_checkpoint`, `set_route`, `log_client_message`, `list_templates`, `list_models`, `list_clients`, `update_client_memory`, `get_policy` and `list_lessons`. There is also a `triage` prompt that works through everything waiting on a decision.

**Guardrails:**

- Everything an agent does is logged as the `agent` actor.
- The agent may only resolve the checkpoint kinds you allow under **Autonomy → Agent access (MCP)**. The default allows sending questions, accepting jobs, approving production spend and deciding QA escalations.
- **Final delivery always needs a human.**
- Agents can read the autonomy policy but cannot change it.

**Claude Code** (with `npm run dev` running):

```bash
claude mcp add studio-operator -- npm --prefix /path/to/UpAstra run -s mcp
```

**Claude Desktop**: add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "studio-operator": {
      "command": "npm",
      "args": ["--prefix", "/path/to/UpAstra", "run", "-s", "mcp"],
      "env": { "STUDIO_API_URL": "http://localhost:8787" }
    }
  }
}
```

**Remote agents (Astra, or Claude through the API):** set `MCP_TOKEN` and the server also serves MCP over Streamable HTTP at `/mcp`, protected by `Authorization: Bearer <MCP_TOKEN>`. Remote platforms need a public HTTPS URL, such as a deployment or a tunnel. For example, with the OpenAI Responses API:

```js
tools: [{ type: "mcp", server_label: "studio-operator", server_url: "https://your-host/mcp",
          headers: { Authorization: `Bearer ${MCP_TOKEN}` }, require_approval: "never" }]
```

Check your platform's current MCP connector docs for the exact field names. The HTTP API and UI have no login of their own, so don't expose `:8787` publicly without putting authentication in front of it. `/mcp` is the only route protected by a token.

## Layout

The UI follows the wireframe: **left rail** (Jobs, Intake, Approvals, Client memory, Playbook, Autonomy), **sidebar** (contextual list), **tabs**, **main content**, **right sidebar** (economics, checkpoints, client memory), and a **bottom bar** (provider modes, spend).

- **Jobs**: KPIs (active jobs, pipeline value, estimated gross profit, jobs needing attention) and job cards.
- **Job**: four tabs: *Brief & intake*, *Production route* (override a model and the economics update), *QA & delivery* (every generation with its QA checks, plus the client thread), and *Activity* (audit log and generation ledger).
- **Approvals**: every open human checkpoint across all jobs.
- **Client memory**: logo, colors, fonts, likes, rejected styles and approved claims, plus the firm's **lessons** (the self-improvement loop: missing inputs that predicted revisions, which models needed repairs, realized margins).
- **Playbook**: service templates (buyer, deliverables, recipe, rulebook, approval points) and the model primer by lane.
- **Autonomy**: the policy. Saving it re-routes every open job.

## Adding a new firm

Add an entry to `shared/templates.ts`: buyer, deliverables, recipe steps (each with a lane, an intent and what must be preserved), a rulebook, and approval points. The interface stays the same. The template changes the buyer, the deliverables, the production recipe and the QA definition of "correct". The three startup ideas from the video ship as templates: *Always-On Ad Pack*, *Franchise Localization Desk* and *Industrial SKU Sales Pack*. Text templates are added the same way: give the deliverable `kind: "text"` and a `copy` spec (format and fields with limits). To add a new copy format, such as landing pages or product descriptions, add its checks to `checkCopy` in `shared/copy.ts` and its drafting to `server/writer.ts`.

## Notes

- Model prices in `shared/catalog.ts` are illustrative list prices used for estimates. Actual charges come from the provider's response.
- Marketplace listings usually require a login, so URL import is best-effort. If it fails, paste the brief text.
- Data is stored in a single JSON file, `data/db.json` (git-ignored).
