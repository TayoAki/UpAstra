# Plan: Captions that always fit

**Source PRD**: `.claude/prds/ugcmediaclips-v2.prd.md`
**Selected Milestone**: 2 — Captions that always fit (B2.1–B2.4 in `clipper/docs/BUILD-PLAN.md`)
**Complexity**: Medium

## Summary
Four changes:
- caption words are spaced by script, so CJK and mixed text get no stray spaces;
- every caption group is measured with libass metrics and broken onto at most 2 lines, or split in time when it needs more;
- the block is bottom-anchored, outline and shadow scale with size, and the karaoke highlight drops during real pauses;
- four new presets, plus a springier pop.

## Patterns to Mirror
| Category | Source | Pattern |
|---|---|---|
| Measurement | `clipper/server/overlays.ts` `textWidth`/`fitText` | libass-measured widths, the ×1.3 fallback for unknown fonts |
| Grouping | `clipper/shared/caption-styles.ts:105` `groupWords` | `{ text, start, end, words, first }` groups |
| ASS | `clipper/server/captions.ts` `buildAss` | one Cap style, events per group (per word for karaoke) |
| Tests | `clipper/tests/render.test.ts` "writes a valid ASS file" | assertions on ASS lines |

## Files to Change
| File | Action | Why |
|---|---|---|
| `clipper/shared/words.ts` | CREATE | `joinWords`: a space between words unless either side is CJK, kana or Thai |
| `clipper/shared/caption-styles.ts` | UPDATE | `groupWords` text via `joinWords`; outline/shadow scale with size; new presets |
| `clipper/server/captions.ts` | UPDATE | `fitCaption` line budget and re-split; `\an2` bottom anchor; pause-aware karaoke; spring pop |
| `clipper/server/render.ts`, `caption-jobs.ts` | UPDATE | drop the per-language `joiner` |
| `clipper/tests/caption-fit.test.ts` | CREATE | per task |

## Tasks
### Task 1: Per-word spacing (B2.1)
- **Validate**: `joinWords(["今日","は","Car","League"])` gives `"今日はCar League"`; Latin is unchanged; a Japanese render's ASS has no spaces between kana and kanji.

### Task 2: Line budget (B2.2)
- **Action**: a group's width is its `textWidth` plus 2×outline, measured against `W − 2·70`. Break it into 2 balanced lines with `\N`. If that still doesn't fit, split the group in time at its widest word boundary, recursively, and only then shrink to 80%.
- **Validate**: a 40-character brand name and a long German compound give no line wider than the safe width and no more than 2 lines, with every word still shown once.

### Task 3: Anchor, scaling, pauses (B2.3)
- **Validate**:
  - captions use `\an2` with y at the old centre + half a line, so single lines look as before;
  - a 2× size override doubles outline and shadow;
  - a 1 s gap between words shows the line without a highlighted word.

### Task 4: Presets and spring (B2.4)
- **Action**:
  - "Box highlight": the active word on an accent box, using a `\3c`/`\bord` swap with BorderStyle 3 per word event;
  - "Underline": the active word `\u1`;
  - "Fill sweep": `\kf` in one event per group;
  - "Accumulate": words appear as spoken;
  - the pop is 72% → 105% → 100%.
- **Validate**: an ASS snapshot per preset; "Fill sweep" emits one event per group.

## Validation
```bash
cd clipper && npm run typecheck && npx vitest run && npm run build
```
Then render a frame for each preset with long, CJK and mixed text, and look at it.

## Risks
| Risk | Likelihood | Mitigation |
|---|---|---|
| Existing presets' look changes | Med | single-line placement is kept identical (`\an2` at centre + half a line); old ASS tests stay green |
| Splitting groups shifts caption timing | Low | splits fall on word boundaries using the words' own times |

## Parity check against hypit
- **B2.1:** `packages/caption/src/types.ts:5-6`, `packages/caption-fine/src/spacing.ts:6-16`.
- **B2.2:** caption-fine `render.ts:628-639`, `:719-724`. **Beats:** hypit throws on overflow; we re-split.
- **B2.3:** caption-fine `README.md:73`, `render.ts:594-598`, `manifest.ts:101-129`, `render.ts:646-663`.
- **B2.4:** caption-fine `render.ts:441-516`, `:939-967`, `:365-373`. **Avoids:** the ~110-knob parameter set.

## Acceptance
- [x] All tasks complete; validation passes; santa-method PASS (both reviewers)
