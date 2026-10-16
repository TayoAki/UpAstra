# Plan: New formats

**Source PRD**: `.claude/prds/ugcmediaclips-v2.prd.md`
**Selected Milestone**: 8 (B8.1–B8.3 in `clipper/docs/BUILD-PLAN.md`)
**Complexity**: Medium

## Summary
- Two new ranking overlays: a Top-N column and a podium. Both reuse the tier board's reveal → glide → settle schedule (B4.1) and its fit check (B4.3).
- A quiz answer strip: 2–4 answer chips, with an optional highlight on the correct answer.
- Format breakdowns record what each beat is for, so plans transfer a format's structure rather than its seconds.

## Patterns to Mirror
| Category | Source | Pattern |
|---|---|---|
| Boards | `server/overlays.ts` `tierLayout`, `tierSchedule`, `overlayEvents` | pure layout + three events per item |
| Overlay validation | `shared/overlays.ts` `sanitizeOverlays` | known kinds and fields only |
| Formats | `server/formats.ts` `cleanBreakdown`, `formatForPlanner` | sanitize model JSON; planner input |

## Tasks
### Task 1: Top-N column and podium (B8.1)
- **Action:** add `kind: "rank"` (`rank` 1–10) and `kind: "podium"` (`rank` 1–3).
  - Each has a layout function: a column of numbered slots, or three blocks with 1st in the middle and tallest.
  - Items pop in at the centre, glide into their slot (`tierSchedule`), and stay until the CTA.
  - Comment cards treat them as a board.
  - SFX treat them like tier items.
  - Wire them into the planner prompt, MCP, the overlay editor and validation.
- **Validate:**
  - ASS snapshots;
  - every label fits its slot (fit check) and stays inside the footage band;
  - slots don't overlap;
  - a countdown 5→1 settles each item before the next.

### Task 2: Quiz answer strip (B8.2)
- **Action:** add `kind: "quiz"` with `answers` (2–4) and an optional `correct` index.
  - A strip of chips along the bottom of the footage pops in on its cue.
  - The correct chip lights in the accent colour for the last 40% of the hold.
- **Validate:**
  - the strip stays in frame for 2, 3 and 4 answers (long answers shrink or wrap within their chip);
  - the reveal is timed as specified.

### Task 3: Richer format breakdowns (B8.3)
- **Action:**
  - `cleanBreakdown` records, for each beat, its `anchor` (what it hangs on: a line, a visual, a cut) and its `job` (what it does for the viewer);
  - it also records persistent systems (elements that run through the video) and the measured speech rate;
  - `formatForPlanner` passes relationships (order, share of the runtime, jobs) instead of raw seconds;
  - it adds transformation lenses, so footage without the reference's elements can redistribute a missing system's job.
- **Validate:** fixture snapshots of `cleanBreakdown` and `formatForPlanner`.

## Parity check against hypit
- **B8.1:** `packages/ranking/src/render.ts:464-650` (study 08 #5).
- **B8.2:** `interview-emoji-reveal/src/program.ts:196-199` (study 08 #9).
- **B8.3:** `R/creation/reference-video.md`, `transformations.md` (study 11 #4, #10).

**Avoids:** per-frame keyframe baking, and throwing on imperfect input.

## Acceptance
- [x] All tasks complete; validation passes; santa-method PASS (both reviewers)
