# 04: Studio (preview app)

- **Batch:** 04, Studio (the preview and editing app)
- **Source:** hypit at commit `dc2b7a8f31b1ef1443a79ca448548d69e3ceb6a0`, treated as read-only
- **Package:** `packages/studio`. It has 13,297 lines in `src/` (11,601 TypeScript plus 1,696 CSS), 2,480 lines across 25 test files, and 971 lines of docs, locales, manifest and `index.html`. The total is 16,748 (`wc -l`). *(corrected in check)*

The study's focus is fivefold:
- the live preview architecture;
- how a composition is previewed and scrubbed;
- inspector and editing affordances;
- how Studio talks to the runtime;
- what UGCMediaClips should adopt in place of its current mix of "render first, then look" and "bake an MP4 in OpenReel". Our side covers `ClipCard`, `RenderPanel`, `FormatsView`, `CaptionsView` and the OpenReel bridge.

Paths below are relative to the hypit repo root unless they start with `clipper/`.

---

## 1. Purpose

Studio is Hypit's local web IDE for one "Run" (an `.svrun` file that selects a Film/Render target from SVML source). It runs as a Vite dev server with custom middleware.

On every source change it recompiles the Run and executes only the deterministic part of the graph, with no paid generation. It compiles the resulting `Composition` into the same `HtmlProgram` document that the production renderer photographs frame by frame, and shows that document in an iframe. The preview player, the timeline and the source pane are cross-linked. Every edit (inspector field, timeline drag or text edit) is written back as a revisioned, preimage-checked patch to the source files, then recompiled.

Studio never creates a Build and never spends money. The README states this at `packages/studio/README.md:303-310`, and the code enforces it in `execute.ts:20-37` and `projection.ts:154-159`.

## 2. Public surface

**CLI**

`cli.ts:3-28` contributes two `hypit` verbs.

| Verb | Flags / behaviour | Where |
|---|---|---|
| `hypit studio --run <x.svrun>` | `--runtime`, `--port` (default 5179), `--project`, `--package-root`, repeatable `--locale-pack`; `--check-locale` lints a language pack | `start.ts:7-29`, `start.ts:51-177` |
| `hypit snapshot --studio <url> --to <dir>` | Requires `--to` (a destination that must not exist yet, `snapshot-cli.ts:56,86`) *(added in check)*. Takes `--at-frame n[,n]` or `--start-frame/--end-frame-exclusive/--step-frames`, plus `--grid CxR`, `--cell px`, `--runtime`, `--project` and `--json`. It captures exact frames of the *current* Studio picture through the Runtime's `rasterize-frames` provider. | `snapshot-cli.ts:17-140` |

**HTTP endpoints**

All endpoints are Vite middleware.

- `server.ts:462-792` registers most of them.
- `feedback-server.ts:37-67` registers the comments endpoint.
- `localization-node.ts:33-46` registers the locales endpoint.

| Method and path | Role |
|---|---|
| `GET /__studio/session` | Returns the current `StudioSnapshot` JSON, or the compile failure (`server.ts:611-626`). |
| `GET /__studio/document` and `/__studio/visual.html` | Return the compiled `HtmlProgram`, or the materialized HTML without the playback shim. They return 409 while a recompile is pending (`server.ts:589-610`). |
| `GET /__studio/material/<res_…>` | Serves preview media bytes with HTTP Range support (`server.ts:706-736`, `requestedByteRange` at `45-63`). |
| `GET /__studio/storyboard/<res_…>` | Returns a PNG filmstrip atlas for a video. The geometry goes in `x-hypit-storyboard-*` headers, and the atlas is cached immutably (`server.ts:672-705`). |
| `GET /__studio/surface-preview` | Serves a package-declared poster image (`server.ts:648-671`). |
| `GET /__studio/library?section=tasks\|artifacts` | Lists Build tasks and media from the Runtime and Result repository (`server.ts:627-647`). |
| `GET /__studio/artifact?build&output` | Streams a finished Build output with Range support (`server.ts:737-790`). |
| `POST /__studio/mutation` | Accepts the whole edit vocabulary, `timeline.adjust` and `parameter.adjust` (`server.ts:545-584`, types at `shared.ts:253-280`). |
| `PUT /__studio/source` | Replaces a whole file from the text editor (`server.ts:464-518`). |
| `PUT /__studio/artifact-name` | Renames an output's display name (`server.ts:519-544`). |
| `GET/POST /__studio/feedback` | Reads and writes timestamped review comments in `<workspace>/FEEDBACK.json` (`feedback-server.ts:37-67`). |
| `GET /__studio/locales` | Returns the language packs (`localization-node.ts:33-46`). |

Push events go over Vite HMR websocket custom events:
- `studio:snapshot` and `studio:error` (`server.ts:156,166`);
- `studio:feedback-changed` (`feedback-server.ts:29,61`).

**Iframe ABI**

The preview iframe exposes three globals, defined outside this batch in `packages/html-program/src/playback.ts:205-217`. Studio's stage uses them at `stage.ts:159-163`.
- `__hypitSeekFrame(frame)` returns a promise of a boolean that resolves once media is decoded.
- `__hypitPlayFrame(frame)`
- `__hypitSetMuted(bool)`

**Companion ABI (consumed, not defined here)**

Packages contribute "Studio Companions" through facets. The kinds are Track, Film, Temporal Domain, Temporal Declaration, Temporal Relation and Parameter. Companions decide:
- which graph outputs become timeline Items;
- the lanes, titles and thumbnails;
- the inspector fields;
- how time edits invert.

Studio assembles them into one immutable `StudioCompanionRegistry` (`companion-assembly.ts:15-36`, `studio-registry.ts:185-487`). Built-in fallbacks cover bare Timeline, AudioTrack and VisualTrack outputs (`fallback-companions.ts:80-98`).

## 3. How it works

### 3.1 Compile, execute, snapshot pipeline (server side)

1. **Startup** (`start.ts:110-177`). Startup loads the package domain (`domain.ts:38-139`) and the Companion registry. It opens the Runtime's *read-only* control interface and a "transient execution" handle (`build-library.ts:242-269`). It then compiles the Run once and runs a preflight check (`studio-preflight.ts:86-198`), and finally starts Vite.
   - The preflight requires exactly one Film composition and exactly one time source (`:103-105`, `:139`).
   - It rejects a target that is satisfied by an opaque media candidate, such as an already-rendered MP4 (`:118-120`).
2. **Observation without re-parsing** (`observe.ts:69-187`). Studio wraps each markup Surface handler so that each authored element's source range, attribute value ranges and produced record and output ids are recorded as it passes through. The compiler itself is unchanged. `compile.ts:111-149` then joins these observations to the compiler's own provenance ids. This is how a timeline Item or inspector field knows the exact byte range in `.svml` that produced it.
3. **Debounced recompile** (`server.ts:113-179`). A filesystem change on any file in the current closure calls `schedule()`, which waits 80 ms (`:172-179`) and then calls `publish()`. The source watcher lives in `source-watch.ts:6-53`: it watches per directory, handles atomic-rename saves and drops directories that are no longer imported.
   - Each attempt carries a monotonically increasing `requestedRevision`, and stale results are dropped (`:125,147,158`).
   - Run and Author are recompiled together, so a new graph is never executed through an old plan (`:116-124`).
4. **Display execution** (`projection.ts:100-269`). Studio plans only the Film composition, the time source and the outputs that Companions require (`session.ts:76-90`). It executes them with deterministic Producers, or through the Runtime's transient executor for capabilities the Runtime explicitly allows outside a Build (`execute.ts:20-37`). Any unserved capability fails the preview with the capability's name; nothing is faked (`projection.ts:154-159`).
5. **Render to preview** (`preview/render.ts:28-61`). `compileHtmlProgram(composition, timeline)` builds the same document the real renderer captures.
   - Every media reference is rewritten to `/__studio/material/<res>`. A reference to anything Studio cannot serve throws instead of showing a picture with holes (`:34-36`).
   - Audio clips become `<audio data-*>` tags whose envelopes are in 48 kHz samples (`:39-59`).
   - The playback shim is injected last (`:60`).
6. **Snapshot** (`snapshot.ts:170-354`). The snapshot converts executed tracks into `StudioTrack`s of `StudioItem`s through the Companions.
   - Audio samples are converted to frames with floor/ceil, and at least one frame is kept (`:73-84`).
   - Each item gets its resolved inspector fields (`parameters.ts:476-505`) and its edit handles (`parameters.ts:508-618`).
   - The snapshot carries the preview `srcdoc`, the canvas, the frame rate and frame count, the source files and the temporal-domain lanes (`shared.ts:213-250`). It is pushed to the browser over HMR.

### 3.2 Preview and scrubbing (browser side)

**The picture is the real render document.** The stage puts `snapshot.preview.srcdoc` into a sandboxed iframe sized to the canvas in CSS pixels, scaled with a transform to fit the viewport (`stage.ts:187-202`, `368-373`). A new revision replaces `srcdoc` and stops playback.

**Frame-exact seeking.** In the shim (`packages/html-program/src/playback.ts:130-202`), `apply(seconds, scrubbing)` places every timed element for the program frame.
- For each `<video>` it computes the source frame with exact BigInt rational math, `sourceFrame = a + (frame-start)·rate` (`:157`), and seeks to the *centre* of that source frame, `(n+0.5)/fps`.
- It waits for the `seeked` event before resolving (`seekDecoded`, `:110-124`).
- It calls the HTML program's `applyFrame` for CSS and DOM animation.

When scrubbing, every element is paused and seeked. During playback the decoder owns its own clock, and Studio corrects it only when drift exceeds **0.08 s** (`:169`, `:192`). The code comments explain why: seeking on every frame used to freeze the picture.

A hold (zero source rate) stays paused on its frame, and reverse playback is evaluated per frame without a negative `playbackRate`. Tests pin both behaviours (`test/video-preview.test.ts:39-106`).

**Transport.** Play is a `requestAnimationFrame` loop that computes `frame = fromFrame + round(elapsedMs/1000·fps)` and pushes it into the store (`stage.ts:217-236`). The store clamps frames to `[0, frameCount-1]` (`selection.ts:88-89`).
- When an item jump arrives during playback, the clock re-anchors instead of stopping (`stage.ts:382-386`).
- Keyboard shortcuts (`main.ts:1071-1107`):

  | Key | Action |
  |---|---|
  | Space | Play or pause |
  | ←/→ or `,`/`.` | ±1 frame |
  | Shift+arrow | ±10 frames |
  | Home / End | First / last frame |
  | `-` / `=` | Zoom |
  | `\` or `f` | Fit |

  The shortcuts are suspended while an input field has focus. Escape also clears the selection, and the zoom and fit keys are ignored in the comments view (`main.ts:1083`, `:1104`). *(added in check)*

**Hover scrubbing without moving the playhead** (`ui/scrub-preview.ts:11-109`). A second, lazily created, muted iframe of the same `srcdoc` (about 200×170 px) seeks to the hovered frame. Requests coalesce: only the latest requested frame is shown (`:26-49`). The main playhead never moves. This needs no thumbnails and no server work. The stage wires it to the progress bar only in review mode (`stage.ts:260-267`; the `reviewMode` guard is at `:261`). *(added in check)*

**On-picture selection.** Item boxes are *measured from the rendered DOM* with `getBoundingClientRect` on `[data-hypit-present-id]`, not recomputed from the layout data. Because of this they include motion offsets (`stage.ts:78-102`; the reasoning is at `ui/overlay.ts:47-58`).
- Click selects the topmost hit.
- Right-click lists every overlapping hit (`stage.ts:111-140`; `overlay.ts:131-142` sorts by z).

**Three-way sync.** One store holds `{snapshot, selection, playhead}`, and each change records its origin: `timeline`, `code`, `video` or `play` (`selection.ts:8-156`). Each pane ignores events that it originated itself, which prevents feedback loops. The links are:
- clicking source text selects the Item that its range produced and seeks to it (`main.ts:1024-1069`);
- selecting an Item outlines its source range (`main.ts:979-1019`);
- the word being spoken at the playhead is highlighted in the script (`main.ts:969-974`, `code.ts:393-413`).

**Timeline** (`ui/timeline.ts`). The timeline is plain DOM rebuilt on each revision or zoom change (`:721-771`, `:815-823`), with a separate minimap zoom strip (`ui/zoom.ts`; the narrowest view is 2 % of the program, `:33`).
- The ruler picks a major tick that is at least 112 px wide (`:415`) and frame subdivisions that are at least 18 px wide (`:435-438`).
- Snapping goes to anchors and item edges within about 6 px (`:190-208`).
- During playback the view auto-scrolls when the playhead passes 88 % of the width (`:777-779`).
- Video items show a storyboard: a server-side ffmpeg atlas with 80 px tiles (`storyboard.ts:104-133`). Sampling is `max(1, min(fps, 360/duration))` (`storyboard.ts:113`), laid out in up to 32 columns. That caps the atlas at about 360 tiles only for videos of 360 s or less. Longer videos are floored at 1 sample/s, so the tile count grows with duration and is not bounded. *(corrected in check)*
- Audio items show a 2,048-column peak waveform decoded in the browser with `decodeAudioData` (`ui/material-preview.ts:101-130`).

**Review mode** (`#comments`). Clicking the picture plays or pauses it, and the progress bar gets hover previews (`stage.ts:260-267`). Comments are stored at seconds precision in `FEEDBACK.json` (`feedback.ts:2-8`). The writes are conflict-checked:
- a mutation must quote the comment as it was before the change (`feedback-store.ts:32-35`);
- writes are serialized through a promise chain (`:59-63`).

Focusing the composer pauses playback and captures the current frame's time (`ui/comments.ts:71,193`).

**Snapshot export.** `hypit snapshot` fetches `/__studio/document` and only the artifacts needed for the requested frames (`snapshot-cli.ts:91-95`). It calls the Runtime's raster provider and writes PNGs and optional labelled grids, staging them in a directory that is atomically renamed (`:111-133`).

### 3.3 Inspector and editing

**Inspector fields** are declared by Companions, never inferred. Each field has:
- a binding path;
- a domain, one of `where`, `when` or `how` (`INSPECTOR.md:3-13`);
- a page and a section;
- a control.

There are seven controls: `text`, `number`, `boolean`, `select`, `color`, `list` and `record` (`INSPECTOR.md:36-44`; the file has 117 lines). *(corrected in check)* The registry rejects a declaration if the binding is unknown, the domain or control is unsupported, the options are repeated, the numeric presentation is invalid or the swatches are not hex (`studio-registry.ts:55-98`).

**Numbers keep their authored units.**
- `parameterNumber` splits off the suffix (for example `78%` or `0.25s`), lets the user edit only the magnitude, and writes the original suffix back (`parameter-values.ts:12-29`).
- `scale` handles conversions such as 0.78 shown as 78 %, and rounds with `toPrecision(15)` to remove float residue (`:9-10`, `:32-41`).
- Validation runs on the *authored* value against the component's public schema (`:47-114`).

**Writes are text patches** (`server.ts:181-238`). Each patch carries:
- a workspace-relative path;
- a byte range;
- the replacement text;
- the expected preimage.

The server applies the following checks before writing:
- every path must be in the current source closure;
- the client's revision must match the server's;
- patches must not overlap;
- the current text in each range must equal the preimage, otherwise the server returns "Source changed outside Studio" with a 409.

Multi-file patches are published atomically through temp files and renames, and files that were already replaced are restored if a later one fails (`source-transaction.ts:19-57`). Each rename is atomic, but the cross-file restore is best effort: a failed restore is swallowed so the original error can propagate (`:45-46`). *(added in check)*

**Commit, recompile, verify, roll back** (`server.ts:412-455`). A mutation is applied, recompiled synchronously and published without notifying the browser.
- For a timeline drag, the server then checks that the rebuilt Item really lands at the requested frames (`:430-442`).
- If compilation failed or the Item landed elsewhere, the original files are restored, the server recompiles again and returns 422 (`:447-451`).
- The UI never draws an optimistic rectangle; it waits for the next snapshot (`ui/timeline.ts:381-385`). Inspector controls also re-render from the last accepted snapshot on failure (`main.ts:759-768`, `1119-1133`).

**Absent attributes can be edited.** If an attribute is missing, its declared fallback is shown, and the first edit inserts `name="…"` after the tag name (`parameters.ts:267-280`). For SVS recipes the property is inserted with matching indentation (`:184-211`).

**Timeline gestures invert through the executed graph.** Edit handles (`move`, `trim-start`, `trim-end`) are derived from each endpoint's "authority" (`parameters.ts:508-618`):

| Authority | Result |
|---|---|
| `fixed` | Read-only |
| `parameter` | Writes that attribute |
| `domain` | Moves a script marker |

`planTemporalInverse` walks the executed producer graph backwards (`temporal-inverse.ts:136-276`). It asks each package's relation companion for inverse plans, branches over the candidates, merges identical write sets, and refuses anything ambiguous with "multiple distinct author inverses" (`:269-270`). Edge grabs use 4-8 px hit zones (`timeline.ts:680-688`) and a 3 px drag threshold (`:324`). Script-anchored drags snap only to real word or segment anchors, and refuse to pick silently between coincident anchors (`temporal-edit.ts:63-139`, `:101`).

**Source pane.** The source pane is a plain `<textarea>` editor over a tokenized, read-only view. It autosaves after 480 ms of inactivity and on Ctrl+S, with a whole-file `PUT` that carries the revision (`ui/code.ts:138-204`).

### 3.4 Talking to the Runtime

Studio opens the Runtime **read-only** (`build-library.ts:256`) and does three things through it (`build-library.ts:174-239`):
1. It reads `activity()` to show live Build progress, which merges with finished Results paged 25 at a time.
2. It uses `openTransientExecution()` to run capabilities that the Runtime allows during authoring.
3. It resolves historical outputs, so that a Run can reuse earlier results with `satisfy` (`run.ts:58-61`).

It never submits a Build. Library views refresh only when the user asks; there is no polling (`README.md:47`).

## 4. Tests

There are 25 files with about 78 `test(...)` declarations; a few are generated in loops. All use `node:test`. Representative assertions:
- **Frame-exact video seek.** Preview frames 0-3 of a clip with source position 7/4 and rate 1/2 land at source frames 1, 2, 2 and 3 (`test/video-preview.test.ts:6-37`). Zero-rate holds never call `play()` (`:39-72`). Reverse rate never assigns a negative `playbackRate` (`:74-106`).
- **Audio envelope parity.** Gains of 0, 0.3 and 2 reach a GainNode, not `volume` (`audio-preview.test.ts:36-42`). Fades and audibility gates are scheduled on the sample clock, and one graph is reused across frames (`:44-60`).
- **Temporal inverse.** Moving a `from/for` window to [15, 30) writes `from=15f` and `for=15f` atomically; a move preserves duration; trim-end changes only `for`; two different candidate writes throw (`temporal-inverse.test.ts:110-229`).
- **Gesture identity.** A drag onto a stop with two distinct anchors returns `undefined` instead of guessing (`semantic-gesture.test.ts:61-65`). `formatTemporalPointEdit` round-trips at 30, 60 and 29.97 fps (`:111-128`).
- **Source safety.**
  - A failed multi-file publish restores every file (`source-transaction.test.ts:6-27`).
  - Watchers follow the closure and catch atomic-rename saves (`source-watch.test.ts`).
  - Cross-origin mutations get a 403 (`mutation-origin.test.ts:16-58`).
  - Stale comment edits throw `FeedbackConflict` (`feedback.test.ts:28-36`).
- **Integration.** A real SVML fixture compiles; unconsumed Instants show on the locator row without changing the Run; and an unresolvable locator does not break the Film view (`unconsumed-instant.test.ts:55-119`).
- **Not tested.** No DOM tests exist for the stage, timeline, inspector or scrub preview. The only UI-folder test is the pure SVML tokenizer (`test/script-syntax.test.ts` imports `src/ui/syntax.ts`). *(corrected in check)* `server.ts`'s commit, verify and rollback loop also has no direct test.

## 5. Quality notes

**Strengths**
- **One picture source.** Preview and final render share one compiled document, so Studio cannot drift from the render (`preview/render.ts:16-22`). This is the most valuable idea in the package.
- **Disciplined write-back.** Edits are revisioned and preimage-checked, applied atomically, then recompiled, verified and rolled back. No edit leaves a half-applied file.
- **Decode-aware seeking.** Resolving only after `seeked`, centring on source frames and correcting drift with hysteresis make frame accuracy real, not approximate. The drift threshold has a written reason.
- **Cheap hover preview.** A second muted iframe gives hover previews with no thumbnail pipeline.
- **Ambiguity is refused, never guessed.** This holds for Companion matching (`studio-registry.ts:344-346`), temporal inverses (`temporal-inverse.ts:269-270`) and anchor choice (`temporal-edit.ts:101`).
- **Local-only mutation guard.** `mutation-origin.ts:4-20` checks loopback host, `Origin` and `Sec-Fetch-Site`.

**Weaknesses, bugs and smells**
- **Dead code.** `server.ts:414-418` throws if `timer !== undefined`, so the `clearTimeout` block at `:419-422` can never run.
- **Untranslated strings in a localized app.** Hard-coded Chinese `disabledReason` strings appear at `parameters.ts:340, 437, 566, 584, 589`, although `LOCALIZATION.md:90-98` says all Studio-owned text goes through the catalog. English text is also hard-coded in the UI (`timeline.ts:623` "item(s)", `timeline.ts:733`, `library.ts:61`).
- **Unbounded caches.**
  - Storyboards are cached forever per resource in a server `Map` (`server.ts:102, 682-686`), and the browser never revokes the object URLs (`material-preview.ts:45`). This is fine for a single-user local tool but leaks in a long-lived process.
  - Material bytes are held fully in memory (`compile.ts:151-166`, `projection.ts:48-63`). These two `bytesOf` helpers are also byte-for-byte duplicates. *(added in check)*
  - The browser-side storyboard and waveform caches (`material-preview.ts:54-60`, `:132-135`) are also unbounded `Map`s. *(added in check)*
- **Unguarded storage.** `localStorage` is not wrapped in try/catch in `ui/resize.ts:35,40`, unlike `theme.ts` and `i18n.ts`, so a blocked storage throws at startup.
- **Full rebuilds.** The timeline rebuilds all DOM on every zoom or pan frame (`timeline.ts:815-823, 840`), with no virtualization. That is fine for short-form content but scales poorly.
- ~~**Unchecked frame list.**~~ *Refuted in check, so this item is removed.* `snapshot-cli.ts` itself checks only ranges (`:76`), but the explicit `--at-frame` list is still bounded before any fetch, Runtime call or staging. `selectHtmlArtifacts` (`:91`) asserts every span lies within `frameCount` (`packages/html-program/src/document.ts:970-982`). `htmlFrameRequest` (`:97`) then requires strictly increasing integers in `[0, frameCount)` (`packages/html-program/src/execution.ts:22-34`). What remains is only that the error message is generic and does not name `--at-frame`.
- **Test fixture uses the wrong attribute.** The shim tests set `data-fps` on the root (`test/video-preview.test.ts:22`, `:57`, `:93`, and also `test/audio-preview.test.ts:21` *(added in check)*), but the shim reads `data-hypit-frame-numerator` and `data-hypit-frame-denominator` and falls back to 30/1 (`packages/html-program/src/playback.ts:16-17`). The tests pass only because 30 is the default, and a non-30 fps regression would go unnoticed.
- **Small race in comments.** `feedback-store.ts:47-49` re-reads and compares before `rename`, but another writer can still slip in between the check and the rename. This is acceptable for one local user.
- **Possible blow-up.** `planTemporalInverse` branches recursively over relation plans (`temporal-inverse.ts:194-263`) with no bound on branches. This is fine with today's few relations but could grow exponentially.

## 6. Relevance to UGCMediaClips: **High**

Our editing loop is "plan, wait one to two minutes for an ffmpeg render, look, edit text, render again" (`clipper/src/components/RenderPanel.tsx:24` "Render started — this takes a minute or two", `:99`; the file has 116 lines). *(corrected in check)* The rest of our UI has the following gaps:

- **`CaptionsView`**
  - The style preview is a CSS stand-in that only approximates libass (`clipper/src/components/CaptionPreview.tsx:19-22`) and is drawn beside the video, not over it (`clipper/src/views/CaptionsView.tsx:233-253`).
  - Transcript lines show their times but are not linked to the `<video>` playhead (`:306-314`).
  - The position and size sliders only commit settings; seeing the result needs a server render (`:279-292`).
- **`FormatsView`.** Beats are drawn as a static bar beside a separate `<video>`. The bar has no click-to-seek and no live highlight (`clipper/src/views/FormatsView.tsx:154-157`, `221-226`).
- **`ClipCard` and `OverlayEditor`.** Overlays are text rows that say "render again to see it" (`clipper/src/components/OverlayEditor.tsx`, the `save` toast). Nothing in the app is previewed in the picture before a render.
- **The OpenReel bridge.** It rebuilds the render in a *different* renderer: the font size is roughly `size*0.8` and the positions are guessed (`clipper/editor/bridge/clip-operator-bridge.tsx:133-188`). It then saves a baked MP4 (`:244-266`). Edits never flow back into the plan, so "rendering again replaces the edit" (`RenderPanel.tsx:99`; the edited MP4 replaces `videoKey` in `clipper/server/app.ts:1248-1280`, and a new render clears `editedAt` in `clipper/server/render.ts:366`). *(corrected in check)* This is the exact two-renderer drift and one-way write that Studio's design avoids.

Our render already separates an expensive phase from a cheap one:
- **Expensive:** voicing and aligning (`clipper/server/render.ts:189-248`), then cutting shots into framed 1080×1920 parts (`render.ts:250-299`). *(corrected in check)*
- **Cheap:** building one ASS file plus emoji stickers plus the audio mix (`render.ts:300-327`, `clipper/server/captions.ts:93`).

The parts are stored (`render.ts:330-364`). This makes Studio's model of one compiled document driving both preview and render reachable for us.

## 7. Better version for us

Our constraints are multi-tenant, CPU-only, cost-sensitive and must work without an agent:

1. **Persist a "composition document" per render.** It would hold:
   - the parts keys;
   - word timings and `captionGroups`;
   - `ctaFrom` and the placed overlays;
   - the sticker positions;
   - the resolved style.

   This is everything `compose()` consumes. Make `buildAss(doc)` and the sticker layout pure functions of that document; `buildAss` already is (`captions.ts:93`).
2. **A browser preview that runs the same libass.** Play the stored parts (already framed, `clipper/server/media.ts:107-128`) and the voice in the browser. Render the *same ASS string* with libass compiled to WASM, for example JASSUB or SubtitlesOctopus (both MIT). Draw emoji stickers as positioned `<img>` elements. Captions, hook, CTA and comment, text and tier overlays would then be pixel-identical to the burn-in, at zero server cost. Restyling becomes instant, with no ffmpeg run and no metering.
3. **Server "recompose" path.** When only the style, overlays, hook or CTA text change, re-run just `compose()` on the stored parts and skip cutting, voicing and alignment. Today any change re-runs the whole pipeline.
4. **Mutations, not baked MP4s.** Map editor actions to plan patches. Moving an overlay's cue word, retiming a caption line, changing the hook or changing the style would each send a `PATCH /clips/:id` with an `expectedRevision`. The server rejects stale writes with a 409 and runs QA again, as `ClipCard` already does. The baked-MP4 path through OpenReel stays as an escape hatch for edits a plan can't express, labelled as a fork.
5. **A frame endpoint for agents and cards.** Add `GET /clips/:id/frame?t=` with ffmpeg `-ss t -frames:v 1` using the same `compose` filter on one frame. This is our version of `hypit snapshot`: it gives MCP and agents visual checks without a full render, at a fraction of a cent on CPU.

## 8. Ideas worth taking (ranked)

1. **Preview and render from one document** (`preview/render.ts:28-61`). For us that means libass-WASM over the stored parts, plus a recompose-only server path. This is the biggest UX and cost win: instant caption, overlay and style feedback with no render meter.
2. **Revisioned, preimage-checked edits with recompile, verify and rollback** (`server.ts:188-238, 412-455`). Apply this to clip-plan edits from `ClipCard`, the editor bridge and MCP `edit_clip`. Concurrent agent and human edits then can't silently overwrite each other, and an edit that fails QA can't leave a broken plan.
3. **Edits come back as plan changes, not pixels** (the whole `StudioMutation` model, `shared.ts:253-280`). Replace "save MP4" for the common edits so that a re-render keeps the user's changes.
4. **Hover-scrub with a second, muted, lazy player** (`ui/scrub-preview.ts`). This is cheap to add to `RenderPanel` and `FormatsView` video and needs no thumbnails.
5. **Timestamped review comments on a clip** (`feedback*.ts`, `ui/comments.ts`). Pausing on a frame and writing "make this caption bigger" would feed the in-app agent or a re-plan, and would also give client approval for agency workspaces. Store them in our DB per clip, with `at` seconds and a `resolved` flag, using the same stale-write check.
6. **Playhead-linked transcript and beats.** Highlight the spoken word or line (`main.ts:969-974`) and click a line to seek, in `CaptionsView` and in the `FormatsView` beat bar.
7. **Frame snapshot endpoint and grid output** (`snapshot-cli.ts`). This gives agents and QA visual evidence cheaply.
8. **Decode-aware seek and drift hysteresis** (`playback.ts:110-124, 169`). Use this if we build our own preview player instead of a bare `<video>`: resolve seeks on `seeked`, and correct drift only beyond about 80 ms.
9. **Storyboard atlas for footage scrubbing** (`storyboard.ts`: one ffmpeg `tile` PNG of about 360 tiles for clips of 360 s or less, and one tile per second beyond that; add a hard cap if we copy it). *(corrected in check)* It is useful on the Footage tab and for choosing shots, and much cheaper than per-frame thumbnails. Cache the atlas in object storage per footage file, not in memory.
10. **Inspector unit discipline** (`parameter-values.ts`). Edit the magnitude but keep the authored unit, show scaled percentages, and validate against the stored value, not the displayed one. This applies directly to the caption size and position sliders.

## 9. Things not to copy

- **The Companion, facet and registry machinery** (`studio-registry.ts`, `parameters.ts` reference chasing, about 1,100 lines). It exists so that third-party packages can extend a generic IDE. Our domain is fixed: shots, voice, captions, overlays and a CTA. A typed clip model plus a hand-written inspector is a fraction of the code.
- **The generic temporal inverse solver** (`temporal-inverse.ts`, `temporal-graph.ts`, `temporal-edit.ts`). Our timing is "overlay on cue words" and "captions from alignment". Retiming means changing a cue word or nudging an offset, which needs a direct field, not graph inversion.
- **Vite dev server as the app server, HMR websocket as the push channel, filesystem watching and `FEEDBACK.json` in the workspace.** All of these assume a single local user. We need DB-backed, tenant-scoped storage and our existing API and SSE.
- **Holding whole media files in memory** to serve previews (`compile.ts:151-166`, `projection.ts:118-126`). On Railway we must stream from object storage with Range, which we already do (`clipper/server/app.ts` `streamKey`).
- **Rebuilding the whole timeline DOM on every zoom** (`timeline.ts:815-823`). If we build a timeline, virtualize it or draw it on a canvas.
- **Origin checks as the only auth** (`mutation-origin.ts`). That is acceptable on loopback but meaningless for a SaaS. We keep our session and API-key auth.

## 10. Coverage

The 25 test files were all read in full. `style.css` was scanned by section, not line by line, because it is presentation only (CSS tokens, layout and tone classes). Everything else was read top to bottom.

| File | Lines | Read |
|---|---:|:---:|
| packages/studio/README.md | 341 | ✅ |
| packages/studio/INSPECTOR.md | 117 | ✅ |
| packages/studio/LOCALIZATION.md | 98 | ✅ |
| packages/studio/package.json | 50 | ✅ |
| packages/studio/index.html | 10 | ✅ |
| packages/studio/locales/en.json | 179 | ✅ (169 messages) |
| packages/studio/locales/zh-CN.json | 176 | ✅ (same 169 IDs, checked by count) |
| src/build-library.ts | 316 | ✅ |
| src/cli.ts | 28 | ✅ |
| src/companion-assembly.ts | 36 | ✅ |
| src/compile.ts | 166 | ✅ |
| src/domain.ts | 139 | ✅ |
| src/execute.ts | 57 | ✅ |
| src/fallback-companions.ts | 98 | ✅ |
| src/feedback-server.ts | 70 | ✅ |
| src/feedback-store.ts | 66 | ✅ |
| src/feedback.ts | 60 | ✅ |
| src/library-media.ts | 19 | ✅ |
| src/localization-node.ts | 46 | ✅ |
| src/localization.ts | 85 | ✅ |
| src/mutation-origin.ts | 20 | ✅ |
| src/observe.ts | 210 | ✅ |
| src/parameter-values.ts | 163 | ✅ |
| src/parameters.ts | 618 | ✅ |
| src/preview/render.ts | 61 | ✅ |
| src/preview/runtime-shim.ts | 1 | ✅ (re-export; the target `packages/html-program/src/playback.ts` was read, lines 1-230) |
| src/projection.ts | 269 | ✅ |
| src/run.ts | 86 | ✅ |
| src/server.ts | 800 | ✅ |
| src/session.ts | 130 | ✅ |
| src/shared.ts | 287 | ✅ |
| src/snapshot-cli.ts | 140 | ✅ |
| src/snapshot.ts | 358 | ✅ |
| src/source-transaction.ts | 57 | ✅ |
| src/source-watch.ts | 53 | ✅ |
| src/start.ts | 177 | ✅ |
| src/storyboard.ts | 133 | ✅ |
| src/studio-preflight.ts | 198 | ✅ |
| src/studio-registry.ts | 516 | ✅ |
| src/studio-trace.ts | 136 | ✅ |
| src/style.css | 1696 | ✅ (scanned by section) |
| src/surface-preview.ts | 35 | ✅ |
| src/temporal-declarations.ts | 79 | ✅ |
| src/temporal-edit.ts | 139 | ✅ |
| src/temporal-graph.ts | 207 | ✅ |
| src/temporal-inverse.ts | 276 | ✅ |
| src/ui/artifact-name.ts | 82 | ✅ |
| src/ui/artifact-preview.ts | 100 | ✅ |
| src/ui/code.ts | 451 | ✅ |
| src/ui/comments.ts | 234 | ✅ |
| src/ui/dropdown.ts | 68 | ✅ |
| src/ui/i18n.ts | 109 | ✅ |
| src/ui/icons.ts | 63 | ✅ |
| src/ui/library.ts | 570 | ✅ |
| src/ui/main.ts | 1143 | ✅ |
| src/ui/markers.ts | 85 | ✅ |
| src/ui/material-preview.ts | 176 | ✅ |
| src/ui/overlay.ts | 149 | ✅ |
| src/ui/resize.ts | 74 | ✅ |
| src/ui/scrub-preview.ts | 110 | ✅ |
| src/ui/selection.ts | 156 | ✅ |
| src/ui/sidebar-panel.ts | 31 | ✅ |
| src/ui/stage.ts | 411 | ✅ |
| src/ui/syntax.ts | 217 | ✅ |
| src/ui/theme.ts | 41 | ✅ |
| src/ui/timeline.ts | 857 | ✅ |
| src/ui/writeback.ts | 10 | ✅ |
| src/ui/zoom.ts | 129 | ✅ |
| test/attribute-groups.test.ts | 43 | ✅ |
| test/audio-preview.test.ts | 60 | ✅ |
| test/build-library.test.ts | 303 | ✅ |
| test/companion-assembly.test.ts | 41 | ✅ |
| test/feedback.test.ts | 54 | ✅ |
| test/localization.test.ts | 55 | ✅ |
| test/material-companions.test.ts | 63 | ✅ |
| test/mutation-origin.test.ts | 85 | ✅ |
| test/parameter-companions.test.ts | 41 | ✅ |
| test/parameter-values.test.ts | 60 | ✅ |
| test/parameters.test.ts | 421 | ✅ |
| test/preflight.test.ts | 50 | ✅ |
| test/provenance.test.ts | 64 | ✅ |
| test/registry.test.ts | 54 | ✅ |
| test/script-syntax.test.ts | 25 | ✅ |
| test/semantic-gesture.test.ts | 128 | ✅ |
| test/snapshot-cli.test.ts | 65 | ✅ |
| test/snapshot-range.test.ts | 86 | ✅ |
| test/source-transaction.test.ts | 27 | ✅ |
| test/source-watch.test.ts | 96 | ✅ |
| test/studio-trace.test.ts | 53 | ✅ |
| test/temporal-graph.test.ts | 152 | ✅ |
| test/temporal-inverse.test.ts | 229 | ✅ |
| test/unconsumed-instant.test.ts | 119 | ✅ |
| test/video-preview.test.ts | 106 | ✅ |

The following UGCMediaClips files were read for the comparison:
- `clipper/src/components/ClipCard.tsx` (234 lines)
- `clipper/src/components/RenderPanel.tsx` (116)
- `clipper/src/components/CaptionPreview.tsx` (62)
- `clipper/src/components/OverlayEditor.tsx` (first 60 of 125)
- `clipper/src/views/CaptionsView.tsx` (331)
- `clipper/src/views/FormatsView.tsx` (305)
- `clipper/editor/bridge/clip-operator-bridge.tsx` (342)
- `clipper/server/app.ts:1195-1260`
- `clipper/server/render.ts:240-370`
- `clipper/server/media.ts:100-132`
- `clipper/server/captions.ts:93-110`

## Check

The second reviewer re-opened every `path:line` citation against hypit `dc2b7a8f` (and `packages/html-program` where the notes cite it), and every "Our app" citation against `clipper` at `8ba4657`.

**Reported bugs and smells**
| Item | Result |
|---|---|
| `server.ts:419-422` dead `clearTimeout` | **Confirmed.** `:414` already throws when `timer !== undefined`. |
| Chinese `disabledReason` strings in `parameters.ts` | **Confirmed** at exactly 340, 437, 566, 584 and 589. These are the only CJK literals in `src/`. The English literals at `timeline.ts:623`, `:733` and `library.ts:61` are also confirmed. |
| Unbounded caches | **Confirmed.** The server storyboard `Map` (`server.ts:102`, `682-686`) evicts an entry only on failure. No `revokeObjectURL` exists anywhere in `src/`. Material bytes are held fully in memory. Extended with the browser caches and the duplicated `bytesOf`. |
| `ui/resize.ts:35,40` unguarded `localStorage` | **Confirmed.** `theme.ts:9-12,32-35` and `i18n.ts:18,60` wrap their calls. `main.ts:94-118` calls `createHandle` at module load, so a throw breaks startup. |
| `--at-frame` bounds | **Refuted, and removed.** The list is bounds- and order-checked downstream, before any side effect (see §5). |
| Shim test `data-fps` vs `data-hypit-frame-numerator` | **Confirmed**, and it also affects `audio-preview.test.ts:21`. |

**Our-app claims.** The `CaptionPreview`, `CaptionsView`, `FormatsView`, `OverlayEditor`, `ClipCard` ("Saved — rules re-checked"), bridge (`size*0.8` at `:180`, guessed positions at `:142-168`, baked MP4 upload at `:244-266`), `media.ts`, `captions.ts:93` and `streamKey` Range claims are all confirmed. Three app citations were wrong. The `RenderPanel.tsx:255-259/:333` lines do not exist (the file has 116 lines); the correct lines are `:24` and `:99`. The `app.ts:1252-1258` citation was the middle of a handler. The expensive render phase was cited only from the cutting step, without voicing.

**Totals.** About 125 claims checked: 113 confirmed, 11 corrected, 1 removed (refuted), 0 left unverified. About 8 additions were made (marked *added in check*).

**Corrections:**
- the header line-count breakdown;
- the `INSPECTOR.md` citation;
- the storyboard bound (two places);
- the UI-test claim;
- the `RenderPanel` citations (two places);
- the `app.ts` citation;
- the `render.ts` phase citation;
- the shim fixture scope;
- the `--at-frame` list (refuted).

**Coverage.** All 93 files under `packages/studio` (61 in `src/`, 25 in `test/`, and 7 docs, locale, manifest and HTML files) are in the table, and every line count matches `wc -l`. No files were added.

**Verdict: Verified with corrections ⚠️.** The correction rate is about 9.6%, just under the 10% line, and the count is an estimate. One of the six headline bugs was false, and several "Our app" line citations pointed at code that does not exist, so this does not qualify as a clean pass. The architecture description, Studio-side citations and recommendations are otherwise accurate.
