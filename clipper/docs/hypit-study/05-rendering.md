# 05 — Rendering

**Batch:** 05 Rendering. **Source:** `hypit-ai/hypit` at commit `dc2b7a8f31b1ef1443a79ca448548d69e3ceb6a0`. Read-only; nothing was built or run.

| Package | Lines (src / test / all files incl. README, package.json) |
|---|---|
| `html-program` | 3,169 / 1,227 / 4,516 |
| `html-document` | 301 / 0 / 393 |
| `html-video` | 211 / 439 / 721 |
| `provider-html-local` | 3,253 / 2,241 / 5,636 |
| `browser-capture` | 431 / 170 / 721 |
| `visual-track` | 3,477 / 749 / 4,410 (+71 lines of preview `.svml/.svs/.svrun`) |
| `composition` | 2,034 / 533 / 2,685 |
| `film` | 652 / 477 / 1,232 |
| `video` | 587 / 373 / 1,097 |
| **Total** | **14,115 / 6,209 / 21,411** |

All paths below are relative to the hypit repo root. Our own files are given as `clipper/...`.

## The pipeline in one picture

```
author markup ─► visual-track / caption / …  ─► VisualTrack (Visual IR v1, composition)
                                                   │
film ─► Composition (canvas + clearColor + peer Tracks)
                                                   │
html-program.compileHtmlProgram ─► HtmlProgram { frameRate, frameCount, canvas, html,
                                                   artifacts+usage spans, surfaces, frameSources }
                                                   │  Need: rasterize-visual / rasterize-frames
provider-html-local ─► stage dir + localhost server ─► N headless Chrome workers
     each frame: applyFrame(n) → swap in FFmpeg-decoded source PNGs → wait images/fonts
                 → CDP Page.captureScreenshot(PNG) → ordered sink → ffmpeg image2pipe → libx264
                                                   │
html-video: compile → rasterize → render audio → mux (audio + mux live in media-operations / media-local, batch 09)
```

The key idea: one self-contained HTML document is a pure function of an **absolute integer frame**. Any Chrome process can open it and seek straight to frame *n* without playing frames 0…n−1. That is what makes parallel, frame-exact capture work.

---

## `@hypit/html-program`

**Purpose.** It compiles a `Composition` plus a `Timeline` into a portable `HtmlProgram`: one HTML string plus typed dependencies. The page exposes a two-method frame ABI. The package never launches a browser (`packages/html-program/README.md:1-30`).

**Public surface.**
- `compileHtmlProgram`, `materializeHtmlProgram`, `selectHtmlArtifacts`, `assertHtmlProgram`, `assertHtmlFrameIndex`, `assertHtmlFrameSpan`, `htmlProgramResourceUri`, `htmlProgramTime` (`packages/html-program/src/index.ts:3`, `src/document.ts:847,1020,1008,866,944,952,181,1033`).
- Execution requests: `htmlRasterRequest`, `verifyHtmlRasterRequest`, `htmlFrameRequest`, `verifyHtmlFrameRequest`, `verifyHtmlFrameImages` (`src/execution.ts:22-63`).
- `htmlVisual()` / `HTML_VISUAL_FORMAT = "hypit.html-visual@1"` is an escape hatch for raw component HTML, CSS and JS (`src/html-visual.ts:5-19`).
- `htmlFrameSelectionPrelude(spans)` (`src/frame-work.ts:137-148`).
- `injectRuntimeShim` from `@hypit/html-program/playback`, for browser preview (`src/playback.ts:225-229`).
- Two capabilities, `rasterize-visual` and `rasterize-frames`, and three producers: compile, request-visual and request-visual-range (`src/manifest.ts:11-19`).
- Page ABI: `window.__hypitFrameProgram.prepare()` and `applyFrame(frame)` (`src/document.ts:757-761`).

**How it works.**
- *Types.* `HtmlProgram` = frame domain + canvas + `artifacts` (each with `usage: always | frames[spans]`) + `surfaces` + `frameSources` + `html` (`src/types.ts:20-56`).
- *Inert resources.* Media URLs are compiled as `hypit-resource://res_…` placeholders (`src/document.ts:181-184`). Compiler-owned media go into `data-hypit-resource-src/href` and are not live `src` attributes (`src/document.ts:186-189`). `materializeHtmlProgram` substitutes real URLs at run time and HTML-escapes them (`src/document.ts:1020-1031`).
- *Exact time.* Seconds are derived with BigInt nanosecond math (`frameSeconds`, `src/document.ts:53-59`). Percent keyframe offsets use 1e-9 precision (`src/document.ts:172-179`). Ids are short stable `hypit-N` tokens, so long track names never become DOM ids (`src/document.ts:211-221`, asserted at `test/document.test.ts:660-725`).
- *Paint order.* Presents are sorted by `z`, then track id, `order` and present id (`src/document.ts:499-507`). Each one becomes an `absolute; inset:0; overflow:hidden` div with a `z-index` equal to its sort index (`src/document.ts:476`).
- *Frame driver.* `applyFrame(frame)`:
  1. validates `0 ≤ frame < frameCount`;
  2. sets `display` on every Present root by its span;
  3. dispatches a `hypit-frame` CustomEvent carrying a `waitUntil(promise)` collector;
  4. awaits the collected promises;
  5. forces layout with `getBoundingClientRect()`.

  `prepare()` awaits `document.fonts.ready` and applies frame 0 (`src/document.ts:735-763`).
- *CSS animation, made seekable.* Keyframes are emitted as real `@keyframes`, but every element starts `animation-play-state:paused`, so page-load wall time can't leak into the first frame (`src/document.ts:264-277`). At run time each animation is read back (`getKeyframes`/`getTiming`) and then cancelled. For each frame, a *transient* `new Animation(new KeyframeEffect(...))` is seeked to `(frame − presentStart) × ms/frame`; the result is read with `getComputedStyle` and written to inline style, and the probe is cancelled (`src/document.ts:648-733`, especially `:702-729`). A frame-span interval tree (`htmlCreateFrameWorkIndex`, `src/frame-work.ts:48-130`) limits this work to animations active at that frame.
- *Video source time.* Each `VisualSourceTimePiece` is split into runs at wrap boundaries by binary search. A hold stays one interval instead of N frames (`src/document.ts:116-154`). Each run becomes its own `<video>` element with `data-hypit-source-frame/rate/start/end` attributes. A typed `frameSources` entry is pushed for the provider, so execution never parses markup (`src/document.ts:378-417`).
- *Render selection.* A prelude defines `__htmlRequestedFrameSpans` (`src/frame-work.ts:137-148`). The capture-scope script then removes every Present that can't be seen in the requested frames: it strips `src/srcset/poster/href` and calls `root.remove()`. It also activates media only in the selected roots, and keeps sampled `<video>` inert because the provider supplies decoded frames instead (`src/capture-scope.ts:5-67`). On the server side, `selectHtmlArtifacts` uses the same spans to decide which bytes to stage (`src/document.ts:1008-1017`).
- *Text.* Terminal text (`text-flow`, `path-text`) is emitted as nested per-paragraph/run/word/grapheme spans (`src/text.ts:522-597`). Shaped text paints (inside or centre stroke, shadow, glow) become shared SVG filters, deduplicated by a paint hash. The comment there records 80 duplicate definitions shrinking to 16 (`src/text.ts:185-230`). An outside stroke is a doubled `-webkit-text-stroke` with `paint-order:stroke fill`, and needs no filter (`src/text.ts:276-291`). A post-layout script handles:
  - ellipsis line clamping;
  - "shrink to fit", a 20-iteration binary search on `transform: scale` with a hard error below `minimumScale` (`src/text.ts:1069-1142`);
  - physical-line detection, for line-unit animations (`src/text.ts:1143-1172`);
  - per-unit WAAPI animations seeked by an exact modulo clock (`src/text.ts:946-957, 1009-1022`).

  It registers `waitUntil(fonts-ready-and-layout)` on every frame event (`src/text.ts:1177-1187`).
- *HtmlVisual.* Component JS runs through `new Function('root','data', setup)`, which must return a **synchronous** `render(localFrame)`. A returned Promise is flagged as an error (`src/html-visual.ts:61-93`). Only active programs, plus spans crossed by a seek, are redrawn (`src/html-visual.ts:94-112`). CSS is wrapped in `@scope (#id)` (`src/document.ts:786`).
- *Background.* `html, body` and the program root are painted `composition.canvas.clearColor` (`src/document.ts:804-805`).
- *Preview shim.* This is an approximate, real-time player and is not frame-exact. `<video>` elements play natively and are re-seeked only when drift exceeds 0.08 s (`src/playback.ts:162-175`). Audio goes through WebAudio gain nodes mirroring the render mixer's envelopes (`src/playback.ts:77-108`).

**Tests.** 28 tests, all without a browser (vm and linkedom).
- Placeholders stay inert (`test/document.test.ts:110-112`).
- `materialize` escapes and does not mutate the document (`:283-293`).
- 29.97 fps math: `frameSeconds(30, 30000, 1001) === "1.001"` (`:305`).
- A fresh worker derives the middle pose without visiting earlier frames, and later Presents keep a Present-relative pose (`:448-488`).
- Holds stay one interval (`:600-658`).
- HtmlVisual: direct seeks, synchronous-only render, setup skipped outside the selection (`:760-859`).
- Capture scope removes unselected Presents and strips their media (`test/capture-scope.test.ts:8-74`).
- Text animations are prepared lazily, once per unit × sequence (`test/text-runtime.test.ts:8-117`).

**Quality notes.**
- Strong: absolute-frame purity is designed in everywhere, not bolted on. Stateless seeks are explicitly tested for reverse order and fresh workers.
- Strong: it is careful about cost. Interval trees, lazy preparation, filter deduplication, and pruning unselected Presents before `DOMContentLoaded` all reduce work.
- Smell: comments still refer to an external engine's adapters that no longer exist, e.g. "HTML renderer' css and waapi adapters" (`src/document.ts:671-674, 711-713`; `src/text.ts:476-478, 1030-1033, 1180`). Frame animation deliberately avoids `Element.animate` to dodge that adapter, yet the text runtime uses `unit.animate(...)` (`src/text.ts:972`). Harmless now, but confusing.
- Smell: `injectRuntimeShim` splices `audioEnvelopeGainAt.toString()` into the page (`src/playback.ts:226`). This breaks if the source is minified or the function gains a closure.
- Risk: `new Function` on author code (`src/html-visual.ts:65`), run in Chrome with `--no-sandbox` (provider, below). It is fine only for trusted, first-party templates.
- `stackIndex` is threaded through `ElementContext` but never read (`src/document.ts:247`).

**Relevance: High.** The frame ABI, the paused-CSS plus transient-probe seeking trick, the inert-resource and selection pruning, and the text shrink-to-fit are exactly what a premium HTML template layer needs.

**Better version for us.** Keep the ABI (`prepare`, `applyFrame(int)`, `waitUntil`) and the "paused CSS + probe" seeking. Drop the Composition/Visual IR generality. Templates would be hand-written HTML/CSS files we own, with a small JSON parameter schema (text, colours, timings). Have a `renderFrame(n)` contract and a `bbox` declaration, so we can capture only the region and frames that matter (see the feasibility section).

---

## `@hypit/provider-html-local`

**Purpose.** This is the local executor for both capabilities. It stages the program on disk and serves it on localhost to independent headless-Chrome processes. Each frame is driven through the page ABI, captured as a PNG over the Chrome DevTools Protocol (CDP), and streamed in order into one libx264 encoder (`packages/provider-html-local/README.md:1-13`).

**Public surface.**
- `createLocalHtmlProvider`, `localHtmlProviderModuleRef`, `rasterizeHtmlProgram`, `rasterizeHtmlFrames`, plus types (`src/index.ts:1-10`).
- The runtime adapter accepts these config keys: `workers`, `maxWorkers`, `quality`, `browserGpu`, `defaultConcurrency`, `browserCapacity`, timeouts and byte budgets (`src/activation.ts:24-27`).
- The managed browser is Chrome Headless Shell `152.0.7928.2`, pinned in `package.json` (`package.json:110-112`, `src/browser.ts:9-19, 51, 79`).

**How it works.**
- *Defaults* (`src/render.ts:39-69`):
  - `workers: "auto"`, `quality: "standard"`, `browserGpu: "hardware"`;
  - `processTimeoutMs` 30 min;
  - `artifactStagingConcurrency` 4;
  - `maxPendingFrameBytes` 256 MiB, `maxDecodedSourceBytes` 1 GiB, `maxRenderedBytes` 16 GiB.
- *Isolation.* The render runs in a child Node process (`src/capture-process.ts:20-27`). An exit hook kills descendants synchronously. It walks the tree with `pgrep -P` and sends SIGKILL to the process group and the pid (`src/capture-exit.ts:7-25`, `src/process-tree.ts:9-88`). Each subprocess gets a minimal env allowlist (PATH, HOME, TMPDIR, LANG, LC_ALL), so host secrets never reach Chrome or ffmpeg (`src/process.ts:46-55`, tested in `test/process-env.test.ts:6-47`).
- *Staging.* Only the artifacts the selection needs are read, up to 4 at once. Exact sizes are checked (`src/stage.ts:66-140`, size at `:117`). Surfaces are validated by ffprobe:
  - exactly one video stream;
  - square pixels, no rotation, progressive;
  - SDR sRGB/BT.709 only;
  - the declared alpha must match the pixel format;
  - frame count and rate must match (`src/surface-validation.ts:91-103, 143-209`).

  The static server blocks path traversal and supports Range requests (`src/server.ts:14-52`).
- *Worker sizing.*
  - `autoWorkerLimit = max(1, min(cpu−2, floor(mem/2/1.5 GiB)))` (`src/concurrency.ts:9-14`).
  - `renderWorkerLimit = min(maxWorkers, ceil(frames/fps))` when auto, so at most one browser per second of footage (`src/concurrency.ts:17-23`).
  - Auto mode starts at `ceil(limit/2)` (`src/concurrency.ts:39-40`).
  - It adds a browser only when the remaining work outweighs twice the startup cost: `remaining/rate > startup × (n+1) × 2` (`:80-87`).
  - It reverts if throughput doesn't improve by at least 5% (`:62-70`), and tries fewer browsers if the rate drops below 70% (`:71-79`).
  - Work is split into roughly 1-second batches, `batchCount = max(limit, ceil(frames/round(fps)))` (`src/capture.ts:46-47`). Workers retire only between batches (`:223`).
- *Browser launch.* `puppeteer.launch`:
  - `headless: true`;
  - viewport = canvas size at `deviceScaleFactor: 1`;
  - `--no-sandbox --disable-dev-shm-usage`;
  - `--disable-gpu` only if `browserGpu === "software"` (`src/capture.ts:187-191`).

  Then: `evaluateOnNewDocument(prelude)` → `goto(localhost)` → `__hypitFrameProgram.prepare()` (`src/capture.ts:199-209`).
- *One frame* (`src/opaque-capture.ts:240-286`) takes three CDP round trips:
  1. `evaluate`: `applyFrame(frame)` and swap the source `<video>` for an `<img>` showing the FFmpeg-decoded PNG of the exact source frame (`:242-271`);
  2. `evaluate`: `__hypitPrepareImages()`, which waits until newly dirty DOM roots have decoded their images, then `document.fonts.ready` (`:273-277`);
  3. `Page.captureScreenshot {format:png, optimizeForSpeed:true, fromSurface:true, clip: canvas}` (`:279-283`).

  Readiness tracking is incremental. A MutationObserver and patched CSSOM methods mark dirty roots. Only resource-bearing inline style changes count, so ordinary per-frame opacity or transform writes are free (`:68-227`, measured in `test/visual-readiness.test.ts:70-102`).
- *Opaque by design.* `Emulation.setDefaultBackgroundColorOverride {r:0,g:0,b:0,a:1}` with the comment "MP4 has no alpha channel" (`src/opaque-capture.ts:19-20`). The output check also *requires* exactly one H.264 stream (`src/output.ts:63-66`). **There is no alpha output path.**
- *Source video.* ffprobe reads dimensions, codec, VFR and HDR transfer (`src/source-frame-decoder.ts:18-36`).
  - Bounded windows of 16 frames (`src/source-frame-store.ts:7`) are decoded to PNG via `image2pipe` at `-compression_level 1`.
  - Alpha codecs vp8/vp9/prores force the matching decoder, so alpha survives (`src/source-frame-decoder.ts:8, 116`).
  - HDR is only handled on macOS, via videotoolbox (`:111-120`).
  - A streaming PNG parser splits the pipe on IEND (`:39-90`).
  - Decoded frames sit in a byte-budgeted, LRU, lease-counted store shared by all workers. One oversized frame may overflow it so the render can't deadlock (`src/source-frame-store.ts:187-213`).
- *Ordering.* `OrderedFrameSink` admits out-of-order PNGs up to 256 MiB. The frontier frame always passes, and one oversized frame is allowed when the set is empty (`src/ordered-frame-sink.ts:46-71`).
- *Encode* (`src/capture.ts:143-152`):
  ```
  ffmpeg -f image2pipe -framerate N/D -vcodec png -i pipe:0 -frames:v <n> -an -c:v libx264
    -crf {draft 28 | standard 23 | high 18} -preset {veryfast for draft, else medium}
    -vf scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,
        setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
    -movflags +faststart
  ```
  Afterwards, ffprobe `-count_frames` verifies codec, size, rate and *exact* frame count (`src/output.ts:39-72`).
- *Sparse frames.* With `frames:[…]`, PNGs are written to disk and stored individually. There is no encoding (`src/capture.ts:248-257`, `src/render.ts:168-174`).

**Tests.** 66 top-level tests. About 11 need `HYPIT_BROWSER_TESTS=1` with a real Chrome (`test/alpha.test.ts:17-19`, `test/range.test.ts:130-132`, `test/visual-readiness.test.ts:18`, and others).
- A transparent WebM over a blue clear colour composites to the right pixels within ±14 (`test/alpha.test.ts:57-82`).
- Wrap, hold and ½-rate sampling across 1, 3 and 4 independent browsers give identical frames (`test/range.test.ts:161-178`).
- An abrupt worker exit kills its own Chrome but not another browser (`test/capture-process.test.ts:32-64`).
- The auto-scaler grows from 2 to 3, then retires back to 2 (`test/concurrency.test.ts:17-30`).
- The ordered sink can't deadlock (`test/ordered-frame-sink.test.ts:9-61`).
- Caption cues stay isolated across reverse seeks (`test/visual-readiness.test.ts:253-363`).

**Quality notes.**
- Excellent: process hygiene (tree kill, pipe grace, env allowlist) and bounded memory everywhere.
- Excellent: it verifies the encoded output against the expected frame count.
- Excellent: explicit BT.709 conversion and tagging. Our pipeline doesn't do this; see the comparison below.
- Weakness: per frame there are three PNG codec passes:
  1. FFmpeg PNG-encodes each source frame (`-compression_level 1`);
  2. Chrome decodes it, then PNG-encodes the screenshot;
  3. ffmpeg decodes that PNG before x264.

  Plus three CDP round trips. On CPU this is the dominant cost.
- Bug-ish: `browserGpu: "auto"` is accepted (`src/options.ts:3`, `src/render.ts:46`) but behaves exactly like `"hardware"`. Only `"software"` adds `--disable-gpu` (`src/capture.ts:190`). Also, the default is `"hardware"` even on GPU-less Linux.
- A single-frame decode uses output seeking (`-i path -ss t`, `src/source-frame-decoder.ts:117`). That is exact but slow on long sources.
- Test smell: the readiness tests' fake `applyFrame(time)` treats integer frames as seconds (`time >= 1/30`, `currentTime = time * 1000`), and passes only because of `fill:both` (`test/visual-readiness.test.ts:118-119, 144`).
- HDR footage on Linux gets no tone-mapping (`src/source-frame-decoder.ts:111-121`), which matters for iPhone UGC.

**Relevance: High** (mechanics). This is the most directly reusable code in the batch: the CDP capture loop, ordered sink, process-tree kill and auto worker scaling.

**Better version for us.**
- Make an **alpha variant** of `createOpaqueFrameCapture`: background override `a:0`, transparent `html/body`, and a screenshot `clip` set to the template's bounding box.
- Feed the PNGs straight into our *existing* compose ffmpeg as an extra overlay input. Don't encode an intermediate H.264.
- Skip source-video decoding in Chrome entirely: we composite footage in ffmpeg, so the browser only ever paints overlays.
- Set `--disable-gpu` and pin a Chrome version in the Docker image.

---

## `@hypit/html-video`

**Purpose.** The author-facing `<html:Video>` element. It wires four separate Needs into one graph: compile HtmlProgram → rasterize visual → plan and render audio → mux → final Blob (`packages/html-video/README.md:1-24`).

**Public surface.** `htmlVideoFragment`, `createHtmlVideoFragment(selectedRange)`, `decodeHtmlVideoSurface`, manifest (`src/index.ts:1-3`). Attributes: `id`, `composition`, `timeline`, and optional `start-frame` / `end-frame-exclusive` (`src/manifest.ts:21-30`).

**How it works.**
- The fragment has six operations: compile, request-visual (or its range variant), plan-audio, render-audio (or its range variant), mux, project-muxed (`src/fragment.ts:13-66`).
- A range is admitted as a `MediaFrameRange` record and fed to both the visual and audio Needs (`src/surface.ts:40-58`).
- It owns no execution; providers satisfy each Need.

**Tests.** 6 tests.
- The plan contains exactly the six producers (`test/render.test.ts:148-167`).
- Stub endpoints complete one render (`:169-251`).
- A visual product with frameCount + 1 is rejected at the mux join, with "different presentation durations" (`:253-300`).
- The range flows into both Needs (`:398-419`).
- A render request's summary exposes size, range and fps but not the HTML (`test/presentation.test.ts:5-20`).

**Quality notes.** Clean, and the frame-domain check at the join is a good safety net. It is thin.

**Relevance: Medium.** The idea of rendering visual and audio as separate products and joining them with an exact frame-count check is worth copying. The graph machinery is not.

**Better version.** In `render.ts`, assert ffprobe's frame count and duration on every intermediate before the final compose, as hypit's `verifyOutput` does.

---

## `@hypit/html-document`

**Purpose.** It produces a self-contained, playable HTML preview page (picture + `<audio>` + driver) for iframes (`packages/html-document/README.md:1-71`).

**Public surface.** `compileHtmlDocument`, `assertHtmlDocument`, `materializeHtmlDocument(doc, resolve, {autoplay, loop, muted, responsive})`, `htmlDocumentFragment`, `<page:Document>` (`src/index.ts:1-6`, `src/manifest.ts:27-40`).

**How it works.**
- It compiles the HtmlProgram plus the media-operations audio plan, and checks they share a frame clock (`src/document.ts:24-53`).
- Resource ids are rebound through `bindings`, so result storage can re-address blobs (`:30-45`).
- The driver strips all scripts with linkedom and re-runs them inside one `load` handler after `fonts.ready` and a rAF (`:80-86, 146-151`).
- Playback: rAF with `frame = floor(elapsed × fps)`, looping or clamped (`:105-123`).
- A `postMessage` command API (play, pause, seek, mute, state) accepts messages only from `window.parent` (`:134-145`). It reports state at most 10 times per second (`:92-98`).

**Tests.** None in this package.

**Quality notes.**
- `postMessage(…, '*')` broadcasts state and errors to any parent origin (`src/document.ts:97, 144`). Low risk, since only frame and playing state are sent, but it should target a known origin.
- Re-running every script inside one async handler changes their execution order relative to parsing. Its correctness isn't tested.

**Relevance: Low–Medium.** It could give template *previews* in our UI (the same HTML the renderer captures, played live), which is a nice "what you see is what renders" story.

**Better version.** Preview templates in an iframe with a tiny `seek(frame)` driver and an origin-checked `postMessage`, reusing the exact page the renderer captures.

---

## `@hypit/browser-capture`

**Purpose.** Screenshot or record websites and authored HTML as project *material*: `hypit capture screenshot | run | install-browser`. It is not the frame-exact renderer (`packages/browser-capture/README.md:1-92`).

**Public surface.** `withCapture(options, task, onOutput)`, `captureBrowserExecutablePath`, `installCaptureBrowser`, `cliCommandModules` (`src/index.ts:12, 89-194`; `src/cli.ts:191-204`). The browser is pinned to Chrome for Testing `153.0.8010.12` (`package.json:23-27`).

**How it works.**
- `screenshot` reserves the destination with `open(path,"wx")`, so it never overwrites, then calls Puppeteer `screenshot` or element `screenshot`. Dimensions are read back with sharp (`src/index.ts:65-74, 122-146`).
- `record` uses Chrome 153+'s native `Page.record`, a **real-time** MP4 recording with maxWidth/maxHeight set to the viewport in device pixels (`src/index.ts:147-186`).
- `--transparent` sets `omitBackground` (`src/cli.ts:146`).

**Tests.** 6 tests, 5 needing Chrome.
- Transparent PNG pixel alpha = 0 (`test/capture.test.ts:54-55`).
- 2× device-scale dimensions (`:51`).
- Recording duration is only asserted to lie in (0, 3) s, because "a loaded machine recorded 0.29 s of a 0.65 s wait" (`:77-80`).

**Quality notes.** Honest about real-time recording being unreliable under load. That is exactly why the frame-exact path exists.

**Relevance: Low.** This is not our template path. One idea is useful for brief/landing-page b-roll: screenshot a campaign's product page into the clip.

**Better version.** If we ever need "product page" b-roll, use a full-page screenshot plus an ffmpeg Ken-Burns scroll, not real-time recording.

---

## `@hypit/visual-track`

**Purpose.** The plain picture-placement author package. A *Clip* = one source (image, normalized media, or typed alpha Surface) + an absolute Window + a Frame rectangle + z + spatial map + source-time + optional treatment + optional affine Motion. It lowers to the terminal `VisualTrack` (`packages/visual-track/README.md:1-139`).

**Public surface.**
- `<visual:Track>` with `<visual:Clip>` children, plus `<visual:Motion>` / `<visual:Pose>`, `<visual:SourceTime>` / `<visual:Map>` and `<visual:Sampling>` (`src/manifest.ts:253-393`).
- Programmatic builders: `appendStillMediaLayer`, `appendTimedMediaLayer`, `appendSurfaceMediaLayer` and their mapped variants; `appendVisualClip`, `finalizeVisualTrack`, `projectVisualTrack`, `resolveVisualSourceTime`, `poseAnimation` (`src/index.ts:1-45`).
- A Studio companion (`src/studio.ts:175-208`).

**How it works.**
- *Fixed wrapper stack per clip* (`src/lower.ts:298-347`): `placement` (absolute Frame px) → `pose` (Motion animation, constant origin) → `frame` (clip, radius, border, shadow, `clip-path: path()`, made relative to the Frame origin, `:60-72`) → for each layer: `sampling` (Ken-Burns transform) → `appearance` (CSS filter, opacity) → `mapping` (`matrix(xx,yx,xy,yy,tx,ty)`) → media element.
- *Blur overscan.* The source is enlarged by `ceil(2 × blur / minScale)` px and clipped back to its mapped outline, so a blur never fades its own edge (`src/lower.ts:195-210`). This is the "blurred fill" look done properly.
- *Fit.* Fit resolves once against the Frame inset (border + padding) to an explicit `SpatialMap2D` (`src/spatial.ts:27-51`, `src/frame-treatment.ts:42-55`). Tests pin `contain 800² into 380×280 → scale 0.345, tx 162, ty 212` (`test/visual-track.test.ts:233`).
- *Source time.* Symbolic relations (rate, anchors, wrap, fit) resolve to exact rational pieces by binary search over valid target frames (`src/source-time.ts:116-152, 207-241`). Sources **must already be normalized to the Timeline frame rate** (`src/source-time.ts:220-222`).
- *Motion.* Poses carry `translate`, `rotate`, `scale` and `opacity` keyframes at start/end±Nf/percent, and must cover the whole clip clock exactly (`src/motion.ts:79-122`). Easing is limited to `linear` and `ease-in`, `ease-out`, `ease-in-out` (`:64-66`).

**Tests.** 18 + 1 studio test. Highlights:
- Clip paths are translated into Frame-local coordinates: `M 0 0 L 400 0 L 360 300 L 40 300 Z` (`test/visual-track.test.ts:273`).
- Self-blur shares one resource across two samples, with 103 px overscan for a 24 px blur (`:320-321`).
- A hold is kept as `rate 0/1` (`:377`).
- Exact reverse, end-aligned, wrap and fit source-time resolution.
- The audio member of synchronized media is never emitted.

**Quality notes.**
- Good: rigorous separation of "where" (Frame/map), "when" (Window/source-time) and "how" (treatment).
- Smell: a duplicate JSDoc block (`src/author.ts:144-145`).
- Smell: an unused `Timeline` type import (`src/manifest.ts:3`).
- The preview's `during={speech.window}` refers to a Window declared with `id="showcase"` (`preview/preview.svml:35, 46`). Unverified whether that resolves; the CLI test only plans it (`packages/video/test/cli.test.ts:53-74`).

**Relevance: Medium.** The blur-overscan trick and the wrapper-stack discipline (pose ≠ sampling ≠ mapping) apply directly to our blurred-fill framing and to any future "zoom/punch-in" feature. The authoring layer itself is not relevant.

**Better version.**
- In `cutSegment` our blur is a full-frame `gblur` on a scaled copy (`clipper/server/media.ts:111`). That is already cheap and fine. Keep it in ffmpeg.
- Adopt the *concept*: separate "pose" (punch-in zooms, keyframed on the composite) from "sampling" (crop inside the shot), so an AI-chosen zoom never fights the framing math.

---

## `@hypit/composition`

**Purpose.** It owns the terminal value types: `VisualTrack` (Presents with rooted element trees), `AudioTrack` (48 kHz sample-exact clips) and `Composition` (canvas + clearColor + tracks). It also owns the **closed CSS vocabulary `hypit.visual-ir@1`** (`packages/composition/README.md:1-82`).

**Public surface.**
- `sealVisualTrack`, `sealAudioTrack`, `sealComposition` and the matching `assert*Identity` functions (`src/track.ts:1294-1456`).
- `VISUAL_IR_V1`, `VISUAL_STYLE_NAMES_V1`, `VISUAL_STYLE_ENUM_VALUES_V1`, `assertVisualStyleV1` (`src/visual.ts:2-222`).
- `animatableLocalStyles`, `audioEnvelopeGainAt`, schemas, `visualCompositionVocabulary` (`src/index.ts:1-29`).

**How it works.**
- *Element kinds:* box, mask, text, text-flow, path-text, image, video, surface, program (`src/track.ts:362`).
- *Closed CSS.* About 140 allowlisted property names (`src/visual.ts:12-155`), including `mix-blend-mode`, `isolation`, `backdrop-filter` and `filter`. Enum-checked values for display, position and so on (`:161-177`). Rejected outright: `url()`, `image-set()`, `;{}`, `!important`, control characters, and `var()`, `env()`, `attr()` (`:184-222`).
- *Attributes* are allowlisted to `data-*`, `aria-*`, `role`, `title`, `lang`, `dir` (`src/track.ts:577-594`).
- *Animatable local styles* are only `backdrop-filter`, `clip-path`, `filter`, `opacity`, `transform` (`src/track.ts:448-454`). Text units may also animate colours (`:457-465`).
- *Structure invariants:* exactly one root; parents must be box, mask or program; no cycles; mask roots are terminal (`src/track.ts:1093-1123`). Video or surface elements can't also carry an animation, which must live on a wrapper (`:999-1001, 1069-1072`).
- *Audio.* Clips are `audio/wav` only, with rational source maps that must land on exact sample boundaries (`src/track.ts:1379-1416`). Gain ≤ 64, envelopes and audibility masks (`src/audio-level-automation.ts:11-44`).
- `clearColor` accepts `#RRGGBBAA` (`src/track.ts:1442`). Capture still forces an opaque black background, so a transparent clear colour has no effect at the renderer.

**Tests.** 15 tests.
- A smuggled `red;backdrop-filter:…` is rejected (`test/track.test.ts:122-140`).
- `mask-image` is outside v1, `position:fixed` and `var(--x)` are rejected (`:142-181`).
- Straight alpha requires a WebM/MOV-type surface, not MP4 (`test/render.test.ts:62-78`).
- Mask ownership rules (`test/render.test.ts:157-215`).

**Quality notes.** Very good defensive design for machine-generated visuals. `seal*` only normalizes, though; validation is a separate call, and callers must remember both.

**Relevance: High** if an AI or agent ever fills premium templates. A closed, versioned style allowlist with "no url(), no var(), no declaration escape" is exactly how to let an LLM customise a template safely across tenants.

**Better version.** For our template parameters, allowlist *values*, not CSS: colour = hex, font = one of the brand-kit fonts, size = a bounded number, text = plain string set via `textContent`. Reuse hypit's rejection regexes for any free-form colour string.

---

## `@hypit/film`

**Purpose.** The assembly element `<film:Film canvas timeline appearance>` with `<film:Track source>` children. It folds any number of tracks into one Composition (`packages/film/README.md:1-54`).

**How it works.**
- An immutable `FilmTrackSet` fold: create, then append (visual or audio) × N, then compile (`src/fragment.ts:32-83`, `src/program.ts:60-110`).
- Its Recipe accepts exactly `background: #rrggbb[aa]` (`src/recipe.ts:11-25`).
- Duplicate track references are rejected at check time, including aliases of the same component output (`src/surface.ts:110-120`).

**Tests.** 7 tests. Film stops at Composition, and HTML compiling is a separate fragment (`test/film.test.ts:188-199`). Duplicate ids and aliases are rejected (`test/surface.test.ts:184-223`).

**Quality notes.** Each append re-validates the whole set (`src/program.ts:67-79`), which is O(n²) in tracks. That is fine at n < 20.

**Relevance: Low.** It is graph plumbing for their DSL.

---

## `@hypit/video`

**Purpose.** The product assembly: compiler host, workspace, source-package discovery, the `hypit vocabulary` CLI, and the **starter runtime profile** (`packages/video/README.md:1-65`).

**How it works.**
- The starter profile wires `html.local → @hypit/provider-html-local` with **no config**, which means `workers:auto` and `browserGpu:"hardware"` (`src/distribution.ts:44-72`).
- `vocabulary` prints the installed manifests and the Visual IR schema, so an agent can discover what it may write (`src/vocabulary.ts:213-231, 299-355`).

**Tests.** 10 tests.
- Discovery selects exactly the imported packages (`test/cli.test.ts:27-51`).
- The visual-track preview plans without any provider (`:53-74`).
- Pricing lists all 25 generation requests (`:114-164`).
- Vocabulary listings (`test/vocabulary.test.ts:28-143`).

**Relevance: Low.** The "vocabulary" introspection is a good pattern for our MCP server: expose template schemas as a tool so agents don't guess.

---

## Comparison with our ASS + ffmpeg pipeline

| Aspect | UGCMediaClips today | hypit |
|---|---|---|
| Graphics engine | libass inside one ffmpeg pass: `[0:v]ass=…[sub]` then a chain of PNG sticker overlays (`clipper/server/media.ts:155-171`, `clipper/server/overlays.ts:289-310`) | Chrome renders every pixel, footage included. ffmpeg only decodes sources and encodes the result (`provider-html-local/src/capture.ts:144-152`) |
| Time base | ASS centiseconds (`clipper/server/captions.ts:211-217`). libass samples per output frame. Good to about 10 ms. | Integer frames, rational fps, BigInt math (`html-program/src/document.ts:53-59`) |
| Motion vocabulary | ASS `\move`, `\t(\fscx…)`, `\fad`, `\frz`, vector `\p1` rounded rects (`clipper/server/overlays.ts:70-85, 162-178`); ffmpeg overlay with an expression bounce (`:305`) | Full CSS: transforms, filters, `backdrop-filter`, `mix-blend-mode`, SVG masks, gradients, per-grapheme staggered WAAPI, path text, shrink-to-fit |
| What it can't do | Gradients on text or shapes; real box/backdrop blur; masks; colour emoji in text (worked around with PNGs, `clipper/server/overlays.ts:10-11`); flexbox layout and auto-fit; Lottie-style motion | Alpha output (it is opaque by design, `opaque-capture.ts:19-20`) |
| Encode | `libx264 -preset veryfast -crf 21 -pix_fmt yuv420p +faststart` (`clipper/server/media.ts:167`); cuts at `veryfast -crf 20` (`:124`) | `libx264 -crf 23` (standard) or 18 (high), `-preset medium`, explicit BT.709 conversion and tags (`capture.ts:143-150`) |
| Colour | Untagged. Overlays are RGBA PNGs converted by ffmpeg's default matrix (`clipper/server/media.ts:113, 167`). | Explicit `out_color_matrix=bt709:out_range=tv` plus `setparams` tags |
| Cost per 30 s clip on 1.6 vCPU | One ffmpeg filter pass; libass is cheap. | ≥ 900 full-frame Chrome screenshots + PNG round trips. No benchmark exists in the repo; my estimate is minutes on one CPU worker. |
| Parallelism | `RENDER_CONCURRENCY` renders, about 1.6 vCPU and 2 GB each (`clipper/README.md:228`, `clipper/server/render.ts:39`) | 1…N browsers inside one render. `autoWorkerLimit` gives **1** browser on a 2 GB container: `floor(2/2/1.5)=0 → max(1,…)` (`concurrency.ts:12-13`) |
| Verification | Exit code only | ffprobe exact frame count, size, rate and codec (`output.ts:39-72`) |

Takeaway: for 1080×1920 UGC with burned captions, our ASS path is the right default. It is about an order of magnitude cheaper (inference, not measured) and already frame-accurate enough. hypit's strength is *rich motion graphics*, and it pays for that with a browser per pixel. A hybrid keeps ffmpeg as the compositor and uses Chrome only for the premium overlay pixels.

**A likely colour bug on our side, worth checking.** Our RGBA PNG stickers are overlaid onto yuv420p and the output carries no colour tags (`clipper/server/media.ts:159-170`). By default swscale converts RGB to YUV with BT.601 coefficients, while players assume BT.709 for untagged HD. Brand colours in stickers, and in any future PNG overlay layer, may shift slightly. Verify with a solid-colour sticker. The fix is hypit's filter tail: `scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=…bt709…`.

---

## Feasibility: a pre-rendered alpha overlay layer for premium templates on CPU-only Railway

**Short answer: feasible for short, region-bounded overlays (a 1–4 s lower-third, title card, CTA, stinger), rendered sparsely and cached. Not feasible for full-frame, full-duration HTML per render at our current 1.6 vCPU / 2 GB budget without a benchmark proving otherwise.** hypit gives us most of the mechanics but no alpha path, so we would add one.

### What to take from hypit
1. **The page ABI and seeking rules.** `prepare()`, `applyFrame(int)`, `waitUntil`, CSS animations paused at load and seeked by transient probe (`html-program/src/document.ts:264-277, 702-763`).
2. **The capture loop.** Per frame: `applyFrame` → wait for images and fonts → `Page.captureScreenshot` (`provider-html-local/src/opaque-capture.ts:240-286`). Plus the readiness tracker, `OrderedFrameSink`, the process-tree kill, and the env allowlist.
3. **The selection idea.** Render only the frames a template is visible (`rasterize-frames` with sparse frames, and the Present pruning in `capture-scope.ts`).

### What to change for alpha
- `Emulation.setDefaultBackgroundColorOverride({color:{r:0,g:0,b:0,a:0}})` instead of `a:1` (`opaque-capture.ts:20`), plus `html,body{background:transparent}`. Chrome screenshots keep alpha when the page and default background are transparent; browser-capture's `omitBackground` test confirms pixel alpha = 0 (`browser-capture/test/capture.test.ts:54-55`).
- **Clip the screenshot to the template's bounding box** (the CDP `clip` is already passed, `opaque-capture.ts:282`). PNG encode and decode cost scales with area: a 1080×400 lower-third is about 21% of a full frame.
- **Don't encode an intermediate H.264.** Write `overlay_%05d.png` (or pipe it) and add it to our *existing* final compose as one more input, e.g. `-framerate 30 -i overlay_%05d.png` with `-itsoffset <start>`, then `overlay=x:y:eof_action=pass`. That is the same pattern `stickerGraph` already uses for PNG emoji (`clipper/server/overlays.ts:289-310`). If an overlay must be cached across renders, store it as **VP9-alpha WebM** (`-c:v libvpx-vp9 -pix_fmt yuva420p`) or **qtrle/ProRes 4444 MOV**. hypit's decoder already treats vp8, vp9 and prores as alpha codecs (`source-frame-decoder.ts:8`), and its surface validator checks that declared alpha matches the bytes (`surface-validation.ts:189-197`).
- **Cache across tenants by `hash(templateId, params, fps, size)`.** Stingers, "follow for more" cards and logo bumpers rarely change per clip. After the first render they cost nothing.
- Add `--disable-gpu`. hypit's default `"hardware"` doesn't (`capture.ts:190`, `render.ts:45`). Also pin a Chrome Headless Shell version in the Dockerfile, as hypit pins `152.0.7928.2` (`provider-html-local/package.json:110-112`).

### Budget (estimates, to be benchmarked; not measured in either repo)
- **Per-frame cost on CPU** is three CDP round trips + raster + PNG encode (`optimizeForSpeed`) + PNG decode in ffmpeg. For a small region with simple CSS (transforms, opacity, text), expect roughly tens of milliseconds per frame on one software Chrome. Full-frame 1080×1920 with blur or `backdrop-filter` is much slower.
- **Lower-third, 3 s at 30 fps** = 90 frames at about 1080×400. Likely ≤ 10–15 s added to a render, plus about 1–2 s Chrome startup (hypit measures `startupMs` per worker, `capture.ts:211-212`). Acceptable for a paid tier.
- **Full overlay for a whole 30 s clip** = 900 full frames. Likely minutes on one browser, and hypit's own auto-sizing allows only one browser in 2 GB. Not acceptable inline. Push it to a separate queue or a bigger instance, or avoid it.
- **Memory.** One headless Chrome is likely a few hundred MB RSS. It fits next to ffmpeg inside the 2 GB per-render budget only if renders are 1 per instance. hypit plans for 1.5 GiB per browser (`concurrency.ts:12`).
- **Image size.** Chrome Headless Shell plus its shared libraries adds an estimated 150–300 MB to the Docker image.

### Risks and guardrails
- **Trust.** hypit runs Chrome with `--no-sandbox` (`capture.ts:189`) and component JS through `new Function` (`html-visual.ts:65`). That is acceptable only because templates are first-party. User strings must go in via `textContent` or escaped attributes, never as HTML. Validate parameter values with hypit-style allowlists (`composition/src/visual.ts:184-222`, `track.ts:616-623`).
- **Network.** Serve staged files from `127.0.0.1` only, as hypit does (`server.ts:43-44`). Block every other request with request interception. Fonts must be local (`font-display:block`, as hypit does at `document.ts:631`), so first-frame text never falls back.
- **Process leaks.** Copy the tree-kill on abort and timeout (`process-tree.ts`, `capture-exit.ts`). A leaked Chrome on a 2 GB container will OOM the next render.
- **Exactness.** Verify the PNG count equals the frames in the span before compose, as `verifyOutput` does for MP4 frame counts.

### Recommended first step (one day)
Benchmark on the Railway image. Render a 3 s 1080×400 transparent lower-third (CSS slide plus a text stagger) to PNGs with one headless Chrome (`--disable-gpu`, using hypit's capture loop with the alpha changes above). Overlay it in `compose`. Measure wall time, peak RSS and image size growth. Ship to a premium tier only if the extra time is ≤ 20% of the current render (about a minute, `clipper/README.md:22-26`).

---

## Ideas worth taking (ranked)

1. **The frame ABI and stateless seeking** (`applyFrame(int)`, paused CSS, transient `Animation` probe, `waitUntil`). This one design choice makes HTML deterministic, parallel and resumable (`html-program/src/document.ts:264-277, 702-763`).
2. **The CDP capture loop and readiness wait.** Wait for images and fonts, then `captureScreenshot` with `clip`, adapted for alpha and bounding boxes (`provider-html-local/src/opaque-capture.ts:17-287`).
3. **Explicit BT.709 conversion and tagging on our final encode**, and especially wherever RGBA overlays are composited (`capture.ts:148-149`). Cheap, and likely fixes a real colour shift.
4. **Output verification.** ffprobe frame count, size and fps after every render step (`output.ts:39-72`), and the exact-length join check from html-video (`html-video/test/render.test.ts:253-300`).
5. **Sparse and region rendering.** Render only frames and areas where an overlay is visible (`requestedFrameRanges`, capture scope, artifact usage spans). This is what makes the cost acceptable.
6. **Closed style and parameter allowlists** for AI-filled templates (`composition/src/visual.ts:12-222`, `track.ts:577-623`).
7. **Process hygiene:** env allowlist (`process.ts:46-55`), tree kill (`process-tree.ts`), bounded stderr (`process.ts:137-143`). Our `run()` already keeps the last 8 KB of stderr and SIGKILLs on timeout (`clipper/server/media.ts:45-63`), but doesn't strip env or kill grandchildren.
8. **Text shrink-to-fit by binary search over scale**, with a hard floor and an error (`text.ts:1069-1142`). We can do this server-side for ASS by measuring with fontkit or canvas, and stop truncating at 27 characters per line (`clipper/server/overlays.ts:88-104, 152`).
9. **Blur overscan** for blurred backgrounds (`visual-track/src/lower.ts:195-210`), if we ever blur a sub-region instead of the whole frame.
10. **A template preview iframe** driven by the same HTML (`html-document`), with an origin-checked `postMessage`.

## Things not to copy

- **Chrome as the compositor for footage.** hypit decodes every source frame to PNG and paints it in the browser (`opaque-capture.ts:249-270`, `source-frame-decoder.ts:124-125`). On CPU that is 3 PNG codec passes per frame for pixels ffmpeg composites natively. Keep footage in ffmpeg.
- **The opaque, MP4-only output contract** (`opaque-capture.ts:19-20`, `output.ts:63-66`). For overlays we need alpha.
- **Default `browserGpu: "hardware"`** and the no-op `"auto"` (`render.ts:45`, `capture.ts:190`). Be explicit on GPU-less hosts.
- **`new Function` author code plus `--no-sandbox`** for anything tenant-supplied (`html-visual.ts:65`, `capture.ts:189`).
- **The Visual IR / Film / Composition DSL machinery** (seal/fold/fragment layers). It is heavy generality for a single-product SaaS. Its value is the invariants, not the graph.
- **The real-time `Page.record` path** for anything that must be frame-exact (`browser-capture/src/index.ts:157`; its own test admits timing drift under load, `test/capture.test.ts:77-80`).
- **`Function.prototype.toString` injection** into pages (`playback.ts:226`).
- **`postMessage(…, "*")`** for state (`html-document/src/document.ts:97, 144`).

---

## Coverage

Every source, test, README and package file in the batch was read top to bottom. Exceptions: the three preview PNGs (binary), and a handful of single lines over 200 characters (schema and producer declarations), which were read truncated where noted.

| File | Lines | Read |
|---|---|---|
| `packages/html-program/README.md` | 77 | ✅ |
| `packages/html-program/package.json` | 43 | ✅ |
| `packages/html-program/src/activation.ts` | 10 | ✅ |
| `packages/html-program/src/capture-scope.ts` | 67 | ✅ |
| `packages/html-program/src/component.ts` | 62 | ✅ |
| `packages/html-program/src/document.ts` | 1033 | ✅ |
| `packages/html-program/src/execution.ts` | 63 | ✅ |
| `packages/html-program/src/fragment.ts` | 32 | ✅ |
| `packages/html-program/src/frame-work.ts` | 148 | ✅ |
| `packages/html-program/src/html-visual.ts` | 116 | ✅ |
| `packages/html-program/src/index.ts` | 17 | ✅ |
| `packages/html-program/src/manifest.ts` | 111 | ✅ |
| `packages/html-program/src/playback.ts` | 229 | ✅ |
| `packages/html-program/src/text.ts` | 1188 | ✅ |
| `packages/html-program/src/types.ts` | 64 | ✅ |
| `packages/html-program/src/visibility.ts` | 29 | ✅ |
| `packages/html-program/test/capture-scope.test.ts` | 74 | ✅ |
| `packages/html-program/test/document.test.ts` | 859 | ✅ |
| `packages/html-program/test/frame-work.test.ts` | 95 | ✅ |
| `packages/html-program/test/text-runtime.test.ts` | 164 | ✅ |
| `packages/html-program/test/visibility.test.ts` | 35 | ✅ |
| `packages/html-document/README.md` | 71 | ✅ |
| `packages/html-document/package.json` | 21 | ✅ |
| `packages/html-document/src/activation.ts` | 17 | ✅ |
| `packages/html-document/src/component.ts` | 19 | ✅ |
| `packages/html-document/src/document.ts` | 170 | ✅ |
| `packages/html-document/src/fragment.ts` | 14 | ✅ |
| `packages/html-document/src/index.ts` | 6 | ✅ |
| `packages/html-document/src/manifest.ts` | 50 | ✅ |
| `packages/html-document/src/surface.ts` | 25 | ✅ |
| `packages/html-video/README.md` | 24 | ✅ |
| `packages/html-video/package.json` | 47 | ✅ |
| `packages/html-video/src/activation.ts` | 17 | ✅ |
| `packages/html-video/src/fragment.ts` | 70 | ✅ |
| `packages/html-video/src/index.ts` | 3 | ✅ |
| `packages/html-video/src/manifest.ts` | 60 | ✅ |
| `packages/html-video/src/surface.ts` | 61 | ✅ |
| `packages/html-video/test/presentation.test.ts` | 20 | ✅ |
| `packages/html-video/test/render.test.ts` | 419 | ✅ |
| `packages/provider-html-local/README.md` | 94 | ✅ |
| `packages/provider-html-local/package.json` | 48 | ✅ |
| `packages/provider-html-local/src/activation.ts` | 128 | ✅ |
| `packages/provider-html-local/src/browser-install.ts` | 5 | ✅ |
| `packages/provider-html-local/src/browser.ts` | 118 | ✅ |
| `packages/provider-html-local/src/capture-exit.ts` | 33 | ✅ |
| `packages/provider-html-local/src/capture-process.ts` | 131 | ✅ |
| `packages/provider-html-local/src/capture-worker.ts` | 38 | ✅ |
| `packages/provider-html-local/src/capture.ts` | 331 | ✅ |
| `packages/provider-html-local/src/concurrency.ts` | 95 | ✅ |
| `packages/provider-html-local/src/frame-span-index.ts` | 109 | ✅ |
| `packages/provider-html-local/src/index.ts` | 10 | ✅ |
| `packages/provider-html-local/src/opaque-capture.ts` | 287 | ✅ |
| `packages/provider-html-local/src/options.ts` | 27 | ✅ |
| `packages/provider-html-local/src/ordered-frame-sink.ts` | 139 | ✅ |
| `packages/provider-html-local/src/output.ts` | 73 | ✅ |
| `packages/provider-html-local/src/process-tree.ts` | 88 | ✅ |
| `packages/provider-html-local/src/process.ts` | 157 | ✅ |
| `packages/provider-html-local/src/program.ts` | 80 | ✅ |
| `packages/provider-html-local/src/progress.ts` | 53 | ✅ |
| `packages/provider-html-local/src/provider.ts` | 98 | ✅ |
| `packages/provider-html-local/src/render.ts` | 191 | ✅ |
| `packages/provider-html-local/src/sampling.ts` | 99 | ✅ |
| `packages/provider-html-local/src/server.ts` | 52 | ✅ |
| `packages/provider-html-local/src/source-frame-decoder.ts` | 178 | ✅ |
| `packages/provider-html-local/src/source-frame-store.ts` | 326 | ✅ |
| `packages/provider-html-local/src/stage.ts` | 148 | ✅ |
| `packages/provider-html-local/src/surface-validation.ts` | 209 | ✅ |
| `packages/provider-html-local/src/weighted-capacity.ts` | 50 | ✅ |
| `packages/provider-html-local/test/alpha.test.ts` | 85 | ✅ |
| `packages/provider-html-local/test/browser-download.test.ts` | 108 | ✅ |
| `packages/provider-html-local/test/browser.test.ts` | 76 | ✅ |
| `packages/provider-html-local/test/capture-process.test.ts` | 269 | ✅ |
| `packages/provider-html-local/test/concurrency.test.ts` | 62 | ✅ |
| `packages/provider-html-local/test/frame-span-index.test.ts` | 44 | ✅ |
| `packages/provider-html-local/test/frames.test.ts` | 60 | ✅ |
| `packages/provider-html-local/test/ordered-frame-sink.test.ts` | 61 | ✅ |
| `packages/provider-html-local/test/process-env.test.ts` | 70 | ✅ |
| `packages/provider-html-local/test/progress.test.ts` | 29 | ✅ |
| `packages/provider-html-local/test/provider.test.ts` | 186 | ✅ |
| `packages/provider-html-local/test/range.test.ts` | 244 | ✅ |
| `packages/provider-html-local/test/source-frame-decoder.test.ts` | 25 | ✅ |
| `packages/provider-html-local/test/source-frame-store.test.ts` | 103 | ✅ |
| `packages/provider-html-local/test/stage.test.ts` | 209 | ✅ |
| `packages/provider-html-local/test/surface-validation.test.ts` | 153 | ✅ |
| `packages/provider-html-local/test/visual-readiness.test.ts` | 439 | ✅ |
| `packages/provider-html-local/test/weighted-capacity.test.ts` | 18 | ✅ |
| `packages/browser-capture/README.md` | 92 | ✅ |
| `packages/browser-capture/package.json` | 28 | ✅ |
| `packages/browser-capture/src/browser.ts` | 33 | ✅ |
| `packages/browser-capture/src/cli.ts` | 204 | ✅ |
| `packages/browser-capture/src/index.ts` | 194 | ✅ |
| `packages/browser-capture/test/capture.test.ts` | 117 | ✅ |
| `packages/browser-capture/test/cli.test.ts` | 53 | ✅ |
| `packages/visual-track/README.md` | 139 | ✅ |
| `packages/visual-track/package.json` | 45 | ✅ |
| `packages/visual-track/preview/build.svrun` | 5 | ✅ |
| `packages/visual-track/preview/preview.svml` | 50 | ✅ |
| `packages/visual-track/preview/recipes.svs` | 16 | ✅ |
| `packages/visual-track/src/activation.ts` | 42 | ✅ |
| `packages/visual-track/src/author.ts` | 204 | ✅ |
| `packages/visual-track/src/component.ts` | 123 | ✅ |
| `packages/visual-track/src/fragment.ts` | 56 | ✅ |
| `packages/visual-track/src/frame-treatment.ts` | 55 | ✅ |
| `packages/visual-track/src/index.ts` | 45 | ✅ |
| `packages/visual-track/src/layers.ts` | 352 | ✅ |
| `packages/visual-track/src/lower.ts` | 347 | ✅ |
| `packages/visual-track/src/manifest.ts` | 438 | ✅ (a few lines over 200 chars read truncated) |
| `packages/visual-track/src/motion.ts` | 145 | ✅ |
| `packages/visual-track/src/program.ts` | 215 | ✅ |
| `packages/visual-track/src/source-time.ts` | 241 | ✅ |
| `packages/visual-track/src/spatial.ts` | 77 | ✅ |
| `packages/visual-track/src/studio.ts` | 210 | ✅ |
| `packages/visual-track/src/surface.ts` | 675 | ✅ (a few lines over 200 chars read truncated) |
| `packages/visual-track/src/types.ts` | 252 | ✅ |
| `packages/visual-track/test/studio-companion.test.ts` | 27 | ✅ |
| `packages/visual-track/test/visual-track.test.ts` | 722 | ✅ (a few lines over 200 chars read truncated) |
| `packages/composition/README.md` | 82 | ✅ |
| `packages/composition/package.json` | 36 | ✅ |
| `packages/composition/src/activation.ts` | 8 | ✅ |
| `packages/composition/src/audio-level-automation.ts` | 44 | ✅ |
| `packages/composition/src/component.ts` | 11 | ✅ |
| `packages/composition/src/index.ts` | 29 | ✅ |
| `packages/composition/src/introspection.ts` | 52 | ✅ |
| `packages/composition/src/manifest.ts` | 12 | ✅ (a few lines over 200 chars read truncated) |
| `packages/composition/src/schema.ts` | 200 | ✅ (a few lines over 200 chars read truncated) |
| `packages/composition/src/track.ts` | 1456 | ✅ |
| `packages/composition/src/visual.ts` | 222 | ✅ |
| `packages/composition/test/render.test.ts` | 215 | ✅ |
| `packages/composition/test/track.test.ts` | 318 | ✅ |
| `packages/film/README.md` | 54 | ✅ |
| `packages/film/package.json` | 49 | ✅ |
| `packages/film/src/activation.ts` | 23 | ✅ |
| `packages/film/src/component.ts` | 62 | ✅ |
| `packages/film/src/fragment.ts` | 83 | ✅ |
| `packages/film/src/index.ts` | 11 | ✅ |
| `packages/film/src/manifest.ts` | 151 | ✅ |
| `packages/film/src/program.ts` | 110 | ✅ |
| `packages/film/src/recipe.ts` | 25 | ✅ |
| `packages/film/src/studio.ts` | 17 | ✅ |
| `packages/film/src/surface.ts` | 144 | ✅ |
| `packages/film/src/types.ts` | 26 | ✅ |
| `packages/film/test/film.test.ts` | 254 | ✅ |
| `packages/film/test/surface.test.ts` | 223 | ✅ |
| `packages/video/README.md` | 65 | ✅ |
| `packages/video/package.json` | 72 | ✅ |
| `packages/video/src/commands.ts` | 19 | ✅ |
| `packages/video/src/compiler.ts` | 74 | ✅ |
| `packages/video/src/distribution.ts` | 95 | ✅ |
| `packages/video/src/index.ts` | 10 | ✅ |
| `packages/video/src/package-selection.ts` | 34 | ✅ |
| `packages/video/src/vocabulary.ts` | 355 | ✅ |
| `packages/video/test/cli.test.ts` | 164 | ✅ |
| `packages/video/test/packages.ts` | 66 | ✅ |
| `packages/video/test/vocabulary.test.ts` | 143 | ✅ |
| `packages/visual-track/preview/{Track,flush,rounded}.png` | binary | not read (images) |
