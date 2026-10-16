# Plan: Resumable, step-cached renders

**Source PRD**: `.claude/prds/ugcmediaclips-v2.prd.md`
**Selected Milestone**: 1 — Resumable, step-cached renders (B1.1–B1.4 in `clipper/docs/BUILD-PLAN.md`)
**Complexity**: Medium

## Summary
Every expensive render step (the paid voiceover with its transcription, each shot cut) runs once per content key and is stored, so a resume, a re-render or a variant reuses it instead of paying or cutting again. A paid step whose outcome is unknown after a crash stops the render with a clear "needs attention" message instead of silently paying twice. Then all three job queues share one weighted, per-workspace fair controller, and users can cancel a render and read its log.

## Patterns to Mirror
| Category | Source | Pattern |
|---|---|---|
| Job lifecycle | `clipper/server/render.ts:46-86` | `tenantLoadHooks` re-queue on load; `pump()` with `running < concurrency()` |
| Progress | `clipper/server/render.ts:121-125` | `step(r, status, text)` mutates `clip.render` and `save()`s |
| Storage | `clipper/server/storage.ts:20-27` | `videoStore().put/exists/read/deletePrefix`, keys are `${workspaceId}/…` |
| Footage identity | `clipper/server/footage-cache.ts:31` | `f.storageKey ?? cacheKey(f)` names a source independent of campaign |
| Budget | `clipper/server/usage.ts:44-55` | `checkAIBudget()` throws `HttpError(429/503)` inside a workspace |
| Tests | `clipper/tests/resume.test.ts` | memory backend + mock OpenRouter server counting calls |

## Files to Change
| File | Action | Why |
|---|---|---|
| `clipper/server/steps.ts` | CREATE | `canonical`, `stepKey`, `cachedStep` (receipts, store-backed outputs) |
| `clipper/shared/types.ts` | UPDATE | `RenderInfo.steps` receipts; `ReferenceFormat.steps` |
| `clipper/server/render.ts` | UPDATE | voice and cut steps through `cachedStep`; budget check before paid calls |
| `clipper/server/formats.ts` | UPDATE | vision breakdown through `cachedStep` |
| `clipper/server/db.ts` | UPDATE | boot scan also finds analyzing formats |
| `clipper/server/jobs.ts` | CREATE (B1.3) | one weighted, round-robin capacity controller |
| `clipper/server/render.ts`, `caption-jobs.ts`, `formats.ts` | UPDATE (B1.3) | use the controller |
| `clipper/server/app.ts` | UPDATE (B1.4) | cancel endpoint; delete stops running job; log endpoint |
| `clipper/server/llm.ts` | UPDATE (B1.4) | 429/5xx retry with `Retry-After` |
| `clipper/tests/steps.test.ts`, `jobs.test.ts`, `cancel.test.ts` | CREATE | per task |

## Tasks
### Task 1: Step cache with receipts (B1.1 + B1.2)
- **Action**: `stepKey(kind, version, params) = sha256(kind@version + canonical(params))`, where `canonical` sorts keys by code point and rejects non-plain objects. `cachedStep` checks `steps/${ws}/${key}.json`. On a hit it downloads the output and returns the stored value with no charge. On a miss it writes a `started` receipt, runs, stores the file and value, and marks the receipt `done`. A paid step found `started` with no output throws "needs attention" and does not re-run. Outputs live under the `steps/` prefix so an S3 lifecycle rule can expire them; a miss just recomputes.
- **Mirror**: storage keys and `step()` progress.
- **Validate**: `npx vitest run tests/steps.test.ts`:
  - same params → one `run`; different version → a new run;
  - a key-order change keeps the same key;
  - a `Date` param throws;
  - a `started` paid receipt with no output throws.

### Task 2: Voice and cuts through the cache (B1.1 + B1.2)
- **Action**: The voice step key covers narration, voice, voice model and glossary. Its value is `{ seconds, al, language }` plus the WAV file, and it calls `checkAIBudget()` before each `speak`. The cut step key covers footage identity, start, length, `hasAudio` and the frame constants. Its value is the final start after black-avoidance, plus the MP4 file.
- **Validate**: in `resume.test.ts` and `steps.test.ts`:
  - rendering the same clip twice calls the TTS mock once and cuts once;
  - a render killed after voicing resumes with 0 more TTS calls;
  - a resume over budget fails with the budget message and no TTS call.

### Task 3: Formats resume without re-paying (B1.1)
- **Action**: the boot scan also picks up formats in `analyzing` (in both Postgres and memory backends), and the vision breakdown goes through `cachedStep` keyed by video key, prompt version and model.
- **Validate**: in `formats.test.ts`, re-analysing the same upload makes 0 more vision calls.

### Task 4: One capacity controller (B1.3)
- **Action**: a `jobs.ts` controller with total capacity `RENDER_CONCURRENCY` (default 1, in CPU units). Weights are render 2, caption 1 and format 1, capped at capacity. Waiting jobs are served round-robin across workspaces, and an enqueue wakes the controller. It replaces the three private pumps.
- **Validate**: in `jobs.test.ts`:
  - workspaces A, A, A, B are served A, B, A, A;
  - with capacity 2, a weight-2 render blocks two caption jobs;
  - nothing polls.

### Task 5: Cancel, log and retries (B1.4)
- **Action**:
  - `POST /api/clips/:id/render/cancel` aborts the running job with an `AbortSignal` threaded to `run()`, which kills the process group, and to `fetch`;
  - deleting a clip, caption job or format cancels its job;
  - a per-render `log` of `{ step, ms }` is kept on `RenderInfo`;
  - `chatJSON` and `speak` retry 429/5xx up to 2 times, honouring `Retry-After` (capped at 20 s).
- **Validate**: in `cancel.test.ts`:
  - cancelling during a cut leaves the clip `cancelled` and kills ffmpeg;
  - a mock 429 then 200 succeeds;
  - a deleted clip's job stops.

## Validation
```bash
cd clipper && npm run typecheck && npx vitest run && npm run build
```

## Risks
| Risk | Likelihood | Mitigation |
|---|---|---|
| Cache serves stale output after a code change | Low | the version is in the key; bump it on any change to that step |
| Storage growth from `steps/` | Med | a top-level `steps/` prefix that an S3 lifecycle rule expires (14 days); a miss only recomputes |
| An S3 HEAD/GET per step slows renders | Low | a few requests per render, against seconds of ffmpeg |
| A shared controller starves long renders | Low | round-robin by workspace, FIFO within one; weights cap concurrency |

## Parity check against hypit
- **Receipts:** `packages/runtime-local/src/worker.ts:86-117`, `executor.ts:388-407` (study 02 #2). **Beats:** we resume from the last done step; hypit fails in-flight jobs (`supervisor.ts:103-106`).
- **Content keys:** `packages/kernel/src/plan.ts:131-297`, `packages/result/src/node/store.ts:370-395` (study 01 #1, #2, #5). **Beats:** hypit has no content identity (`packages/protocol/src/identity.ts:1`). **Avoids:** `localeCompare` canonicalisation (`canonical.ts:16`), path-based ids, and silently turning non-plain objects into `{}` (study 01 check).
- **Capacity:** `packages/runtime/src/capacity.ts:1-51`. **Beats:** our admission is round-robin across tenants; hypit's runtime-local admits oldest first (study 02 check).

## Acceptance
- [ ] All tasks complete
- [ ] Validation passes
- [ ] Patterns mirrored, not reinvented
- [ ] Parity notes in each commit; santa-method PASS
