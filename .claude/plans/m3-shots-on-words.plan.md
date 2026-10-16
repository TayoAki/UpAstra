# Plan: Shots that land on their words

**Source PRD**: `.claude/prds/ugcmediaclips-v2.prd.md`
**Selected Milestone**: 3 — Shots that land on their words (B3.1–B3.3 in `clipper/docs/BUILD-PLAN.md`)
**Complexity**: Medium

## Summary
Each planned shot names the narration phrase it illustrates, and each shot starts when that phrase is spoken: on aligned word times, or on estimated ones when there's no transcription. A shot whose phrase can't be found falls back to proportional sizing, and the fallback is logged. Shot in-points snap to a nearby scene cut. The planner prompt gets a short "visual evidence" rule.

## Deviation from BUILD-PLAN B3.2 (decided here)
A whole-file pre-scan decodes every frame of a 20-minute 1080p source; at a measured 5.6× the keyframe proxy, that's minutes of CPU per file. Snapping instead needs only the 0.8 s around each shot's start, decoded at 64 px wide, inside the cut step, so it's cached and resumable with the cut. Black-frame avoidance already runs per shot (`blackSpans`). "Feed pacing to formats" stays with formats, which run their own scene detection.

## Patterns to Mirror
| Category | Source | Pattern |
|---|---|---|
| Phrase lookup | `clipper/server/overlays.ts` `placeOverlays` | normalised token match, later uses take later occurrences |
| Cue validation | `clipper/shared/overlays.ts` `cueInScript` | whole-word match against the script |
| Cut step | `clipper/server/render.ts` cut `cachedStep` | snapping happens inside the cached step |
| Scene detection | `clipper/server/formats.ts` `sceneCuts` | `select='gt(scene,…)',showinfo` |

## Tasks
### Task 1: Snap to cuts (B3.2')
- **Action**: `sceneCutNear(src, t)`: decode `[t−0.4, t+0.4]` at 64 px wide and return the scene change nearest `t`. The cut step starts there.
- **Validate**: with a black/white/black fixture (cuts at 4 s and 8 s), a requested start of 3.8 s gives 4.0 s, and 6.0 s stays at 6.0 s.

### Task 2: Phrase-bound shots (B3.1)
- **Action**: add `Shot.phrase`, sanitised against the narration. Shot boundaries are pure: `shotTimes(shots, words, duration)` returns each shot's start and length, a phrase-located start where the phrase is found in order, and proportional otherwise (minimum 1.5 s). Render uses it, and logs any fallbacks.
- **Validate**:
  - each shot starts within 1 frame of its phrase's first word;
  - one missing phrase falls back for that shot only;
  - the lengths sum to the duration.

### Task 3: Planner rule (B3.3)
- **Action**: the prompt asks for a `phrase` per shot (exact narration words where the cut lands; the first shot starts with the narration) and adds the "visual evidence, not noun illustration" rule. At most 150 more prompt tokens.
- **Validate**: a prompt snapshot; a token-count assertion; the plan sanitiser keeps valid phrases and drops invented ones.

## Validation
```bash
cd clipper && npm run typecheck && npx vitest run && npm run build
```

## Parity check against hypit
- **Phrase binding:** `R/production/component-design.md:140-144`; `R/playbooks/formats/narration-led-demo.md:30-49` (study 11 #1, #2). **Beats:** the planner emits the binding and render checks it; no agent is needed.
- **Cuts:** `packages/media-local/src/files.ts:467-491` (boundary pass). **Avoids:** a whole-file decode per upload, and unbounded boundary output.

## Acceptance
- [ ] All tasks complete; validation passes; santa-method PASS
