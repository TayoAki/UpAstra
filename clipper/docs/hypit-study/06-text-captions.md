# 06 · Text & captions

- **Source:** `hypit` at commit `dc2b7a8f31b1ef1443a79ca448548d69e3ceb6a0` (read-only; nothing was built or run).
- **Our side:** `clipper/shared/caption-styles.ts` (121 lines), `clipper/server/captions.ts` (167), `clipper/server/fonts.ts` (39).

| Package | `src/**` lines | `test/**` lines | Files |
| --- | ---: | ---: | --- |
| `@hypit/caption` | 514 | 34 | 11 src + 1 test |
| `@hypit/caption-fine` | 3,112 | 835 | 14 src + 3 tests (+1 preview PNG) |
| `@hypit/text` | 1,303 | 228 | 10 src + 1 test |
| `@hypit/text-fine` | 2,425 | 675 | 8 src + 1 test (+2 preview PNGs) |
| `@hypit/fontsource` | 234 | 61 | 5 src + 1 test |
| `@hypit/narrative-caption` | 366 | 0 | 11 src, no tests |
| **Total** | **7,954** | **1,833** | |

All paths below are relative to the hypit repo root unless they start with `clipper/`.

---

## Summary for UGCMediaClips

hypit's caption system is split into three layers:

1. **Content**: `CaptionDocument`, made of words, units and cues.
2. **Timing**: `CaptionTiming`, absolute frame boundaries for each unit.
3. **Presentation**: a "family" such as `caption-fine`, which renders HTML/CSS Visual IR and draws it in a browser.

Cues (caption groups) are **authored upstream by Script** (`||`) and never split or merged by the renderer (`packages/caption-fine/README.md:52-56`). No automatic grouping algorithm exists anywhere in this batch. Our `groupWords` is therefore ahead on automation.

What hypit does better, and what we can port into libass without a browser:

- **Per-word authored separators.** These fix CJK and mixed-script spacing.
- **Structural line rows with a hard line budget.**
- **Exclusive "current word" activation.**
- **An explicit lead/tail visibility envelope with cut handoff.**
- **Layered active-word treatments.** These are fill, underline, a box (isolated or joined) and a response pop.
- **A strict recipe schema** with inheritance from the base paint to the active paint.
- **Typography guidance** that ties stroke, shadow and glow to type size.
- **Time-windowed style overrides,** including a "Hidden" style.

The fonts adapter (`fontsource`) is a clean, deterministic way to pin exact faces, including unicode-range shards.

---

## 1. `@hypit/caption`: source-neutral caption content, timing and style selection

**Purpose.** This package defines the shared data model for every caption family:

- display words with authored separators;
- N:M "units" (the smallest timed group);
- authored cues;
- a flat timing table;
- an ordered list of style "Uses" that may be limited to a time window or a role.

It renders nothing itself. A family package such as `caption-fine` does the drawing (`packages/caption/README.md:6-18`, `:44-47`).

**Public surface.**

- **Types** (`packages/caption/src/types.ts`):
  - `CaptionDisplayWord`, with `separatorBefore: "" | " "`, `text` and `attributes` (`:4-11`);
  - `CaptionUnit` (`:21-24`);
  - `CaptionCue`, with an optional `role` (`:27-31`);
  - `CaptionDocument` (`:34-39`);
  - `CaptionStyleIntent`, where `rendering: null` means Hidden (`:41-48`);
  - `CaptionUse` and `CaptionProgram` (`:51-62`);
  - `CaptionTiming`, with units as `{unitId, startFrame, endFrameExclusive}` (`:64-76`).
- **Functions:**
  - `assertCaptionDocumentIdentity` (`packages/caption/src/identity.ts:18`);
  - `assertCaptionDocument`, `captionUnitsForRole` and `captionWordsForAttribute` (`packages/caption/src/display.ts:8,19,27`);
  - `appendCaptionUse` and `sealCaptionStyle` (`packages/caption/src/style.ts:52,11`);
  - `assertCaptionTimingForDocument` (`packages/caption/src/temporalize.ts:19`);
  - `captionUseVisibility` (`packages/caption/src/visibility.ts:5`).
- **Producers:** `create-caption-uses`, `append-caption-use` and `append-unbounded-caption-use` (`packages/caption/src/manifest.ts:5-9`).
- **Markup:** `<caption:Hidden id/>` (`packages/caption/src/manifest.ts:66-74`, handler `packages/caption/src/surface.ts:6-16`).

**How it works.**

- **Partition invariant.** Words partition into units, and units partition into cues, both in document order. Empty documents are allowed only when words, units and cues are all empty (`packages/caption/src/identity.ts:20-52`).
- **Separators.** The separator is per word: either `""` or `" "` (`packages/caption/src/display.ts:11`). This is how `3D`, `3개월` and `是的 就是这样` stay correct. Our app has a single `joiner` per language instead.
- **Exact timing coverage.** Timing must cover the document's units exactly. Missing and unknown units are both listed in the error. Order and monotonicity are deliberately *not* enforced (`packages/caption/src/temporalize.ts:18-34`).
- **Use precedence** (`packages/caption/src/visibility.ts:5-23`):
  1. A Use's visibility is the cue envelope ∩ the Use window, filtered by role.
  2. Every *later* matching Use subtracts its window.
  3. Hidden (`rendering: null`) still subtracts. A later "hide" therefore masks an earlier style without restarting anything.
- **Style conflicts.** Re-declaring a style id with different parameters throws (`packages/caption/src/style.ts:53-54`).

**Tests.** There is 1 test (`packages/caption/test/caption.test.ts:24-34`). It covers the partition validity, the role→unit query, and the rejection of out-of-order cue partitions.

**Quality notes.**

- *Strengths:* the invariants are tight and the errors are explicit.
- *Weaknesses:* almost all behaviour is exercised only via `caption-fine` tests.
- `captionUseVisibility` is O(uses²) per cue. That is fine at caption scale.

**Relevance: Medium.** We don't need the graph machinery. The **data shape** is worth copying, though:

- a per-word `separatorBefore`;
- a units layer (one timed unit may hold several display words, e.g. "1,000" spoken as "one thousand");
- cues kept separate from timing.

**Better version.** Keep our flat `{text,start,end}[]`, but add `sep: "" | " "` per word, set from the transcriber and aligner. Then build caption text as `words.map((w,i)=> (i? w.sep:"") + w.text)` instead of `join(" ")` or a per-language `joiner`. Store cue boundaries as indices, so that editor edits don't touch timing.

---

## 2. `@hypit/caption-fine`: the uniform-flow caption renderer (karaoke, boxes, motion)

**Purpose.** This is the caption family. One SVS recipe freezes three things:

- **Where:** placement, anchors, width, wrap and line limits.
- **How:** an exact font stack, base and active glyph paint, the cue box and decorations.
- **When:** the lead/tail envelope, handoff, cue/atom motion, reveal, karaoke and loops.

The family schedules visible cue envelopes, then renders each cue as nested HTML/CSS Visual IR elements with keyframe animations. These are drawn in a browser (`packages/caption-fine/README.md:46-56`).

**Public surface** (`packages/caption-fine/src/index.ts:1-21`):

- `scheduleFineCaption` and `assertFineCaptionSchedule` (`packages/caption-fine/src/schedule.ts:42,122`);
- `renderFineCaption` (`packages/caption-fine/src/render.ts:1080`);
- `fineCaptionParameters`, `fineCaptionStyle` and `FINE_CAPTION_FAMILY="@hypit/caption-fine@1"` (`packages/caption-fine/src/style.ts:173,359,16`);
- the recipe schema and property lists (`packages/caption-fine/src/recipe.ts:74-120`);
- 24 one-shot motions (`packages/caption-fine/src/recipe.ts:3-7`).

Markup:

- `<caption-fine:Style id recipe font>` with `<Fallback font>` children (`packages/caption-fine/src/manifest.ts:36-300`, decoder `packages/caption-fine/src/surface.ts:108-118`);
- `<caption-fine:Caption id document timing timeline within [regions]>`, with `<Use style [role] [during] [id]>` children (`packages/caption-fine/src/manifest.ts:301-343`, decoder `packages/caption-fine/src/surface.ts:120-177`).

There is also a Studio facet (`packages/caption-fine/src/studio.ts`).

### Scheduling (`packages/caption-fine/src/schedule.ts`)

- **Cue spans.** A cue's timed span is the min of its unit starts to the max of its unit ends (`:21-33`).
- **Lead and tail.** Per Use: `visibleStart = max(0, start − leadFrames)` and `visibleEnd = end + tailFrames` (`:72-73`). Lead and tail never touch unit timing, so karaoke stays on true speech times (`:35-41`).
- **`handoff: cut`.** This applies per role (`:78`). Cues are sorted by timed start (`:77`). When the previous cue ends at or before the next cue starts:
  - the previous cue's visible end is clamped to `max(prevTimedEnd, min(prevVisibleEnd, nextTimedStart))`;
  - the next cue's visible start becomes `min(nextTimedStart, max(nextVisibleStart, thatEnd))` (`:85-89`).

  So the tail of one cue and the lead of the next never overlap, and neither spoken span is shortened. Different roles (speakers) may overlap.
- **Masking.** Use-window masking runs after the handoff (`:93-97`).
- **Envelope check.** The visible envelope must contain the timed span (`:108-113`).
- **Worked example.** The test at `packages/caption-fine/test/caption-fine.test.ts:122-131` uses lead 4 and tail 6. Two cues at [10,30) and [36,56) become visible at [6,36) and [36,62).

### Layout and line-breaking (`packages/caption-fine/src/render.ts`)

- **Placement.** The placement box is absolute at `within.x + x·W` and `within.y + y·H`, with `width = width·W` and an optional `height` (`:725-748`). The anchor is a `translate(-50%|-100%)` (`:594-598`). The cue box is either `width:100%` (fixed) or `max-content` (hug), capped at `max-width:100%` (`:767-795`).
- **Wrapping** is browser flow. Atoms are `inline-flex` with `overflow-wrap:anywhere`. `word-break` is `break-all` only for `wrap: grapheme` (`:709-716`).
- **Structural rows.** `max-words-per-line` inserts forced breaks between whole units when the running word count would exceed the limit (`structuralRowStarts`, `:628-639`; breaks emitted at `:878-885`).
- **`max-lines`.** This requires `max-words-per-line` (`packages/caption-fine/src/style.ts:342-344`). When the counted rows exceed it, the renderer **throws** rather than clipping (`packages/caption-fine/src/render.ts:719-724`, test `packages/caption-fine/test/caption-fine.test.ts:247-260`). Browser soft-wrapping is *not* measured or limited (`packages/caption-fine/README.md:123-124`).
- **Word gap.** Spacing comes from authored separators only (`packages/caption-fine/src/spacing.ts:6-16`). A uniform run uses `column-gap`; a mixed run puts `margin-left` (or right, for RTL) on individual words (`packages/caption-fine/src/render.ts:704-716`). Separators between atoms are zero-size text nodes whose `letter-spacing` equals the gap (`:797-806`). The default `word-gap` is `size·0.25` (`packages/caption-fine/src/style.ts:208`).

### Active-word styling (`packages/caption-fine/src/render.ts`)

- **Element nesting.** Each atom is `entry → loop → response → atom` (`:896-938`), so entry motion, loops and the active pop compose without fighting over `transform`.
- **Exclusive "current" owner.** Acoustic word windows may overlap. For current-only states, a unit ends at `min(ownEnd, nextUnitStart)` (`exclusiveActivationFrames`, `:646-663`; test `packages/caption-fine/test/caption-fine.test.ts:282-307`). During a pause inside a cue, no word is highlighted.
- **Karaoke.** The base glyphs are always drawn. An **absolutely positioned copy** in the active paint sits on top (`:1027-1075`). Its visibility works in one of two ways:
  - **`step`:** an opacity step at the start and end (`activationStepAnimation`, `:441-456`).
  - **`wipe`:** a `clip-path: inset(...)` sweep over the unit's own interval (`karaokeWipeAnimation`, `:463-486`).

  `current` turns off at the end of the unit; `trail` stays on.
- **Active underline** reuses the same layer with transparent glyphs and `text-decoration` (`:1073-1075`, `:224-235`).
- **Active box, isolated.** One absolute box per atom, inset by `−padding` (`:939-967`). For `current` mode it uses the exclusive window.
- **Active box, joined** (`trail` + `joined`). A browser-side program measures a hidden, untransformed clone of the whole cue with `Range.getClientRects()`. It merges word rectangles per line (keyed by `rect.top`), pads them, and traces the exterior outline of the union of rectangles on a grid. Corners are rounded at `min(radius, edge/2)` (`packages/caption-fine/src/joined-box.ts:21-73`, `:74-112`). The result is that translucent fills paint once and internal borders disappear. The clone is re-measured on every seek, including after fonts load (`packages/caption-fine/README.md:109-113`).
- **Active response.**
  - `pop`: scale `1 + (activeScale−1)·sin(πp)`.
  - `spring`: `1 + a·e^(−4p)·sin(12p)`.
  - `scale`: a step to `activeScale`.

  The defaults are `activeScale 1.08` and 6 frames (`packages/caption-fine/src/render.ts:488-516`; defaults `packages/caption-fine/src/style.ts:277-278`).
- **Typewriter reveal.** This splits the text into graphemes with `Intl.Segmenter("und",{granularity:"grapheme"})`. Each grapheme appears at `start + floor((end−start)·i/count)` (`packages/caption-fine/src/render.ts:968-1010`; test with `é` kept whole at `packages/caption-fine/test/caption-fine.test.ts:413-426`).

### Paint (`packages/caption-fine/src/render.ts`)

- **Outlines outside the glyph.** An outline is emitted as ordered paint layers (soft effects, then an outside stroke, then the fill), not as `-webkit-text-stroke`. The reason is that the CSS stroke is centred, so half of it eats into the letter (`:75-85`, `:140-164`).
- **Blur conversion.** CSS blur radii are halved into Gaussian deviations (`:86-93`).
- **Long shadow.** This is drawn as up to 32 zero-blur stacked shadows (`:104-118`).
- **Clipping fix.** `clip-path: inset(0 0 0 0)` was found to clip outlines and shadows. It is now emitted only for wipe motions (`:292-306`). This is a careful fix that is well documented.

### Motion (`packages/caption-fine/src/render.ts`)

- **Curves.** The ease curves are `easeOut` (cubic), `easeOutBack` (c1 = 1.3), bounce and elastic (`:265-288`). The 24 one-shot motions are mapped to opacity, transform, filter and clip (`:308-352`).
- **Cue spring.** The cue-entrance spring is a fixed piecewise scale: from `start` (default 0.72) to 1.05 at 50%, to 0.95 at 75%, then to 1 (`:354-375`). The test confirms 0.75 → 1.05 → 0.95 over 4 frames (`packages/caption-fine/test/caption-fine.test.ts:148-189`).
- **Duration cap.** Enter and exit are each capped at half the cue's duration (`packages/caption-fine/src/render.ts:393-396`).
- **Keyframe sampling.** Spring, bounce and elastic are sampled at up to 12 points per transition; the other motions at up to 4 (`:386-390`).
- **Loops.** There are 7 periodic loops plus `none`: shake, wobble, breathe, float, pulse, flicker and glow-pulse. Their amplitudes are fixed, e.g. shake ±3 px and wobble ±2.5° (`:518-561`).

### Recipe and validation (`packages/caption-fine/src/style.ts`)

- **Property set.** There are 11 required properties (`packages/caption-fine/src/recipe.ts:74-77`) and about 100 optional ones (`:79-97`). Unknown properties are rejected (`packages/caption-fine/src/style.ts:177-179`).
- **Colors** must be `#RRGGBB` or `#RRGGBBAA` (`:61-67`).
- **Padding** is "y [x]" (`:69-75`).
- **Inheritance.** The active paint inherits every base field except the gradient (`:98-133`, `:87`). The default active fill is `#FFD54A` (`:106`).
- **Defaults** (`:194-209`):
  - anchors: left/top;
  - `inline-size`: hug;
  - `block-align`: center;
  - `wrap`: word.
- **Bounds.** `assertFineCaptionParameters` checks all numeric bounds and rejects a duplicate font face (`:295-357`).
- **Typography guidance in the vocabulary** (`packages/caption-fine/src/manifest.ts`):
  - stroke ≈ `size/20`; past roughly `size/10` the letter counters fill in (`:101`);
  - shadow offset ≈ `size/40` and blur ≈ `size/10` (`:107-111`);
  - glow blur ≈ `size/10` (`:127`).

### Head-following regions

When `regions` is given, each cue's role selects a series. The cue is placed at the top centre of the region on each frame. A `null` frame hides the cue (opacity 0), and a role with no series falls back to the authored x/y (`packages/caption-fine/src/render.ts:600-626`, `:1132-1140`; tests `packages/caption-fine/test/caption-fine.test.ts:191-231`). The region series must cover the timeline frame-for-frame (`packages/caption-fine/src/render.ts:1109-1116`).

### Tests

There are 26 test declarations, about 28 tests at runtime counting loops:

- **`caption-fine.test.ts`:** 21 declarations, 2 of them in loops (`packages/caption-fine/test/caption-fine.test.ts`). They cover:
  - the schedule numbers (`:122-146`);
  - spring scales (`:148-189`);
  - region following and the null-frame hide (`:191-231`);
  - placement inside an arbitrary frame (`:233-245`): 350px, 920px, 400px, 192px;
  - the max-lines throw (`:247-260`);
  - Hidden producing no output (`:262-272`);
  - the overlapping-word karaoke owner (`:282-307`);
  - CJK karaoke, underline and boxes on uneven timing (`:361-383`);
  - the CJK wipe and typewriter (`:385-411`);
  - a Use starting mid-cue keeping identical animation data (`:471-501`);
  - authored separators for `3개월` and `是的 就是这样`, giving a 14px gap, and for `3D`, giving no gap (`:550-580`).
- **`layout.browser.test.ts`:** 2 tests, run in a real browser and skipped without one. They assert that the joined-box clone geometry matches the visible glyphs within 0.1px across alignments, RTL, wrap and typewriter. They also check that joined fills cover wrapped glyphs, keep alpha 50% (pixel 127,191,127), and survive reverse seeks and rotation (`packages/caption-fine/test/layout.browser.test.ts:40-137`).
- **`studio-companion.test.ts`:** 3 tests (`packages/caption-fine/test/studio-companion.test.ts`).

### Quality notes

**Strengths:**

- a precise separation of timing (truth) from visibility (presentation);
- careful CJK and grapheme handling;
- well-explained paint ordering;
- strict recipe validation;
- real browser pixel tests for the hardest piece, the joined boxes.

**Weaknesses and smells:**

1. `max-lines` counts only *structural* rows. Physical wraps can still exceed the limit, which the README admits (`packages/caption-fine/README.md:123-124`). Exceeding the structural limit throws at render time (`packages/caption-fine/src/render.ts:719-724`), which is hostile to unattended pipelines.
2. In `activeBoxAnimation`, `enterFrames` and `exitFrames` are each capped by the full logical span, not by the span minus the other transition (`packages/caption-fine/src/render.ts:572-573`). On short words the enter and exit transitions overlap. The code then picks `enter` while `enterProgress < 1` (`:585`), so the exit is effectively truncated. This is minor.
3. The joined box requires a live DOM and `getClientRects` on every seek (`packages/caption-fine/src/joined-box.ts:74-99`). It only works in a browser backend (`packages/caption-fine/README.md:112-113`).
4. There are unused imports: `Timeline` and `temporalTypes` in `packages/caption-fine/src/manifest.ts:1,5`.
5. The surface is large: about 110 recipe properties and 24 motions × 5 motion slots, plus 8 loop options. It is powerful, but the parameter space is hard to audit visually.

**Relevance: High.** This is the closest thing in hypit to our caption renderer. Its algorithms translate directly to ASS.

**Better version.** Stay on libass, which is CPU-cheap and deterministic, and port the semantics:

- the lead/tail plus `cut` scheduler;
- exclusive activation;
- per-word separators;
- structural rows with a *re-split* (not a throw) when a group would exceed N lines;
- karaoke `trail` and `wipe` via ASS `\k` and `\kf` in one event, keeping per-word events for `current`;
- an isolated active box as a second event layer (`BorderStyle 3` on the active word only, or an `\p` drawing);
- springs approximated with chained `\t` transforms.

Skip the joined box and head-following unless we adopt a browser renderer.

---

## 3. `@hypit/text`: data-only text templates and the `Text` graph value

**Purpose.** This package provides a domain-neutral `Text {value}` value and a finite, data-only template language (`TextTemplate`). Templates are rendered against explicit bindings, and the output feeds prompts, labels and titles. It also lowers a flat SVS "text-template" recipe sheet into that language (`packages/text/README.md:6-37`).

**Public surface.**

- **Functions:** `renderText`, `bindText`, `sealText*`, `verifyText*` and `textTemplateBindingNames` (`packages/text/src/program.ts`); `textTemplateFromRecipes` (`packages/text/src/recipe.ts:115`).
- **Frontend:** the SVS frontend `@hypit/text/svs@1` (`packages/text/src/frontend.ts:11-40`).
- **Producers:** `empty-bindings`, `bind-text` and `render` (`packages/text/src/manifest.ts:13-17`).
- **Markup:** `<text:Value id>` and `<text:Render id template [recipe]>`, with `<Param>`, `<Set>` and `<Append>` children (`packages/text/src/manifest.ts:19-126`; decoders `packages/text/src/surface.ts:104-212`).

**How it works.**

- **Expressions.** The kinds are `literal`, `slot`, `sequence`, `join` (with `omitEmpty`), `choice`, `optional`, `each`, `replace`, `transform` and `call` (`packages/text/src/types.ts:35-72`).
- **Calls** are checked for unknown targets and cycles with a DFS (`packages/text/src/program.ts:171-190`).
- **Choices.** A choice that matches more than one case throws. A choice with no match and no `otherwise` throws (`:372-378`).
- **Bindings.** `each` binds a lexical local (`:382-386`). Binding names must be lower-kebab, max 96 characters (`:15`).
- **`renderText` strictness.** It rejects bindings the template doesn't consume, and defaults that are never consumed (`:407-418`).
- **`bindText`.** `set` refuses to overwrite an existing value; `append` accumulates a list (`:230-246`).
- **Recipe lowering.** Blocks of kind fixed, axis, variant or slot are ordered by `order` and joined with `"\n\n"` and `omitEmpty` (`packages/text/src/recipe.ts:115-188`). Stray recipes under the root are rejected (`:172-178`).
- **Render surface.** It projects only the recipe properties the template declares; an explicit `Param` wins (`packages/text/src/surface.ts:128-162`).

**Tests.** There are 7 tests (`packages/text/test/text.test.ts`). They cover:

- a literal `</sheet>` preserved inside template text (`:22-31`);
- nested choices, lists and transforms (`:33-85`);
- the "already set" refusal (`:87-96`);
- cycle and ambiguous-choice rejection (`:98-114`);
- `each` lexical scope (`:116-134`);
- markup surfaces (`:136-182`);
- recipe projection with Param override (`:184-228`).

**Quality notes.**

- *Strength:* the language is small, total and deterministic.
- *Inconsistency:* the `Set` child is documented as one that "replaces the binding of that name" (`packages/text/src/manifest.ts:89`). However, `bindText` throws when the name is already set (`packages/text/src/program.ts:239-241`). A `Set` on a name already filled by a `Param` or by the recipe therefore fails the build.
- *Smell:* every recipe under `.choice.` is marked "consumed" (`packages/text/src/recipe.ts:175`). A choice recipe for a block id that doesn't exist is silently ignored instead of being rejected as stray.

**Relevance: Low.** Our hook, on-screen text and CTA strings come from LLM clip plans, not from templates. The template idea could tidy prompt assembly in `server/` (unverified for us; not studied here), but it does not affect captions.

**Better version.** If we template prompts, a plain TS function per prompt is enough. Borrow only two rules: reject unknown bindings, and reject ambiguous choices.

---

## 4. `@hypit/text-fine`: titles, labels and editorial text (Flow / Point / Path / Mask)

**Purpose.** This package handles independent, timed text occurrences such as titles, labels and short copy. They come in three geometric forms:

- **Flow:** text inside a frame;
- **Point:** text anchored at a point;
- **Path:** text along a Bézier path.

Each occurrence has its own style, motion and absolute window. A separate `Mask` cuts a still image through glyphs. It is explicitly *not* for spoken captions (`packages/text-fine/README.md:3-13`, `:41-43`).

**Public surface.**

- **Functions:**
  - `createFineTextOccurrence` (`packages/text-fine/src/program.ts:310`);
  - `renderFineTextOccurrence` (`:540`);
  - `renderFineTextMask` (`:620`);
  - the bind-placement helpers (`:258-279`);
  - the seal/assert helpers (`packages/text-fine/src/index.ts:3`).
- **Markup:** `Style`, `Motion`, `PathMotion`, `Flow`, `Point`, `Path` and `Mask` (`packages/text-fine/src/manifest.ts:192-504`; decoders `packages/text-fine/src/surface.ts:354-841`).
- **Producers:** seven in all (`packages/text-fine/src/manifest.ts:49-57`).

**How it works.**

- **The package is a declaration layer.** It emits a single `text-flow` or `path-text` Visual IR element under `placement → motion` boxes (`packages/text-fine/src/program.ts:403-440`, `:522-538`). The heavy features (wrap, ellipsis, shrink-to-fit, columns, line/word/grapheme boxes, joined boxes, sequences and path layout) are implemented by the composition and html-program renderer, **not in this batch**. That renderer's behaviour is unverified here. The tests only assert that the HTML contains markers such as `data-hypit-text-overflow="shrink"`, `<textPath` and `feMorphology` (`packages/text-fine/test/text-fine.test.ts:575-586`).
- **Flow policy.**
  - `overflow` is one of visible, clip, ellipsis or shrink.
  - `shrink` requires `minimumScale` in (0, 1].
  - `maxLines` is valid only with ellipsis or shrink (`packages/text-fine/src/program.ts:199-226`).
  - Surface defaults: fixed/fixed sizing, `align` center, `block-align` center, `wrap` word, `overflow` visible (`packages/text-fine/src/surface.ts:615-636`).
  - Point anchors default to center/center (`:638-644`).
- **Style.** A style recipe takes typography properties only: size, weight, line-height, tracking, CJK spacing, punctuation trim and so on (`packages/text-fine/src/surface.ts:347-352`). Paints are ordered children: Fill, Stroke (inside, center or outside), Shadow, Glow, and Box. A Box targets the frame, content, paragraph, line, run, word or grapheme, and can be isolated or joined, with a tail and box shadows (`:255-345`). At least one Fill or Stroke is required (`:400-402`).
- **Rich documents.** These are built from `<P>`, `<Span style>` and `<Break>`. Paragraph text is dedented as one block, with `\u0000` marks standing in for nested elements (`packages/text-fine/src/surface.ts:529-589`; test `packages/text-fine/test/text-fine.test.ts:589-675`).
- **Motion.** There are whole-item keyframes plus `Sequence`s over word, line, run and similar units, with stagger, cycles and seed (`packages/text-fine/src/surface.ts:456-499`).
- **Mask** is deliberately narrow: one unstyled Flow paragraph, no sequences, no wrap, a fixed size, a still material, and a font that matches its primary face without synthesis (`packages/text-fine/src/program.ts:442-520`). The material is fitted with `resolveContentFit` and then emitted as a matrix transform (`:580-610`).

**Tests.** There are 8 tests (`packages/text-fine/test/text-fine.test.ts`). They cover:

- a single occurrence rendering as `text-flow` (`:164-179`);
- Mask element order, the cover matrix `matrix(2,0,0,2,0,-120)`, and rejection of timed material and of `shrink` (`:181-225`);
- the out-of-timeline span check (`:227-234`);
- a selection-projected window giving [30, 60) (`:236-263`);
- a full markup compile with no aggregate producers (`:265-446`);
- only `during` being exposed for timing (`:448-464`);
- rich lowering markers (`:466-587`);
- paragraph dedent (`:589-675`).

**Quality notes.**

- *Strength:* a clean separation of reusable style from per-occurrence geometry and `z` (`packages/text-fine/README.md:78-83`).
- *Smell:* `fonts.length` is read before the `fonts !== undefined` guard, so the guard is dead (`packages/text-fine/src/program.ts:473-475`).
- *Smell:* enum-valued recipe properties are cast with `as` without local validation (`packages/text-fine/src/surface.ts:408-425`, `:485-487`). They are presumably caught by the Visual IR validation reached via `assertVisualTrackIdentity` (`packages/text-fine/src/program.ts:80-107`), but that is not verified in this batch.

**Relevance: Medium.** Our hook (top, 3.2 s) and CTA card are exactly "text-fine occurrences" (`clipper/server/captions.ts:10`, `:132-134`, `:140`, `:165`). The ideas that matter are **shrink-to-fit with `minimumScale` and `maxLines`** for long LLM hooks, line-target boxes, and anchoring. We can't use Path or Mask in libass without drawing commands.

**Better version.** Fit hooks server-side with font metrics, without a browser:

1. Measure advance widths with a small OpenType reader against the exact TTF in `fonts/`.
2. Choose the largest size between `minimumScale·base` and `base` that fits in 2 lines.
3. Emit explicit `\N` line breaks and `\fs`.

---

## 5. `@hypit/fontsource`: exact font faces from installed npm packages

**Purpose.** This adapter turns `<fontsource:Face package weight style>` into a `FontArtifactRef`. It reads the installed `@fontsource*` package's `metadata.json` and CSS **as data**, never executing package code. The font version comes from the project lockfile, and there is no built-in catalog (`packages/fontsource/README.md:3-21`).

**Public surface.**

- `decodeFontsourceFaceSurface` (`packages/fontsource/src/surface.ts:95`);
- the manifest, with the `Face` surface (`packages/fontsource/src/manifest.ts:6-30`);
- a Studio inspector, with weight 1–1000 and style normal or italic (`packages/fontsource/src/studio.ts:4-21`).

**How it works.**

1. The package name must match `@fontsource(-variable)/name` (`packages/fontsource/src/surface.ts:32-38`).
2. Metadata is shape-checked (`:81-93`).
3. The style and weight are validated:
   - for static fonts, against the `weights` list, giving `${weight}[-italic].css`;
   - for variable fonts, against the `wght` axis min and max, giving `wght[-italic].css` (`:113-124`).
4. The CSS is parsed for each `@font-face`'s `./files/*.woff2` URL and its `unicode-range` (`:55-71`).
5. Each shard is resolved through the host asset resolver and kept along with its unicode range (`:127-140`).

**Tests.** There are 2 tests (`packages/fontsource/test/fontsource.test.ts`). The first checks that Inter Variable 700 normal yields **7 shards**, all from `files/` (`:11-45`). The second checks that a non-fontsource package is rejected before any asset access (`:47-61`).

**Quality notes.**

- Only woff2 files referenced as `./files/` are accepted (`packages/fontsource/src/surface.ts:61`). That is fine for Fontsource.
- The variable-axis `step` is ignored.
- It is a good example of a deterministic, lockfile-owned font with no system fallback.

**Relevance: Medium.** Our fonts work differently:

- We copy every bundled TTF plus the brand uploads into a per-job folder (`clipper/server/fonts.ts:11-25`).
- libass picks a face by **family name string** (`clipper/shared/caption-styles.ts:12`, `clipper/server/captions.ts:133`).
- Missing glyphs (CJK, Arabic) fall back to system Noto through fontconfig (`clipper/server/fonts.ts:7-8`).

A mistyped or mismatched brand family silently falls back. hypit's exact-face refs make that impossible.

**Better version.** We don't need npm Fontsource. Instead:

1. Keep `fc-scan` at upload (`clipper/server/fonts.ts:28-36`).
2. At render, check `fc-match -f '%{file}' "<family>"` against the per-job dir. Log, alert or fall back explicitly when the match is outside it.
3. Pin the Noto CJK and Arabic files into the image's `fonts/` dir, so fallback is reproducible across Railway hosts.

Unicode-range sharding is only worth it for browser previews (the editor), where it saves bytes.

---

## 6. `@hypit/narrative-caption`: Narrative-token-to-caption-unit timing adapter

**Purpose.** This adapter projects a `NarrativeCaptionBinding` (`unitId → sourceTokenIds[]`) through a `NarrativeProjection` (token boundaries on a timeline) into a complete `CaptionTiming`. It never drops content, pads zero-length intervals, shortens overlaps or forms cues (`packages/narrative-caption/README.md:3-11`).

**Public surface.**

- **Functions:**
  - `projectNarrativeCaptionTiming` (`packages/narrative-caption/src/project.ts:9`);
  - `captionUnitsForNarrativeSelection` (`packages/narrative-caption/src/selection.ts:9`);
  - `assertNarrativeCaptionBinding{Identity,For}` (`packages/narrative-caption/src/identity.ts:20,31`).
- **Error class:** `NarrativeCaptionTimingError`, with codes `CAPTION_BINDING`, `CAPTION_PROJECTION` and `CAPTION_UNIT_WINDOW` (`packages/narrative-caption/src/error.ts:1-9`).
- **Producer:** `project-narrative-caption-timing` (`packages/narrative-caption/src/manifest.ts:10-31`).
- **Markup:** `<narrative-caption:Timing id document binding projection/>` (`packages/narrative-caption/src/surface.ts:32-80`).

**How it works.**

- A unit's start is the start boundary of its *first listed* token. Its end is the end boundary of its *last listed* token (`packages/narrative-caption/src/project.ts:41-57`).
- Every failure reports the full identity path, for example `CaptionDocument → Unit → Token → Boundary` (`:36-55`).
- `end <= start` throws `CAPTION_UNIT_WINDOW` (`:53-56`).
- Selection → units requires that each unit is entirely inside or entirely outside the selection. A partially selected unit throws (`packages/narrative-caption/src/selection.ts:28-33`).

**Tests.** None. The package has no `test/` directory.

**Quality notes.**

- The diagnostics are excellent.
- *Smell:* token order within a unit is assumed chronological but never validated (`packages/narrative-caption/src/project.ts:41-42`).
- *Smell:* in `captionUnitsForNarrativeSelection`, a unit with no binding gives `positions = []`. Then `Math.min()` is `Infinity` and `Math.max()+1` is `-Infinity`, so the unit is silently skipped instead of rejected (`packages/narrative-caption/src/selection.ts:24-30`).
- There is zero test coverage.

**Relevance: Medium-Low.** Our equivalent is the script→transcript DP aligner (`clipper/server/align.ts`, outside this batch). The useful idea is the **N:M unit binding** with full-path errors. A displayed word such as "$1,000" can map to spoken tokens "one thousand dollars" and take the first-to-last token span, instead of being forced into 1:1 alignment.

**Better version.** Let the aligner output `{displayWordIdx[] ↔ spokenTokenIdx[]}` groups. Time each group from its first to its last token, and report unaligned groups with their text and indices rather than dropping them.

---

## Comparison with our caption stack

### Grouping and line-breaking

`groupWords` (`clipper/shared/caption-styles.ts:105-121`) works like this:

- It closes a group at `max` words or after punctuation `[.!?,;:—。！？、，]` (`:112`).
- It joins text with a literal `" "` (`:113`, `:117`).
- It closes gaps under 0.25 s by stretching the previous group's end (`:119`).

There are four gaps relative to hypit:

1. **Spacing is wrong for CJK and mixed scripts in the editor path.** `buildAss` rebuilds text with a per-render `joiner` (`clipper/server/captions.ts:113`, `:161`). However, the editor's caption parts store `g.text` (`clipper/server/render.ts:353`), which is always space-joined. The captions page also joins with `" "` (`clipper/src/views/CaptionsView.tsx:174`, `:312`). A per-language joiner also cannot express `3D`, `3개월` or `是的 就是这样` together. hypit's per-word `separatorBefore` can (`packages/caption/src/types.ts:5-6`, `packages/caption-fine/test/caption-fine.test.ts:550-580`).
2. **There is no line budget.** We emit `WrapStyle: 0` with 70px margins (`clipper/server/captions.ts:127`, `:133`). The "subtitle" preset (9 words at 54px, `clipper/shared/caption-styles.ts:51`) or a size override up to 220px (`:94`) can wrap to 3 or more lines. hypit has structural rows plus `max-lines` (`packages/caption-fine/src/render.ts:628-639`, `:719-724`).
3. **The anchor is the centre.** We use `\an5\pos(W/2, position·H)` (`clipper/server/captions.ts:142`), so an extra line grows *downward* toward the platform UI. hypit's example anchors the bottom, growing upward (`packages/caption-fine/README.md:73`).
4. **There is no lead or tail.** We only close gaps. hypit uses lead/tail with `cut` handoff per speaker (`packages/caption-fine/src/schedule.ts:72-89`).

### Active-word styling

Our karaoke emits one `Dialogue` per word. The highlighted word runs from its start to the **next word's start** (`clipper/server/captions.ts:149-157`, `:153`), so during a pause the last word stays lit. hypit uses `min(ownEnd, nextStart)` (`packages/caption-fine/src/render.ts:646-663`). Ours is arguably better for short pauses and worse for long ones. A threshold would do: hold through gaps under ~0.3 s.

We only have the "current fill" treatment. hypit adds the following, and each has a libass equivalent:

| hypit treatment | libass equivalent |
| --- | --- |
| `trail` (`packages/caption-fine/src/render.ts:448-450`) | `\k` |
| `wipe` (`:463-486`) | `\kf` |
| active underline | `\u1` on the word |
| isolated active box | a second event with `BorderStyle 3` or `\p` |
| active pop (`:488-516`) | `\t` scale on the active word's span |

### Paint

| Our preset | Outline / size | Ratio |
| --- | --- | --- |
| bold-pop | 8/92 | ≈ 1/11.5 |
| karaoke | 7/84 | = 1/12 |
| hormozi | 9/112 | ≈ 1/12.4 |
| one-word | 9/160 | ≈ 1/17.8 |
| minimal | 3/62 | ≈ 1/20.7 |

Sources: `clipper/shared/caption-styles.ts:44-50`. hypit's guidance is about `size/20`, with counters closing past `size/10` (`packages/caption-fine/src/manifest.ts:101`). Our heavy presets are about 1.7× the guidance by design (the TikTok look) but stay under the ceiling.

The problem is that a **size override doesn't rescale `outlineWidth` or `shadow`** (`clipper/shared/caption-styles.ts:85-95`). Minimal at 220px keeps a 3px outline, and one-word shrunk to 24px keeps a 9px outline, which turns into a slab.

libass `\bord` already draws outward under the fill, so we don't share hypit's CSS centred-stroke problem (`packages/caption-fine/src/render.ts:75-85`).

### Recipes and validation

`resolveCaptionStyle` clamps overrides and falls back on bad hex values (`clipper/shared/caption-styles.ts:79-96`). That is lenient and friendly. hypit is strict: unknown properties throw (`packages/caption-fine/src/style.ts:177-179`). For agent and MCP-authored custom styles, strict validation with clear errors is the better default. Keep the lenient path for brand-kit colours.

### Fonts

See §5. Our fallback is implicit (fontconfig plus system Noto, `clipper/server/fonts.ts:7-8`), and hypit's is explicit (an ordered exact stack plus `<Fallback>` children, `packages/caption-fine/src/surface.ts:68-106`).

---

## Ideas worth taking (ranked)

1. **Per-word `sep` instead of a per-language `joiner`.** Apply it in `groupWords`, `buildAss`, the editor caption parts (`clipper/server/render.ts:353`) and the captions page. This is a small change that fixes visible CJK and mixed-script bugs (`packages/caption/src/types.ts:5-6`, `packages/caption-fine/src/spacing.ts:6-16`).
2. **A structural line budget that re-splits instead of throwing.**
   - Estimate line width from font advance widths and size against `W − 2·margin`.
   - Insert explicit `\N`.
   - If a group needs more than `maxLines` (2), split the group at the best word boundary, recursively.

   This adapts `structuralRowStarts` and `max-lines` (`packages/caption-fine/src/render.ts:628-639`, `:719-724`) and replaces its throw with a re-split.
3. **Bottom-anchored caption block.** Use `\an2` with `y` as the block's bottom edge, so extra lines grow up and away from platform UI (`packages/caption-fine/README.md:73`, `packages/caption-fine/src/render.ts:594-598`).
4. **Lead/tail plus `cut` handoff.** For example, lead 2–4 frames and tail 4 frames. These replace the 0.25 s gap-close and never shift word timing (`packages/caption-fine/src/schedule.ts:72-89`).
5. **More active-word treatments, all native ASS:**
   - `trail` and `wipe` via `\k` and `\kf` in one event, which also means fewer events;
   - an active underline;
   - an isolated active box;
   - an active pop on each word (`packages/caption-fine/src/render.ts:441-516`, `:939-967`).

   These make about four new presets cheap: "box highlight", "underline", "fill sweep" and "accumulate".
6. **Size-proportional outline, shadow and glow.** Store them as ratios (e.g. outline = size/12, shadow ≈ size/40, glow blur ≈ size/10) so that size overrides stay legible (`packages/caption-fine/src/manifest.ts:101-129`).
7. **Exclusive activation with a pause threshold.** Hold the highlight through short gaps and drop it on long ones (`packages/caption-fine/src/render.ts:646-663`).
8. **Time-windowed style Uses, including Hidden.** For example, hide captions while a tier board or comment overlay is up, or switch to an "impact" style during the hook moment, without re-grouping (`packages/caption/src/visibility.ts:5-23`).
9. **A spring entrance with overshoot**, as chained `\t` transforms: 72% → 105% → 95% → 100%. This replaces the current 86% → 100% linear pop (`packages/caption-fine/src/render.ts:365-373` vs `clipper/server/captions.ts:143`).
10. **A strict schema for custom caption styles** from MCP or the agent: reject unknown keys, and let the active style inherit from the base (`packages/caption-fine/src/style.ts:98-133`, `:177-179`).
11. **Explicit font resolution checks** (`fc-match` against the job dir) and pinned Noto fallbacks, in the spirit of exact `FontArtifactRef`s (`packages/fontsource/src/surface.ts:95-148`).
12. **Shrink-to-fit for hook and CTA text** (`minimumScale`, `maxLines`), done server-side with font metrics (`packages/text-fine/src/program.ts:217-225`).
13. **N:M display↔spoken unit binding with full-path errors** in the aligner (`packages/narrative-caption/src/project.ts:31-57`).

## Things not to copy

- **Browser rendering and measurement.** The joined boxes, Path text, Mask and the html-program text engine all need headless Chromium with DOM measurement on every seek (`packages/caption-fine/src/joined-box.ts:74-99`). On CPU-only Railway at SaaS volume, libass is far cheaper and deterministic.
- **Throwing on overflow at render time** (`packages/caption-fine/src/render.ts:719-724`). An unattended pipeline must degrade, by re-splitting or shrinking, not fail a paid render.
- **Authored-only cues.** hypit relies on Script `||` for grouping (`packages/caption-fine/README.md:62-63`). We need automatic grouping from ASR output.
- **The parameter explosion.** About 110 recipe properties, 24 motions × 5 motion slots, and 8 loop options (`packages/caption-fine/src/recipe.ts:3-97`). Clippers want 8–12 curated presets with a few overrides, and every knob is a support and QA surface.
- **The graph, producer, manifest and fragment ceremony** for each value type (`packages/caption/src/component.ts`, `packages/caption-fine/src/fragment.ts`, `packages/text/src/fragment.ts`). It is valuable for hypit's agent-authored build graph and pure overhead for our Express pipeline.
- **Head-following regions.** They need upstream face/region tracking per frame (`packages/caption-fine/README.md:17-40`), which is costly on CPU and of marginal value for gameplay clips.
- **`@hypit/text` templates for prompts.** These are overkill; TS functions suffice.

## Coverage

Every file listed below was read in full (✅). PNGs are binary previews and were not read as text.

| File | Lines | Read |
| --- | ---: | :---: |
| packages/caption/README.md | 76 | ✅ |
| packages/caption/package.json | 30 | ✅ |
| packages/caption/src/activation.ts | 19 | ✅ |
| packages/caption/src/component.ts | 55 | ✅ |
| packages/caption/src/display.ts | 48 | ✅ |
| packages/caption/src/identity.ts | 53 | ✅ |
| packages/caption/src/index.ts | 34 | ✅ |
| packages/caption/src/manifest.ts | 97 | ✅ |
| packages/caption/src/style.ts | 59 | ✅ |
| packages/caption/src/surface.ts | 16 | ✅ |
| packages/caption/src/temporalize.ts | 34 | ✅ |
| packages/caption/src/types.ts | 76 | ✅ |
| packages/caption/src/visibility.ts | 23 | ✅ |
| packages/caption/test/caption.test.ts | 34 | ✅ |
| packages/caption-fine/README.md | 155 | ✅ |
| packages/caption-fine/package.json | 53 | ✅ |
| packages/caption-fine/src/activation.ts | 40 | ✅ |
| packages/caption-fine/src/component.ts | 61 | ✅ |
| packages/caption-fine/src/fragment.ts | 88 | ✅ |
| packages/caption-fine/src/index.ts | 21 | ✅ |
| packages/caption-fine/src/joined-box.ts | 114 | ✅ |
| packages/caption-fine/src/manifest.ts | 398 | ✅ |
| packages/caption-fine/src/recipe.ts | 127 | ✅ |
| packages/caption-fine/src/render.ts | 1162 | ✅ |
| packages/caption-fine/src/schedule.ts | 149 | ✅ |
| packages/caption-fine/src/spacing.ts | 16 | ✅ |
| packages/caption-fine/src/studio.ts | 196 | ✅ |
| packages/caption-fine/src/style.ts | 371 | ✅ |
| packages/caption-fine/src/surface.ts | 177 | ✅ |
| packages/caption-fine/src/types.ts | 192 | ✅ |
| packages/caption-fine/test/caption-fine.test.ts | 580 | ✅ |
| packages/caption-fine/test/layout.browser.test.ts | 137 | ✅ |
| packages/caption-fine/test/studio-companion.test.ts | 118 | ✅ |
| packages/caption-fine/preview/Track.png | binary | not read (image) |
| packages/text/README.md | 59 | ✅ |
| packages/text/package.json | 23 | ✅ |
| packages/text/src/activation.ts | 35 | ✅ |
| packages/text/src/component.ts | 73 | ✅ |
| packages/text/src/fragment.ts | 57 | ✅ |
| packages/text/src/frontend.ts | 40 | ✅ |
| packages/text/src/index.ts | 27 | ✅ |
| packages/text/src/manifest.ts | 170 | ✅ |
| packages/text/src/program.ts | 418 | ✅ |
| packages/text/src/recipe.ts | 189 | ✅ |
| packages/text/src/surface.ts | 212 | ✅ |
| packages/text/src/types.ts | 82 | ✅ |
| packages/text/test/text.test.ts | 228 | ✅ |
| packages/text-fine/README.md | 91 | ✅ |
| packages/text-fine/package.json | 51 | ✅ |
| packages/text-fine/src/activation.ts | 56 | ✅ |
| packages/text-fine/src/component.ts | 93 | ✅ |
| packages/text-fine/src/index.ts | 13 | ✅ |
| packages/text-fine/src/manifest.ts | 535 | ✅ |
| packages/text-fine/src/program.ts | 628 | ✅ |
| packages/text-fine/src/studio.ts | 140 | ✅ |
| packages/text-fine/src/surface.ts | 841 | ✅ |
| packages/text-fine/src/types.ts | 119 | ✅ |
| packages/text-fine/test/text-fine.test.ts | 675 | ✅ |
| packages/text-fine/preview/Mask.png | binary | not read (image) |
| packages/text-fine/preview/Track.png | binary | not read (image) |
| packages/fontsource/README.md | 21 | ✅ |
| packages/fontsource/package.json | 28 | ✅ |
| packages/fontsource/src/activation.ts | 22 | ✅ |
| packages/fontsource/src/index.ts | 3 | ✅ |
| packages/fontsource/src/manifest.ts | 40 | ✅ |
| packages/fontsource/src/studio.ts | 21 | ✅ |
| packages/fontsource/src/surface.ts | 148 | ✅ |
| packages/fontsource/test/fontsource.test.ts | 61 | ✅ |
| packages/narrative-caption/README.md | 18 | ✅ |
| packages/narrative-caption/package.json | 33 | ✅ |
| packages/narrative-caption/src/activation.ts | 23 | ✅ |
| packages/narrative-caption/src/component.ts | 34 | ✅ |
| packages/narrative-caption/src/error.ts | 9 | ✅ |
| packages/narrative-caption/src/identity.ts | 53 | ✅ |
| packages/narrative-caption/src/index.ts | 15 | ✅ |
| packages/narrative-caption/src/manifest.ts | 32 | ✅ |
| packages/narrative-caption/src/project.ts | 62 | ✅ |
| packages/narrative-caption/src/schema.ts | 13 | ✅ |
| packages/narrative-caption/src/selection.ts | 38 | ✅ |
| packages/narrative-caption/src/surface.ts | 80 | ✅ |
| packages/narrative-caption/src/types.ts | 7 | ✅ |
