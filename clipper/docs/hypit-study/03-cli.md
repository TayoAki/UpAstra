# 03 · CLI & companion

**Batch:** 03 "CLI & companion"
**Source:** `hypit` at commit `dc2b7a8f31b1ef1443a79ca448548d69e3ceb6a0` (read-only; nothing installed, built or run)
**Packages:**

| Package | src lines | test lines | README | Tests |
| --- | --- | --- | --- | --- |
| `packages/cli` (`@hypit/cli`) | 6,261 | 3,973 | 204 | 122 `test(...)` declarations (17 files) |
| `packages/studio-companion` (`@hypit/studio-companion`) | 1,083 | 33 | 386 | 2 |

The two packages have about 7.3k source lines. The brief's focus verbs (`transcribe`, `media tile/tiles/frames/boundaries`, `download`, `capture`, `estimate`) are **not in `@hypit/cli`**. They are contributed command modules that the root `package.json` mounts explicitly (`package.json:162-174`). I read their command surface (help text, options, JSON output) to complete the verb map in §1.3, but not their algorithms. Those belong to other batches.

---

## 1. `@hypit/cli`

### 1.1 Purpose

A domain-neutral command host for the "long compilation" model: **check** sources, **plan** and **price** a Build, **submit/follow** it to a Runtime Worker, then browse **Results** (`builds`, `history`, `inspect`, `get`, `logs`). It owns argument parsing, help, output encoding, exit codes and command-module composition. Video-specific verbs are plugged in as `hypit.cli-command@1` modules that cannot shadow its roots (`packages/cli/src/application.ts:18-29`, `:53-79`).

### 1.2 Public surface

**Exports** (`packages/cli/src/index.ts:1-40`):
- `runCli`, `runCliApplication`, `indexCliCommandModules`, `runNodeCli`, `runInstalledCliApplication`;
- `writeCliOutput`, `renderCliError`, `writeCliHelp`, `commandHint`;
- the immediate-request helpers `openCliRuntimeHost`, `selectCliProvider`, `createCliScratchResources`, `cliProviderLine/View` (`immediate.ts:15-84`);
- `loadRunFile`, `resolveBuildResultValue`, `discoverSourcePackages`, `loadDiscoveredSourcePackages`;
- the types `CliDistribution`, `CliRuntimeHost`, `CliIo` and the machine views.

The structural ABI for third-party command packages is `src/public.ts:1-12`.

**Generic root verbs** (reserved names, `command.ts:10-28`; parser `arguments.ts:53-232`):

| Verb | Synopsis | Needs Runtime? | JSON `format` |
| --- | --- | --- | --- |
| `check <source>` | Validate an Author or Run source without executing (`main.ts:198-264`) | no | `hypit.cli-check@1` |
| `plan <run>` | Targets, every demanded request, Endpoint resolution, preflight (`main.ts:493-578`) | optional | `hypit.cli-plan@1` |
| `pricing <run>` | Provider rate documents grouped by request shape; never totals (`main.ts:506-521`, `output.ts:694-723`) | yes | `hypit.cli-pricing@1` |
| `build <run> [--follow] [--title] [--max-wait-ms]` | Preflight, then submit one durable Build, optionally follow (`main.ts:265-492`) | yes | `hypit.cli-build@1` |
| `builds [--limit --before]` | Results newest first, cursor paging (`commands/results.ts:47-78`) | no | `hypit.cli-builds@1` |
| `history <output> [--source]` | One named Output across Builds (`results.ts:80-115`, `result-query.ts:15-46`) | no | `hypit.cli-history@1` |
| `inspect <build> [--output]` | Targets and highlighted Outputs, failures, receipts (`results.ts:117-158`) | no | `hypit.cli-inspect@1` |
| `get <build> --output <name> --to <path>` | Export one Output atomically (`result-export.ts:119-157`) | no | `hypit.cli-get@1` |
| `logs <build> [--lines]` | Execution phases and diagnostics, tail plus omitted count (`commands/execution.ts:55-106`) | finished: no; active: yes | `hypit.cli-logs@1` |
| `status <build> [--watch]` | Work vs. Result state (`execution.ts:108-141`, `:222-309`) | finished: no | `hypit.cli-status@1` |
| `activity [--watch [--jsonl]]` | Active Builds and phases; capacity with `--verbose` (`execution.ts:164-220`) | yes | `hypit.cli-activity@1` |
| `cancel <build> [--reason]` | Request cancellation (`execution.ts:357-384`) | yes | `hypit.cli-cancel@1` |
| `result finish/discard/edit <build>` | Finish an interrupted Result write, discard a submission, or set title/note/highlights (`execution.ts:148-160,311-355`; `results.ts:160-185`) | finish/discard: yes | `hypit.cli-result-*@1` |
| `auth status/login/logout <endpoint> [--slot] [--from]` | Credential presence and OAuth/secret entry (`commands/environment.ts:62-151`) | yes | `hypit.cli-auth-*@1` |
| `doctor [profile] [--endpoint]` | Diagnose project Results and optionally the Runtime (`environment.ts:36-60`) | optional | `hypit.cli-doctor@1` |
| `version [--check] [--registry]` | Distribution version and npm latest (`version.ts:40-108`) | no | `hypit.cli-version@1` |
| `cli status/use/remove` | Edit `package.json` `hypit.cli.use` (`installed-application.ts:219-275`) | no | `hypit.cli-composition@1` |

**Common options** are `--json`, `--color`, `--no-color`, `--verbose` and `--debug` (`arguments.ts:42`). Every other option is allowlisted per command, and an unlisted one throws `"<opt> does not apply to <cmd>"` (`arguments.ts:299-305`). Non-repeatable options throw on repeat (`:339-343`). `--out` is rejected on purpose with a pointer to `get` (`:373-375`).

### 1.3 Full verb surface as mounted (contributed modules, surface only)

These are listed from their module declarations. They are outside this batch, so this covers only the surface:

| Root | Module | Sub-verbs and key options | Notes |
| --- | --- | --- | --- |
| `runtime` | `@hypit/runtime-local` (`runtime-local/src/cli.ts:366`) | `init`, `use`, `unset`, `up`, `status`, `logs`, `down` (`:352-356`) | Local Worker lifecycle |
| `programs` | same | `prepare`, `up`, `status`, `down` with `--endpoint` (`:357-358`) | Local model servers (e.g. WhisperX) |
| `paths` | same | `--project`, `--runtime` (`:359-360`) | Where state lives |
| `media` | `@hypit/media-local` (`media-local/src/cli.ts:8`) | `probe`, `cut`, `frames`, `tile`, `tiles`, `boundaries` (`media-local/src/files.ts:19`) | Local only: "No Runtime Profile, network request or project state" (`files.ts:824`) |
| `transcribe` | `@hypit/whisperx` (`whisperx/src/cli.ts:143`) | `<audio/video> --to <json> --language <code>` (`:87`) | One immediate request with no Build state (`:89`) |
| `estimate` | `@hypit/speech-estimate` (`speech-estimate/src/cli.ts:143`) | `--text` or `<svml> --segment`, plus `--pace` or `--rate`, `--rounding`, `--padding` (`:87-89`) | Speech duration estimate |
| `download` | `@hypit/yt-dlp` (`yt-dlp/src/cli.ts:81`) | `<url> --to <video.mp4>`; `download prepare` (`:44,54`) | Reference or source video |
| `capture` | `@hypit/browser-capture` (`browser-capture/src/cli.ts:194`) | `screenshot <url> --to` with `--selector/--clip/--viewport/...` (`:11-32`) | Web page capture |
| `vocabulary` | `@hypit/video` (`video/src/commands.ts:9`) | Installed packages and Surfaces | Author vocabulary discovery |
| `studio`, `snapshot` | `@hypit/studio` (`studio/src/cli.ts:6`) | `studio --run <build.svrun>`, `snapshot --studio <url>` (`:49`) | Browser editor and frame grabs |

**Media verbs in detail** (`files.ts:806-826`). These are the most interesting for us:
- `media frames <file> (--at s,s | --every s | --every-frame) [--label-time] [--transcript json] --to <dir>`: individual frames named by source time. `--transcript` prints word times and context under each picture.
- `media tile <file> [--start/--end | --at] [--every | --frames n] [--cell px] [--columns n] --to grid.jpg`: one contact sheet.
  - Defaults: 3 columns (`files.ts:403`) and 480 px cells (`:404`).
  - The frame count is `clamp(round(seconds×1.5), 4, 9)` (`:406`).
- `media tiles ... [--ranges json] [--every-frame] [--rows n] --to <dir>`: paginated grids, 3 rows by default (`:708`). A ranges file holds `{start,end,id?,frames?,every?}`, and each range is strictly validated (`:659-671`).
- `media boundaries <file> [--rate] [--threshold]`: mechanical adjacent-frame change scores at 12 samples/s with threshold 0.1 by default (`:467-468`). The help says these are "never editorial shot labels" (`:819`).
- **Phrase addressing:** every sampler accepts `--around "<phrase>" --transcript <json>` in place of `--start/--end`. A repeated phrase errors unless `--occurrence n` is given (`:511-527`). `--padding` defaults to 0.3 s (`:522`).
- **Outputs:** commands refuse to overwrite and write only what `--to` names (`:826`).

### 1.4 How it works

**Dispatch and context** (`main.ts:52-582`, `application.ts:87-132`, `installed-application.ts:278-320`)
- Help is resolved first (`main.ts:58-63`).
- The project is found upward through a `package.json` with `hypit.project: true`, or set with `--project` (README:131-135). The Runtime Profile comes from `--runtime` or the project's selection (`main.ts:110-118`).
- Commands split into four families: environment (`doctor/auth`), project-result (Runtime-free), execution (`logs/status/activity/cancel/result finish|discard`), and author (`check/plan/pricing/build`) (`main.ts:119-159`).
- Runtime hosts are memoized per `(profile, packageRoot)` (`main.ts:85-101`).

**Build path: "refuse before spending"** (`main.ts:265-345`)
1. Load and compile the Run (`:273-291`).
2. Evaluate deterministic Producers only, to learn every external request ("Need") before execution (`build-planning.ts:247-326`).
3. Resolve an Endpoint for each request (`describePlanProviders`, `:354-377`).
4. `assertPlannedRequests` throws on any unresolved, ambiguous or unsupported request, ending with "No Build was queued and no external request was made." (`build-planning.ts:409-439`).
5. Cheap `preflight` runs on only the demanded Endpoints (`:441-460`). `assertPreflight` refuses on any error-severity diagnostic (`main.ts:333`).
6. `ensureExecution` starts the Worker (`main.ts:334-341`). Then comes one `runtime.build(request)` with a fresh time-ordered Build id (`main.ts:32-34`, `:344`).

A test checks this whole sequence: a preflight error means no Program is started and nothing is submitted (`test/build-programs.test.ts:171-188`).

**Plan output.** `plan` keeps every target, request and diagnostic in both encodings. `--limit` bounds only expanded detail (`output.ts:150-176`). The exit code is 1 on any preflight, request or producer failure (`main.ts:576-578`).
- **Human rendering** groups requests by "shape" (fields, reference counts, pending inputs). Text lengths are bucketed as `<words>`, so prompts that differ only in length collapse into one `×N` line with a range (`output.ts:442-495`).
- **Word measure:** prompts are summarized as "N words", or "N chars" for CJK (`build-planning.ts:172-179`).
- **Pricing** factors shared parameters out of each group and keeps the varying combinations (`output.ts:652-691`). It never computes a total (`output.ts:869`).

**Observation** (`observation.ts`)
- Polling starts at 100 ms and doubles to 1 s while nothing changes (`:134,146`).
- Progress lines are coalesced to at most one per 5 s (`:11`). Heartbeats fire at 30 s, then every 60 s (`:8-9`).
- The comparison key deliberately ignores Worker scheduling churn (`ready/running/waiting` → "working", `:35-41`) and capacity leases (`:76-90`).
- If the Worker stops, observation throws with two copy-paste evidence commands (`runtime status`, `logs <id>`) (`:160-168`), not a misleading "Result read failed".
- Progress goes to `writeProgress` (stderr), so stdout stays the single final JSON (`main.ts:376-381`, `node-application.ts:52-53`).

**Results without a Runtime**
- `builds`, `history`, `inspect`, `get` and `result edit` open only the project Result repository (`main.ts:133-146`).
- `history` scans pages of at least 32 Builds until it has `limit` matches, and returns a `before` cursor (`result-query.ts:26-45`).
- `get` writes into a temp `.part-<uuid>`, then renames it, and refuses an existing destination (`result-export.ts:61-75`). A composite Output becomes a directory holding `value.json` plus its files, with path containment checked (`:35-41`, `:77-116`).

**Errors and exit codes**
- JSON errors use `{format:"hypit.cli-error@1", ok:false, error:{code,message,help?,trace?}}` (`output.ts:1028-1039`).
- Usage errors carry `code: "CLI_USAGE"` and `help: "hypit help <cmd>"` (`usage-error.ts:2-8`, `arguments.ts:44-51`).
- Commands call `io.setExitCode(1)` for semantic failures while still printing their result. Examples: a plan with issues, a failed Build, an unavailable log (`main.ts:486`, `execution.ts:104`).

**Command hints.** Every "next step" line is a fully scoped, shell-quoted command that keeps `--project/--runtime` (`command-hint.ts:8-20`, used e.g. `main.ts:435-485`). The README says the CLI "formats these existing commands; it does not choose which one the Agent must execute next" (README:86-89).

**Immediate requests** (used by `transcribe`). `selectCliProvider` resolves the single Need against the Profile before any spend, and gives specific errors for no Endpoint, an ambiguous binding or an unsupported request (`immediate.ts:47-69`). A `MemoryResourceStore` scratch area means no Build or Result state is created (`immediate.ts:15-17`). `transcribe` then streams phase changes to stderr and writes a `hypit.whisperx-transcribe@1` view (`whisperx/src/cli.ts:116-138`).

**Credentials**
- `auth login` uses an Endpoint-declared OAuth PKCE flow: S256 challenge, `state = nonce.port`, a loopback server on `127.0.0.1:0` with CORS and Private-Network-Access preflight, and a timeout on the token exchange (`oauth.ts:80-222`).
- Otherwise it reads a hidden TTY secret with UTF-8-aware backspace (`secret-input.ts:9-20`, `node-application.ts:9-35`) or takes `--from <file>`.
- An environment-owned credential is refused with a hint (`environment.ts:108-113`).

**Composition security.** A project command package must be a direct dependency (`installed-application.ts:87-95`) and named explicitly in `hypit.cli.use`. Installing it alone grants nothing (`test/installed-application.test.ts:83-90`). Distribution and project contributions cannot claim the same root, and neither can claim a generic root (`application.ts:53-79`).

### 1.5 Tests (122 declarations, about 532 `assert.*` calls)

- **Preflight ordering:** `build` refuses before provisioning (`build-programs.test.ts:171`). `--follow` output order is submitted → `· Working` → "Build still active", with scoped `status --watch`/`cancel` hints (`:204-271`).
- **Plan:** `plan --json` sets `ok:false` and exit 1 when preflight fails, and `steps` is absent without `--verbose` (`:273-298`).
- **Pricing:** producer failures keep exit 1 in both encodings (`:300-324`). 24 no-charge requests are summarized while all 15 priced ones are kept (`output.test.ts:238`).
- **Option discipline:** bad options fail closed, e.g. `--asset-root` on `status`, a repeated `--runtime`, `--json` with `--jsonl` (`control-commands.test.ts:428-465`).
- **Encodings:** JSON mode writes exactly the machine object with no ANSI (`output.test.ts:59-71`).
- **Results:** `get` exports bytes and a self-contained composite dir with `value.json` (`build-results.test.ts:192-277`). History paging keeps the project and source query (`:727`) and survives a deleted source dir behind a symlink (`:744`).
- **Logs:** an unavailable log is unsuccessful, while an empty log is valid (`build-results.test.ts:763`).
- **Observation:** it ignores Worker churn and coalesces progress (`observation.test.ts:48`). A stopped Worker ends watching with scoped evidence commands (`control-commands.test.ts:721`).
- **Auth and composition:** auth never opens the execution Runtime (`control-commands.test.ts:496`). Project command packages cannot shadow `build` (`installed-application.test.ts:92`).
- **OAuth:** a Windows `cmd start` quoting regression is covered (`oauth.test.ts:87-125`).
- `programs-command.test.ts` and `runtime-selection.test.ts` (29 tests) exercise the **runtime-local** module through this host (`programs-command.test.ts:11`).

### 1.6 Quality notes

**Strengths**
- **A real dry run.** `plan`/`pricing` evaluate deterministic producers and resolve every paid request *before* anything is queued, then refuse with a precise message (`build-planning.ts:409-439`). This is the strongest idea in the batch.
- **Agent-grade I/O contract.** Every result is a versioned `format` object. Errors are parseable with a `help` pointer. Progress goes to stderr. Exit codes separate "the command answered" from "the answer is bad".
- **Fail-closed parsing.** Unknown and misplaced flags error instead of being ignored (`arguments.ts:299-305`).
- **Safe file output.** `get` and `media` refuse to overwrite and write atomically.
- **Scale-aware rendering.** Grouping repeated requests (`output.ts:483-495`) keeps a 40-request plan readable.

**Weaknesses, bugs and smells**
- **`--project=<dir>` is half-supported.** The installed host accepts the `=` form (`installed-application.ts:176`), but the generic parser treats any `--x=y` as unknown (`arguments.ts:423`), so `hypit plan run.svrun --project=/p` fails after the host already resolved it.
- **Dead code.** `rejectDuplicateProfile` (`arguments.ts:496-503`) and `usage()` (`:505-511`) have no caller in `cli/src` or `runtime-local/src`.
- **OAuth wait has no deadline.**
  - Only the token exchange has a timeout (`oauth.ts:177`). The wait for the browser callback (`:175`) has none, so `auth login` hangs forever if the tab is closed.
  - `JSON.parse(body)` on a 200 non-JSON response is unguarded (`:204`).
- **Possible duplicate Runtime host.** `build` may open a second host when `--package-root` differs, because the memo key includes packageRoot (`main.ts:325` vs `:342`).
- **Non-atomic manifest edit.** `cli use/remove` rewrites the user's `package.json` with `writeFile` and reformats it to 2-space JSON (`installed-application.ts:239,250`).
- **No exit for agents.** `activity --watch` is an unbounded `while(true)` with a 1 s sleep (`execution.ts:215-218`). That's fine for a human; an agent must use `--jsonl` and kill it.
- **Inconsistent JSON views across modules.** `media` JSON outputs have no `format` field (`media-local/src/files.ts:562,630,647,730,796`), unlike the `hypit.cli-*@1` convention.
- **Abstract vocabulary.** Prose and messages are very abstract ("Distribution", "Candidate", "Satisfaction", "Need"). The README spends many lines on philosophy (README:71-94), and the cognitive load is high.

### 1.7 Relevance to UGCMediaClips: **High** (for the agent/MCP surface)

We already expose our product to agents over MCP, with 25 tools in `server/mcp.ts`, and in-app through the same tools in memory (`server/agent.ts:141-145`). Hypit is the most complete example in this codebase of a **CLI designed to be driven by an agent**: versioned machine views, dry-run with refusal before spend, observation that does not own execution, scoped next-step hints, and cheap local "eyes" (`media tile/frames/boundaries`, `transcribe`).

---

## 2. `@hypit/studio-companion`

### 2.1 Purpose

A data-only ABI (`hypit.studio-companion@1`) through which component packages tell Hypit Studio how to draw their outputs on a timeline: lanes, items, previews and inspector fields. It also declares how a timeline gesture inverts back into an exact source edit. It contains types plus a handful of pure helpers. Studio itself owns DOM, CSS and writes (README:262-264).

### 2.2 Public surface

**Facet constructors** (`src/index.ts:805-832`):
- `createStudioTrackCompanionFacet(tracks)`;
- `createStudioCompanionFacet({tracks, films, temporalDomains, temporalDeclarations, temporalRelations, parameters})`.

**Host-side qualification:** `studioContributionFromPackage(owner, facets)` (`:850-892`) and `studioTrackCompanionsFromPackage` (`:898-903`).

**Helpers:**
- value lookups: `sameSurfaceValue`, `requiredSurfaceValue`, `requiredReferencedValue` (`:917-946`);
- display layers: `artifactPreview`, `previewLayer`, `textLayer` (`:948-965`);
- lineage: `temporalBindingsFor`, `temporalLineageFor`, `temporalDomainSource` (`:968-1029`);
- authored identity: `authoredChildFor`, `authoredItemTitle`, `childItems` (`:981-1083`).

**Main types:**
- `StudioTrackCompanion` (`:601-628`), `StudioItemDraft` (`:544-567`);
- `StudioInspectorFieldDeclaration` with 7 finite controls (`:118-121`, `:187-203`);
- `StudioSourceBindingDeclaration` (`:227-244`);
- `StudioEditHandle` (`:302-321`);
- `StudioTemporalRelationCompanion` (`invert` and `trace`, `:776-798`).

### 2.3 How it works

- **Identity.** Package-local ids are qualified as `<physical package>#<id>`, and a local id containing `#` is rejected (`:843-848`). An executable facet therefore cannot impersonate an official companion (README:203-207). Tested at `test/identity.test.ts:26-33`.
- **Exact matching.** Companions match outputs by full `TypeRef` and origins by `ModuleRef + Surface` (README:186-189). `requiredReferencedValue` demands exactly one reference with that input name and exact type, and throws otherwise (`:931-946`).
- **No ordinal guessing.**
  - `authoredChildFor` matches by explicit `id` or by a typed value whose `.id` equals the authored id. More than one match throws (`:981-997`).
  - `temporalLineageFor` returns undefined for no match (read-only) and throws on ambiguity (`:999-1010`).
  - Tested at `identity.test.ts:9-24`.
- **Edit authority.** An Inspector field is editable only if its binding resolves to a source `edit` endpoint (`:213-224`). Timeline handles carry explicit sources and temporal authority (`:302-321`). Inversion through package-private producers is delegated to `temporalRelations[].invert`, which returns candidate plans. Studio composes them and commits only a unique survivor (README:236-242).
- **Frame model.** Intervals are half-open (`startFrame`, `endFrameExclusive`, `:548-549`), and `stackOrder` breaks ties (`:550-551`).

### 2.4 Tests

Two tests (`test/identity.test.ts`):
- typed child lookup works and is version-exact (`:9-24`);
- relation ids are qualified (`:26-33`).

Nothing tests the larger helpers (`childItems`, `temporalDomainSource`, `authoredItemTitle`) inside this package.

### 2.5 Quality notes

**Strengths**
- The API is strictly data-only. Companions can't inject DOM, CSS or filesystem writes (README:262-264).
- The "exact identity or nothing" rule runs throughout, with ambiguity raised as an error rather than a guess.

**Weaknesses**
- The DTO surface is very large and stringly typed in places. For example, `StudioPlacement.attributes: Record<string,string>` (`:484`), and `StudioTemporalConsumerInput.type` repeats `TypeRef`'s shape instead of reusing it (`:96`, `:102`, `:445`).
- `childItems` always uses `renders[0]` as `presentId` without ordering (`:1069-1071`).
- `studioContributionFromPackage` validates only `format` and `tracks` being an array (`:864-866`). Malformed films or relations surface later.
- Test coverage is very thin for a stable ABI.

### 2.6 Relevance: **Low**

We embed OpenReel and don't author a timeline editor or source language. One transferable concept is medium-low: **timeline edits that write back to the plan**. Today an OpenReel save replaces the clip's MP4 (README "Save to UGCMediaClips"), and the clip plan no longer describes the video. Hypit's "a timeline item carries lineage to the exact source endpoint, or it is read-only" is the principled version of that.

---

## 3. Comparison with our agent surface

### 3.1 What we have

`server/mcp.ts` registers 25 tools plus one prompt:
- **Campaigns and plans:** `overview`, `brief_to_shorts`, `add_campaign`, `get_campaign`, `find_moments`, `plan_clips`, `make_variants`, `edit_clip`, `review_clip`.
- **Formats:** `clone_format`, `list_formats`, `get_format`.
- **Renders and captions:** `get_clip`, `render_clip`, `wait_for_renders`, `caption_video`, `get_caption_job`.
- **Publishing:** `list_social_accounts`, `schedule_clip`, `list_schedule`, `cancel_scheduled_post`.
- **Tracking and learning:** `log_post`, `update_post_metrics`, `list_posts`, `whats_working`.

Tools call our HTTP API (`mcp.ts:16-29`) and return pretty JSON or `Error: <message>` (`mcp.ts:42-43`).

The in-app agent (`server/agent.ts`) reuses them in memory:
- it is capped at 30 steps (`agent.ts:16`) and truncates tool results to 12k characters (`:17,56`);
- it pauses only for publishing tools (`:15`, `:194-200`).

Our tools are **workflow-level**: one call does brief → plans → renders. Hypit's are **primitive-level plus a dry run**: plan, then price, then build, then observe, then export. It also has local "eyes" for media.

### 3.2 Verb-by-verb gap table

| Hypit verb | What it gives an agent | Our equivalent | Gap |
| --- | --- | --- | --- |
| `media probe` | Duration, streams, size, fps | `server/media.ts:68` `probe()`, internal only | **Missing tool** (cheap; useful before planning cuts) |
| `media frames --at/--every [--transcript]` | Time-named stills, optional word context | No tool. Our moments pipeline makes a 1 fps preview with burned timestamps (`server/media.ts:81-105`) but never returns frames | **Missing: `get_frames`** (clipId/footageId + times → image URLs) |
| `media tile` / `tiles` | Contact sheet(s) of a span, phrase-addressable | None | **Missing: `contact_sheet`**. Highest value: lets Claude *see* a footage span or a rendered clip before approving or editing |
| `media boundaries` | Scene-change candidates with scores | `server/formats.ts:89` uses `select='gt(scene,0.3)'` internally for format cloning | **Missing tool**. Expose cut candidates per footage file |
| `media cut` | Trim or join evidence clips | Internal `cutSegment` (`media.ts:107`) | Low priority as a tool. Renders already cut |
| `transcribe` | Word-timed transcript JSON, no Build state | `caption_video` transcribes *and* renders. `get_caption_job` returns plain joined text (`mcp.ts:116`), not word times. The API has `/captions/:id/transcribe` (`app.ts:890`) | **Partial.** Add `transcribe` (url or footageId → words with times, language) without rendering |
| `estimate` | Speech duration for a script | QA checks "voiceover fits the length" internally (README) | **Missing tool**. `estimate_voiceover(text, voice)` would let the agent fix length before `edit_clip` |
| `download <url>` | Fetch a reference video from a page URL | `clone_format` requires a *direct file* link and says "not a TikTok/Instagram/YouTube page" (`mcp.ts:292`) | **Gap** (product decision: ToS and cost) |
| `plan` | Dry run: every paid request and readiness, refusal reasons | `plan_clips` writes plans and QA, but there is no preview of render cost, missing footage or quota | **Missing: `preflight_render` / dry-run flag** |
| `pricing` | Provider rate material per request group | Costs are only in prose (README: ~$0.01/analysis, ~$0.001/voice) and in usage metering (`/usage`, `app.ts:503`) | **Missing: `estimate_cost`** (per clip or campaign, from our own metering table) |
| `build --follow` | Submit plus bounded observation, progress to stderr | `render_clip` + `wait_for_renders` (polls full `/state` every 5 s, `mcp.ts:375-385`) | Equivalent, but polling is heavy (see §4) |
| `status <id> [--watch]` | Work vs. Result state for one id | `get_clip` (render status) | OK |
| `activity` | All active work and phases | `overview.rendering` (`mcp.ts:190`) | OK |
| `cancel <id>` | Cancel queued or active work | **none** for renders (only `cancel_scheduled_post`) | **Missing: `cancel_render`** |
| `logs <id> [--lines]` | Tail of execution phases and diagnostics, omitted count | `render.step` / `render.error` only (`mcp.ts:59`) | **Missing: `get_render_log`** (ffmpeg stderr tail, per-step timings) |
| `builds`, `history <output>` | Paged Result history with cursor | `get_campaign` lists all clips; nothing pages | Low. Fine at our scale, but `/state` grows unbounded per call |
| `inspect <id>` | Targets, highlighted Outputs, failure receipts | `get_clip` | OK |
| `get --to` | Atomic export of an Output | 7-day share link (`get_clip`, `/clips/:id/link`) | OK for SaaS |
| `result edit --title/--note/--highlight` | Annotate Results | `edit_clip` covers plan fields only | Low |
| `auth`, `doctor` | Credential and setup diagnostics | `overview.services` (`ServiceStatus`) | OK (we own the keys) |
| `vocabulary` | Discover installed components | Caption styles and voices are enumerated in tool schemas (`mcp.ts:123,399`) | OK |

### 3.3 How Hypit expects an agent to drive it (vs. us)

**Hypit's loop:**
1. `media probe/tiles/frames` and `transcribe` on references and sources. These are local, need no state, and refuse to overwrite.
2. Write Sources and a Run.
3. `check`, then `plan --runtime`, then `pricing`.
4. `build --follow --max-wait-ms N`, then `status --watch` or `activity`.
5. `inspect`, then `get --to`. `studio`/`snapshot` for review.

At every step the agent reads one JSON object on stdout and a non-zero exit when the answer is bad. Next steps arrive as scoped shell commands. The orchestration policy lives in the Skill (`skills/hypit/SKILL.md:234-237` on `--follow` only detaching; `:317` routing to `references/production/builds.md`), not in the CLI.

**Our loop** packs the policy into tools (`brief_to_shorts` auto-approves passing plans, `mcp.ts:165-179`) and into the server `instructions` string (`mcp.ts:130-136`). That suits clippers. The cost is that the agent can't **look** at footage or a render, can't **dry-run** spend, and can't **cancel** or **diagnose** a render.

---

## 4. Ideas worth taking (ranked)

1. **Visual inspection tools for the agent (`contact_sheet`, `get_frames`, `scene_cuts`).** Port the `media tile/tiles/frames/boundaries` semantics to MCP tools that return image URLs (or MCP `image` content).
   - Inputs: footage id or clip id, `start/end` or `at[]`, `frames` or `every`, and optionally `aroundPhrase` resolved against our whisper words.
   - Reuse what we have: `buildProxy`'s timestamp `drawtext` (`server/media.ts:90`) and `formats.ts:89` scene detection.
   - Keep Hypit's defaults: 3 columns × 480 px cells, `clamp(round(1.5·s), 4, 9)` frames, 3 rows per page, and phrase addressing with `--occurrence` disambiguation.
   - It's CPU-cheap (one ffmpeg pass, no model), so it fits Railway, and it lets Claude Desktop/Code review a render before `schedule_clip`.
2. **Dry run with refusal before spend.** Add `preflight_render(clipIds)` and/or a `dryRun: true` on `render_clip`/`brief_to_shorts`.
   - It returns per clip: footage cached or missing, moments analyzed or pending (a vision cost), voice cost, render-queue position, remaining workspace quota, and blocking issues.
   - In the real path, refuse before queuing with a message in the style of "No render was queued and nothing was charged" (pattern from `build-planning.ts:409-439`).
   - This matters most for unattended automation and per-tenant metering.
3. **A versioned machine contract for tool results.**
   - Give every tool result a `format: "ugc.<tool>@1"`.
   - Make errors structured, `{ok:false, error:{code, message, help}}` (pattern from `output.ts:1028-1039`), instead of `Error: <text>` (`mcp.ts:43`).
   - Keep `isError`, but give the model a stable `code` (`QUOTA_EXCEEDED`, `FOOTAGE_MISSING`, `QA_FAILED`, ...) to branch on.
4. **Fail-closed tool arguments.** zod objects strip unknown keys by default. A model that sends `formatID` or `autorender` today gets silently ignored values. Use strict schemas so typos error (the Hypit equivalent is `arguments.ts:299-305`). This is a one-line change per tool.
5. **A consistent `next` field with exact tool calls.** Only `brief_to_shorts` and `clone_format` return `next` (`mcp.ts:214,296`). Adopt the command-hint idea: every state-changing tool returns `next: [{tool, args, why}]` with ids filled in. Hypit keeps this scoped and doesn't pick the action for the agent (README:86-89). That fits our in-app agent's 30-step budget (`agent.ts:16`).
6. **A standalone `transcribe` tool.** Take a URL or footage id and return word-timed JSON plus language, without rendering. We have the pieces (`server/transcribe.ts:42`, `/captions/:id/transcribe`). `get_caption_job` currently returns joined text, which drops timing (`mcp.ts:116`).
7. **`cancel_render` and `get_render_log`.** Mirror `cancel` and `logs --lines` (tail plus `omittedRecords`, `execution.ts:89-103`). This turns "render failed" into something an agent can fix.
8. **Cheaper, better-behaved waiting.** `wait_for_renders` fetches the full `/state` every 5 s (`mcp.ts:383-384`). Adopt Hypit's observation shape:
   - a per-clip status endpoint;
   - backoff from 100 ms to 1 s on change, or our 5 s;
   - a stopped-worker check that ends the wait with evidence instead of timing out silently (`observation.ts:160-168`).
9. **`estimate_voiceover`.** Return speech duration for a script and voice, so the agent fixes length before rendering. This mirrors `estimate`.
10. **Atomic, no-overwrite writes for exported artifacts** (`result-export.ts:61-75`). Low priority: our storage keys are already unique.

## 5. Things not to copy

- **Local Runtime Profiles, Workers, Programs, Endpoint bindings and `auth login`.** We're multi-tenant and own the provider keys. Per-user credential stores and an OAuth loopback (`oauth.ts`) solve a desktop-tool problem we don't have. Outstand already handles social OAuth.
- **Package-installed command composition** (`installed-application.ts`, `hypit.cli.use`). We are not a distribution others extend, and dynamic `import()` of project packages (`:128`) would be a supply-chain liability on a shared server.
- **Leaving orchestration policy entirely to a Skill.** Hypit's CLI refuses to choose a next action (README:86-89), and the 328-line Skill plus about 40 reference docs carry the workflow. Our users and automations need `brief_to_shorts`-style one-call paths that work with no agent in the loop. Keep workflow tools, and add primitives beside them.
- **The Studio Companion ABI.** It is a large data contract for a bespoke timeline and source language. With OpenReel, only the principle "edits must map back to plan fields or be read-only" is worth keeping.
- **Abstract vocabulary in user-facing text** ("Satisfaction", "Candidate", "Need", "Distribution"). Our tool descriptions are plain and should stay that way.
- **Unbounded watch loops** (`execution.ts:215`) and **no-deadline OAuth waits** (`oauth.ts:175`). Any agent-facing wait we add must have a cap, as `wait_for_renders` already does (`mcp.ts:374`, max 240 s).

---

## 6. Coverage table

All files were read in full, except the out-of-batch module files in the last group, which I read for verb surface only.

| File | Lines | Read |
| --- | --- | --- |
| packages/cli/package.json | 31 | ✅ |
| packages/cli/README.md | 204 | ✅ |
| packages/cli/src/application.ts | 132 | ✅ |
| packages/cli/src/arguments.ts | 511 | ✅ |
| packages/cli/src/build-planning.ts | 483 | ✅ |
| packages/cli/src/command-hint.ts | 20 | ✅ |
| packages/cli/src/command.ts | 161 | ✅ |
| packages/cli/src/commands/environment.ts | 152 | ✅ |
| packages/cli/src/commands/execution.ts | 388 | ✅ |
| packages/cli/src/commands/results.ts | 204 | ✅ |
| packages/cli/src/commands/types.ts | 9 | ✅ |
| packages/cli/src/distribution.ts | 75 | ✅ |
| packages/cli/src/immediate.ts | 84 | ✅ |
| packages/cli/src/index.ts | 40 | ✅ |
| packages/cli/src/installed-application.ts | 320 | ✅ |
| packages/cli/src/machine-view.ts | 19 | ✅ |
| packages/cli/src/main.ts | 582 | ✅ |
| packages/cli/src/node-application.ts | 84 | ✅ |
| packages/cli/src/oauth.ts | 291 | ✅ |
| packages/cli/src/observation.ts | 214 | ✅ |
| packages/cli/src/output.ts | 1,056 | ✅ |
| packages/cli/src/paths.ts | 30 | ✅ |
| packages/cli/src/public.ts | 12 | ✅ |
| packages/cli/src/reachability.ts | 91 | ✅ |
| packages/cli/src/result-export.ts | 157 | ✅ |
| packages/cli/src/result-query.ts | 46 | ✅ |
| packages/cli/src/run-file.ts | 232 | ✅ |
| packages/cli/src/runtime-port.ts | 199 | ✅ |
| packages/cli/src/runtime-view.ts | 15 | ✅ |
| packages/cli/src/secret-input.ts | 20 | ✅ |
| packages/cli/src/source-discovery.ts | 149 | ✅ |
| packages/cli/src/source-packages.ts | 91 | ✅ |
| packages/cli/src/usage-error.ts | 8 | ✅ |
| packages/cli/src/version.ts | 108 | ✅ |
| packages/cli/src/view.ts | 278 | ✅ |
| packages/cli/test/application.test.ts | 97 | ✅ (titles and assertions) |
| packages/cli/test/build-programs.test.ts | 324 | ✅ |
| packages/cli/test/build-results.test.ts | 784 | ✅ (titles; `get`/composite test in full) |
| packages/cli/test/command-hint.test.ts | 22 | ✅ (titles) |
| packages/cli/test/control-commands.test.ts | 783 | ✅ (titles; option-discipline test in full) |
| packages/cli/test/installed-application.test.ts | 112 | ✅ |
| packages/cli/test/oauth.test.ts | 176 | ✅ (titles) |
| packages/cli/test/observation.test.ts | 113 | ✅ (titles) |
| packages/cli/test/output.test.ts | 442 | ✅ (titles; JSON-mode test in full) |
| packages/cli/test/plan-needs.test.ts | 64 | ✅ (titles) |
| packages/cli/test/programs-command.test.ts | 405 | ✅ (titles and imports) |
| packages/cli/test/reachability.test.ts | 84 | ✅ (titles) |
| packages/cli/test/runtime-selection.test.ts | 294 | ✅ (titles and imports) |
| packages/cli/test/secret-input.test.ts | 19 | ✅ (titles) |
| packages/cli/test/source-discovery.test.ts | 99 | ✅ (titles) |
| packages/cli/test/version.test.ts | 82 | ✅ (titles) |
| packages/cli/test/view.test.ts | 73 | ✅ (titles) |
| packages/studio-companion/package.json | 20 | ✅ |
| packages/studio-companion/README.md | 386 | ✅ |
| packages/studio-companion/src/index.ts | 1,083 | ✅ |
| packages/studio-companion/test/identity.test.ts | 33 | ✅ |
| *Out of batch, surface only:* packages/media-local/src/cli.ts (22), packages/media-local/src/files.ts (help, options, JSON views at :19, :403-406, :467-468, :496-551, :659-671, :806-826), packages/whisperx/src/cli.ts (80-147), packages/runtime-local/src/cli.ts (help :352-366), packages/{yt-dlp,speech-estimate,browser-capture,studio,video} command modules, root package.json :162-174, skills/hypit/SKILL.md (:225-260, :300-328) | — | partial |
| *Ours:* clipper/server/mcp.ts (584), clipper/server/agent.ts (226), clipper/README.md (1-80) | — | ✅ |

**Test-reading caveat:** I read the source files in full. For the larger test files, I read every test title and the bodies of the representative tests cited above. I didn't trace every line of all 3,973 test lines.
