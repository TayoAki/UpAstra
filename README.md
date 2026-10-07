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

Open the app and **create an account**. Each account gets its own workspace, optionally pre-filled with a demo firm: clients, jobs at every stage, and a Job Radar search with scored leads. With no API keys set, every external service runs on a **free deterministic simulator**. The bottom bar shows what's `simulated` and what's `live`.

| Command | What it does |
| --- | --- |
| `npm run dev` | API (tsx watch) and Vite UI |
| `npm test` | Unit, pipeline, copy and SaaS tests (vitest). Set `TEST_DATABASE_URL` to run the SaaS suite against Postgres |
| `npm run typecheck` | TypeScript check |
| `npm run build && npm start` | Production build, served by the API |
| `npm run reset-data` | Delete local file storage |
| `npm run mcp` | MCP server over stdio (see below) |

All configuration is in [`.env.example`](.env.example).

## SaaS model

- **Accounts and workspaces:** users sign up with email and password and get a workspace they own. They can invite teammates with one-time codes (as member or admin) and switch between workspaces.
- **Isolation:** each workspace's jobs, clients, generations, audit log, lessons, policy, firm profile and radar are stored as one document. Postgres stores it as a `JSONB` row (`DATABASE_URL`); without Postgres it's a file in `./data`. Every request and background task runs inside its workspace's context, and `getDB()` can only return that workspace.
- **Roles:** owners and admins can change the policy, invites, members and the agent token. Members do the work.
- **Platform guardrails:** `MAX_SPEND_PER_JOB_CEILING` caps per-job spend for every workspace, `RADAR_MAX_RUNS_PER_DAY` limits scraping, and login and signup are throttled.
- **Keys:** OpenRouter, Higgsfield and Apify keys are platform-level environment variables and never reach the browser.
- **Not built yet:** billing (e.g. Stripe) and per-workspace usage metering. Run a single replica, because workspace documents are cached in memory.

## Built-in AI: OpenRouter

`server/llm.ts` is the only file that talks to a language model. Intake, QA, copywriting, client-message reading and proposals all go through `chatJSON()`.

- **Provider:** with `OPENROUTER_API_KEY` set it calls OpenRouter's OpenAI-compatible API, including attribution headers and usage-based cost reporting. `OPENAI_API_KEY` + `OPENAI_BASE_URL` work as an alternative.
- **Models:** set a model per role with `ASTRA_MODEL`, `COPY_FAST_MODEL`, `COPY_PRO_MODEL`, `COPY_EDIT_MODEL` and `PROPOSAL_MODEL`. Unset roles fall back to `ASTRA_MODEL`, then to `openrouter/auto`.
- **Swapping it out:** to plug in your own OpenRouter client, replace the body of `chatJSON()`. Nothing else needs to change.

## Job Radar: Apify

1. **Saved searches** (source, query, Apify actor, actor input JSON with `{{query}}` and `{{maxItems}}` placeholders, schedule) run on demand or every 6h, 12h or daily.
2. **Normalization:** results are mapped from the field names common across marketplace actors: title, description, budget (fixed or hourly), client verification, spend, rating, proposal count and posted time.
3. **Scoring:** each lead gets a score out of 100:
   - service fit (30)
   - budget vs. your list price and margin floor (25)
   - client quality (20)
   - brief clarity (15)
   - competition and freshness (10)

   Scams (unpaid tests, off-platform contact), rights risks and work you don't offer are **skipped** automatically.
4. **Proposals:** good fits get a draft proposal written from your **firm profile**, which never invents proof. Each draft is checked for length, specificity, a closing question, spam, and pricing above cost. You can edit it, copy it, and mark it applied. **It never submits proposals for you.**
5. **Won jobs** convert into a Studio Operator job in one click, and from there intake, pricing and production take over.

`APIFY_TOKEN` enables live scraping. Set the default actor per source with `APIFY_ACTOR_UPWORK` etc., or set it per search. Actor input formats differ, so check each actor's input schema on Apify. Without a token, runs return a realistic simulated sample.

## Deploying to Railway

The repo includes a `Dockerfile` and `railway.json` (health check `/api/health`).

1. Create a project with a **Postgres** database and a service from this repo.
2. On the service, set:
   - `DATABASE_URL=${{Postgres.DATABASE_URL}}`
   - `SESSION_SECRET=<random>`
   - `NODE_ENV=production`
   - `APP_URL=https://<your-domain>`
   - your `OPENROUTER_API_KEY`, `APIFY_TOKEN` and `HIGGSFIELD_API_KEY`
3. Generate a domain. Keep the service at **one replica**.

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

Each workspace creates an **agent token** in **Settings → Agent access**. The token only reaches that workspace, and actions taken with it are logged as `agent`.

**Claude Code / Claude Desktop (stdio)** works with a local or deployed instance:

```bash
claude mcp add studio-operator \
  -e STUDIO_API_URL=https://your-app.up.railway.app \
  -e STUDIO_API_TOKEN=so_agent_… \
  -- npx -y tsx /path/to/UpAstra/server/mcp-stdio.ts
```

**Remote agents (Astra, Claude API, other MCP platforms):** use Streamable HTTP at `https://your-app/mcp` with the header `Authorization: Bearer so_agent_…`.

Check your platform's current MCP connector docs for the exact field names.

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
