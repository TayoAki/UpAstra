# Plan: Agents that can see and plan spend

**Source PRD**: `.claude/prds/ugcmediaclips-v2.prd.md`
**Selected Milestone**: 6 (B6.2 → B6.3 → B6.1 → B6.4 in `clipper/docs/BUILD-PLAN.md`)
**Complexity**: Medium–Large

## Summary
- An MCP contract agents can rely on: strict arguments, coded errors, versioned result formats and `next` hints.
- A preflight check that says what a render will cost and what blocks it, before anything is charged.
- Tools for seeing footage (frames, contact sheets, scene cuts) and for steering renders (transcribe, voice estimate, cancel, log), with waits that don't refetch the whole state.

## Patterns to Mirror
| Category | Source | Pattern |
|---|---|---|
| MCP tools | `clipper/server/mcp.ts` `tool()` | thin wrappers over the HTTP API |
| Step cache | `clipper/server/steps.ts` | content keys; `stepStored` checks without running |
| Usage | `clipper/server/usage.ts` | per-kind usd/calls per month; daily budget |
| Tests | `clipper/tests/mcp*.test.ts` | real app + MCP client over HTTP, simulated AI |

## Tasks
### Task 1: Contract (B6.2), done in 31964a8
- Strict zod objects; `ToolError` codes from HTTP status; SDK schema errors in the same shape; `format`; `next[]`.

### Task 2: Preflight and dry run (B6.3)
- **Action:**
  - `server/preflight.ts` `preflightRender(clip, voice, override)` reports:
    - footage, each file cached and whether its moments are pending;
    - whether the voice take is cached (the same step key render uses);
    - estimates from the workspace's own average cost per call (or defaults);
    - queue position and quota left (budget USD, calls, render slots);
    - `blockers[]` with HTTP status.
  - `POST /api/clips/:id/render` with `dryRun` returns the preflight without queuing or counting. Real calls refuse on a blocker before queuing, saying "Nothing was charged".
  - MCP adds `preflight_render(clipIds)` and `dryRun` on `render_clip` and `brief_to_shorts`.
- **Validate:**
  - a dry run makes no paid call and records no usage, and the clip isn't queued;
  - the estimate equals the history average;
  - over budget, a real render is refused with no usage recorded and the clip stays approved.

### Task 3: Seeing footage (B6.1)
- `get_frames`, `contact_sheet` (3 columns × 480 px cells, `clamp(round(1.5·s), 4, 9)` frames, 3 rows a page, labels under the picture with decoded times) and `scene_cuts`, with `aroundPhrase` and `occurrence`.

### Task 4: Steering and cheap waits (B6.4)
- Add `transcribe`, `estimate_voiceover`, `cancel_render` and `get_render_log`.
- Add `GET /api/clips/:id/status`; waits back off from 100 ms to 1 s and end when the worker has stopped.

## Parity check against hypit
- **B6.2:** cli `output.ts:1028-1039`, `arguments.ts:299-305` (study 03 #3–#5).
- **B6.3:** `build-planning.ts:409-439` (study 03 #2).
- **B6.1:** study 03 #1, study 09 #4.
- **B6.4:** study 03 #6–#9.

**Avoids:** a second error vocabulary beside the API's, and estimates from static price tables that drift.

## Acceptance
- [x] All tasks complete; validation passes; santa-method PASS (both reviewers)
