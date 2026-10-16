# Plan: Script that says one thing and shows another

**Source PRD**: `.claude/prds/ugcmediaclips-v2.prd.md`
**Selected Milestone**: 5 (B5.3 → B5.2 → B5.1 → B5.4 in `clipper/docs/BUILD-PLAN.md`)
**Complexity**: Large

## Summary
- Speech-length estimates count syllables (Latin, with digits expanded) or characters and morae (CJK), calibrated per voice from measured renders.
- The aligner learns M:N groups ("website"/"web site", brand names merged or split by ASR), with confidence-weighted costs and speech-bounded edges.
- Narration can carry display/spoken text (`<$5|five dollars>`), so the voice says one thing while captions show another, plus named moments that overlays can cue on.

## Patterns to Mirror
| Category | Source | Pattern |
|---|---|---|
| Shared rules | `clipper/shared/rules.ts` | pure functions used by server and browser |
| Aligner | `clipper/server/align.ts` | DP over script × spoken, free edges, interpolated gaps |
| Tests | `clipper/tests/align.test.ts` | hand-built spoken word lists |

## Tasks
### Task 1: Speech estimate v2 (B5.3)
- **Action**:
  - `speechUnits(text)` counts syllables (vowel groups) for spaced scripts, characters for Han, morae for kana, and expands numbers;
  - `speechSeconds(text, rate?)` uses the default unit rate unless a calibrated one is given;
  - the per-voice rate is learned after each voiced render (`voiceRates` on the workspace, a running mean) and used by the rules check, the clip card and the planner's length;
  - `WORDS_PER_SECOND` stays only as wording in the prompt.
- **Validate**:
  - "1,250" counts as "one thousand two hundred fifty";
  - existing rule tests still pass;
  - after 5 calibration samples the estimate is within 10% on held-out scripts.

### Task 2: M:N aligner (B5.2)
- **Action**: alongside 1:1 pairs, the DP allows groups of 1..3 script words to 1..3 spoken words, matched on their concatenated normalised text. An exact concatenation match costs 0.055, near-misses cost by edit distance, and ties break deterministically. Times inside a group are split by character share. Free edges and retake trimming are kept.
- **Validate**:
  - "website" (script) vs "web site" (spoken), and the reverse;
  - "Car League" heard as "CarLeague" gets real split times;
  - every existing `align.test.ts` case still passes;
  - overlapping or nested ASR windows are clamped monotonic, never thrown.

### Task 3: Display/spoken markup (B5.1)
- **Action**:
  - `narration` may contain `<display|spoken>`;
  - TTS reads the spoken form, captions show the display form, and alignment runs on the spoken words, with display tokens getting the time span of their spoken words;
  - `@{name}` marks a moment, which overlays can cue on (`cue: "@name"`);
  - the planner may emit both;
  - rule checks read the spoken form for required phrases and the display form for banned claims.
- **Validate**:
  - `<$5|five dollars>`: the TTS mock hears "five dollars" while the caption shows "$5" across both words' time;
  - an unknown moment is a validation error;
  - a narration without markup is unchanged.

### Task 4: Confidence and speech bounds (B5.4)
- **Action**:
  - whisper.cpp token probabilities scale mismatch costs: `0.5 + 0.5·p`;
  - unmatched leading and trailing script words are bounded by the speech spans.
- **Validate**: a low-confidence word loses a tie; trailing unmatched words never run past the end of speech.

## Parity check against hypit
- **B5.2:** `narrative-speech-alignment` `align.ts:8`, `:25-32`, `:71-74`, `:91-99`, `:214-223` (study 07 §1, check).
- **B5.1:** `R/creation/script-and-time.md:58-111`; `narrative-caption/src/project.ts:31-57`.
- **B5.3:** study 07 #4, study 11 #5.

**Avoids:** charging for chatter at the edges (ours trims it), throwing on imperfect input, and an author markup language beyond these few forms.

## Acceptance
- [x] All tasks complete; validation passes; santa-method PASS (both reviewers)
