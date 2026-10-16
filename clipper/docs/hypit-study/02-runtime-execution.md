# 02 — Runtime & execution

- **Batch:** 02, Runtime & execution
- **Source:** hypit at commit `dc2b7a8f31b1ef1443a79ca448548d69e3ceb6a0`. Treated as read-only; nothing was built or run.
- **Packages** (line counts as `src` / `test` / everything in the package directory, including README and package.json):

| Package | src | test | all files |
|---|---:|---:|---:|
| `runtime` | 827 | 0 | 886 |
| `runtime-local` | 6,766 | 4,263 | 11,343 |
| `executor` | 1,100 | 1,112 | 2,258 |
| `run` | 643 | 0 | 682 |
| `endpoint` | 619 | 128 | 914 |
| `credential-store-local` | 493 (incl. 61-line `.ps1`) | 461 | 1,019 |
| `credential-store-env` | 48 | 17 | 101 |
| `producer` | 151 | 0 | 274 |
| **Total** | **10,647** | **5,981** | **17,477** |

Paths below are relative to the hypit repo root (`packages/...`). Our own code is cited as `clipper/server/...`.

---

## How the pieces fit

The main path through these packages, as the code shows it:

1. **`run`** turns a Run document into a sealed `RunGraph`: candidates, operations, satisfactions and targets (`packages/run/src/resolve.ts:72-213`). The kernel (batch 01) turns that graph into a `BuildDefinition`.
2. **`executor`** takes the commands the kernel has outstanding and classifies each one. A command is either runnable, with resource claims, or blocked (missing, ambiguous or unsupported endpoint) (`packages/executor/src/executor.ts:169-252`, `:536-561`).
3. **`runtime`** owns the ports (`BuildStore`, `OperationStore`, `ResourceStore`, `CredentialStore`) and `InProcessBuildScheduler`. The scheduler admits runnable commands across several builds under declared resource limits (`packages/runtime/src/scheduler.ts:54-286`).
4. **`runtime-local`** is the production host. A detached coordinator process supervises "carrier" child processes. Carriers poll SQLite for ready builds, take a build's turn, run one scheduler pass, then release the turn with a `wakeAt` (`packages/runtime-local/src/supervisor.ts`, `executor.ts`, `worker.ts`, `sqlite-state.ts`).
5. **`endpoint`** is the provider SDK. An endpoint is either immediate (one call) or asynchronous (submit, poll, optional collect, optional cancel), and it declares concurrency and rate limits (`packages/endpoint/src/index.ts:144-206`, `:351-476`).
6. **`producer`** is the SDK for pure, deterministic component handlers. They get no credentials, network or stores (`packages/producer/src/index.ts:20-28`).
7. **`credential-store-*`** resolve `CredentialRef {store, key}` to secrets. They are combined by `CompositeCredentialStore` (`packages/runtime/src/credentials.ts:99-125`).

Five design rules run through the whole batch:

- **At most once, never replay.** An immediate command that started but has no stored result fails rather than running again (`packages/runtime-local/src/worker.ts:86-98`).
- **A submit with no receipt is a failure** (`packages/executor/src/executor.ts:388-393`).
- **A lost carrier fails its builds** (`packages/runtime-local/src/supervisor.ts:103-106`).
- **No automatic retries.** The executor never retries (`packages/executor/README.md:18`). Retry policy belongs to each provider (`packages/endpoint/README.md:95-99`).
- **"Try again" means a new build.** It can reuse outputs from the old build explicitly (`packages/runtime/README.md:33`; `packages/run/src/resolve.ts:125-147`).

---

## `@hypit/runtime`

**Purpose.** Environment-neutral contracts for execution: build, operation, resource, credential and command-execution stores, capacity claims, and execution logs. It also ships one reference scheduler that runs ready commands from many builds concurrently in one process.

**Public surface** (`packages/runtime/src/index.ts:1-21`):

| Export | Kind | Where |
|---|---|---|
| `CapacityResourceClaim`, `capacityUnits` | Claim type and validation | `packages/runtime/src/capacity.ts:2-24` |
| `CapacityReservation`, `CapacityAcquireRequest`, `CapacityAcquire` | Types | `packages/runtime/src/capacity.ts:27-51` |
| `CredentialRef`, `CredentialValue`, `CredentialStore`, `WritableCredentialStore` | Types | `packages/runtime/src/credentials.ts:1-63` |
| `encodeOAuth2Credential`, `decodeOAuth2Credential` | OAuth2 token JSON codec | `packages/runtime/src/credentials.ts:21-40` |
| `CompositeCredentialStore`, `writableCredentialStore`, `credentialRef`, `verifyCredentialRef`, `isWritableCredentialStore` | Combining stores | `packages/runtime/src/credentials.ts:69-125` |
| `CommandExecutionStore`, `CommandExecutionReceipt` | Live handoff for immediate commands | `packages/runtime/src/execution.ts:3-24` |
| `OperationStore`, `OperationSnapshot`, `OperationUpdate`, `OperationProgress`, `OperationReceipt` | Async work records | `packages/runtime/src/operations.ts:9-99` |
| `ExecutionLogRecord`, `readExecutionLog` | JSONL log format and tail reader | `packages/runtime/src/log.ts:2-51` |
| `InProcessBuildScheduler` | Scheduler | `packages/runtime/src/scheduler.ts:54` |
| `RuntimeCommandExecutor`, `ResourceStore`, `StreamingResourceStore`, `BuildStore`, `isStreamingResourceStore` | Ports | `packages/runtime/src/types.ts:67-140` |

**How it works.**

*Capacity claims.* A claim is `{id, limit, units?, periodMs?}`.
- Without `periodMs`, the claim is **occupancy**: units are held until released.
- With `periodMs`, it is a **token-bucket rate** that "replenish[es] `limit` units per period, with a burst of at most `limit`. Rate units are not returned" (`packages/runtime/src/capacity.ts:1-9`).
- `capacityUnits` rejects non-integer limits and a claim whose units exceed its limit (`packages/runtime/src/capacity.ts:11-24`).
- A blocked acquire says why (`resource-in-flight` or `rate-limit`) and may give an `availableAt` (`packages/runtime/src/capacity.ts:43-51`).

*Operations* are the durable record of asynchronous remote work:
- facts: `createdAt`, `acknowledgedAt`, `endedAt`, the stored `request`, credential refs (never values), `pool`, a public `receipt`, `remoteEnded` and `submission: queued|started|accepted` (`packages/runtime/src/operations.ts:14-25`);
- status: `pending`, `completed`, `failed` or `cancelled`, plus an opaque provider `handle`, `wakeAt` and `progress` (`packages/runtime/src/operations.ts:57-83`).

Cancellation outcomes separate `confirmed` from `accepted`, `unsupported`, `too-late` and `failed` (`packages/runtime/src/operations.ts:65`). Updates to a terminal operation return it unchanged (`packages/runtime/src/operations.ts:95-96`).

*`InProcessBuildScheduler.run`* (`packages/runtime/src/scheduler.ts:65-285`):
- Builds start from in-memory state or from a durable snapshot plus a `BuildMachine` (`:68-97`).
- On each loop it re-prepares every live build. Commands already active, or already attempted in this run, are filtered out (`:130-146`).
- It counts units in use across all active commands (`:148-156`), then admits work round-robin across builds with a rotating `cursor`. Each admitted command must fit **all** of its claims within their limits (`:176-196`).
- If two commands give different limits for the same resource id, the run throws (`:102-111`).
- It waits on `Promise.race` over active promises (`:199`).
- A `pending` (async submitted) or `deferred` (capacity-blocked) result marks the command as attempted, so the pass ends and the host can come back later (`:214-237`).
- `command-failed` stops launching new work, but results from calls already running are still accepted. The failure is applied last (`:240-245`, `:266-268`). A thrown error waits for every active call before rethrowing (`:270-273`).

The scheduler counts rate claims like occupancy, but that is consistent: the registry forbids rate claims on whole-operation resources (`packages/executor/src/registry.ts:49-51`). Rates are enforced only on action admission (see runtime-local).

*Execution log.* `readExecutionLog` keeps a ring buffer of the last `limit` records from a chunk stream. It ignores a trailing partial line, because a live writer may still be appending (`packages/runtime/src/log.ts:27-51`).

*Composite credentials.* `resolve` asks **every** store in parallel and throws if more than one returns a value (`packages/runtime/src/credentials.ts:106-111`). Write ownership uses the structural `owns()` predicate, because "a read cannot prove ownership for a missing key" (`packages/runtime/src/credentials.ts:114-125`).

**Tests.** The package has no tests of its own. The scheduler is exercised by `packages/executor/test/scheduler.test.ts` (11 tests); see executor.

**Quality notes.**
- (+) Small, clear ports. The rate and occupancy split is explicit and type-documented.
- (+) Failure handling keeps already-running siblings' results instead of discarding paid work (`scheduler.ts:240-245`).
- (−) No package-local tests for `readExecutionLog` or `CompositeCredentialStore`. Their behaviour is only covered indirectly (`packages/runtime-local/test/log.test.ts`).
- (−) `resourceCounts()` and the admission loop rescan every active command for each candidate (`scheduler.ts:148-156`, `:181-183`). That is fine for tens of commands, but it is quadratic-ish.
- (note) `CompositeCredentialStore.resolve` asks every store for every lookup (`credentials.ts:108`), but each store checks `owns(ref)` first and returns `undefined` for a foreign store name, so only the owning store (e.g. the OS locker) spawns a process (`packages/credential-store-local/src/os.ts:119-126`, `store.ts:65-80`). The fan-out is cheap. *(corrected in check)*

**Relevance to UGCMediaClips: High.** The claim model is exactly what our three uncoordinated queues lack:
- named resources, integer limits, weighted `units`, and token-bucket rates;
- atomic multi-resource admission;
- round-robin fairness across jobs.

**Better version.** Keep the claim shape `{id, limit, units, periodMs}` and the "acquire all or nothing" rule. Implement it as one in-process admission controller in front of render, caption and format jobs (`cpu:ffmpeg` with weighted units, `ai:openrouter` rate, `whisper` occupancy). Round-robin by **workspace**, not by build. We don't need the kernel, fact log or snapshot machinery.

---

## `@hypit/executor`

**Purpose.** Turns kernel commands into producer calls or endpoint calls. It validates results through type owners before they reach the kernel, and drives asynchronous endpoints through submit, poll and collect, with durable `OperationStore` records. It also offers a direct, sequential `run()` and a producers-only planner.

**Public surface** (`packages/executor/src/index.ts:1-10`):
- `Executor` (`executor.ts:91`), with `prepare`, `prepareExecution`, `executeCommand`, `executeExecutionCommand`, `advanceOperation`, `acceptOperation`, `cancelOperation` and `run` (`:564-685`);
- `ProducerRegistry` (`registry.ts:66-83`), `EndpointRegistry` (`registry.ts:100-234`) with `bind`, `contested`, `capacityConflicts` and `resolve`;
- `MemoryResourceStore` (`resources.ts:4-34`);
- `evaluateProducerPlan` (`planning.ts:23-67`).

**How it works.**

*Classification.* An unknown producer is blocked as `missing-producer` (`executor.ts:174-196`). For a need, `EndpointRegistry.resolve` returns one of four results (`registry.ts:195-232`):
- **bound:** an explicit binding wins;
- **missing**;
- **unsupported:** with each provider's own `supports()` reason;
- **ambiguous:** more than one supported endpoint and no binding.

An asynchronous endpoint without an `OperationStore` is blocked (`executor.ts:232-240`). Default scheduling for an endpoint with no declaration is one slot, `endpoint:<id>`, limit 1 (`executor.ts:245-248`).

*Credentials.* Only the slots the endpoint declares are resolved (`executor.ts:117-147`). Concurrent reads of the same `[store, key]` are coalesced through an in-flight promise map, which is cleared on settle, so nothing is cached (`:127-133`). If the owning store is writable, the endpoint gets a narrow `replace()` that writes only that ref (`:138-143`). This is how OAuth refresh tokens rotate.

*Asynchronous state machine* (`executor.ts:308-460`):
1. **Find or create.** Find the build+command's single operation; more than one throws (`:316-317`). The endpoint id may not change between attempts (`:318-321`). If none exists, create one with the stored `request`, credential **refs**, pool and `submission: "queued"` (`:322-329`).
2. **Wait.** Return the operation unchanged before `wakeAt` (`:382`).
3. **Pick the action:** `collect` if `remoteEnded`, `poll` if a handle exists, otherwise `submit` (`:386-387`).
4. **Guard the submit.** Before calling `start`, the operation is set to `submission: "started"` (`:407`). If a later attempt finds a submit that isn't `queued` and has no handle, the operation fails with `SUBMISSION_INTERRUPTED`. It never submits twice (`:388-393`).
5. **Checkpoint.** `checkpoint()` lets a provider save the remote job id **before** doing more work (`:400-404`).
6. **Admit the action.** Per-action limits (`actions.submit|poll|collect`) go through the runtime's `RuntimeActionExecutor`. A blocked admission becomes `pending` with `progress.phase = "waiting-resource"` and the `wakeAt` from the rate bucket (`:420-430`).
7. **Record failures.** Any thrown error from an action becomes a terminal `ENDPOINT_ACTION_FAILED` that keeps the receipt (`:431-435`).
8. **Map the outcome:** `pending` → new handle and `wakeAt`; `ready` → `remoteEnded` and wake now for collect; `failed`; `completed` → completion is stored but stays `pending` until `acceptOperation` validates it (`:442-459`, `:272-306`).

*Direct `run()`.* Runs the first executable command, reduces, repeats. Any error becomes `command-failed` with code `EXECUTION_FAILED` (`executor.ts:625-685`). `failureMessage` flattens the `cause` chain and error codes (`:73-89`).

*`evaluateProducerPlan`.* Runs every pure producer once with no endpoints installed, to preview the plan. Each failure is reported per step rather than looping (`planning.ts:16-67`).

*Registry diagnostics.* `capacityConflicts()` finds a shared resource id sized differently by different endpoints, e.g. "1 per 100 ms" vs "1 per 200 ms" (`registry.ts:124-143`). `contested()` lists capabilities that more than one endpoint offers (`:146-155`).

**Tests:** 27 tests, about 133 asserts (`driver.test.ts` 11, `scheduler.test.ts` 11, `validation.test.ts` 5). Examples:
- **Secrets stay out of state:** `JSON.stringify(state)` never contains the secret (`packages/executor/test/driver.test.ts:119-148`).
- **`replace()` rotates a credential** (`:150-179`).
- **Ambiguous registrations block** (`:102-117`).
- **Shared capacity:** one endpoint resource is shared across two builds, with peak concurrency 1 (`packages/executor/test/scheduler.test.ts:182-202`).
- **Weighted units:** two 4-unit requests never fit in 6 slots together (`:469-484`).
- **A failure keeps a late sibling's result** (`:227-272`).
- **One submit, then polls:** an async endpoint submits once and is polled to completion across scheduler passes (`:274-317`).
- **Collect can be retried** by returning `pending` (`:376-406`).
- **A single poll transport error fails the operation for good,** keeps the receipt, and never polls again (`:486-504`).
- **A failed build doesn't rerun:** a direct-run failure isn't retried; a new build reruns every producer from scratch (`driver.test.ts:266-290`).

**Quality notes.**
- (+) The at-most-once submit guard (`executor.ts:388-393`, `:407`) is the right default when every submit costs money.
- (+) The receipt and checkpoint split means a crash after the vendor accepted the job leaves a recorded job id, not a lost paid task.
- (+) Credentials never enter persisted state. Only refs are stored with operations (`:326`).
- (−) **Harsh.** One transient poll error (DNS blip, 502) fails the whole build (`scheduler.test.ts:486-504`). Only a provider that catches its own errors and returns `pending` avoids this. Every provider has to re-implement retry and backoff.
- (−) `#advanceOperationStep` reads the operation again after every action (`executor.ts:437`), and `OperationStore.update` itself reads first (`packages/runtime-local/src/sqlite-state.ts:397`). That is two to three SQLite reads per poll. Fine locally.
- (smell) In `acceptOperation`, a cancellation message always blames "the Runtime capacity controller" (`executor.ts:300`), even for user cancellations. The same string is in `packages/runtime-local/src/result-writer.ts:44`.

**Relevance to UGCMediaClips: High** for the submit, poll and collect lifecycle and the receipt and checkpoint idea. We will have async vendors (video generation, Outstand scheduling). Today our voice and vision calls are synchronous HTTP with no durable "accepted" record (`clipper/server/llm.ts:211-230`).

**Better version.**
- Adopt the lifecycle and `submission: queued → started → accepted` as columns on a Postgres job-step row.
- Keep the rule "never resubmit a paid call whose acceptance is unknown".
- **Differ** on transient errors. Give the executor a default bounded retry for `poll` and `collect` (idempotent reads): about 3 attempts with jittered backoff, honouring `Retry-After`. Keep `submit` at most once. This matches our `outstand.ts` 429 handling (`clipper/server/outstand.ts:36-37`) and removes boilerplate from every provider.

---

## `@hypit/endpoint` (SDK `@hypit/hypit/endpoint`, plus `/http`)

**Purpose.** The SDK a provider package uses to declare a configured endpoint instance:
- which capabilities it serves and the result types;
- credential slots and how to log in;
- capacity and rate limits;
- pricing references;
- immediate handlers, or async `start/poll/collect/cancel`.

The `/http` subpath adds transport-evidence helpers that deliberately don't decide outcomes.

**Public surface:**
- `defineEndpoint` (`packages/endpoint/src/index.ts:351-476`), `wakeAfter` (`:478-497`), `actionResourceClaims` (`:132-142`), `endpointResourceClaims` (`:195-206`), `verifyEndpointPricingDocument` (`:93-101`) and `EndpointServiceError` (`:500-502`);
- types `EndpointRequest`, `EndpointOutcome`, `AsyncEndpoint`, `EndpointScheduling`, `EndpointPricing` and `EndpointInstance` (`:62-275`);
- `http.ts`: `EndpointHttpError` (with `retryAfterMs`), `EndpointTransportError`, `EndpointResponseError`, `endpointTransportError`, `transport`, `withRequestDeadline` and `retryAfterMs` (`packages/endpoint/src/http.ts:1-117`).

**How it works.**

*Resources generated by `defineEndpoint`:*
- `pool:<pool>`, sized by `defaultConcurrency` (default **1**) (`index.ts:430`, `:444-447`);
- `capacity:<pool>/<capacity-class>`, sized by `maxConcurrency` (`:449-451`);
- any capability-declared resources (`:452`).

`unitsForRequest(request)` can weight claims per request, e.g. a render that needs 4 browser slots. Only resource ids that are already declared may be weighted (`:195-206`).

*Action limits.* `actionLimits.{submit,poll,collect}` become claims `action:<pool>/<action>` (concurrency) and `rate:<pool>/<action>` (`{limit, periodMs}`) (`index.ts:132-142`).

*Validation:*
- An instance can't repeat a capability (`:357-358`).
- One capacity class can't get two concurrency limits (`:375-377`).
- Async capabilities can't be `transient` (`:368-369`).
- Pricing pages must be HTTPS (`:361-365`).
- Pricing documents must use HTTPS or localhost (`:93-101`).

*Outcomes:*
- `pending` (handle, `wakeAt`, progress); `completed`; `failed`;
- `ready`: remote done, collect separately, so download capacity can differ from task capacity;
- each may carry an optional public `receipt` (`index.ts:144-155`).

`wakeAfter(handle, delayMs)` builds a `pending` result with an absolute `wakeAt` (`:478-497`).

*Transient capabilities.* A provider can mark an immediate capability `transient: true`. That asserts it "submits no paid generation and creates no externally visible side effect", so it may run outside a build (`index.ts:218-224`; README `:85-90`).

*Pricing* is information only:
- `{kind: "page", url}` or `{kind: "local"}`, plus an optional `readPricing(request)` that returns provider-shaped documents;
- the runtime never computes totals or treats price as permission (`packages/endpoint/README.md:101-134`).

*HTTP helpers:*
- `withRequestDeadline` bounds one exchange, including reading the body, and always clears its timer (`http.ts:82-109`);
- `retryAfterMs` parses delay-seconds or an HTTP-date (`:112-117`);
- `transportDetail` recovers `ENOTFOUND` and similar codes from Node's generic `fetch failed` (`:34-52`).

**Tests:** 4 tests, 17 asserts (`packages/endpoint/test/endpoint.test.ts`):
- one definition yields one instance with a host-neutral registration (`:44-85`);
- async plus transient is refused (`:87-102`);
- `wakeAfter` arithmetic (`:104-110`);
- Retry-After parsing (seconds, date, garbage), `ENOTFOUND` code recovery and deadline timeout (`:112-128`).

**Quality notes.**
- (+) Cleanly separates "what the request is", "what it costs" and "who may spend" (README `:126-134`).
- (+) The `ready` → `collect` split is a real-world insight: vendor job slots and download bandwidth are separate bottlenecks.
- (+) `transportDetail` fixes a real Node pain point.
- (−) Heavy configuration surface: instance, pool, capacity class and three action limits for every provider.
- (−) `defaultConcurrency ?? 1` is a conservative default, but it serializes every provider that forgets to set it.

**Relevance to UGCMediaClips: Medium-High.**
- Per-provider concurrency and rate declarations, Retry-After and deadline helpers, and the `ready/collect` split are directly useful.
- Pricing-as-information is weaker than what we already do. We meter real billed cost (`clipper/server/usage.ts:57-70`).

**Better version.**
- A small `ProviderSpec` per vendor (OpenRouter chat, OpenRouter audio, Gemini vision, Outstand, future video generators) holding `concurrency`, `rate`, a `retry` policy per action and a `costOf(response)` extractor.
- Adopt `withRequestDeadline` and `retryAfterMs` nearly verbatim in spirit; our `llm.ts` has fixed `AbortSignal.timeout` and no 429/5xx retry (`clipper/server/llm.ts:190-202`).
- Keep billed-cost metering as the source of truth, and add an optional **estimate before spend**: a `readPricing`-like call shown before a render is queued.

---

## `@hypit/runtime-local`

**Purpose.** The default single-host runtime:
- a detached coordinator process and per-build module-scoped carrier processes;
- a SQLite store for active work: builds, facts, operations, command receipts, capacity and rates, waiters, submissions, catalog;
- writing results to the project and per-build JSONL execution logs;
- managed local "programs" (e.g. a WhisperX server) with install, start, stop and probe;
- Runtime Profile parsing, `doctor`/`preflight`, provider and pricing inspection, transient (non-build) execution;
- credential control and the `runtime | programs | paths` CLI.

**Public surface** (`packages/runtime-local/src/index.ts:1-44`; subpath exports in `package.json`: `.`, `./cli`, `./extension`, `./node`, `./config`, `./programs`, `./worker-process`):
- **Building a runtime:** `createLocalRuntime` (`runtime.ts:110-346`), `openLocalRuntimeHost` (`host.ts:37-201`), `createRuntimeFromConfig` and related factories (`config.ts:1086-1264`).
- **Profile and diagnostics:** `parseLocalRuntimeProfile` (`config.ts:207-235`), `doctorRuntimeConfig` and `preflightRuntimeConfig` (`config.ts:1071-1084`).
- **One-off and transient calls:** `invokeRuntimeConfigNeed` (`config.ts:791-843`), `openTransientRuntimeConfigExecution` (`config.ts:491-580`), `readRuntimeConfigPricing` (`config.ts:666-781`).
- **Storage:** `FileResourceStore` (`resource-store.ts:26-154`), `SqliteRuntimeState` (`sqlite-state.ts:945-1101`, not re-exported from the index; tests import it directly).
- **Managed programs:** `bringManagedProgramsUp`, `takeManagedProgramsDown`, `prepareManagedPrograms` and `reportManagedPrograms` (`programs.ts:467-587`).
- **Adapters:** the extension facets `createRuntimeEndpointAdapterFacet` and `createRuntimeCredentialStoreAdapterFacet`, plus `RuntimeAdapterRegistry` and the `runtimeConfig*` readers (`extension.ts:162-317`).
- **CLI verbs** (`cli.ts:363-370`, `:174-342`): `runtime init|use|unset|up|status|logs|down`, `programs prepare|up|status|down`, `paths`, and the internal `_worker`.

### Process architecture

- **Coordinator.** `runtime up` spawns the coordinator **detached**, with stdout and stderr in `worker/worker.log` (`worker-process.ts:173-266`, `:225-231`). A `launch.lock` file created with `wx` holds the owner's PID; a stale lock (dead PID) is deleted (`worker-process.ts:108-137`). The coordinator must write a ready-file containing its owner token within **10 s** (`:139-162`, `:177`). Logs rotate at **10 MiB** (`:33`, `:50-61`).
- **Startup recovery.** On start the coordinator (`supervisor.ts:11-150`):
  - frees any Result-write ownership left by a previous process (`:102`);
  - **fails every build that was started but not decided**, with "Build executor was lost; its code context is gone. Create a new Build to continue" (`:103-106`);
  - frees capacity held by short actions (`:110`).
- **Dispatch.** The coordinator then polls `listUnstarted()` every **100 ms** and hands each build to the current accepting carrier over IPC (`:112-144`).
- **Carrier rotation.** Once a carrier has completed at least one build and its reported RSS reaches the budget (`worker.executionMemoryMb`, default **1024 MiB**, `config.ts:238-240`), it stops taking new builds. Its existing builds finish where they are, and a fresh carrier takes new work (`supervisor.ts:25-32`). Idle carriers are told to stop (`:113-118`).
- **Carrier loss.** If a carrier exits with builds still assigned, each of those builds is concluded through `interrupt` and its Result is written (`:33-44`, `:84-96`). A carrier that loses its IPC parent kills itself (`host.ts:163`).
- **Carrier loop** (`executor.ts:10-66`):
  - every **25 ms**, list ready builds (`:30`, `:58`);
  - open a build context with its own `NodeModuleScope` the first time (`:33-41`);
  - call `workOnce`, but serialize only the "hydration" phase: one build's JSON parse at a time (`:44-55`; `worker.ts:213-227`). Network actions overlap.

### The SQLite store (`sqlite-state.ts`)

*Setup:*
- `node:sqlite` `DatabaseSync`, with `busy_timeout = 5000`, `journal_mode = WAL` and `synchronous = NORMAL` (`:967-971`);
- every multi-step change is a `BEGIN IMMEDIATE` transaction (`:60-70`);
- ten `STRICT` tables with CHECK constraints tying nullable column pairs together (`:972-1056`);
- additive migrations via `PRAGMA table_info` / `ALTER TABLE ADD COLUMN` (`:1057-1070`).

| Table | Role | Key facts |
|---|---|---|
| `hypit_builds` / `hypit_build_facts` | Build definition plus append-only accepted facts | `UNIQUE(build_id, command_id)` prevents a double fact (`:977-983`). The snapshot is rebuilt with `materializeBuild` (`:72-82`). |
| `hypit_operations` | Async work | Identity columns plus a `payload_json` blob (`:984-991`). `update` is read-merge-write **outside** a transaction and leaves terminal rows untouched (`:396-409`). |
| `hypit_command_executions` | Receipts for immediate commands | `begin` = `INSERT OR IGNORE` and returns `created` (`:442-453`). This is the at-most-once guard. |
| `hypit_executions` | Scheduling root per build | `wake_at`, `turn_owner`, `started_at`, `stop_*`, `decision_*`, `attention_*`, `result_writer_*`. Index on `(decision_outcome, turn_owner, wake_at)` (`:1012-1038`). |
| `hypit_capacity` | Held reservations | `resources_json`; `lifetime` is `action` or `operation` (`:1039-1046`). |
| `hypit_resource_waits` | Parked claims | One row per build+command (`:1047-1051`). |
| `hypit_rates` | Token buckets | `tokens REAL`, `updated_at` (`:1052-1055`). |
| `hypit_submissions` / `hypit_build_catalog` | Two-phase submit; presentation metadata | (`:1000-1011`) |

*Turn protocol:*
- **`claim(owner)`.** One transaction selects a ready, undecided, unowned row with `wake_at <= now`, ordered so **builds already holding capacity come first**, then `wake_at`, then `created_at`. It then does a guarded `UPDATE` (`:581-607`). Draining in-flight builds first keeps pool slots from stalling. **But** the production path never uses that ordering: the carrier iterates `listReady()` (ordered `wake_at, created_at`, `sqlite-state.ts:615-618`) and calls `claim(owner, now, build)` with a specific build id (`worker.ts:415-422`), so the `ORDER BY` only matters for an untargeted claim, as in the test (`sqlite-state.test.ts:348-366`). *(corrected in check)*
- **`releaseTurn`.** Rechecks parked waits in the same transaction, so a capacity release that raced the turn is not lost. A stop request also forces an immediate wake (`:648-673`).
- **`decide`.** Freezes exactly one outcome. An earlier stop overrides the requested outcome (`:675-704`). `requestStop` keeps the **first** cause (`:783-801`).
- **`interrupt`.** Concludes a lost attempt as `failed`, or `cancelled` if the user asked (`:631-646`). Runtime README: "There is no turn-reclaim operation that makes a lost attempt runnable again" (`packages/runtime/README.md:44`).
- **Turns have no lease or TTL.** A turn is freed only by its owner, or by the supervisor deciding the build on carrier loss.

*Capacity admission* (`acquireCapacity`, `:835-873`):
1. Sort claims by id and reject duplicate ids (`:838-840`).
2. If this build+command already holds a reservation, return it (idempotent, `:842-845`).
3. Otherwise run `#blocked`. For occupancy, it sums `json_extract(claim.value,'$.units')` over `json_each(resources_json)` for **all** reservations (`:822-829`). For rates, it refills tokens `min(limit, tokens + elapsed·limit/periodMs)` (`:803-810`) and, when blocked, returns `availableAt = now + ceil((units − tokens)·periodMs/limit)` (`:816-820`).
4. If blocked, upsert a wait row (`:848-852`).
5. Otherwise spend rate tokens (`:854-860`) and insert only the occupancy claims (`:863-868`). Rate units are never "held".
6. Delete the wait, then wake the next fitting waiter (`:869-870`).

*Waking waiters.* `#wakeAvailableWaiter` wakes **one** waiter that fits, in build `created_at` order (`:883-898`). Each successful acquire wakes the next one, so wake-ups chain.

*Ordering on start.* `pending.prepare` refuses an id that exists in any of the eight tables (`:251-262`). `commit` atomically moves the submission into the builds, catalog and executions tables (`:291-327`). `removeActiveBuild` deletes the whole set of rows, root last, in one transaction (`:1080-1096`).

Test-verified numbers (`packages/runtime-local/test/sqlite-state.test.ts`):
- 4 + 2 units fit a 6-unit pool, 1 more is blocked, and nothing partial is held. The state survives reopening the database (`:324-346`).
- A rate of 2 per 1000 ms blocks the third admission until `availableAt = 500`. A blocked request spends no tokens (`:386-405`).
- An in-flight build is claimed before fresh work (`:348-366`).
- A release that happens before a waiter parks still wakes it (`:407-434`).

### The worker (`worker.ts`) and short actions (`actions.ts`)

*`CapacityExecutor`* wraps the executor (`worker.ts:39-196`):
- **Ownership check.** Before running anything it asserts that this worker still owns the turn and that no stop was requested (`:58-63`).
- **Immediate commands.** `commandExecutions.begin()` must create the receipt. If a receipt already exists in `started` state, the command is completed as `EXECUTION_UNKNOWN`, "the same Build will not run it again" (`:85-98`). A thrown handler error is also stored as `EXECUTION_UNKNOWN` (`:108-117`).
- **Capacity.** It is acquired before execution. A blocked acquire becomes `deferred` with the rate `wakeAt` (`:142-154`).
- **Async jobs keep their slot.** For an async command, the slot is kept while the remote task runs. It is freed only when the submit is still `queued`, when `remoteEnded`, or when the operation ends (`:120-124`, `:157-162`, `:351-353`). This is how a remote job's occupancy of a vendor pool is modelled.

*`createActionExecutor`* admits a submit, poll or collect call under its own key `action:[command, action]`, and always frees the slot in `finally` (`actions.ts:5-20`).

*`DurableLocalWorker`*:
- **Polling waiting builds.** A build that is only waiting on operations is polled from the operation rows **without loading the build snapshot** (`worker.ts:338-371`).
- **Normal pass.** Otherwise it installs the build's execution packages, loads the snapshot and runs one `InProcessBuildScheduler` pass (`:372-405`). `runOnce` passes exactly one build to that pass (`:432`), so in runtime-local the scheduler's round-robin cursor never spans builds; cross-build sharing is decided by SQLite `acquireCapacity` (first come at acquire time) and the oldest-build-first waiter wake (`sqlite-state.ts:883-898`). *(added in check)*
- **Pending results** are synced to the Result incrementally after each accepted fact, and sync errors are swallowed (`:388`).
- **Finishing.** Builds are concluded in `#finish`: complete; failed if any outcome errored; failed if blocked with nothing pending; otherwise the turn is released with the minimum `wakeAt` (`:282-317`).
- **Stopping.** It accepts already-received sibling completions. On user cancellation it calls `cancelOperation` on each pending operation and logs the acknowledgement as a diagnostic (`:235-275`).
- **Ownership guard.** `runOnce` refuses to touch a started build that this context doesn't own (`:408-437`, `:420`).

### Results, resources and logs

*Result writer:*
- Writing a finished result first re-applies every stored success, then every stored failure, to the fact log, so validated sibling outputs survive (`result-writer.ts:79-101`, `:96-97`).
- It then syncs outputs and writes the terminal manifest. The manifest includes per-operation receipts, pool and credential **refs**, timestamps, cancellation outcome and the execution log stream (`:126-172`).
- **Failure modes.** If writing the Result fails, the build gets `attention: {step, error}` (step `result` or `cleanup`). Writer ownership is released so `hypit result finish` can retry the write **without re-running anything** (`:174-194`; supervisor `:102`; `sqlite-state.ts:761-781`).

*`FileResourceStore`*:
- streams to `.incoming/res_<uuid>`, checks `AbortSignal` per chunk and the expected size, `link()`s into place (EEXIST tolerated) and always removes the temp file (`resource-store.ts:34-80`);
- ids are **random** (`:90`), so equal bytes are independent resources;
- per-build stores live under `work/<build>` and are deleted after the Result is written (`config.ts:1162-1165`).

*Staging attachments.* Only resources that the definition actually references are staged, and existing ones are skipped (`runtime.ts:49-79`, `:193-220`).

*`fileExecutionLogs`* appends `hypit.execution-log@1` JSONL to `work/<build>/execution.jsonl` through a per-build promise chain. A write failure is recorded, not thrown into the provider call. It then surfaces when the Result writer opens the log (`log.ts:14-47`).

### Profile, configuration, credentials, pricing

*Profile* (`config.ts:207-235`):
- `{format, dataRoot, worker?, credentials{}, endpoints{use, pool?, config?}, bindings{"name@ver#cap": instance}}`;
- strict keys; instance ids are unique; bindings must name a real instance (`:192-205`).

*Snapshot at submit.* The resolved profile is captured into each build's `context_json`. "Execution choices are captured at submission; later Profile edits belong to later Builds" (`config.ts:1093-1149`). Each build's runtime is recreated from that snapshot (`:1114-1123`).

*Scoping.* `scopedProfile` narrows endpoints by explicit ids or full bindings before loading packages (`:113-128`). `credentialProfile` opens only the credential stores the selected endpoints use (`:405-408`).

*`inspectRuntimeConfig`* reports (`:892-1064`):
- data-root, package and endpoint config errors;
- managed programs that are down or mismatched;
- unbound capabilities;
- invalid bindings;
- `RUNTIME_POOL_CONFLICT` (`:977-984`);
- ambiguity: an error if the capability is needed, otherwise a warning (`:985-994`);
- missing credentials, with a hint (`env` → "Set X…"; otherwise `hypit auth login`) (`:1027-1043`).

`preflight` is passive. `doctor` additionally runs each adapter's active `diagnose`/`doctor` (`:1071-1084`).

*Transient execution* installs only `transient: true` immediate capabilities. It shares in-memory concurrency for one session (`TransientSessionCapacity`, which wakes all waiters on each release) and checks program readiness lazily (`config.ts:449-580`).

*`invokeRuntimeConfigNeed`* runs one immediate need outside any build and refuses asynchronous capabilities: "slow paid generation goes through a Build" (`:783-843`).

*`readRuntimeConfigPricing`* resolves the endpoint. It then calls `readPricing` with **lazy** credential resolution for only that endpoint, and validates documents. Errors become `pricingError`, not failures (`:666-781`).

*Credential control* reads declared slots and writability without resolving secrets. `putCredential` and `deleteCredential` never read the old value, so a corrupt credential can still be replaced (`credentials.ts:20-66`).

### Managed programs (`programs.ts`, `program-lock.ts`)

- **Locking.** Each program home has an OS-owned exclusive lock through `koffi` FFI: `flock(LOCK_EX|LOCK_NB)` on POSIX, `CreateFileW` with no sharing on Windows. The OS releases it on exit; there are no stale-lock heuristics (`program-lock.ts:16-40`).
- **`bringUp`** (`programs.ts:296-442`):
  - probes first, and never starts a second copy next to a `mismatch` (`:315-318`);
  - runs install commands, logging each command's label but never its arguments, "Arguments and environment values can contain credentials" (`:128-131`, `:445-464`);
  - starts detached (POSIX), or through PowerShell `Start-Process -WindowStyle Hidden` with `-EncodedCommand` (Windows, long comments `:191-284`, `:364-377`);
  - publishes `process.pid` with a temp-file rename before waiting for readiness (`:394-399`);
  - polls the probe every **1 s** up to `maxWaitMs`, default **300 000** (`:286-294`, `:498`).
- **`down`** stops only processes with a hypit PID record: SIGTERM to the process group, **15 s** grace, then SIGKILL (`:503-576`; `process-control.ts:18-34`).

### CLI (`cli.ts`)

Hand-rolled argument parsing (`cli.ts:43-115`):
- `runtime init` writes the distribution's starter profile with `wx` and never overwrites it (`:175-194`);
- `runtime up` validates by creating a runtime, then brings up programs and the worker (`:276-295`);
- `status` summarizes build activity, programs and held capacity (`:318-341`).

**Tests:** 90 tests, about 505 asserts over 18 files *(corrected in check)*. Highlights:
- **Concurrency at scale:** 24 builds with an 8-task remote pool, and 24 with 24. Every build submits **once**, local work progresses while remote work is pending, and every result completes. A 1000-build scale variant is opt-in (`packages/runtime-local/test/concurrency-process.test.ts:24-33`).
- **Mixed failures:** 20 builds with injected submit, poll and download failures. Remote peak ≤ 8, download peak exactly 2, 14 complete and 6 failed, 18 receipts retained, `starts === 20` (`packages/runtime-local/test/local.test.ts:1249-1331`).
- **Carrier rotation** with a 1 MiB budget: a draining carrier finishes build A, and a new carrier runs C but **shares** the occupied pool. C does not submit until A releases (`packages/runtime-local/test/rotation-process.test.ts:23-106`).
- **No replay after a crash:** an immediate command left `started` fails the build with 0 producer calls (`local.test.ts:731-768`).
- **Persisted facts stop upstream replay:** after a reload, prompt and request producers ran exactly once (`local.test.ts:407-408`).
- **Cancellation** records receipts without polling. `remoteActive === 1`: "local termination does not pretend the cloud task stopped" (`local.test.ts:1186-1246`).
- **An interrupted Result write** finishes later without re-running generation (`local.test.ts:603-690`).
- **An executor that fails before ready** fails its builds, and supervision continues (`startup-failure.test.ts:17-74`).
- **Programs:** 16 tests covering cold reconcile, mismatch not started, "down leaves a process without a record", installation log preserved, and lock exclusion (`programs.test.ts`).
- **Config:** 18 tests covering pricing reads with only the selected endpoint's credential, the shared resolver for `providers`/`doctor`/`invoke`, and pool-conflict detection (`config.test.ts:325-388`, `:683-751`, `:753-797`).

**Quality notes.**
- (+) Unusually rigorous crash semantics. Every state transition is one SQLite transaction, with first-cause-wins stops, idempotent acquire, two-phase submit and a "result attention" recovery path that never re-executes.
- (+) Weighted multi-resource admission plus token buckets, persisted across restarts. Test numbers match the documented behaviour.
- (+) Secrets hygiene throughout: refs only in state, labels not argv in logs, JSON parse errors never echo secret bytes.
- (−) **No resume.** A coordinator restart fails every started build (`supervisor.ts:103-106`). For a desktop CLI this is honest. For a server that redeploys several times a day, it would fail every in-flight job on every deploy.
- (−) **Polling.** The carrier polls every 25 ms and the coordinator every 100 ms (`executor.ts:58`, `supervisor.ts:143`). That is fine on one machine, and it would be wasteful on a shared database.
- (−) **Capacity check cost.** `#blocked` scans every reservation with `json_each` for every claim (`sqlite-state.ts:822-826`). This is O(reservations × claims) per acquire, with no index on resource id in the capacity table. The index exists only on waits (`:1051`).
- (−) **No lease on turns.** Correctness depends on the supervisor detecting carrier death. A hung but live carrier holds its builds forever.
- (smell) **Unguarded update.** `SqliteOperationStore.update` is an unguarded read-modify-write (`sqlite-state.ts:396-409`). It is safe only because one carrier owns a build, and that assumption is documented (`packages/runtime/src/operations.ts:95`) rather than enforced.
- (smell) **Two locking styles.** The `launch.lock` uses a `wx` file plus a PID liveness check (`worker-process.ts:108-137`), while program homes use OS `flock` (`program-lock.ts`).
- (smell) **Silent sync failures.** `worker.ts:388` swallows Result-sync errors. The final write retries, but an operator sees nothing until then.
- (−) **Size.** `config.ts` is 1,264 lines mixing parsing, doctor, pricing, invoke and transient execution. `programs.ts` contains about 100 lines of Windows console workarounds.

**Relevance to UGCMediaClips: High** for the concepts:
- durable job rows;
- at-most-once receipts for paid steps;
- capacity and rates shared across job kinds;
- "attention" instead of silent failure;
- a per-job event log;
- a config snapshot taken at enqueue.

Low for the process machinery (module-scoped carriers, managed programs, Windows consoles, CLI). Railway gives us one container and a supervisor already.

**Better version.** See "What we'd build" below. In short: one Postgres `jobs` + `job_steps` design using `SKIP LOCKED` claims with a lease. Keep hypit's receipt rules for paid steps, but **resume** from the last completed step after a deploy instead of failing.

---

## `@hypit/run`

**Purpose.** A syntax-neutral compiler from a decoded Run document (frontend-supplied) and a compiled author source to a sealed `RunGraph`:
- candidates: provided values, files, prior-build records, or fragment instances;
- operations, satisfactions (logical output → candidate), and targets.

**Public surface** (`packages/run/src/index.ts:1-32`):
- `resolveRunDocument` and `collectRunModuleRequests` (`resolve.ts:31-213`);
- `compileRunSource`, `RunFrontendRegistry` and `RunSourceError` (`frontend.ts:11-49`);
- `sealRunGraph`, `verifyRunGraph` and `RunGraphError` (`graph.ts:3-65`);
- `createProvidedCandidate` (`candidate.ts:17-33`);
- `RunFragmentRegistry` (`registry.ts:5-24`);
- the fragment and frontend facet helpers (`facet.ts:25-59`, `frontend-facet.ts:17-23`).

**How it works.**
- `resolveRunDocument` walks candidate declarations (`resolve.ts:96-180`):
  - `provided` and `file` become placeholder candidates (`value: null`) with a `candidateSources` entry, filled in only once planning selects them (`:99-124`; `types.ts:132-142`);
  - **`build-record`** reuses a public output of a previous build `{build, output}`. All of its destinations must be logical outputs of one type (`:125-147`; `types.ts:50-56`);
  - fragment instances are elaborated with literal inputs typed by the fragment's declarations (`:149-180`).
- Each logical output may be satisfied at most once (`:182-195`).
- `sealRunGraph` sorts every collection for canonical identity and verifies uniqueness, inline-only records and at least one target (`graph.ts:17-65`).

**Tests:** none in this package. I couldn't verify whether other packages' tests cover it; that is outside this batch.

**Quality notes.**
- (+) The run graph always exists, so "which candidate satisfied which output" is explicit data, not CLI flags (`packages/run/README.md:13-16`).
- (−) Only `RunSourceError` and `RunGraphError` carry codes. `resolve.ts` throws plain `Error`s throughout (`:48`, `:66`, `:97`, `:153`) *(corrected in check)*.

**Relevance to UGCMediaClips: Low**, with one idea worth noting. **Re-runs are explicit about reuse**: a re-render can say "take the voiceover from render X". This is how hypit avoids paying twice without a hidden cache.

**Better version.** No graph compiler. A `reuse` field on a render request (`{voiceFrom: renderId, shotsFrom: renderId}`) when the user asks for "same voice, new captions", plus content-addressed reuse for deterministic steps (see below).

---

## `@hypit/producer`

**Purpose.** The minimal SDK for trusted deterministic component handlers. A handler receives only `{command, producer, inputs}` and returns `{outputs, needs}`. Anything that needs bytes, credentials or network must be declared as a need and fulfilled by an endpoint (`packages/producer/src/index.ts:15-32`; README `:10-13`).

**Public surface:**
- `ProducerHandler`, `ProducerFacet`, `ProducerPackage` and `ProducerRegistrar` (`index.ts:15-46`, `:119-123`);
- `PlannedNeedFacet` and `plannedNeedInputs` (`:48-107`);
- `registerProducerFacets`, `createProducerPackageFacet` and `producerPackagesFromFacets` (`:109-151`).

**How it works.**
- `plannedNeedInputs` lists a step's inputs that don't exist yet. Each comes back as `{input, record, sourceStep?, role?}`, so a provider's `supports()` can judge a request before upstream values exist (`index.ts:86-107`).
- Facets are plain data: `abi: "hypit.producer-package@1"` (`:125-151`).

**Tests:** none in this package. It is exercised by the executor and runtime-local tests through `registerProducerFacets`.

**Quality notes.**
- (+) Separating pure compute from effects is what makes the fact log replay-safe, and the README is honest about it: "This is dependency inversion, not a sandbox" (README `:15-16`).
- (smell) **Scheduling is dropped.** `ProducerRegistrar.registerProducer(producer, handler)` has no scheduling argument (`index.ts:35-40`), and `registerProducerFacets` passes none (`:113-115`). Yet `ProducerRegistry.registerProducer` accepts `{scheduling}` (`packages/executor/src/registry.ts:69-78`). So package-loaded producers can never declare CPU resources, and heavy local producers run unthrottled.

**Relevance to UGCMediaClips: Low-Medium.** The useful rule is "pure functions get no I/O". Our caption, ASS and overlay builders are already pure (`clipper/server/captions.ts`, `clipper/server/overlays.ts`). Writing that rule down would make content-hash caching safe.

**Better version.** Mark our pure builders (ASS generation, overlay placement, alignment) and key their outputs by a hash of their inputs. Nothing more is needed.

---

## `@hypit/credential-store-env`

**Purpose.** A read-only store for `{store: "env", key}` that reads exactly the named variable and never enumerates the environment (`packages/credential-store-env/src/index.ts:8-23`). Activated by a runtime facet that accepts no config (`activation.ts:9-18`).

**Tests:** 1 test, 3 asserts. It checks the requested key, a missing key → `undefined`, and a foreign store → `undefined` (`test/store.test.ts:7-17`).

**Quality notes.** (+) Tiny and correct. Empty strings are treated as missing (`index.ts:20`).

**Relevance: Low.** We already read `process.env` directly. The idea worth keeping is that a credential **reference** is stored with the job, and a value never is.

---

## `@hypit/credential-store-local`

**Purpose.** A writable store for `{store: "local"}`. It uses macOS Keychain or Windows Credential Locker on those platforms, and owner-private JSON files on Linux (`packages/credential-store-local/src/store.ts:38-63`).

**Public surface:** `LocalCredentialStore` (`store.ts:42`), `FileCredentialStore` (`file.ts:23`), `OsCredentialStore` (`os.ts:94`), and the activation facet with config `{backend: system|file, path, service}` (`activation.ts:10-35`).

**How it works.**
- **Store names.** `LocalCredentialStore` rewrites `local:<key>` to its backend's own name (`os` or `file`) before delegating (`store.ts:73-75`). Selecting `system` on Linux fails rather than silently falling back (`:57-62`).
- **File backend:**
  - one file per key, named `key-<hex(utf16le(key))>.json`, so the name is safe on case-insensitive filesystems and has no path separators (`file.ts:28-34`);
  - the directory is created `0o700` and must not have group or other bits set (`0o077`), and the same is checked per file (`:36-43`, `:58-61`);
  - writes go to a temp file opened `wx` with mode `0o600`, then `replaceFile` (`:70-80`);
  - a decode error names the file, never its contents (`:63-66`).
- **macOS:** `/usr/bin/security`, with exit 44 meaning not found and a 10 s timeout (`os.ts:22-60`).
- **Windows:** a PowerShell bridge receives a base64 JSON request on stdin, has a 4 MiB output cap and a 10 s timeout, and enforces PasswordVault's 512-character limit before the call (`windows.ts:12-60`; `runtime/windows-credential.ps1:1-61`).

**Tests:** 20 tests, about 78 asserts:
- concurrent writes from several processes, for different keys and for the same key (`test/file-concurrency.test.ts:48-101`);
- a failed replacement keeps the old value (`file-failed-replacement.test.ts:10-45`);
- a corrupt file can be replaced or deleted without being read (`file-store.test.ts:37-56`);
- platform selection, and locker errors don't switch to files (`store.test.ts:26-126`);
- an oversized bridge response kills the child and keeps the secret out of the error (`windows.test.ts:12-34`).

**Quality notes.**
- (+) Careful POSIX permissions, atomic replace, no secret bytes in errors.
- (−) **macOS write leaks to argv.** The write passes the secret as `-w <secret>` on argv (`os.ts:39-41`). It is briefly visible to other local users through `ps`. The comment acknowledges `security(1)` forces this (`:36-38`).
- (smell) **Wrong hint in `.ps1`.** The script's over-limit message says "Select @hypit/credential-store-local for OAuth tokens" (`windows-credential.ps1:42`). That is the package already in use. The TypeScript side correctly says "with backend file" (`windows.ts:20`).

**Relevance: Low.** We are a server: secrets are Railway env vars, and per-workspace tokens (Outstand OAuth) live in Postgres. The patterns worth borrowing:
- the `replace()` slot given to the code that refreshes a token (`packages/executor/src/executor.ts:138-143`);
- delete and replace without reading the old value.

---

## Our queues against hypit's runtime

| Concern | UGCMediaClips today | hypit |
|---|---|---|
| **Queue storage** | In-memory arrays per module (`clipper/server/render.ts:36-38`, `clipper/server/caption-jobs.ts:20-21`, `clipper/server/formats.ts:40-41` *(corrected in check)*). Status is mirrored into the workspace JSON document via debounced `save()` (`clipper/server/db.ts:8-11`). | SQLite rows, and every transition is a transaction (`sqlite-state.ts:60-70`). |
| **Concurrency** | Render: `RENDER_CONCURRENCY`, default 1 (`render.ts:39`). Captions: 1 (`caption-jobs.ts:21`). Formats: 1 (`formats.ts:41` *(corrected in check)*). The three are independent, so one render, one caption burn and one format breakdown can run three ffmpeg processes at once on a CPU-only box (formats also run ffmpeg scene detection, `formats.ts:89`, and whisper, `:123`; renders run whisper for word timing, `render.ts:213`). | Named shared resources with weighted units, admitted atomically across all job kinds (`sqlite-state.ts:835-873`). |
| **Fairness** | Global FIFO with per-workspace queue caps: 20 renders, 5 caption jobs, 3 formats (`render.ts:66-68`, `caption-jobs.ts:24-25`, `formats.ts:44` *(corrected in check)*). The caps count only waiting jobs, not the running one. One workspace's 20 renders run ahead of everyone else's. | `InProcessBuildScheduler` has a round-robin cursor across the builds of one pass (`scheduler.ts:176-196`), and an untargeted `claim` prefers builds holding capacity (`sqlite-state.ts:588-591`). In runtime-local, though, each pass holds one build (`worker.ts:432`) and claims are targeted (`worker.ts:422`), so production fairness is oldest-first: ready builds by `wake_at, created_at` (`sqlite-state.ts:615-618`), parked waiters woken by build `created_at` (`:883-898`). *(corrected in check)* |
| **Restart** | Resume from the start: up to 2 times for renders and caption jobs, once for formats (`render.ts:45-62`, `caption-jobs.ts:45-60`, `formats.ts:64-77` *(corrected in check)*). The scan runs 45 s after boot (`clipper/server/index.ts:16-28`), but it only finds workspaces with pending clip renders or caption jobs (`clipper/server/db.ts:147-155`, `:251-258`). An interrupted format breakdown resumes only when its workspace is loaded for another reason. *(added in check)* | Never resume. Every started build fails, and the user starts a new build that may reuse outputs (`supervisor.ts:103-106`). |
| **Paid-step repeat on resume** | The voice is re-recorded on resume (`render.ts:201-204`), about $0.001 per take per the README. Footage analysis is cached on the file (`render.ts:142`), so it isn't repeated. Confirmed in check: each render gets a fresh `mkdtemp` directory (`render.ts:135`) and `speak()` is always called (`:203`), so no take survives a restart. A resumed format breakdown also re-runs its paid `chatJSON` vision call (`formats.ts:151`). *(added in check)* | Paid immediate steps are at most once (`worker.ts:86-98`). Async submits are guarded (`executor.ts:388-393`). |
| **Retries** | `chatJSON` retries only for a `response_format` 400 (`clipper/server/llm.ts:197-201`). Voice: none. Outstand: 429 with Retry-After capped at 30 s (`clipper/server/outstand.ts:36-37`). Voice takes are re-recorded for **quality** (`render.ts:201-224`). | None in the framework; providers own retry (`packages/executor/README.md:18`). Helpers exist (`http.ts:82-117`). |
| **Timeouts** | Fixed: 120–180 s for AI (`llm.ts:91`, `:195`, `:227`), 20 min default for ffmpeg (`clipper/server/media.ts:45`), 60 min for caption burns (`caption-jobs.ts:129`). | `withRequestDeadline` per exchange. Program readiness 300 s. |
| **Cancel** | No render, caption or format cancel. Only scheduled posts (`clipper/server/app.ts:686-688`) and agent runs (`app.ts:578`) can be stopped *(corrected in check)*. Deleting a clip, caption job or format removes the record but doesn't stop a job that's already running (`app.ts:858-868`, `:927-937`, `:1397-1404`); a queued render whose clip is gone is skipped (`render.ts:95-96`). *(added in check)* | Durable stop request, first cause wins. One best-effort remote cancel, whose acknowledgement is recorded separately (`sqlite-state.ts:783-801`, `worker.ts:259-271`). |
| **Cost and credentials** | Billed AI dollars per workspace per day, plus a global daily cap (`clipper/server/usage.ts:16-54`) and a call-count cap (`clipper/server/llm.ts:41-50`). Compute is estimated from rates (`usage.ts:24-31`). The budget is checked **at enqueue** (`app.ts:1190`); a resume re-spends without a check. Confirmed in check: the only caller of `checkAIBudget` is `spendAI` (`llm.ts:48`), the resume hooks (`render.ts:46-62`, `caption-jobs.ts:45-60`, `formats.ts:64-77`) call neither, and `speak`/`chatJSON` don't check it either. | No spend control at all. Pricing is information only (`packages/endpoint/README.md:101-134`). Credentials are refs, resolved per call. |
| **Caching** | Footage cache keyed by Drive id or URL hash, with in-flight coalescing (`clipper/server/footage-cache.ts:20-31`, `:84-94`). Moments are cached per file. | Nothing is cached across builds: random resource ids (`resource-store.ts:90`), and producers re-run in a new build (`driver.test.ts:266-290`). Within a build, persisted facts prevent replay (`local.test.ts:407`). Cross-build reuse is explicit `build-record` (`run/src/resolve.ts:125-147`). |
| **Observability** | `render.step` strings plus the Activity log (`render.ts:119-123`). | A per-build JSONL execution log (started, phase, diagnostic, failed), archived with the Result (`log.ts:14-47`, `result-writer.ts:153-158`). Live `activity` and capacity view (`control.ts:108-121`). |
| **Scale-out** | Impossible: the queue is in-process. | One host; SQLite plus OS processes. |

Overall: we are **ahead on cost metering** and **pragmatically better on restarts for a SaaS**, because resuming beats failing every job on every deploy. hypit is **far ahead on admission control, at-most-once guarantees for paid steps, cancellation and per-job evidence**.

---

## What we'd build (the "better version" for this batch)

A durable job system in the Postgres we already run (`clipper/server/db.ts:62-65`), sized for one CPU-only Railway container now and several replicas later:

1. **Tables.**
   - `jobs(id, workspace_id, kind, status, priority, wake_at, lease_owner, lease_until, attempts, stop_cause, decision, attention, config_snapshot, created_at)`;
   - `job_steps(job_id, step, status: started|done|failed, output_ref, cost_usd, receipt, started_at, ended_at)`, unique on `(job_id, step)`.

   This is hypit's `executions` plus `command_executions`, in our vocabulary.
2. **Claim:** `UPDATE … WHERE id = (SELECT id FROM jobs WHERE status = 'ready' AND wake_at <= now() AND (lease_until IS NULL OR lease_until < now()) ORDER BY holds_capacity DESC, workspace_rr, wake_at FOR UPDATE SKIP LOCKED LIMIT 1)`. Unlike hypit, use a **lease** with heartbeat, so a hung worker gives its jobs back.
3. **Admission.** One `capacity` controller with claims `{id, limit, units, periodMs}`:
   - `cpu:ffmpeg` with limit = vCPUs; a 1080×1920 render takes 2 units, a caption burn 1;
   - `whisper` with limit 1;
   - `ai:openrouter`, as a rate;
   - `outstand`, as a rate.

   All job kinds share it. Round-robin across workspaces.
4. **Paid steps.** Voice, vision analysis, format breakdown and future video generation each write `job_steps.started` before calling, and `done` with `output_ref` and `cost_usd` after.
   - **On resume, skip `done` steps.** Store the voice WAV in object storage before cutting shots, so a redeploy never re-pays.
   - A step left in `started` with no receipt is **not** retried automatically if the vendor is async and not idempotent. Mark the job `attention` instead (hypit's `EXECUTION_UNKNOWN` and `SUBMISSION_INTERRUPTED`).
   - Cheap steps (ffmpeg cuts, ASS) just re-run.
5. **Retry policy per action.**
   - `submit`: at most once.
   - `poll`/`collect` and idempotent GETs: up to 3 tries with jittered backoff honouring `Retry-After` (borrow `retryAfterMs` and the `withRequestDeadline` shape).
   - ffmpeg: none.
6. **Budget at every paid step,** not only at enqueue. Call `checkAIBudget()` before each paid step, including on resume, and record the step's billed cost on the step row.
7. **Cancel.** A `stop_cause` column, first cause wins. The worker checks it between steps and kills the ffmpeg child; a remote cancel is best effort and its acknowledgement is recorded.
8. **Per-job event log.** A JSONL file or a `job_events` table recording started, phase, diagnostic and failed, with secrets and bodies excluded. Show it on the clip's "details" view and attach it to alerts.
9. **Config snapshot at enqueue.** Store the model ids, voice, caption style and brand, so a settings change mid-queue doesn't alter a queued render (hypit `config.ts:1093-1149`).
10. **Content-addressed reuse for deterministic steps:**
    - key the cut segments on `(footage key, start, len, framing version)`;
    - key the voice on `(script hash, voice, model)`, only if the user opts in, since takes vary;
    - key analysis on the file, as today.

    hypit doesn't do this, so it's our improvement.

---

## Ideas worth taking (ranked)

1. **A shared, weighted, atomic capacity controller with token-bucket rates** (`packages/runtime/src/capacity.ts:1-51`; `packages/runtime-local/src/sqlite-state.ts:803-873`). This fixes our three uncoordinated single-slot queues fighting for the same CPU, and gives us provider rate limits.
2. **At-most-once receipts for paid steps.** Write `started` before a paid call; an unknown outcome is a recorded failure or attention, never a silent repeat (`worker.ts:85-117`; `executor.ts:388-407`). Combined with **resume-from-last-done-step**, which hypit doesn't do, redeploys stop re-paying.
3. **The async lifecycle `submit → (checkpoint receipt) → poll(wakeAt) → ready → collect`,** with separate action limits (`packages/endpoint/src/index.ts:119-185`; `executor.ts:374-460`). Needed as soon as we add async video generation or long vendor jobs.
4. **Fairness:** round-robin across tenants, and claim in-flight work first (`scheduler.ts:176-196`; `sqlite-state.ts:588-591`). Both exist in hypit, but neither is on runtime-local's production path (see the Fairness row above), so treat them as ideas, not proven practice. *(corrected in check)*
5. **Durable stop requests,** first cause wins, with best-effort remote cancellation recorded separately (`sqlite-state.ts:783-801`; `worker.ts:259-271`). Gives us a "Cancel render" button.
6. **A per-job execution log archived with the output** (`packages/runtime-local/src/log.ts:14-47`), plus a "result attention" state instead of a silent failure when only the upload step failed (`result-writer.ts:174-194`). Re-upload without re-rendering.
7. **A config snapshot at enqueue** (`config.ts:1093-1149`).
8. **HTTP helpers:** `withRequestDeadline`, `retryAfterMs` and transport cause-chain recovery (`packages/endpoint/src/http.ts:34-117`).
9. **Coalescing concurrent credential and footage reads** (`executor.ts:127-133`). We already do this for footage (`footage-cache.ts:84-94`); extend it to transcriptions and analyses of the same file.
10. **Doctor-style diagnostics** for provider config: unbound or ambiguous capability, a pool sized two ways, a missing credential with a fix hint (`config.ts:892-1064`). This would be useful for an admin "health" page.

## Things not to copy

- **Failing every in-flight job on restart** (`supervisor.ts:103-106`). On Railway every deploy restarts the container. We should resume, skipping completed paid steps, as above.
- **Failing a whole job on one transient poll error** (`packages/executor/test/scheduler.test.ts:486-504`). Use a bounded retry for idempotent reads.
- **No lease or TTL on turns** (`sqlite-state.ts:581-607`). A hung worker would hold jobs forever. Use leases with heartbeat.
- **Busy-polling loops** at 25 ms and 100 ms (`executor.ts:58`, `supervisor.ts:143`). With Postgres, use `LISTEN/NOTIFY` or a 1–2 s poll plus an in-process wake on enqueue.
- **An O(reservations) `json_each` scan per capacity check** (`sqlite-state.ts:822-826`). Keep a counter per resource instead.
- **Per-build module-scoped carrier processes and memory-based rotation** (`supervisor.ts`, `executor.ts`). These solve "user project code changes between builds", which a SaaS with one codebase doesn't have.
- **Managed local programs with Windows console workarounds** (`programs.ts:191-284`, `:364-377`). Railway and Docker own our process lifecycle.
- **Pricing as information only, with no spending authority** (`packages/endpoint/README.md:101-134`). Multi-tenant SaaS needs hard budgets, which we have. Keep `usage.ts`'s enforce-and-record model.
- **Random resource ids with no content addressing** (`resource-store.ts:90`). For us, content-hash keys on deterministic outputs are a cheap win.
- **The run-graph and candidate compiler** (`packages/run`) for reuse. A plain `reuseFrom` field on a render request is enough.
- **Passing secrets on argv** (`credential-store-local/src/os.ts:39-41`). Not that we would, but worth noting.

---

## Coverage table

Every file in the eight package directories, read in full ✅.

| File | Lines | Read |
|---|---:|:---:|
| `packages/runtime/README.md` | 45 | ✅ |
| `packages/runtime/package.json` | 14 | ✅ |
| `packages/runtime/src/capacity.ts` | 51 | ✅ |
| `packages/runtime/src/credentials.ts` | 126 | ✅ |
| `packages/runtime/src/execution.ts` | 24 | ✅ |
| `packages/runtime/src/index.ts` | 21 | ✅ |
| `packages/runtime/src/log.ts` | 51 | ✅ |
| `packages/runtime/src/operations.ts` | 99 | ✅ |
| `packages/runtime/src/scheduler.ts` | 286 | ✅ |
| `packages/runtime/src/types.ts` | 169 | ✅ |
| `packages/runtime-local/README.md` | 273 | ✅ |
| `packages/runtime-local/package.json` | 41 | ✅ |
| `packages/runtime-local/src/actions.ts` | 21 | ✅ |
| `packages/runtime-local/src/catalog.ts` | 34 | ✅ |
| `packages/runtime-local/src/cli.ts` | 370 | ✅ |
| `packages/runtime-local/src/config.ts` | 1264 | ✅ |
| `packages/runtime-local/src/control.ts` | 132 | ✅ |
| `packages/runtime-local/src/credentials.ts` | 66 | ✅ |
| `packages/runtime-local/src/execution.ts` | 116 | ✅ |
| `packages/runtime-local/src/executor.ts` | 66 | ✅ |
| `packages/runtime-local/src/extension.ts` | 317 | ✅ |
| `packages/runtime-local/src/host-api.ts` | 290 | ✅ |
| `packages/runtime-local/src/host.ts` | 201 | ✅ |
| `packages/runtime-local/src/index.ts` | 44 | ✅ |
| `packages/runtime-local/src/log.ts` | 48 | ✅ |
| `packages/runtime-local/src/node.ts` | 86 | ✅ |
| `packages/runtime-local/src/process-control.ts` | 62 | ✅ |
| `packages/runtime-local/src/process-logs.ts` | 33 | ✅ |
| `packages/runtime-local/src/profile-selection.ts` | 84 | ✅ |
| `packages/runtime-local/src/program-lock.ts` | 40 | ✅ |
| `packages/runtime-local/src/programs.ts` | 587 | ✅ |
| `packages/runtime-local/src/resource-store.ts` | 154 | ✅ |
| `packages/runtime-local/src/result-writer.ts` | 248 | ✅ |
| `packages/runtime-local/src/runtime.ts` | 346 | ✅ |
| `packages/runtime-local/src/sqlite-state.ts` | 1101 | ✅ |
| `packages/runtime-local/src/submission.ts` | 24 | ✅ |
| `packages/runtime-local/src/supervisor.ts` | 150 | ✅ |
| `packages/runtime-local/src/types.ts` | 114 | ✅ |
| `packages/runtime-local/src/worker-process.ts` | 321 | ✅ |
| `packages/runtime-local/src/worker.ts` | 447 | ✅ |
| `packages/runtime-local/test/concurrency-process.test.ts` | 144 | ✅ |
| `packages/runtime-local/test/config.test.ts` | 837 | ✅ |
| `packages/runtime-local/test/execution-process.test.ts` | 188 | ✅ |
| `packages/runtime-local/test/extension.test.ts` | 111 | ✅ |
| `packages/runtime-local/test/file-credentials-cli.test.ts` | 54 | ✅ |
| `packages/runtime-local/test/host-api.test.ts` | 29 | ✅ |
| `packages/runtime-local/test/local.test.ts` | 1392 | ✅ |
| `packages/runtime-local/test/log.test.ts` | 33 | ✅ |
| `packages/runtime-local/test/platform-credentials-cli.test.ts` | 89 | ✅ |
| `packages/runtime-local/test/process-control.test.ts` | 15 | ✅ |
| `packages/runtime-local/test/program-lock.test.ts` | 39 | ✅ |
| `packages/runtime-local/test/programs.test.ts` | 508 | ✅ |
| `packages/runtime-local/test/resource-store.test.ts` | 68 | ✅ |
| `packages/runtime-local/test/rotation-process.test.ts` | 107 | ✅ |
| `packages/runtime-local/test/sqlite-state.test.ts` | 434 | ✅ |
| `packages/runtime-local/test/startup-failure.test.ts` | 74 | ✅ |
| `packages/runtime-local/test/windows-command-line.test.ts` | 10 | ✅ |
| `packages/runtime-local/test/worker-process.test.ts` | 131 | ✅ |
| `packages/executor/README.md` | 28 | ✅ |
| `packages/executor/package.json` | 18 | ✅ |
| `packages/executor/src/executor.ts` | 686 | ✅ |
| `packages/executor/src/index.ts` | 10 | ✅ |
| `packages/executor/src/planning.ts` | 67 | ✅ |
| `packages/executor/src/registry.ts` | 234 | ✅ |
| `packages/executor/src/resources.ts` | 34 | ✅ |
| `packages/executor/src/types.ts` | 69 | ✅ |
| `packages/executor/test/driver.test.ts` | 304 | ✅ |
| `packages/executor/test/scheduler.test.ts` | 504 | ✅ |
| `packages/executor/test/validation.test.ts` | 304 | ✅ |
| `packages/run/README.md` | 23 | ✅ |
| `packages/run/package.json` | 16 | ✅ |
| `packages/run/src/candidate.ts` | 33 | ✅ |
| `packages/run/src/facet.ts` | 59 | ✅ |
| `packages/run/src/frontend-facet.ts` | 23 | ✅ |
| `packages/run/src/frontend.ts` | 49 | ✅ |
| `packages/run/src/graph.ts` | 65 | ✅ |
| `packages/run/src/index.ts` | 32 | ✅ |
| `packages/run/src/registry.ts` | 24 | ✅ |
| `packages/run/src/resolve.ts` | 213 | ✅ |
| `packages/run/src/types.ts` | 145 | ✅ |
| `packages/endpoint/README.md` | 152 | ✅ |
| `packages/endpoint/package.json` | 15 | ✅ |
| `packages/endpoint/src/http.ts` | 117 | ✅ |
| `packages/endpoint/src/index.ts` | 502 | ✅ |
| `packages/endpoint/test/endpoint.test.ts` | 128 | ✅ |
| `packages/credential-store-local/README.md` | 37 | ✅ |
| `packages/credential-store-local/package.json` | 28 | ✅ |
| `packages/credential-store-local/runtime/windows-credential.ps1` | 61 | ✅ |
| `packages/credential-store-local/src/activation.ts` | 41 | ✅ |
| `packages/credential-store-local/src/file.ts` | 90 | ✅ |
| `packages/credential-store-local/src/index.ts` | 4 | ✅ |
| `packages/credential-store-local/src/os.ts` | 142 | ✅ |
| `packages/credential-store-local/src/store.ts` | 94 | ✅ |
| `packages/credential-store-local/src/windows.ts` | 61 | ✅ |
| `packages/credential-store-local/test/file-concurrency.test.ts` | 103 | ✅ |
| `packages/credential-store-local/test/file-failed-replacement.test.ts` | 46 | ✅ |
| `packages/credential-store-local/test/file-store-writer-fixture.ts` | 19 | ✅ |
| `packages/credential-store-local/test/file-store.test.ts` | 66 | ✅ |
| `packages/credential-store-local/test/os-store.test.ts` | 37 | ✅ |
| `packages/credential-store-local/test/store.test.ts` | 128 | ✅ |
| `packages/credential-store-local/test/windows-limit.test.ts` | 12 | ✅ |
| `packages/credential-store-local/test/windows.test.ts` | 50 | ✅ |
| `packages/credential-store-env/README.md` | 11 | ✅ |
| `packages/credential-store-env/package.json` | 25 | ✅ |
| `packages/credential-store-env/src/activation.ts` | 25 | ✅ |
| `packages/credential-store-env/src/index.ts` | 23 | ✅ |
| `packages/credential-store-env/test/store.test.ts` | 17 | ✅ |
| `packages/producer/README.md` | 109 | ✅ |
| `packages/producer/package.json` | 14 | ✅ |
| `packages/producer/src/index.ts` | 151 | ✅ |

**Reading note.** All `src/**`, READMEs, package manifests and the `.ps1` were read top to bottom. The large test files (`local.test.ts`, `config.test.ts`, `programs.test.ts`) were read for their test bodies and every assertion; their long inline fixture setup was read more quickly. Test counts and assertion counts above come from counting `test(` and `assert` occurrences per file, so they are approximate.

---

## Check

Second review against hypit `dc2b7a8f31b1ef1443a79ca448548d69e3ceb6a0` and `clipper/server` at `8ba4657`.

**Totals.** About 150 claims checked (citations, numbers, test counts and our-app comparisons). 140 confirmed, 10 corrected or extended, 0 removed, 0 left unverified.

**Our app (priority 1), confirmed:**
- Three independent in-memory queues that don't share capacity: `render.ts:36-39`, `caption-jobs.ts:20-21`, `formats.ts:40-41`.
- Global FIFO (`push`/`shift`). The per-workspace caps (20 / 5 / 3) are the only fairness, and they count only waiting jobs.
- A resume re-records the voiceover: fresh temp dir, `speak()` always called (`render.ts:135`, `:201-203`).
- The AI budget isn't re-checked on resume. `checkAIBudget` is reached only through `spendAI` at enqueue (`llm.ts:48`, `app.ts:1190`).
- There are no cancel endpoints for render, caption or format jobs.
- `llm.ts` has no 429/5xx retry. Its only retry is the `response_format` 400 fallback (`llm.ts:197-201`).

**Corrected:**
1. `formats.ts` citations were stale (`:211-212`, `:212`, `:215`, `:234-248`). They are now `:40-41`, `:41`, `:44` and `:64-77`. Other our-app line ranges were nudged too (`render.ts:45-62`, `index.ts:16-28`).
2. Cancel row: agent runs can also be stopped (`app.ts:578`), not only scheduled posts.
3. Fairness (table row, turn protocol, idea 4): the round-robin cursor and the "capacity holders first" claim ordering exist, but runtime-local runs one build per scheduler pass and always claims a named build (`worker.ts:415-432`). The production order is oldest-first.
4. The `CompositeCredentialStore` "wasteful" smell was overstated. Foreign stores return early through `owns()`, so only the owning store spawns a process.
5. The runtime-local assert count was about 505, not about 530. One `resolve.ts` line cite was off by one (`:98` → `:97`).

**Added:** the boot resume scan ignores format breakdowns (`db.ts:147-155`). Deleting a job doesn't stop running work. A resumed format re-pays its vision call. Whisper and ffmpeg run in all three queues.

**Hypit (priority 2), confirmed as written:**
- the capacity claim model (`capacity.ts:1-51`);
- `sqlite-state.ts:803-873` (token refill, `availableAt` formula, `json_each` occupancy sum, all-or-nothing transaction, rate tokens spent but not held);
- `scheduler.ts:176-196`;
- `worker.ts:86-117` (`EXECUTION_UNKNOWN` on a `started` receipt or a thrown error) and `:388` (`.catch(() => undefined)`);
- `executor.ts:388-407` (`SUBMISSION_INTERRUPTED`; `submission: "started"` set before `start`);
- `supervisor.ts:103-106`;
- `executor/README.md:18`;
- `scheduler.test.ts:486-504` (`starts === 1`, `polls === 1`, receipt kept);
- `run/src/resolve.ts:125-147`;
- the macOS keychain secret on argv (`os.ts:35-49`, with `-w secret` at `:39-41`).

**Coverage.** Every file in the eight packages is in the table, and all line counts match `wc -l`. The package totals also match (src 10,647, all 17,477). No files were added.

**Verdict: Verified ✅.** Corrections were under 10% of claims, and coverage is complete. The one substantive issue was the fairness description, now fixed: hypit's round-robin and in-flight-first ordering aren't what governs cross-build admission in runtime-local.
