# 08 — Overlay components

**Batch:** 08 "Overlay components" · **Commit:** `dc2b7a8f31b1ef1443a79ca448548d69e3ceb6a0`

| Package | TS lines (src + test) | All files incl. README/JSON/SVG/PNG (`wc -l`) |
|---|---|---|
| `ranking` | 5,011 | 5,344 |
| `comment-sticker` | 1,992 | 2,358 |
| `interview-emoji-reveal` | 756 | 881 |
| `depth-stack` | 2,650 | 3,144 |
| `spatial` | 1,550 | 1,656 |
| `region-evidence` | 312 | 372 |
| **Total** | **12,271** | 13,755 |

Paths are relative to the hypit repo root (`packages/...`). Our code is cited as `clipper/...`. Every TypeScript file in the batch was read top to bottom. The preview images were opened and looked at. Hypit modules this batch only imports were not read in full: `@hypit/composition`, `@hypit/visual-track`, `@hypit/temporal` (except `resolveTriggeredSchedule`, which I opened) and `@hypit/studio-companion`. Claims about how those modules behave are marked *(unverified)*.

---

## 0. The shape every package shares

The four overlay packages (ranking, comment-sticker, interview-emoji-reveal, depth-stack) are built the same way, so this is described once. `spatial` and `region-evidence` share only the surface and fragment layers: they have no style decoder, program or renderer. Only ranking, comment-sticker and depth-stack ship a `studio.ts`; interview-emoji-reveal, spatial and region-evidence have none *(corrected in check)*.

1. **Surface** (`surface.ts`): a markup tag handler. It checks attributes against an allow-list and resolves typed references (Frame, Window/Instant, Recipe, Font, Blob). It emits sealed *records* plus one *component* whose graph *fragment* does the work. Unknown attributes and wrong reference types throw.
2. **Style decoder** (`style.ts`/`author.ts`): takes an "SVS Recipe" (a flat key→value map). Unknown keys are refused *by name*. Every key has a default. The result is a typed, canonicalized Style object.
3. **Fragment** (`fragment.ts`): a finite chain of producer operations: create an empty set, append each item (one operation per item), build a schedule, build a program, render. This makes every intermediate value a cacheable, content-addressed graph value.
4. **Program/schedule** (`schedule.ts`/`program.ts`): pure functions with heavy `assert*` validation. They are idempotent, and each one is re-run at every hand-off (append, build and render all re-assert).
5. **Render** (`render.ts`/`lower.ts`): emits a `VisualTrack` (a list of `presents`). Each present has a frame span, `z`, a `subjectId` and a tree of CSS-styled elements. Animation is given as **keyframes on integer frames**. Renderers bake many keyframes, often one per frame. The terminal HTML/Chrome renderer (batch 05) turns this into pixels.
6. **Studio companion** (`studio.ts`): editor projection (timeline lanes and inspector fields) generated from the same Recipe vocabulary.

Timing is **never** found inside a component. Components receive already-resolved absolute `TemporalWindow` / `TemporalInstant` values. The narrative/speech projection (batch 07) produces them upstream. This is the main architectural difference from us: our `placeOverlays` searches the word list for cue text itself (`clipper/server/overlays.ts:28-56`).

---

## 1. `@hypit/ranking`

### Purpose
Ranking overlays have three forms. **TierBoard** places icons into S/A/B/C/D-style rows. **Column** is a numbered rank rail with a big "stage" reveal per row. **TopThree** is a podium of three rings that fill one at a time. In each form, an item is introduced, gets its verdict, and **keeps its settled place** while later items are discussed. Optional appear/move sounds are driven by the same event frames as the animation.

### Public surface
- Markup tags: `ranking:TierBoardStyle`, `ColumnStyle`, `TopThreeStyle` (Recipe + font → Style plus a `.sound` record). `ranking:TierBoard` / `TierItem`, `ranking:Column` / `ColumnItem`, `ranking:TopThree` / `TopThreeItem` (`packages/ranking/src/manifest.ts:247-694`, handlers `packages/ranking/src/surface.ts:80-299`).
- Exports: schedule builders and asserts (`packages/ranking/src/index.ts:1`), tier pose math (`index.ts:2`), style decoders (`index.ts:3-7`), renderers `renderTierBoard`/`renderColumn`/`renderTopThree`/`renderRankingAudio` (`index.ts:8-13`), and the fragment builder (`index.ts:15`).
- 33 producers (`packages/ranking/src/manifest.ts:46-80`) and 5 admission validators (`packages/ranking/src/component.ts:260-271`).
- Outputs per board: `.schedule`, `.program` and `.visual`, plus `.events` and `.audio` when a sound is authored (`packages/ranking/src/surface.ts:283-292`).

### Data model
- `RankingItemSpec` is a union (`packages/ranking/src/types.ts:182-210`):
  - tier item: `{tier, preset:true}` or `{tier, preset:false, entry:"direct"|"drop"}`;
  - column item: `{label, rank, preset}`;
  - top-three item: `{label}`.
  - All forms take an optional per-item `stackingOrder`.
- Icons are separate `BlobRef`s. A tier item **requires** an icon; column and top-three icons are optional, with the label or rank number as fallback (`types.ts:222-224`).
- Labels can be literal text or a graph `Text` edge. A "text item shell" is materialized into a spec once the Text resolves (`packages/ranking/src/schedule.ts:259-266`).
- Schedules (`types.ts:17-81`):
  - **windowed** (tier and column): each entry is either `preset` (`settled = outer`) or `reveal` (`window`, then `settled = [window.end, outer.end)`);
  - **triggered** (TopThree): each entry has `triggerFrame`, `stage = [trigger, nextTrigger|terminal)`, `cumulative = [trigger, outer.end)` and `settled = [stage.end, outer.end)`.

### Reveal/settle schedules (the key algorithms)
- **Windowed schedule**: `packages/ranking/src/schedule.ts:445-519`.
  - Every non-preset item must own exactly one window, and presets must own none (`:464-468`).
  - Every window lies inside the outer window (`:475-477`).
  - A tier window must span **at least 2 frames** so its entrance can animate (`:478-481`).
  - Windows must be **pairwise disjoint** once sorted by start (`:483-488`).
  - Item order:
    - Column: by `rank`, so rank, child order and reveal time are independent.
    - TierBoard: presets first, in author order, then reveals in window order (`:491-497`).
  - The re-assert also requires that no tier preset appears after a reveal (`:588-596`) and that reveals are chronological (`:614-623`).
- **Triggered schedule** (TopThree): `schedule.ts:331-381`. Activation instants are sorted, then handed to `resolveTriggeredSchedule` (`packages/temporal/src/schedule.ts:13-50`). That function requires triggers strictly increasing inside `[outer.start, terminal)`, with `exclusive[i] = [t_i, t_{i+1}|terminal)` and `cumulative[i] = [t_i, outer.end)`. The ranking re-assert checks all of these identities (`schedule.ts:541-572`).
- **Motion fitting.** A window that is shorter than the preferred motion is never an error:
  - TierBoard: `moveStart = max(appearFrames, duration − moveFrames)`. When there is a glide, it **ends exactly at the window end** (`schedule.ts:711-725`). But when `duration ≤ appearFrames` (8 by default), `moveEndFrame` is left undefined: there is no glide and no `move` sound event, and the drop item jumps from the stage straight to its cell at the window end (`schedule.ts:719-723`, `tier.ts:136-175`, `schedule.ts:838-840`) *(corrected in check)*.
  - Column: `fitColumnRevealMotion` keeps preferred appear+move when they fit. Otherwise it splits the duration in proportion. A 1-frame window becomes a hard "direct" cut (`schedule.ts:727-743`).
  - TopThree: `fitRankingEntranceMotion` clamps the appear time to the stage (`schedule.ts:699-709`).
- **Sound events** are derived from the same phases:
  - TierBoard: `appear@window.start`, plus `move@window.start+moveStart` only for `entry="drop"` items that actually move (`schedule.ts:826-843`);
  - Column: `appear@start` and `move@end−moveFrames` (`:845-858`);
  - TopThree: `appear@trigger` (`:860-866`).
  - Events are sorted by frame, then kind, then id.

### Layout math
- **TierBoard geometry** (`packages/ranking/src/tier.ts:49-80`):
  - `rowHeight = frameH / rows`;
  - `labelWidth = round(rowHeight·1.5)`, or `frameW·labelWidthRatio` with the ratio in [0.08, 0.3] (`schedule.ts:175-178`);
  - `gap = max(4, round(rowHeight·0.03))`; `iconSize = rowHeight − 2·gap`;
  - cell `x = labelWidth + gap + col·(iconSize+gap)`, vertically centred.
  - The test pins a 720×280 frame with 2 rows to `rowHeight 140, labelWidth 210, gap 4, iconSize 132` (`packages/ranking/test/ranking.test.ts:352-357`).
  - Overflow **throws**: `"TierBoard row … cannot fit Item"` when `cell.x+size > frameW` (`packages/ranking/src/render.ts:321-322`). Rows never wrap.
- **Stage**: the drop stage centre is `stagePoint × within` frame, not the board frame. Defaults are (0.2, 0.3) with a 168 px stage (`tier.ts:65-71`, `packages/ranking/src/style.ts:204-205`). The board and the "explanation stage" are deliberately separate Frames.
- **Column** (`render.ts:464-562`):
  - `cell = rowHeight` (default 74) and `columnGap = max(8, round(cell·0.16))`;
  - `contentSize = min(cell, frameW − 2·pad − cell − gap)`;
  - the frame must fit `2·pad + n·cell + (n−1)·rowGap`, else **throw** (`:472-476`);
  - the reveal enters from below `within` (`entryCenterY = within.bottom + stageSize·0.25`, `:519`).
- **TopThree**: slots are centred on `centerX`, `slotX = frameX + frameW·centerX − total/2 + i·(icon+gap)`, on baseline `baselineY` (`render.ts:564-568`). The label box is padded by 0.25 em at top and bottom so ascenders and descenders aren't clipped (`render.ts:629-637`). That is a good, documented detail.

### Motion recipes (the "feel")
- **Direct tier entrance**, from `tier.ts:96-116`:
  - `scale = 0.76 + 0.24·outCubic(p) + 0.075·sin(πp)`, an overshoot pop;
  - `opacity = min(1, 4p)`;
  - `blur = 1.2px·(1−e)`;
  - drop shadow eases from 12/18/0.28 to the settled 7/10/0.2 (`:82-94`).
- **Drop entrance**, from `tier.ts:118-176`:
  1. Pop at the stage, scaled `stageSize/cellSize`, with 0.06 overshoot and blur 1.6.
  2. Hold still on the stage while the item is discussed.
  3. Glide with **smootherstep** easing along an **arc**: `arcHeight = clamp(|Δy|·0.09, 20, 48)`, plus a 0.025 scale bump at mid-arc.
  - Rendered as **one keyframe per frame**, all linear (`render.ts:241-251`).
- **Column reveal** (`render.ts:408-462`):
  - rises from below with `outBack` overshoot at 72% of appear;
  - during a hold of 6 frames or more, two tiny "breathing" keyframes, (+0.8, −1.8) px at scale 1.007 and then (−0.4, +1.6) px at scale 1.002 (`:453-458`) *(corrected in check)*;
  - then shrinks and moves into the slot over the last `moveFrames`.
- **TopThree**: the item fades and rises 8 px from scale 0.82 (`render.ts:222-231`). Its accent ring pulses to `scale 1.08` at mid-stage (`:570-577`). The settled copy drops the ring (`:618-619`, asserted at `ranking.test.ts:466-470`).

### Styles/recipes (defaults that matter)
- **Tier** (`style.ts:187-218`):
  - rows S `#EE5F52`, A `#F0A04C`, B `#F0C84D`, C `#EDE356`, D `#A6DA7B` (`:156-162`);
  - label text `#2c2c2c` at `0.3×rowHeight`, content field `#2b2b30`, 3 px grid `#111315`;
  - appear 8 frames, move 14 frames;
  - z values: board 20, stage 25, item 30.
- **Column**: rank colours gold/silver/bronze/blue/violet, 18 px pad, 74 px rows, 10 px gap, appear 6/move 8, `ease-in-out` (`style.ts:220-246`).
- **TopThree**: 104 px icons, 52 px radius (circles), 5 px ring, 24 px gap (`style.ts:248-272`).
- **Sound style**: `appear-gain`/`move-gain` (0–64) and `sound-fade-frames` (`style.ts:144-153`, `schedule.ts:140-146`).

### Sound plan
`renderRankingAudio` (`render.ts:652-697`) works as follows:
- one clip per event at a sample-exact `timelineFrameSampleBoundary(frame, 48000)`;
- the clip length is the min of the source length and the time left in the timeline;
- gain comes from `kind`, with a fade-in only;
- it **asserts** that each supplied sound has at least one matching event (`:690-693`). A "move" sound on a board with no drop items is refused earlier, at the surface (`packages/ranking/src/surface.ts:266-267`).

The test shows events `appear 25, move 59, appear 65, move 89` → sample starts `40000, 94400, 104000, 142400` at 30 fps (`ranking.test.ts:484-501`).

### Validation (fail-closed)
- Identities match `^[A-Za-z][A-Za-z0-9_.:#-]{0,191}$` (`schedule.ts:62-64`).
- Colours must be hex or `transparent` (`:70-72`).
- A Column needs unique ranks (`:283-286`).
- TopThree needs exactly 3 slot colours and at most 3 items (`:219`, `:776`).
- Windows must not overlap and must stay in bounds (above).
- Rows and columns must fit (`render.ts:321`, `:472-476`).
- `preset` + `during` is refused, and so is a non-preset item without `during` (`surface.ts:131-133`, `:151-152`).
- The manifest states the policy: "invalid input is refused, never repaired" (`manifest.ts:625`).

### Tests
`packages/ranking/test/ranking.test.ts` has 12 tests; `test/companion.test.ts` has 2. They assert:
- schedule spans from moments (`:290-299`);
- strict-increase errors (`:301-310`);
- unknown Recipe keys refused by name (`:312-325`);
- exact tier geometry, phase frames and an exact drop transform string at frame 20 (`translate(-376px,146px) scale(1.272727)`, `:383-385`);
- arc above the linear midpoint (`:380-381`);
- column overlap and out-of-bounds refusal (`:433-453`);
- shared visual and sound phase frames (`:484-501`);
- surface wiring (`:517-618`);
- fail-closed icon and sound combinations (`:643-667`).

### Quality notes
- **Strong:**
  - one shared event law for picture and sound;
  - windows that are short are handled by fitting, not by rejection;
  - stage and board Frames are separate;
  - every derived span is re-asserted.
- **Bug: Column stage defaults disagree.** The code defaults are `stage-x 0.66, stage-y 0.73, stage-size 356` (`style.ts:237-238`). The published vocabulary says `0.5, 0.24, 132` (`manifest.ts:381-386`), and Studio shows the manifest values. The manifest also says "fraction of the Frame's width", but the code uses `within` (`render.ts:517-518`).
- **Doc/code mismatch:** `sound-fade-frames` "fades in and out" (`manifest.ts:303-304`, repeated for Column `:397` and TopThree `:468`), but the renderer sets `fadeOutSamples: 0` (`render.ts:687`). Studio's inspector labels the same field "Fade In" (`packages/ranking/src/studio.ts:215`), so Studio matches the code and only the manifest text is wrong. The audio-track module does support fade-out (`packages/audio-track/src/program.ts:92`), so the omission is ranking-only. *(added in check)*
- **Dead code:**
  - `rowY` (`render.ts:374-377`);
  - the `cell-gap` schema/placement, which is not a Recipe key (`manifest.ts:120`, `packages/ranking/src/studio.ts:75`);
  - `TierBoard.png` in `preview/` is not referenced; the manifest uses `TierBoard.svg` (`manifest.ts:494`). It also shows an older look: full coloured rows with rounded corners.
- In `renderTopThree`, `duration` and `activeFrames` are the same expression (`render.ts:607-608`), so the ring pulse always spans the whole stage.
- Per-frame keyframes (`render.ts:246`) are deterministic but bulky: about 40 keyframes × 3 style strings per tier item.

### Relevance: **High**
"Tier list" and "top N ranking" are staple clipper formats. We already ship a text-only tier board (`clipper/server/overlays.ts:183-211`). Hypit's schedule semantics are clearly better: reveal window, then settle, plus stage-then-glide.

### Better version
Keep our ASS route, but adopt the **windowed schedule model**:
- **Window:** derive each tier item's reveal window from speech, from its cue word to the next ranked item's cue (or to its sentence end).
- **Settle:** settled from the window end to the CTA.
- **Validation:** check disjointness and fit at plan time, in `sanitizeOverlays`.
- **Failures:** repair (shrink or truncate) rather than throw, and log the repair to Activity.
- **New variant:** add Column/Top-N as a new overlay kind with the same model.
- **Sound:** emit sound events from the same placed spans (see §7).

---

## 2. `@hypit/comment-sticker`

### Purpose
Timed social "reply to comment" cards. Each Sticker has its own Frame (where), its Style Recipe and font (look and local motion), and its own absolute Window (when). The output is one VisualTrack.

### Public surface
- Tags: `comment:Style` (Recipe + `FontStackRef`) and `comment:Track` with `comment:Sticker` children (`packages/comment-sticker/src/manifest.ts:142-326`, handlers `packages/comment-sticker/src/surface.ts:73-160`).
- Sticker copy:
  - `comment`, `author`, `header` and `meta` can each be literal or a graph Text;
  - body text and `comment=` are mutually exclusive (`surface.ts:110-116`).
- Optional `avatar` is a Blob edge.
- Exports: `renderCommentSticker`, `decodeCommentStickerStyle` and the content builders (`packages/comment-sticker/src/index.ts:1-8`).

### Data model
- `CommentStickerStyle` (`packages/comment-sticker/src/types.ts:14-73`) has these parts:
  - card: background, border, radius, padX/Y, gap, `rotationDeg`, CSS shadow, speech `tail{enabled,w,h,offsetX}`;
  - avatar: `fallback none|initial`, size, ring;
  - three text styles: header, body (+`maxLines`), meta;
  - motion: `enter{none|fade|pop|slide-pop, frames, offsetY, startScale, rotationDelta, easing incl. out-back}`, `exit{none|fade|fade-up,…}`, `hold{none|float, amplitudeY, rotationAmplitude, periodFrames}`.
- `CommentStickerContent = {comment, author?, header?, meta?}`. Blank optional fields are refused (`packages/comment-sticker/src/program.ts:137-142`).

### Reveal schedule and motion
- One present per sticker over exactly its window (`program.ts:592-610`).
- Motion is baked per frame (`program.ts:295-329`):
  - enter progress uses the chosen easing; `out-back` uses `1 + 2.70158(p−1)³ + 1.70158(p−1)²` (`:283-293`);
  - the exit starts at `duration − exitFrames`;
  - the float hold is `sin` with period `periodFrames`, active only between enter and exit;
  - transforms are composed: `translate3d(0, enterY+holdY+exitY) rotate(base+enterRot+holdRot) scale(enterScale)`;
  - opacity is `enter × (1 − exit)`.
- Short windows **compose overlapping enter and exit instead of rejecting**. A 90-frame window with 70-frame enter and 60-frame exit is accepted, and frame 45 has opacity strictly between 0 and 1 (`packages/comment-sticker/test/comment-sticker.test.ts:109-133`).

### Layout math (`program.ts:455-590`)
- `cardHeight = frameH − tailHeight`. The tail is a `clip-path: polygon(0 0,100% 0,0 100%)` right triangle, drawn 1 px up so it overlaps the card (`:509-525`).
- Avatar column: `avatarSize + gap`, present only when there is an avatar or `fallback=initial` with an author (`:461-464`).
- Header row height is `size·lineHeight`. The body starts at `header + 0.55·gap` and is word-wrapped with `maxLines` and **ellipsis** (`:409-423`), tracked at −0.02 em (`:430`). The meta row is pinned to the bottom (`:585-588`).
- Header text: `header` if given; else `Reply to @author's comment`; else `Reply to comment` (`:444-449`).
- Metadata is **never fabricated**. When there's no meta, there's no row (`program.ts:468`, asserted at `comment-sticker.test.ts:82-83` "37 replies" absent).
- Geometry failures **throw**: tail taller than the frame, frame too narrow, too short for the text (`:460`, `:466`, `:473`).

### Default recipe (`packages/comment-sticker/src/author.ts:86-147`)
| Area | Defaults |
|---|---|
| Card | white, radius 28, pad 28/24, gap 18, **rotation −2.5°**, shadow `0 18 46 #0000004d`, tail 42×28 at x 58, z 62 |
| Avatar | 58 px, 3 px white ring, initial disc `#34313a` |
| Text | header 24 px/680 `#8f8f8f`; body **42 px/850** `#111111`, 3 lines; meta 21 px/650 |
| Motion | enter **pop**, 17 frames, start scale 0.78, rotation delta −4.5°, ease-out; exit **fade-up**, 20 frames, −28 px, ease-in; hold **float** 4 px / 0.35° / 84-frame period |

### Validation
- Colours must be 6- or 8-digit hex. Only the avatar background may be a `linear-gradient(...)` (`program.ts:62-71`).
- Weight is an integer from 1 to 1000. `maxLines` is at least 1. All enums are checked (`:87-130`).
- The Recipe refuses geometry keys such as `x` by name (`comment-sticker.test.ts:102-107`).
- There are no sound hooks. The README says SFX are a separate Audio Track.

### Tests
6 tests (`packages/comment-sticker/test/comment-sticker.test.ts`):
- determinism (deep-equal across two renders);
- meta absent vs present;
- the track compiles in the real HTML compiler with `data-hypit-element-id="meta"/"body"` (`:88-100`);
- Recipe refusal;
- overlapping enter/exit;
- style and track surfaces lower to the exact producer list (`:167-197`).

### Quality notes
- Good: separate concerns, no fabricated metadata, explicit failure when text can't fit, and a clean, readable motion function.
- The markup vocabulary lists `enter-easing` values without `out-back` (`manifest.ts:236`), but the decoder accepts it (`author.ts:132`), and so do the style schema in the same manifest (`manifest.ts:94`) and the asserts (`program.ts:121`). Only the author-facing list under-documents the code *(corrected in check)*. The omission also hides a behaviour: with `out-back`, enter opacity is `min(1, 1.35·rawProgress)` instead of following the eased curve (`program.ts:306-308`) *(added in check)*.
- The avatar `fallback` defaults to `none` (`author.ts:115`), so by default a sticker with no avatar Blob has no avatar column, even when it has an author. The initial disc appears only with `avatar-fallback=initial` *(added in check)*.
- An unused `duration` schema (`manifest.ts:60-64`).
- `textElement` uses `wrap:"none"` with `maxLines:1` and an ellipsis for header and meta (`program.ts:384`). Long handles truncate instead of shrinking. That is acceptable.
- "Too short for its text" is checked only against the box height. The body's real ink height depends on the browser wrap, and the ellipsis hides overflow. So it does not fail closed on *content* overflow, only on geometry.

### Relevance: **High**
We already render this card (`clipper/server/overlays.ts:150-169`), and it is one of our four overlay kinds.

### Comparison with ours
| Aspect | Hypit | Ours |
|---|---|---|
| Timing | absolute window from upstream | cue word + `hold` (default 2.8 s) (`clipper/server/overlays.ts:19`, `:52`) |
| Placement | explicit Frame per sticker | band top + 40 px; stacks below a still-visible previous comment; moves above the footage while a tier board is up (`overlays.ts:157-158`) |
| Card | rounded rect, **−2.5° tilt**, soft blurred shadow, speech tail | rounded rect (`roundedRect` Bézier, `overlays.ts:71-85`), hard ASS shadow (`OvShape` shadow 4, `overlays.ts:125`) |
| Avatar | image or initial disc with ring | accent disc with initial (`overlays.ts:164-166`) |
| Header | "Reply to @x's comment" (header overridable) | "Reply to @x" (`overlays.ts:167`) |
| Body | measured word wrap, maxLines, ellipsis, −0.02 em tracking | char-count wrap 27 chars × 3 lines + "…" (`overlays.ts:88-104`, `:152`) |
| Enter | pop 0.78→1 + rotation unwind, 17 f | slide-up 28 px in 160 ms + 140 ms fade (`overlays.ts:162`) |
| Hold | float sin 4 px / 0.35° | static |
| Exit | fade-up −28 px, 20 f, ease-in | 180 ms fade |
| Meta row | optional, never fabricated | none |

### Better version
Move our card to the hypit look entirely inside ASS:
- **Tilt:** add `\frz-2.5` with a shared `\org(cardCentre)` on every line of the card, so the group rotates together.
- **Shadow:** draw a second, `\blur`-ed shape layer for the soft shadow.
- **Tail:** add the triangle as an ASS `\p1` drawing.
- **Pop:** use `\t(0,570,\fscx100\fscy100\frz-2.5)` from `\fscx78\fscy78\frz-7` with `\org` at the centre.
- **Float:** see §7 for how to get it in ASS.
- **Text fit:** replace the char-count wrap with measured wrapping (§7).

---

## 3. `@hypit/interview-emoji-reveal`

### Purpose
A top-of-frame "answer strip". There is a row of fixed-size slots. Each slot starts as a shared **placeholder** icon, such as "?". At its activation Instant, the slot swaps to its answer icon with an overshoot pop. Earlier answers stay and later slots stay unanswered. Preset items are answered from frame 0. Despite the name, it uses **PNG icons** (Tabler SVGs rasterized), not emoji fonts (`packages/interview-emoji-reveal/README.md:31-34`).

### Public surface
- Tags: `emoji:Style` (Recipe only, no font) and `emoji:EmojiReveal` with `emoji:Item` children (`id`, `icon`, `preset` | `at`) (`packages/interview-emoji-reveal/src/surface.ts:38-99`).
- Exports: `renderEmojiReveal`, `finalizeEmojiReveal` and the append functions (`packages/interview-emoji-reveal/src/index.ts:1-16`).

### Data model and schedule
- Item: `{spec:{id,preset}, icon, activation?}` (`packages/interview-emoji-reveal/src/types.ts:32-41`). The program carries `outer` Window, `style`, `placeholder` and `items` (`types.ts:45-52`).
- Finalization rules (`packages/interview-emoji-reveal/src/program.ts:87-114`):
  - presets must come first;
  - reveal instants must be **strictly increasing in source order** and lie inside `[outer.start, outer.end)`.
  - Display order is source order. Unlike Ranking, it is not re-sorted.

### Layout math (`program.ts:186-242`)
- Strip width is `2·padX + n·slot + (n−1)·gap`, so it adapts to the item count.
- `left = within.x + within.w·centerX − width/2` and `top = within.y + within.h·topY`.
- The strip, **including its hard shadow offset**, must fit inside `within`, or it **throws** (`:196-199`).
- `iconSize ≤ slotSize` is asserted (`:50`).

### Reveal recipe
- `revealAnimation` (`program.ts:140-152`): invisible until `atFrame−1`, then visible at scale 0.72 at `atFrame`. It goes to **1.14** at +34% of `revealFrames`, **0.95** at +68%, and **1.0** at +100%. Default `revealFrames` is 6.
- The placeholder hard-cuts to opacity 0 at the same frame (`:154-162`).
- Defaults (`packages/interview-emoji-reveal/src/style.ts:33-44`): `centerX 0.5`, `topY 0.07`, slot 72, gap 10, pad 18/14, board `#FFFDF7`, 4 px `#161616` border, radius 22, **hard shadow 9/10/0 `#000000B8`** ("meme-style", `packages/interview-emoji-reveal/src/manifest.ts:91`), icon 48, z 66.

### Tests
**None.** The package has no `test/` directory. Its only consumer in the repo is `examples/interview/*.svml`.

### Quality notes
- **Stale schema:**
  - The exported `blob` schema uses a `digest` field of length 71 (`packages/interview-emoji-reveal/src/manifest.ts:45-50`), while every BlobRef in the system carries `resource` (for example `packages/comment-sticker/src/manifest.ts:54-59`). `emojiRevealSetSchema` and `emojiRevealProgramSchema` would therefore reject real values.
  - They're exported but not attached to the manifest types (`manifest.ts:151-154`), so it's dead and wrong rather than a live bug.
- **Preview mismatch:** `preview/Track.png` shows coloured per-slot tiles with borders, but the renderer draws plain slot boxes with no fill (`program.ts:221-226`).
- **Unused code:** the unused `oneOfReference` helper and an unused `SurfaceComponentDraft` import (`surface.ts:2`, `:20-24`).
- The placeholder hard cut combined with the answer pop is a deliberate "snap" feel, but it is not configurable.

### Relevance: **Medium**
"Guess the X / quiz" clips use exactly this strip. We could build it today from our emoji sticker pipeline plus an ASS box.

### Better version
Add an `answers` overlay kind:
- one strip, with N slots computed from N items;
- each item cued to a word;
- placeholder "?" drawn as ASS text;
- answers as Noto emoji PNGs through our existing `stickerGraph`, with the scale keyframes as `scale` animated by `eval=frame` (§7) or a pre-rendered 6-frame pop.

---

## 4. `@hypit/depth-stack`

### Purpose
A "deck" of cards (stills, videos or surfaces) dealt into one Frame. At each card's activation Instant, the **whole visible neighbourhood reflows** to new relative-depth poses. The current card is in front. Earlier cards step back one way and upcoming cards peek out the other way. Card pixels reuse Visual Track's media lowerer *(unverified internals)*.

### Public surface
- Tags: `deck:Label` (exact-font label bound to Text) and `deck:DepthStack` with `deck:Card` children (`source`, `extent` for stills, `at`, optional per-card `appearance` and `label`), plus `until` (`packages/depth-stack/src/manifest.ts:122-358`, handlers `packages/depth-stack/src/surface.ts:128-271`).
- Exports: `resolveDepthStackState`, `resolveDepthStackPose`, `renderDepthStack` and others (`packages/depth-stack/src/index.ts:1-16`).

### Data model
- `DepthStackSpec` (`packages/depth-stack/src/types.ts:58-64`):
  - visibility `{previous, next, wrap}`;
  - poses `{current: Pose, previous: Step, next: Step}`, where a Step is `{x/yPerDepth, scalePerDepth (multiplicative), rotationPerDepth + mode linear|alternate, opacityPerDepth (mult.), stackingPerDepth, tonePerDepth{brightness,contrast,saturation}}`;
  - reflow `{frames, easing}`, frame treatment and z.
- Card: `{id, activationFrame, material: MediaLayerSet, label, playback{future: hold-head|continue, past: hold-tail|continue|hide}}` (`types.ts:92-98`).

### Placement algorithm
- **State** (`packages/depth-stack/src/program.ts:315-329`): `Map<cardIndex, relativeDepth>`.
  - The current card is depth 0, previous cards are −1…−P and next cards are +1…+N.
  - Wrap is optional.
  - `past:"hide"` drops cards that are behind.
  - It **asserts that no card occupies two depths**. With wrap on, `P+N+1 ≤ cards` is enforced at the program level (`:292-295`).
- **Pose** (`program.ts:340-361`), with `m = |depth|`:
  - `x = cur.x + step.x·m` (y likewise);
  - `scale = cur.scale·step.scale^m`, `opacity = cur.opacity·step.opacity^m`, tone likewise;
  - rotation is `cur.rot + step.rot·m` (linear) or `cur.rot ± step.rot` alternating by parity (`program.ts:346`, `:352`) *(corrected in check: the current pose's rotation is added)*;
  - `stacking = cur.stacking + step.stacking·m`.
  - The test fixes depth −2 → scale 0.81, opacity 0.64, rotation +4 (alternate) (`packages/depth-stack/test/depth-stack.test.ts:293-296`).
- **Render** (`packages/depth-stack/src/lower.ts:249-331`): one *stage* per card, `[activation_i, activation_{i+1}|terminal)`.
  - Each stage emits one present per card in the union of the old and new state, or only the new state when the reflow is 0 (a cut) (`:261-263`).
  - The pose animates old→new over `reflow.frames` with easing, then holds (`:64-85`).
  - Entering and leaving cards come from or go to a "hidden pose" one step beyond the visible depth, at opacity 0 (`:57-62`).
  - Present `z = stackingOrder + pose.stacking` (`:314-316`).
- **Validation:** the reflow must fit every stage after the first one; the loop starts at card 1 because the first stage has no reflow (`program.ts:296-301`) *(corrected in check)*; triggers must be strictly increasing (`:189`); the terminal must come after the last trigger (`:290-291`).

### Card media clocks (a genuinely good idea)
`sourceTimeFor` (`lower.ts:158-196`) gives every card a pure, explicit source-time map per stage. Nothing depends on the player's playback history.
- **Current card:** the authored source-time spec over the stage.
- **Future card** with `hold-head`: frame 0 at rate 0.
- **Past card** with `hold-tail`: last frame at rate 0.
- **`continue`:** rate 1 with `wrap` and phase `(stageStart − activation) mod length` (`:138-156`).
- Timed media must already be normalized to the timeline frame rate, or the render throws (`:169-171`).
- Sampling motions are disabled on non-current cards (`:291`).

### Defaults (`packages/depth-stack/src/author.ts:134-180`)
| Setting | Default |
|---|---|
| Visibility | previous 2, next 1, no wrap |
| Previous step | y +28, scale 0.94, rotation −2.5 alternating, opacity 0.82, tone 0.92/1/0.86 |
| Next step | y −20, scale 0.92, rotation +2 alternating, opacity 0.72, tone 0.88/1/0.78 *(tone added in check)* |
| Reflow | 8 frames, ease-in-out |
| z | 30 |

The Label surface defaults are 34 px white, centred and bottom-aligned with 20 px padding, word wrap and clip. Synthetic bold is forbidden (`surface.ts:128-174`, `program.ts:104-114`).

### Tests
15 tests (`packages/depth-stack/test/depth-stack.test.ts`) *(corrected in check: was 14)*:
- the Surface declares every sealed Record it may emit (`:84`) *(added in check)*;
- state boundaries (`:256-263`);
- the wrap aliasing refusal (`:265-275`);
- trigger order errors (`:277-285`);
- pose maths (`:287-297`);
- union reflow keyframes `[0,4,20]` vs a cut with no animation (`:299-316`);
- hold-head/hold-tail/continue clocks (`:318-359`);
- label parenting (`:389-401`);
- purity (`:403-406`);
- surface graph inputs (`:408-453`);
- label surfaces (`:455-499`);
- coexistence of another deck family (`:501-525`);
- Recipe decoding (`:527-544`).

### Quality notes
- **Strong:** the media-clock model is explicit and stateless, so renders can be chunked or parallelized safely. It also fails closed on frame-rate mismatch.
- **Wasteful:** a leaving card's present lasts for the whole stage at opacity 0 after its reflow finishes (`lower.ts:268-270`, `:83`).
- **Doc/code mismatch:**
  - `playback-past` is described as "once its material is spent" (`manifest.ts:277`), but it applies as soon as a card is behind current (`lower.ts:182`), regardless of material length.
  - Studio declares placements for `enter`/`exit`/`sustain` keys that the Recipe doesn't have (`packages/depth-stack/src/studio.ts:49-51`).
- **Unused parameters:** `labelFragment(id)` ignores `id` (`surface.ts:115`), and `groupElements` ignores `stageStart`/`stageEnd` (`lower.ts:198-204`).
- The manifest dependencies omit the blob module, although Blob types are used (`manifest.ts:364`).

### Relevance: **Medium-Low**
It is useful for "receipts/proof" moments in clips, for example stacking 3–4 screenshots or highlight stills as they're named. The rendering cost in ffmpeg is real (§7). Clipper briefs rarely call for it.

### Better version
If we build it at all, build it **still-only**:
- pre-render each card once to a rounded, bordered PNG (ImageMagick or sharp);
- in ffmpeg, per stage, overlay ≤4 PNGs with `rotate`, `scale` and opacity driven by time expressions;
- keep the pose formula and `hold-head`/`hold-tail` semantics;
- leave video cards out (hold-tail can be a poster frame).

---

## 5. `@hypit/spatial`

### Purpose
Pure 2-D geometry: Canvas, Point, Frame, Path, IntrinsicExtent, affine `SpatialMap2D` and `ContentFit`. It has no layers, media, time or renderer policy (`packages/spatial/README.md:3-5`). Every overlay above takes `SpatialFrame` values built here.

### Public surface
- Tags: `space:Canvas` (`.canvas` and `.bounds`), `Point`, `Path` (Move/Line/Quadratic/Cubic/Close), `Extent`, `Map`, `Frame` (edges), `AnchoredFrame` and `AspectFrame` (`packages/spatial/src/manifest.ts:44-306`, handlers `packages/spatial/src/surface.ts:97-289`).
- Exports: all of the geometry module (`packages/spatial/src/index.ts:9`) and the Recipe decoder `decodeContentFitProperties` (`packages/spatial/src/author.ts:39-59`).

### Algorithms
- **Lengths** are `px` or `%`. A percent is relative to the parent width on x and the parent height on y (`packages/spatial/src/geometry.ts:109-114`; surface regex `surface.ts:62`).
- **`frameFromEdges`**: left/top/right/bottom are all measured from the parent's left/top. Width and height must come out positive (`geometry.ts:135-142`).
- **`anchoredFrame`**: `x = targetX − w·anchor.x + offset`, over 9 anchors (`:144-161`, `:116-122`).
- **`aspectFrame`**: derives the other axis from the extent ratio, then anchors (`:163-178`).
- **`resolveContentFit`** (`:189-219`):
  - scale is one of `contain/cover/fit-width/fit-height/native(1)/scale-down(min(1,contain))/stretch(independent)`;
  - `pos = frame + frameSize·framePoint − contentSize·contentPoint + offset`;
  - `bounded` clamps the position into the range between "flush to start" and "flush to end" (`:180-186`), which works for content both larger and smaller than the frame;
  - it returns an affine **map**, not a rectangle.
- `composeSpatialMaps`, `mapSpatialPath` and `mapSpatialFrameBounds` keep rotation exact. Bounds are just a derived rectangle (`:231-308`).

### Tests
10 tests (`packages/spatial/test/spatial.test.ts`):
- percent edges and anchors (`:54-64`);
- all 9 anchors (`:66-80`);
- aspect (`:82-88`);
- every sizing mode (`:90-103`);
- map composition with a quarter turn (`:105-114`);
- a 3×3×7 matrix checking centre, aspect and per-mode invariants (`:116-178`);
- focal point bounded vs free (`:180-195`);
- off-canvas allowed (`:197-204`);
- path rules (`:206-211`);
- a full compile through the real compiler producing only `frame-edges` + `aspect-frame` steps (`:217-268`).

### Quality notes
Small, correct and well tested. A few loose ends:
- Unused schema imports in the manifest (`manifest.ts:2-12`). The types are published without schemas.
- `contentFitPropertyNames` (`author.ts:6-9`) duplicates `visualMaterialKeys.fit` used by depth-stack (`packages/depth-stack/src/author.ts:123`) *(owner of the latter not verified)*.

### Relevance: **Medium**
Our overlay layout is ad-hoc pixel math scaled by `k = min(W,H)/1080` against a fixed footage band (`clipper/server/overlays.ts:120-123`, `:136-138`). A tiny Frame/anchor/fit helper would let formats (`clipper/server/formats.ts`) carry overlay frames such as "comment at top-centre 82% wide". That one change would also fix the comment stacking that collides today (see §7).

### Better version
Port about 80 lines: `SpatialFrame`, `frameFromEdges`, `anchoredFrame` and `resolveContentFit`, plus the 3×3×7 invariant test. Skip Path, Map and the markup surfaces.

---

## 6. `@hypit/region-evidence`

### Purpose
Frame-exact external spatial evidence. One or more named series of normalized `[x,y,w,h]|null` boxes, **exactly one per timeline frame**, are resolved into program-picture `SpatialFrame`s inside an explicit `within` Frame. It does no detection, interpolation or identity inference (`packages/region-evidence/README.md:3-5`).

### Surface and algorithm
- Tag: `region:Evidence` (`id`, `within`, `timeline`, `recipe`) (`packages/region-evidence/src/surface.ts:24-40`).
- `resolveRegionEvidence` (`packages/region-evidence/src/evidence.ts:60-82`):
  - Recipe keys are exactly `series`, and each item is exactly `{id, regions}`;
  - `regions.length` must equal `timelineFrameCount`;
  - each box must satisfy `x,y ≥ 0`, `w,h > 0` and `x+w ≤ 1`, `y+h ≤ 1`, or it **throws** (`:22-37`).
- `assertRegionEvidence` checks unique series ids and equal frame counts (`:39-52`).
- Consumer: `caption-fine` makes captions *follow a speaker's region* by Script Role and fails if the regions don't cover the timeline (`packages/caption-fine/src/render.ts:1109-1135`; batch 06).

### Tests
2 tests:
- resolution into a 400×800 Frame at offset (100,200), giving `{300,280,80,240}` (`packages/region-evidence/test/region-evidence.test.ts:8-20`);
- an out-of-frame box is refused (`:22-28`).

### Quality notes
- Strict and simple.
- The schema is exported but not attached to the manifest type (`packages/region-evidence/src/schema.ts:6-14`, `manifest.ts:40`).
- One value per frame is heavy for long timelines. 60 s at 30 fps is 1,800 entries per series, written into a Recipe file. There is no sparse or keyframe form.

### Relevance: **Low (Medium later)**
We have no per-frame subject boxes. Our moments are 1 fps vision descriptions. The idea "overlays and captions avoid or follow a region" is valuable for face-cam clips, but it needs a detector. Doing that on CPU is possible (an OpenCV face cascade at a low sampling rate) but not free.

### Better version
If we want it:
- a sparse keyframed form, `[{t, box}]` with linear interpolation, sampled at 2–5 fps from a cheap detector;
- use it only for "avoid" placement of overlays and captions: pick the anchor whose Frame doesn't intersect the subject box.

---

## 7. Our ASS/ffmpeg approach vs hypit: what we can and cannot reproduce

### Where we stand
- `clipper/shared/overlays.ts`:
  - sanitizes up to `MAX_OVERLAYS = 12` overlays (`:5`);
  - known kinds only;
  - text caps: comment 140, tier 24, other 40 (`:44`);
  - emoji must be one grapheme (`:39-42`);
  - unknown tiers become "C" (`:49`);
  - an overlay with no cue and no `at` is dropped, and so is one whose cue isn't spoken (`:50-51`). Matching is normalized whole-word in-order (`:7-13`).
- `clipper/server/overlays.ts`:
  - `placeOverlays` finds the cue in the timed words; repeated cues take later occurrences (`:28-56`);
  - default holds: comment 2.8 s, emoji 1.3 s, text 1.1 s; tier until the CTA (`:19`, `:52`);
  - ASS events for comment, pop text and tier board (`:135-213`);
  - Noto emoji PNGs (cached in storage) overlaid by ffmpeg with fade and a 0.18 s bounce (`:227-249`, `:289-310`).
- Everything is burned in one `ass=` pass plus a chained `overlay` per emoji (`clipper/server/media.ts:140-164`). Missed overlays are logged to Activity (`clipper/server/render.ts:317-320`).

### Model-level gaps (cheap to fix, no renderer change)
1. **Windows vs holds.** Hypit gives a ranking item a *reveal window* (introduce → verdict), then a *settled* span. We have "start at cue, fixed hold" (tier: "until CTA"). Fix: derive `window = [cue word start, next sibling cue start)`, capped at the sentence end, and keep `settled = [window end, CTA)`.
2. **Disjointness and fit checks at plan time.** Hypit refuses overlapping tier windows, rows that don't fit and strips wider than the frame. We draw blindly. Two problems I found in ours:
   - **Tier items in one row collide from item 4 onwards, not item 7** *(corrected in check)*. Slots are `x = idx % 3` with a single `+px(26)` drop for every `idx ≥ 3` (`clipper/server/overlays.ts:204-207`). Computed at 1080×1920 (k = 1, `rowH = min(124, ⌊(844−40)/5⌋) = 124`) with `\an4` (vertically centred):
     - Items 1–3 are centred at `rowCentre`. Items 4–6 are centred at `rowCentre + 26`, in the same three x columns.
     - The offset of 26 px is smaller than the font size of 48 px (or 38 px for names over 12 chars). Item 4 therefore overlaps item 1 vertically by about 22 px (12 px at 38 px), and likewise 5 on 2 and 6 on 3.
     - Items 7, 8 and 9 (`idx` 6–8) get exactly the same x and y as items 4, 5 and 6, so they overprint them completely. The original claim that item 7 lands on item 4 is right, but the collision starts three items earlier.
   - **No width check, but the overflow depends on the font** *(corrected in check)*. `slotW = (1000−130−20)/3 = 283.3 px` (`:205`). Names are cut to 22 chars (`:203`) and drawn at `\fs38` if they are over 12 chars, else `\fs48` (`:208`), with a `px(5)` outline (`:130`). libass maps `\fs` to the font's winAscent+winDescent, not to the em. I measured glyph advances with PIL, scaled by `upm/(winAscent+winDescent)` and added the 10 px of outline. The text was not rendered through libass. The results:
     - A typical 22-char mixed-case name at 38 px measures about **243–276 px** in Poppins Black/ExtraBold (the default caption styles), about 210 px in Anton and about 225 px in Bebas Neue. All of these **fit** in 283 px.
     - The same name in **Archivo Black** (the "Boxed" style) measures about **340–415 px**, and **overflows**. In Archivo, even a 12-char name at 48 px measures about 325 px and overflows.
     - Wide all-caps names overflow in every bundled font, for example 22×"W" at 532 px in Poppins. Brand-uploaded fonts are unbounded.
     - The overflow does not stop at the next slot. The third slot starts at x ≈ 757, so a 400 px name runs past the board edge (1048) and off the 1080 frame.
   - **Comment stacking** (`:148-160`) *(corrected in check)*. Each comment compares itself only with the one before it (`lastEnd`/`lastBottom`). The height is `h = 118 + 56·lines`, so a 3-line card is 286 px.
     - **Three mutually overlapping comments do not collide with each other.** Each one stacks below the last. With 3-line bodies, the third ends at `560 + 40 + 3·286 + 2·16 = 1490`, which is **86 px below the 1404 band bottom** (`clipper/server/media.ts:100-101`), over the caption area. With 2-line bodies, the stack ends at 1322 and fits.
     - **The real collision is with a comment that is not the previous one.** Suppose comment A has a long `hold` (up to 8 s) and B is short. If C starts after B ends but while A is still visible, C resets to `bandTop + 40` and draws over A.
     - **While a tier board is up, all comments share one y** (`bandTop − h − 24`). The over-board branch never stacks, so two comments over a board overlap completely.

   Hypit throws in these cases. For an automated SaaS we should instead validate in `sanitizeOverlays` (cap per row, cap total), **repair** (shrink font, truncate, move to the next row) and log what was repaired. A render is not the place to fail.
3. **One event law for picture and sound.** Hypit derives sound events from the same phase frames as the animation. We have no SFX at all (`clipper/server/media.ts:147-153` mixes only game + voice). Adding SFX is cheap:
   - build `[{t, kind}]` from `Placed` (pop for text/emoji, whoosh for comment enter, "thud" at tier settle);
   - add one `-i sfx.wav` per kind and `adelay=t_ms|t_ms,volume=g` per event into the existing `amix` **before** `loudnorm`;
   - CPU cost is negligible;
   - it needs bundled CC0 SFX.
4. **Explicit Frames.** Replace the `bandTop + px(40)` constants with Frame helpers (§5) so formats can move overlays.
5. **Never fabricate.** Hypit's comment card omits rows it wasn't given. Our "Reply to @viewer" default user (`clipper/shared/overlays.ts:48`) is a mild fabrication. Prefer "Reply to comment" when no handle is given.

### Renderer-level: ASS (libass) can reproduce
| Hypit effect | ASS technique | Fidelity |
|---|---|---|
| Rounded cards, rows, rings, rank badges, tier label cells, emoji strip board | `\p1` drawings (we already have `roundedRect`); circles as 4 Béziers | exact |
| Pop/overshoot scale (0.72→1.14→0.95→1, 0.76→1+0.075 sin, out-back) | chained `\t(t1,t2,\fscx\fscy)` segments, 2–3 per pop; `\t` accel exponent for ease-in/out | close (piecewise) |
| Tilt and rotation unwind (−2.5° base, −4.5° delta) | `\frz` + `\t(\frz)`, with a **shared `\org`** on every line of a multi-line card so it rotates as a group | exact |
| Fade and fade-up exit | `\fad` + `\move(..., t1,t2)` | close, not exact *(corrected in check)*. Hypit's fade-up is `ease-in` and `\move` is linear. A line takes only one `\move`, and ours is already used for the slide-in (`clipper/server/overlays.ts:162`), so the exit needs its own split event. A multi-line ASS card also fades each line separately: text over the card shows the card through it mid-fade, whereas CSS `opacity` on the group composites once |
| Eased or arced glide (tier "drop", column move) | `\move` is linear only and `\pos` can't be `\t`-animated. Use either (a) split into 6–10 consecutive Dialogue events with short `\move`s along the smootherstep/arc samples, or (b) the arc via `\org` far below + `\t(\frz)` rotation | good (a) / exact arc (b) |
| Float hold (sin 4 px / 0.35°, 84 f) | rotation part: alternating `\t(\frz)` segments with accel; vertical part: split events with tiny `\move`s, or a tiny `\frz` about a far-away `\org` (translation-like) | approximate |
| Soft drop shadow (CSS blur 46 px) | a second shape line, offset, `\1a&H80&\blur10–20` (libass Gaussian; large blur costs CPU but only for a few events) | approximate |
| Hard "meme" shadow (emoji strip) | offset duplicate shape, no blur | exact |
| Speech-bubble tail | triangle `\p1` drawing | exact |
| Ellipsized, `maxLines` body text | ASS can't measure; we must wrap ourselves. Replace char-count `wrap` with **glyph-advance measurement** from the bundled TTFs (e.g. `opentype.js`), then insert `\N` and an ellipsis | exact once measured |
| Podium ring pulse (scale 1.08) | `\t(0,mid,\fscx108\fscy108)\t(mid,end,\fscx100\fscy100)` on the ring drawing | exact |
| Board/stage/item stacking (z 20/25/30) | Dialogue `Layer` field | exact |
| Per-frame keyframe baking (hypit's style) | not needed: ASS times are centisecond-precise (`clipper/server/overlays.ts:60-66`) | — |

### Renderer-level: ASS cannot, ffmpeg can (at a cost)
| Hypit effect | ffmpeg route | Cost / caveat |
|---|---|---|
| Raster icons in tier cells, column rows, podium slots, emoji-strip answers, comment avatars | `overlay` per image, as with our emoji stickers. Each needs its own looped input and `setpts` window (`clipper/server/overlays.ts:289-310`) | one filter chain per image; fine up to ~10–15 per clip |
| Animated scale/rotation of images (pop, drop glide) | `scale=…:eval=frame` with `t` expressions, `rotate=a='expr(t)'`, `overlay=x='expr(t)':y='expr(t)'` | *(unverified on our ffmpeg build — test before relying on `scale` eval=frame)*. Cheaper alternative: pre-render the 6–14 frame pop as a short PNG sequence and overlay it, then a static PNG for the settled span |
| Rounded image corners / circular avatars | `alphamerge` with a pre-rendered mask PNG, or pre-process the image once with ImageMagick/sharp | pre-processing is the cheap route |
| Opacity ramps on images | `fade=…:alpha=1` (already used) or `colorchannelmixer=aa=` | cheap |
| Depth-stack tone (brightness/contrast/saturation per depth) | `eq=brightness:contrast:saturation` per card per stage | cheap for stills |
| Depth-stack video cards with hold-head / hold-tail / continue clocks | `trim`/`tpad=stop_mode=clone`/`loop`/`setpts` per card per stage | heavy: N cards × visible neighbours of decode + scale + rotate per frame. Not worth it on CPU-only Railway; restrict to stills |
| Blur on images (entrance blur 1.2–1.6 px) | `gblur` with timeline enable | cheap but negligible visually; skip |
| SFX plan | `adelay` + `volume` + `amix` | trivial |

### Cannot reproduce faithfully without a browser/canvas renderer
- **CSS `linear-gradient` fills** (avatar background option, `packages/comment-sticker/src/program.ts:66-71`; depth-stack `frame-paint` linear/radial). Approximations: stacked `\clip` strips in ASS, or a pre-rendered PNG.
- **Browser text layout** features: real `text-flow` with kerning/feature control, `letter-spacing −0.02em` and fixed-box `ellipsis` decided by the renderer. libass has `\fsp` (spacing) and `Kerning: yes`, so −0.02 em ≈ `\fsp-0.8` at 42 px. Line-breaking is ours to compute.
- **CSS filters on arbitrary subtrees** (`filter: blur() drop-shadow()` over an icon + box group). These need per-group compositing that neither libass nor a simple overlay chain does in one pass.
- **Pixel-identical parity with hypit's previews.** That would need their Chrome-based renderer (batch 05), which we deliberately don't run.

### Verdict
About **90% of the visual vocabulary** in this batch is reproducible in our ASS + ffmpeg pipeline at negligible CPU cost:
- text-and-shape boards;
- pops, tilts, fades, arcs;
- hard and soft shadows;
- SFX.

The remaining 10% is gradients, CSS filters over groups and video cards. It needs either pre-rendered PNGs or a browser renderer. None of it is essential for clipper formats.

**Checker's challenge to the 90% figure.** The figure holds for the *vector-and-text* vocabulary. It overstates what this batch's components need, for five reasons:
1. **These components are image-first.** A TierBoard item *requires* an icon (`packages/ranking/src/types.ts:222`). The emoji strip is PNG-only. A depth-stack is media cards. Stickers carry avatars. Each of these needs a per-item raster through the ffmpeg route, and for arbitrary ranked items ("Taco Bell", "Remini") we have no source of icons at all. The hard problem is getting the assets, not drawing them. The 90% figure doesn't count it.
2. **z-order between ASS and images can't be interleaved in one pass.** Every `overlay` image sits above *all* of the `ass=` output (`clipper/server/media.ts:155-164`). Hypit's board 20 → stage 25 → item 30, and a comment card (z 62) above a board with icons, can't be reproduced unless the ASS track is split and `ass → overlay → ass` passes are chained. Each extra pass is another libass render over the full frame.
3. **Group opacity and fades are approximate, not exact** (see the corrected fade row). Neither are eased exits, because `\move` is linear and a line takes only one.
4. **Pixel values don't port 1:1.** libass `\fs` is the cell height (winAscent+winDescent), not the CSS em. For Poppins that is about 0.57 em per `\fs` unit, so hypit's `42 px` body is roughly `\fs74` in our styles. All hypit sizes must be converted per font. That's measurable, but the "exact" rows assume it has been done.
5. **Animated image transforms are untested** on our ffmpeg build (as already marked).

A fairer statement: about 90% of the shape, text and motion vocabulary is reproducible. By component, about **two-thirds** is reproducible without extra passes, image sourcing or per-font size calibration: comment cards, text tier boards, column and podium in text form, and SFX. Icon tiers, the emoji strip and depth-stack need the image path and its z-order limits. *(added in check; the two-thirds figure is the checker's judgement, not a measurement)*

---

## Ideas worth taking (ranked)

1. **Reveal-window → settled-span schedule for list overlays** (`packages/ranking/src/schedule.ts:445-519`). Derive windows from speech (cue → next cue), with stage-then-glide for tier items, done in ASS with split `\move` events. This directly improves our existing tier board.
2. **Motion fitting instead of rejection** (`schedule.ts:699-743`). When a window is short, compress appear+move proportionally and keep the glide ending at the window end. Our fixed 180 ms drop and 2.8 s holds ignore speech pace.
3. **Sound events from the same phase frames** (`schedule.ts:826-866`, `render.ts:652-697`). Add an SFX plan to `compose()` via `adelay`/`amix`, with per-kind gain, before `loudnorm`. It is cheap and adds noticeable punch.
4. **Plan-time fit validation with repair**, borrowing hypit's checks (row fit `render.ts:321`, column fit `:472-476`, strip-in-frame `packages/interview-emoji-reveal/src/program.ts:196-199`, card text box `packages/comment-sticker/src/program.ts:460-473`) but repairing and logging instead of throwing. This also fixes our overlap from the 4th item in a row and long tier names *(corrected in check: was "7+")*.
5. **Column/Top-N and podium variants** as new overlay kinds (`packages/ranking/src/render.ts:464-650`), reusing the same schedule. They are proven clipper formats.
6. **Comment card polish:** −2.5° tilt, pop with rotation unwind, float hold, fade-up exit, speech tail, "Reply to @x's comment", optional meta, never fabricated (`packages/comment-sticker/src/author.ts:86-147`). All of it is doable in ASS.
7. **Measured text wrapping with ellipsis** from the bundled fonts (replacing `clipper/server/overlays.ts:88-104`).
8. **Frame/anchor/fit helpers** (`packages/spatial/src/geometry.ts:109-219`) so formats can place overlays, plus the invariant test matrix (`packages/spatial/test/spatial.test.ts:116-178`).
9. **Answer strip** (`packages/interview-emoji-reveal`) as a quiz overlay, built from our emoji sticker pipeline.
10. **Stateless media-clock idea** from depth-stack (`packages/depth-stack/src/lower.ts:122-196`). It applies if we ever do picture-in-picture or stacked clips: every clock is derived from activation and stage, never from playback history.

## Things not to copy

- **Per-frame keyframe baking** (`packages/ranking/src/render.ts:241-251`, `packages/comment-sticker/src/program.ts:302-327`). It only makes sense for their HTML renderer. ASS `\t` with timed segments is far smaller and exact enough.
- **Throw-on-invalid at render time** ("refused, never repaired", `packages/ranking/src/manifest.ts:625`). That suits an author/agent loop. Our users get an automated render, so validate early, repair and report.
- **The graph-fragment ceremony** (create-set → append × N → finalize → render, each a producer). It is about 30 producers for one ranking package (`packages/ranking/src/manifest.ts:46-80`). We don't need content-addressed intermediate values per overlay item.
- **Per-frame region evidence in Recipe files** (`packages/region-evidence/src/evidence.ts:73-75`). It is too heavy. Use sparse keyframes if we ever do this.
- **Video cards in a depth stack on CPU-only servers**: the decode × neighbours × frames cost is too high.
- **Stale published vocabularies.** Hypit's manifests drift from code: Column stage defaults (`packages/ranking/src/style.ts:237-238` vs `manifest.ts:381-386`), fade-out claims, missing `out-back`, the `digest` blob schema. If we expose overlay knobs to the planner or MCP, generate the documentation from the same defaults table the code uses.

---

## Coverage table

All files in the six packages. Line counts are `wc -l` at the studied commit; for PNGs this is a byte-newline count, and those files were opened as images.

| File | Lines | Read |
|---|---|---|
| packages/ranking/README.md | 74 | ✅ |
| packages/ranking/package.json | 44 | ✅ |
| packages/ranking/src/index.ts | 26 | ✅ |
| packages/ranking/src/activation.ts | 45 | ✅ |
| packages/ranking/src/types.ts | 277 | ✅ |
| packages/ranking/src/tier.ts | 176 | ✅ |
| packages/ranking/src/schedule.ts | 892 | ✅ |
| packages/ranking/src/style.ts | 272 | ✅ |
| packages/ranking/src/render.ts | 697 | ✅ |
| packages/ranking/src/component.ts | 272 | ✅ |
| packages/ranking/src/fragment.ts | 210 | ✅ |
| packages/ranking/src/surface.ts | 299 | ✅ |
| packages/ranking/src/studio.ts | 324 | ✅ |
| packages/ranking/src/manifest.ts | 812 | ✅ |
| packages/ranking/test/ranking.test.ts | 667 | ✅ |
| packages/ranking/test/companion.test.ts | 42 | ✅ |
| packages/ranking/preview/Column.svg | 29 | ✅ |
| packages/ranking/preview/TierBoard.svg | 36 | ✅ |
| packages/ranking/preview/TierBoard.png | 70 | ✅ (viewed; unreferenced) |
| packages/ranking/preview/TopThree.png | 80 | ✅ (viewed) |
| packages/comment-sticker/README.md | 49 | ✅ |
| packages/comment-sticker/package.json | 44 | ✅ |
| packages/comment-sticker/src/index.ts | 8 | ✅ |
| packages/comment-sticker/src/activation.ts | 37 | ✅ |
| packages/comment-sticker/src/types.ts | 109 | ✅ |
| packages/comment-sticker/src/component.ts | 97 | ✅ |
| packages/comment-sticker/src/fragment.ts | 124 | ✅ |
| packages/comment-sticker/src/author.ts | 148 | ✅ |
| packages/comment-sticker/src/surface.ts | 160 | ✅ |
| packages/comment-sticker/src/studio.ts | 133 | ✅ |
| packages/comment-sticker/src/manifest.ts | 369 | ✅ |
| packages/comment-sticker/src/program.ts | 610 | ✅ |
| packages/comment-sticker/test/comment-sticker.test.ts | 197 | ✅ |
| packages/comment-sticker/preview/Track.png | 273 | ✅ (viewed) |
| packages/interview-emoji-reveal/README.md | 43 | ✅ |
| packages/interview-emoji-reveal/package.json | 31 | ✅ |
| packages/interview-emoji-reveal/src/index.ts | 16 | ✅ |
| packages/interview-emoji-reveal/src/activation.ts | 18 | ✅ |
| packages/interview-emoji-reveal/src/component.ts | 46 | ✅ |
| packages/interview-emoji-reveal/src/style.ts | 47 | ✅ |
| packages/interview-emoji-reveal/src/types.ts | 52 | ✅ |
| packages/interview-emoji-reveal/src/fragment.ts | 63 | ✅ |
| packages/interview-emoji-reveal/src/surface.ts | 99 | ✅ |
| packages/interview-emoji-reveal/src/manifest.ts | 173 | ✅ |
| packages/interview-emoji-reveal/src/program.ts | 242 | ✅ |
| packages/interview-emoji-reveal/preview/Track.png | 51 | ✅ (viewed) |
| packages/depth-stack/README.md | 61 | ✅ |
| packages/depth-stack/package.json | 50 | ✅ |
| packages/depth-stack/src/index.ts | 16 | ✅ |
| packages/depth-stack/src/activation.ts | 37 | ✅ |
| packages/depth-stack/src/component.ts | 86 | ✅ |
| packages/depth-stack/src/types.ts | 117 | ✅ |
| packages/depth-stack/src/studio.ts | 134 | ✅ |
| packages/depth-stack/src/fragment.ts | 148 | ✅ |
| packages/depth-stack/src/author.ts | 214 | ✅ |
| packages/depth-stack/src/surface.ts | 271 | ✅ |
| packages/depth-stack/src/lower.ts | 331 | ✅ |
| packages/depth-stack/src/program.ts | 361 | ✅ |
| packages/depth-stack/src/manifest.ts | 391 | ✅ |
| packages/depth-stack/test/depth-stack.test.ts | 544 | ✅ |
| packages/depth-stack/preview/DepthStack.png | 383 | ✅ (viewed) |
| packages/spatial/README.md | 75 | ✅ |
| packages/spatial/package.json | 31 | ✅ |
| packages/spatial/src/fragment.ts | 29 | ✅ |
| packages/spatial/src/index.ts | 35 | ✅ |
| packages/spatial/src/schema.ts | 36 | ✅ |
| packages/spatial/src/component.ts | 42 | ✅ |
| packages/spatial/src/activation.ts | 45 | ✅ |
| packages/spatial/src/author.ts | 59 | ✅ |
| packages/spatial/src/types.ts | 96 | ✅ |
| packages/spatial/src/surface.ts | 289 | ✅ |
| packages/spatial/src/geometry.ts | 316 | ✅ |
| packages/spatial/src/manifest.ts | 334 | ✅ |
| packages/spatial/test/spatial.test.ts | 269 | ✅ |
| packages/region-evidence/README.md | 27 | ✅ |
| packages/region-evidence/package.json | 33 | ✅ |
| packages/region-evidence/src/types.ts | 13 | ✅ |
| packages/region-evidence/src/index.ts | 14 | ✅ |
| packages/region-evidence/src/schema.ts | 14 | ✅ |
| packages/region-evidence/src/fragment.ts | 20 | ✅ |
| packages/region-evidence/src/activation.ts | 23 | ✅ |
| packages/region-evidence/src/component.ts | 26 | ✅ |
| packages/region-evidence/src/surface.ts | 40 | ✅ |
| packages/region-evidence/src/manifest.ts | 52 | ✅ |
| packages/region-evidence/src/evidence.ts | 82 | ✅ |
| packages/region-evidence/test/region-evidence.test.ts | 28 | ✅ |

The comparison is based on these of our files, read in full: `clipper/shared/overlays.ts` (56) and `clipper/server/overlays.ts` (310). The call sites were read: `clipper/server/render.ts:300-321`, `clipper/server/media.ts:140-164` and `clipper/server/captions.ts:125-164`.
