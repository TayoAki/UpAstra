# Batch 09: Media and audio operations

**Source:** hypit at commit `dc2b7a8f31b1ef1443a79ca448548d69e3ceb6a0` (read-only; nothing was built or run).

**Packages** (source lines = `src/**` plus Python runtime; test lines = `test/**`):

| Package | src lines | test lines | One-line role |
|---|---:|---:|---|
| `media` | 1,097 | 238 | Neutral media value types (`MediaInspection`, `SynchronizedMedia`, `TimelineAudio`, `MuxedMedia`, fonts) and `<media:Image/Audio/Video/Font>` |
| `media-local` | 3,396 | 1,717 | The trusted local ffmpeg/ffprobe executor, plus the `hypit media` CLI (probe, cut, frames, tile, tiles, boundaries) |
| `media-operations` | 2,325 | 435 | Provider-neutral vocabulary: inspect, select, normalize, transform, extract, StillVideo, audio plan, mux |
| `image-operations` | 1,321 | 247 | Still-image Transform programs and rectangular Compose (contracts only) |
| `provider-image-opencv-local` | 366 + 299 py | 240 | OpenCV/NumPy realization of image-operations, one Python process per Need |
| `audio-track` | 1,166 | 395 | Audio Clip placement on a Timeline: windows, source-time maps, gain and fades |
| `volcengine-matting` | 108 | 24 | Binding to a remote portrait-matting model (through the HypiHub provider) |
| `yt-dlp` | 228 | 139 | Pinned yt-dlp downloader and the `hypit download` CLI |
| `recipe` | 415 | 371 | The `.svs` "sheet" parser for generic parameter Recipes |

Altogether that is about 10.7k source lines and 3.8k test lines. Paths below are relative to the hypit repo root (`packages/...`) or to `clipper/` for our app.

---

## 1. `media`: contract types

**Purpose.** This package defines the media values that flow through hypit's build graph, and the author tags that bring files in. It does no I/O. `<media:Video>` only asks the Host for bytes, and every executor stage is described by a value type.

**Public surface.**
- Types (`packages/media/src/types.ts`):
  - `MediaInspection` (61-66) with video, audio and "other" streams (31-58);
  - `MediaStreamSelection` (68-77);
  - `SynchronizedMedia` (79-93): one `frameDomain` {frameRate, frameCount}, an optional video artifact with width and height, and an optional WAV artifact;
  - `TimelineVisual`, `TimelineAudio` and `MuxedMedia` (98-125).
- Validators and seals (`identity.ts`): `verify*` and `seal*` for each type, plus `synchronizedMediaSampleFrames` (161-168).
- `MediaFrameRange` and `mediaFrameRangeSamples` (`frame-range.ts:4-33`).
- Font refs: `FontArtifactRef`, `FontStackRef` and `CompositableSurfaceRef` (`render.ts:17-48`).
- Markup tags `Image`, `Audio`, `Video`, `Font` and `FontStack` (`manifest.ts:22-144`). One producer, `local-domain` (`manifest.ts:160-162`, `component.ts:22-26`).

**How it works.**
- **Audio is always 48 kHz.** A frame domain becomes samples as `round(frameCount × 48000 × den / num)`, computed in BigInt with round-half-up (`identity.ts:115-121`, `161-168`). A frame range takes its start from the original clock and its length from the new zero-based clock. The comment admits the two roundings can differ by one sample (`frame-range.ts:19-33`).
- **Timestamps are exact rationals.** They are `{ticks: string, timeBase}` and are compared by cross-multiplying (`identity.ts:51-57`).
- **Timing must be "admissible".** A stream marked admissible must carry a non-empty start/end PTS interval (`identity.ts:83-87`). Synchronized audio must be `audio/wav` (`identity.ts:183-185`). Muxed media must be MP4 whose `presentationSampleFrames` equals the frame domain exactly (`identity.ts:223-226`).
- **Media type comes from the extension**, from fixed tables: image (.avif/.gif/.jpeg/.jpg/.png/.webp), audio (8 extensions) and video (.m4v/.mov/.mp4/.webm) (`surface.ts:7-39`). A different extension needs an explicit `media-type`, and the type the Host resolves must match (`surface.ts:73-93`, `111-113`).
- **Fonts.** A Font is either a `src` or several unicode-range `<Source>` shards, never both (`surface.ts:152-160`). Weight is 1-1000, and style is normal, italic or oblique (`surface.ts:138-145`). Straight alpha is accepted only for PNG, WebP or WebM (`render.ts:117-119`).

**Tests.** 9 tests:
- Each asset tag publishes the resolved Blob (`test/asset-surface.test.ts:13-47`).
- Ambiguous extensions, and a resolved artifact of the wrong type, are rejected (`:49-62`).
- Font validation fails before any bytes are read (`test/font-surface.test.ts:52-65`).
- Unicode-range shards are preserved (`:67-112`).
- The local domain carries no program position (`test/domain.test.ts:17-22`).

**Quality notes.**
- Validation is strict and thorough.
- The schema/validator pairs are written twice: once declaratively in `schema.ts` and once imperatively in `identity.ts`. Drift between them is possible.
- `compareTimestamp` assumes positive denominators, which the validator does enforce.

**Relevance: Low.** The ideas behind it matter more than the code. Exact frame-to-sample math and "audio is always 48 kHz stereo WAV inside the pipeline" are worth copying as conventions. Clipper mixes at 44.1 kHz (`clipper/server/media.ts:114`, `142`).

**Better version.** We need no type system. Adopt one internal audio format (48 kHz s16 stereo WAV), and one helper `samplesFor(frames, fps)` with integer rounding, used by captions, voice and mux.

---

## 2. `media-local`: ffmpeg executor and the `hypit media` CLI

**Purpose.** This is the only package that runs ffmpeg and ffprobe. It has two independent ports:
1. a Provider that fulfils media-operations Needs against a content-addressed ResourceStore;
2. a "file port", exposed as `hypit media`, that gives an authoring agent evidence: probes, cuts, labelled frames, frame grids with transcript labels, and visual-change candidates (`README.md:3-20`, `24-44`).

**Public surface.**
- `createLocalMediaProvider` (`src/provider.ts:50-145`), with nine capabilities. Six are "transient" (usable in authoring previews): inspect, normalize, transform, extract-audio, extract-frame and render-still. Three are build-only: speech-evidence projection, render-timeline-audio and mux (`provider.ts:82-142`).
- CLI verbs `probe | cut | frames | tile | tiles | boundaries` (`src/files.ts:19`), registered as `hypit media` (`src/cli.ts:5-19`).
- Exports: `decodeMediaFrames`, `writeFrameGrid`, `snapshotFrameLabel`, `probeMedia` and `speechEvidenceFile` (`src/index.ts:1-8`).
- Runtime config keys: `ffmpegPath`, `ffprobePath`, `defaultConcurrency`, `processTimeoutMs` and `maxProbeOutputBytes` (`src/activation.ts:21-23`).

### 2a. Process boundary
- **No shell.** Processes start with `spawn` and no shell (`process.ts:18-22`).
- **Bounded.** A timeout sends SIGKILL (`:34`). Stdout has an optional byte cap (`:37-41`), and stderr keeps only its last 100,000 characters (`:47`).
- **Scrubbed environment.** Children get only `PATH`, plus the Windows process-creation variables, so credentials never reach ffmpeg (`process-env.ts:8-21`; asserted in `test/process-env.test.ts:8-43`).
- **Defaults.** Timeout 10 min, probe JSON cap 256 MB, concurrency 1 (`provider.ts:53-55`, `81`). The file-port helpers use 300 s (`process.ts:95`, `100`).

### 2b. Probe (inspection)
- **Every frame is decoded.** `inspectFile` runs `ffprobe -show_format -show_streams -show_frames` (`execute.ts:271`). From the frames it derives each stream's timing status:
  - **non-monotonic** if PTS ever fails to increase (`probe.ts:161-171`);
  - **audio discontinuous** if the gap between packets exceeds 2 ticks (`probe.ts:189-197`);
  - **video discontinuous** if any delta exceeds max(4 × the median cadence, 0.5 s) (`probe.ts:199-210`).
- **Last-frame duration** is inherited from the previous delta (`probe.ts:177-180`). The test asserts that frames at 0/40/80 ticks give an end of 120 (`test/probe.test.ts:8-57`).
- **Display rotation** comes from the display-matrix side data or the `rotate` tag. Only quarter turns are accepted; anything else throws (`probe.ts:99-107`).
- **Stream role.** A stream is "moving" when ≥2 units are decoded, "attached-picture" by disposition, and otherwise "still" (`probe.ts:247-249`).
- **The simple CLI probe** (`probeMedia`, `files.ts:161-190`) is close to clipper's `probe`: duration, hasAudio, width, height and frameRate. It also excludes album-art streams (`files.ts:172`; test `files.test.ts:134-173`).

### 2c. Normalization
- **Plan** (`execute.ts:203-258`):
  - A source with video must use video as the span authority (`:213-215`).
  - Frame count is rounded for video authority and ceiled for audio authority (`:221-223`).
  - Audio is placed against the authority's start PTS in 48 kHz samples, with head delay, trim and tail pad computed exactly (`:242-257`).
- **Visual filter chain:**
  - `setpts=PTS-STARTPTS, fps=…:round=near:start_time=0, trim=end_frame=N, setpts=N/…`;
  - then a scale that expands, never shrinks, the non-square axis, and `setsar=1` (`execute.ts:687-697`);
  - ffmpeg's default autorotation bakes in rotation (`:698-699`).
- **Encoders:**
  - Opaque video uses libx264 veryfast, yuv420p, faststart.
  - Transparent video uses VP9 lossless yuva420p, `-deadline realtime -cpu-used 8` (`:705-710`).
  - For alpha VP8/VP9 input the libvpx decoder is forced, so ffmpeg keeps the alpha sidecar (`execute.ts:589-600`).
- **Copy fast path** (`copyNormalizedVisual`, `execute.ts:604-662`). It skips the re-encode only when all of these hold:
  - the source is H.264 yuv420p, profile Baseline/Main/High, level ≤4.1;
  - dimensions are even, pixels are square and there is no rotation (`:616-626`);
  - a per-frame ffprobe confirms every PTS equals `index/fps` and every duration is exactly one frame (`normalize-copy.ts:34-55`).

  A single-stream MP4 is reused as-is (`:640-641`); otherwise it is remuxed with `-c:v copy`.
- **Audio filter chain:** `aresample=48000:async=0:first_pts=0`, stereo, `atrim`/`adelay`/`apad` to the exact sample count, then s16 WAV (`execute.ts:749-763`).
- **Every output is re-probed** and its frame or sample count asserted (`:735-740`, `776-778`).

### 2d. Other executors
- **StillVideo.**
  - The first frame is held with `select=eq(n,0), loop=-1, trim=end_frame`, then tagged BT.709 limited range (`execute.ts:833-843`).
  - With several images, each is fitted inside the first image's frame and letterboxed (`:859-865`).
  - The output is re-probed for frame count, SAR, rotation and frame rate (`:887-898`).
  - Tests check that colour round-trips within ±3 for 0x20/0xC0/0x40, and the bt709 tags (`test/provider.test.ts:726-815`).
- **Transform.** An ordered trim/retime compiles to `trim`/`setpts=PTS/r` for video and `atrim`/`atempo` for audio. `atempo` is chained in factors between 0.5 and 2 (`execute.ts:477-491`, `918-961`). Audio comes out as AAC inside MP4 (`:985`).
- **ExtractFrame.** It uses `setpts=PTS-STARTPTS, select=…` for first, last, frame N or `gte(t, s)`, and writes PNG (`execute.ts:1077-1090`). There is no input seek, so a late timestamp decodes from frame 0.
- **ExtractAudio** writes 48 kHz stereo s16 WAV (`execute.ts:1040-1050`).
- **Speech evidence** writes exact 16 kHz mono s16 (`execute.ts:1135-1146`).

### 2e. Audio program render and mux (the mixer)
- **Window first.** Clips are first filtered to the render window (`execute.ts:1188-1189`).
- **Per-clip chain** (`audioClipFilter`, `execute.ts:493-519`):
  1. `atrim` the source samples;
  2. `aloop` the source interval when looping (`:502`), plus a phase trim;
  3. `atempo`, then exact length via trim, `apad` and trim;
  4. `volume=gain`;
  5. per-sample level automation;
  6. crop to the window;
  7. `adelay` by the offset in samples.
- **Level automation** (`audio-level-automation.ts:4-31`) builds one `aeval` expression:
  - a gain envelope interpolated by nested `if(lt(n+offset, …))` per segment;
  - multiplied by audibility spans, as a sum of `gte*lt` terms;
  - then linear fade-in and fade-out on the clip-global mix clock.
- **Mixdown** is `amix … normalize=0` with no limiter (`execute.ts:1236-1238`). An empty plan renders `anullsrc` silence (`:1225-1228`).
- **Mux.**
  - It checks that video and audio share one presentation origin (`execute.ts:1343-1345`).
  - It accepts an AAC presentation span within 1,024 samples of the WAV. The comment documents measured AAC priming drift of -16 and -32 samples at ffmpeg 6.1 (`execute.ts:1347-1367`).
  - The test asserts the 48,000-sample span exactly (`test/provider.test.ts:817-937`), and an NTSC 30000/1001 tail within 64 samples (`:939-989`).

### 2f. The `hypit media` evidence CLI (most relevant to us)
- **Seek run-up.** `openAt` jumps with `-ss` to 2 s before the target, then decodes the remaining run-up with an output `-ss` (`files.ts:192-204`). The comment reports byte-identical JPEGs and 11.6 s → 0.2 s on a 9-minute 1080p source. It says input seek alone "lands on the keyframe before it". That is only true for stream copy: with re-encoding, ffmpeg's default `-accurate_seek` already decodes forward. Their measurement was against output-seek, so the speedup is real.
- **Exact frame time** (`cutFrame`, `files.ts:375-401`). It runs `-copyts -start_at_zero`, input-seeks to target - 2 s, then applies `trim=start=at, showinfo` and parses `config in time_base` plus the `n:0 pts:` line from stderr. It returns the **actual decoded frame time**, not the requested time. The test asserts a label at 53/24 s for a request at 2.2 s (`test/files.test.ts:258-260`).
- **Labels without drawtext.** A 5×7 bitmap glyph font for `0-9 : .` is rasterized in JS and overlaid from a rawvideo pipe, so time labels work even when ffmpeg lacks drawtext/libfreetype (`files.ts:210-271`, `273-278`, `393-396`). `--label-time` cuts burn the time of every frame, at up to 30 fps (`files.ts:300-311`).
- **Tiles and grids.**
  - Defaults: 3 columns, 480 px cells, never wider than the source (`files.ts:403-404`, `642`).
  - The default frame count is `clamp(round(sec × 1.5), 4, 9)` (`files.ts:406`), sampled at interval midpoints `start + (i + 0.5)·span/n` (`:408-412`).
  - `tiles` paginates at columns × rows, 3×3 by default (`files.ts:706-709`). It reads a JSON ranges file `{id?, start, end, frames?|every?}` (`files.ts:659-671`).
  - Grid layout uses sharp: 8 px gutters on #0c0c0c, with labels *under* the picture so they never cover it (`frame-grid.ts:4-26`; asserted in `files.test.ts:270-273`).
- **Transcript labels.**
  - With `--transcript` (hypit.transcript@1 JSON), each cell's label lists the word active at that frame with its start-end times, plus up to 3 words of context either side, the active one highlighted in amber (`files.ts:418-432`). The selection is `wordsAt` (`packages/speech-evidence/src/transcript-document.ts:75-87`).
  - An untimed gap is labelled "No timed word at this frame" (`files.ts:421`).
  - `--around "<phrase>"` finds a timed phrase with case and punctuation folding (`speech-evidence/.../transcript-document.ts:89-100`). It refuses an ambiguous match without `--occurrence`, and pads 0.3 s by default (`files.ts:510-527`; test `files.test.ts:250-261`).
- **Native frames** (`--every-frame`). Each interval is decoded once with `-fps_mode passthrough`, keeping every real PTS from showinfo, so variable frame rate is preserved (`file-frames.ts:8-25`). The test asserts frames at [0, 0.1, 0.3, 0.5] and the half-open bound behaviour (`test/file-frames.test.ts:10-34`).
- **Visual boundaries** (`files.ts:467-491`).
  - ffmpeg decodes at `fps=12, scale=32:32, rgb24` to raw stdout.
  - The score is the mean absolute byte difference between adjacent frames / 255, and anything ≥0.1 is a candidate. Defaults are rate 12 and threshold 0.1, with CLI bounds of 1-120 and 0-1 (`files.ts:793-794`).
  - The output is explicitly "candidates … never editorial shot labels" (`files.ts:799`, `819`). The test finds cuts at 0.5, 1.0 and 1.5 s in a red/blue/green/white sample (`files.test.ts:121-124`).
- **Multi-span cut** (`--keep a:b --keep c:d`): one decode with split/asplit, then trim + setpts per span, then concat. It encodes x264 medium CRF 17 with vfr, or s24 PCM for audio-only (`files.ts:329-356`). The JSON output includes a nominal source→output time mapping (`files.ts:591-597`).
- **Never overwrites.**
  - `cut` publishes via `link()`, which fails if the target exists (`files.ts:359-373`).
  - `frames` and `tiles` build a staging directory and `rename` it (`files.ts:614`, `625`, `711`, `725`).
  - All refuse an existing `--to` (`files.ts:128-140`).

**Tests.** 33 tests across 8 files; most skip when ffmpeg is absent. The provider suite alone has 16 (`test/provider.test.ts`, starting at lines 33, 199, 264, 338, 379, 407, 438, 481, 530, 567, 726, 817, 939, 991, 1048 and 1086). Highlights:
- 32 kHz AAC plus an attached picture normalizes to exactly 30 frames and 48,000 samples (`:264-336`);
- rotation and SAR are baked in, so 160×96 at SAR 2:1 rotated 90° becomes 96×320 (`:338-377`);
- a late-starting audio stream keeps its offset within 64 samples (`:481-528`);
- a loop starts from the authored phase (`:991-1046`);
- a range render matches the full render within 1 PCM unit (`:1048-1084`);
- envelope plus audibility keeps phase through gaps (`:1086-1125`);
- alpha survives normalize for WebM VP9, WebM VP8 and MOV (`test/alpha.test.ts:10-52`).

**Quality notes.**
- **Strengths:**
  - every output is re-probed and asserted;
  - all frame and sample arithmetic is exact (BigInt);
  - the A/V-origin handling is honest;
  - the AAC tolerance is reasoned in the code;
  - the environment is scrubbed;
  - output is never clobbered;
  - grid labels never cover the picture.
- **Whole-file probe.** `-show_frames` decodes every frame and serializes every frame as JSON (`execute.ts:271`), capped at 256 MB (`provider.ts:54`). This is O(duration) CPU on every inspect. By my estimate (unverified), an hour-long source could exceed the cap.
- **Frame extraction never seeks.** It always decodes from frame 0 (`execute.ts:1084-1090`), unlike the file port's `openAt`.
- **Two seek implementations** (provider and file port) diverge.
- **No input hardening.** Staged sources (`source.bin`) are handed to ffprobe and ffmpeg without `-protocol_whitelist` or `-format_whitelist` (`execute.ts:271`, `721`, `762`). Clipper's `hardenInputs` is stricter here (`clipper/server/media.ts:24-43`).
- **No dedup or minimum gap in `visualBoundaries`.** A fade or a fast pan emits many consecutive candidates (`files.ts:482-489`). Clipper's `sceneCuts` merges cuts closer than 0.25 s (`clipper/server/formats.ts:91`).
- **Boundary times assume a stream start of 0.** They are computed as `index / sampleRate` (`files.ts:488`), so a source with a non-zero start PTS shifts every candidate.
- **Boundary memory and time.** Stdout is buffered unbounded (`process.ts:14` default ∞), about 133 MB for an hour at 12 fps, and capped by the 300 s default timeout (`process.ts:95`).
- **Bounds checked after storing.** `executeExtractAudio` stores the artifact *before* verifying it (`execute.ts:1051-1059`), so a failed check leaves an orphan.
- **Possible clipping.** `amix normalize=0` with no limiter (`execute.ts:1236`) and gains up to 64 (`audio-plan.ts:80`) can clip at s16.
- **`aeval` cost grows with the envelope.** The expression grows linearly with envelope points and is evaluated per sample (`audio-level-automation.ts:9-18`). It is fine for a few points and slow for dense ducking envelopes.
- **Hard-coded binaries.** File-port helpers call bare `"ffmpeg"` rather than the configured path (`file-frames.ts:13`, `files.ts:291`, `378`).

**Relevance: High.** This is the closest analogue to `clipper/server/media.ts` and `moments.ts`, and the evidence CLI is directly useful for our vision-model inputs.

**Better version for us.**
- Keep our HTTP range-read approach to remote footage (`clipper/server/media.ts:4-6`) and our input hardening.
- Adopt three things:
  1. exact decoded frame times via `showinfo`;
  2. labelled grids with transcript words under each cell;
  3. a cheap 32×32 difference pass to snap shot boundaries.
- Skip `-show_frames` whole-file probing; on a CPU-only Railway box it is too costly per tenant upload.

---

## 3. `media-operations`: neutral operation vocabulary

**Purpose.** It declares what each operation means: Needs, request types and markup tags, with no ffmpeg in it. Ingestion is always `Blob → inspect → select → normalize → SynchronizedMedia` (`README.md:3-13`).

**Public surface.**
- Eight capabilities: `inspect-media`, `normalize-media`, `transform-media`, `extract-media-audio`, `extract-media-frame`, `render-still-video`, `render-timeline-audio` and `mux-program-media` (`src/manifest.ts:20-29`).
- 14 producers (`manifest.ts:30-45`).
- Tags (`manifest.ts:246-429`): `<mediaop:Normalize>`, `<mediaop:StillVideo>` with `<Still weight>`, `<mediaop:Transform>` with `<Trim start|end|tail>` and `<Retime rate>`, `<mediaop:ExtractAudio audio=default|stream:N>`, and `<mediaop:ExtractFrame at=first|last|frame:N|time:S>`.
- Functions: `selectMediaStreams`, `planStillVideoSegments`, `compileAudioProgramPlan` and `verifyAudioProgramPlan`.

**How it works.**
- **Stream selection** (`selection.ts:38-108`):
  - "Primary moving" excludes attached pictures and streams whose timing is not admissible.
  - It prefers exactly one default-disposition stream, accepts a single unambiguous candidate, and otherwise throws ("fail closed").
  - The policy tag records how the choice was made (`:97-101`).
  - The test uses a real "Grok" container with an MJPEG cover art stream (`test/selection.test.ts:22-97`).
- **Normalize tag.** It needs either a `recipe` or all three of `video`/`audio`/`span-authority` (`surface.ts:165-169`). A Recipe may carry only those three keys (`surface.ts:54-65`). The `clock` reference is mandatory (`surface.ts:175-179`).
- **StillVideo split** (`operations.ts:139-162`): every picture gets 1 frame, then the remaining frames are shared by weight using the floor plus largest-remainder method, earliest first on ties. For example, 10 frames over weights [1, 1, 1] gives [4, 3, 3] (`test/manifest.test.ts:209-215`). The duration must resolve to a whole frame count and is never rounded (`component.ts:254-258`; `test/still-video.test.ts:19-29`).
- **Transform.** Trim times are relative to the *current* timeline after earlier operations (`types.ts:34`). Retime rate must be in (0, 100] (`operations.ts:61-63`).
- **AudioProgramPlan** (`audio-plan.ts:36-146`):
  - It compiles a Composition plus a Timeline into flat clips with exact 48 kHz sample boundaries, loop phase, playback rate, the clip-global mix window used by fades, gain (0-64), envelopes and audibility.
  - It requires `mix: {normalize: false, limiter: "none"}` and rejects anything else, so mastering can never be hidden (`audio-plan.ts:88-89`).
  - Source ends must land on exact sample boundaries or compilation throws (`audio-plan.ts:21-30`).
- **Mux producer.** It checks that the audio sample count equals the frame domain before planning a mux (`component.ts:322-336`; 5 frame-rate cases in `test/mux.test.ts:10-35`).

**Tests.** 16 tests:
- tags compile to graph fragments;
- StillVideo planning;
- mux sample-boundary acceptance and ±1 rejection;
- selection fail-closed;
- planned-need presentation.

**Quality notes.**
- The separation is clean, but there is duplication:
  - `uniqueDefault` exists both in `operations.ts:210-220` and as `selectUniqueDefault` in `selection.ts:38-48`;
  - `selectVideoStream` and `selectedVideo` overlap (`operations.ts:222-232` vs `selection.ts:50-70`).
- Each value is described three times: as a type, a schema and a validator.
- "Loudness: preserve" is hard-coded (`component.ts:187`), so loudness normalization belongs to some other package.

**Relevance: Medium.**
- The good ideas: fail-closed stream selection (drop cover art, refuse ambiguity), the whole-frame still split, and "no hidden normalization" as an *explicit* plan field.
- For clipper, explicit loudness policy as a recorded setting is useful, because brand kits may want -14 vs -16 LUFS.

**Better version.** Give `cutSegment` a selection step: probe streams, skip `attached_pic`, and pick the default audio. Our `probe` (`clipper/server/media.ts:68-73`) takes the first video stream, which can be cover art in some MP4 or MOV uploads; the hypit test shows this exists in generator output (`packages/media-operations/test/selection.test.ts:82-97`).

---

## 4. `image-operations`: still-image contracts

**Purpose.** It defines two capabilities: `transform-image` (an ordered program) and `compose-image` (rectangular alpha layering onto a Canvas, written as PNG) (`README.md:3-12`). It contains no pixels code.

**Public surface.**
- `<image:Program>` with children Crop, Resize, Rotate, Flip, Denoise, Color, Sharpen, Blur, Alpha and Encode (`manifest.ts:30-165`).
- `<image:Transform source program>` (`manifest.ts:166-192`).
- `<image:Compose canvas background><Layer source frame fit interpolation opacity/>` (`compose-declaration.ts:6-50`).
- Request builders `imageTransformRequest` and `imageComposeRequest`, and validators (`execution.ts:86-132`).

**How it works.** Parameter ranges are validated (`execution.ts:28-84`):
- resize up to 16,384 px;
- denoise windows must be odd, with search > template;
- colour exposure ±8 stops, contrast and saturation 0-4, gamma 0.1-10;
- `encode` at most once and last (`execution.ts:86-92`).

Compose allows at most 64 layers (`compose-program.ts:56`) and needs a `#RRGGBBAA` background (`compose-program.ts:15-17`). Denoise defaults are luma 2, chroma 10, template 7, search 21 and saturation recovery 1.02 (`surface.ts:88-98`).

**Tests.** 8. Programs seal in order and reject "encode not last" (`test/image-transform.test.ts:29-42`). Compose layer order is preserved (`test/image-compose.test.ts:47-68`).

**Quality notes.**
- Tidy.
- The `color()` helper's `alpha` flag means "allow 6 *or* 8 digits", and the name reads backwards (`execution.ts:18-22`).
- Pixel crops are not checked against the image size until execution.

**Relevance: Low.** Our overlays and stickers are ASS and ffmpeg (`clipper/server/overlays.ts`), and sharp would cover any still-image need.

**Better version.** If we ever need thumbnail or poster compositing, call sharp directly. No capability layer.

---

## 5. `provider-image-opencv-local`

**Purpose.** It implements both image capabilities with a locked Python 3.13 environment (numpy 2.5.1, opencv-python-headless 4.14.0.94 in `runtime/uv.lock`), one bounded subprocess per Need (`README.md:3-16`).

**Public surface.** `createLocalOpenCvImageProvider` (`src/provider.ts:97-181`). `runtime/raster_execute.py <request.json> <output>`, with `--self-test` (`raster_execute.py:278-295`).

**How it works.**
- **Per Need:** sources are copied to temp files, a JSON request is written, and Python is spawned. Limits are 5 min, 128 MB of total input, 256 MB of output and 256 KB of stderr (`provider.ts:99-101`, `148`).
- **Deployment:** `uv sync --frozen` goes into `<hostState>/programs/image-opencv-<instance>/.venv` (`deployment.ts:46-61`). The probe checks major versions cv2 4 and numpy 2 (`program.ts:8`, `44-59`).
- **Python side:**
  - fit geometry uses round-half-up (`raster_execute.py:74-82`);
  - denoise is NLM per YCrCb channel with saturation recovery (`:105-119`);
  - colour is exposure, contrast, saturation and temperature/tint ±32 levels, then gamma (`:122-136`);
  - sharpen is an unsharp mask with a threshold (`:139-148`);
  - compose uses straight-alpha "over" with opacity (`:239-255`).

**Tests.** 7. Two are live and run only with `HYPIT_OPENCV_TESTS=1` (`test/provider.test.ts:107-109`). One asserts a 1×1 PNG stretched to 64×64 (`:111-149`).

**Quality notes.**
- **Grayscale crash.** A grayscale input to `resize` with fit `contain` assigns a 2-D array into a 3-channel canvas, which raises a NumPy broadcast error (`raster_execute.py:96-101`).
- **16-bit PNGs** load as uint16 through `IMREAD_UNCHANGED` (`:68`), but every operation assumes 0-255 uint8.
- **Denoise silently no-ops** below 32 px (`:107-108`).
- **Environment not scrubbed.** Python is spawned without `env` (`provider.ts:65`), unlike media-local.
- **Wrong error text.** Errors say "image transform" even for compose (`provider.ts:73`, `89`).

**Relevance: Low.** A Python and OpenCV runtime per Need is heavy for CPU-only multi-tenant hosting. sharp (libvips) is already a Node dependency in this ecosystem (`packages/media-local/package.json:24`).

**Better version.** Use sharp in-process with a worker pool.

---

## 6. `audio-track`: audio placement

**Purpose.** "Audio Clip = normalized audio source + absolute Window + sampling + mix; Audio Track = additive set of Audio Clips" (`README.md:5-8`). Voice, music, ambience and SFX are all equal clips (`README.md:45-47`). **Ducking and crossfades are deliberately not built in.** They are meant to be separate components that compute gain envelopes and audibility (`README.md:49-52`). No such component exists in this batch, and a grep finds "duck" only in READMEs and one HTML document file.

**Public surface.**
- `<audio:Track id timeline>`, with `<audio:Clip source during gain fade-in fade-out source-time>` and inline `<audio:Map>` children.
- `<audio:SourceTime id>` for a reusable map (`manifest.ts:77-144`).
- Functions: `appendAudioClip`, `finalizeAudioTrack`, `renderAudioTrack` and `resolveAudioSourceTime`.
- A Studio companion: a gain inspector as a percentage up to 6400%, and fade fields that accept ms, s and f (`studio.ts:43-81`).

**How it works.**
- **Default mapping.** With no Map, the clip uses "bounded partial identity": the window start maps to the source start at rate 1, and the excess is silence (`source-time.ts:42-51`). The test checks that 1 s of source in a 2 s window yields 1 s audible (`test/audio-track.test.ts:136-152`).
- **Rate maps.** Anchors (`target-at`/`source-at`, `start|end±dur`) plus an exact rational rate. The valid target interval is found by binary search over samples (`source-time.ts:117-126`, `141-149`). `wrap-from`/`wrap-until` makes the source periodic, and the phase is computed by modulo (`:152-156`).
- **Fit maps.** With no rate or anchors, the source interval is fitted to the target, optionally bounded by `min-rate`/`max-rate`. Outside the bounds it throws rather than truncating (`source-time.ts:168-178`; test `:169-179`).
- **Several Maps** must not overlap (`source-time.ts:195-199`). Fades stay on one clip-global clock across the pieces (`test/audio-track.test.ts:214-244`).
- **Duration literals** accept `12f`, `250ms` or `1.5s`, kept as exact rationals (`surface.ts:64-80`). A fade longer than the window throws (`program.ts:166-167`).

**Tests.** 10. Highlights: end-alignment and loop phase (`:154-167`), a rate of 128 allowed with no arbitrary ceiling (`:181-190`), and one track with overlaps compiling the same as two peer tracks (`:270-296`).

**Quality notes.**
- The algebra is elegant and exact.
- **Clip identity comes from the window.** `realizedClips` sets the clip id to `window.id` and the author's id to `subjectId` (`program.ts:93-96`), then rejects duplicate ids (`program.ts:101-103`). Two clips with the same `during` window, such as voice and music over the whole program, would therefore collide. The README example uses different windows (`README.md:19-26`). Whether temporal projection gives each clip a distinct window id is unverified here.
- No ducking, SFX library, beat sync or loudness, by design.

**Relevance: Medium.**
- Our mix is fixed: game at 0.22, voice at 1.6, then `loudnorm` at -14 LUFS (`clipper/server/media.ts:146-151`). That is "static ducking", not real ducking.
- Hypit's clip, window, gain and envelope model is the right data shape if we add music beds and SFX hits on captions or overlays.

**Better version.** Have a small `AudioPlan`:

```
{ clips: [{ src, startSec, srcStartSec, gain, fadeIn, fadeOut, loop, duckUnder?: "voice" }] }
```

compiled to one ffmpeg graph. Duck with `sidechaincompress`, keyed on the voice stem, or with `volume=…:eval=frame` envelopes built from our `speechSpans` (`clipper/server/media.ts:175-187`). Keep a final `loudnorm` with a true-peak limit, since social platforms favour it. Avoid hypit's per-sample `aeval`.

---

## 7. `volcengine-matting`

**Purpose.** It binds a single remote model, `matte-portrait-video`, which removes the background from a person video and returns WEBM or MOV with alpha (`README.md:3-14`). The HypiHub provider maps it to `POST /v1/videos` with `ref_video_url` and `format` (`README.md:79-82`).

**Public surface.**
- `<matte:Portrait id source format=WEBM|MOV>`; WEBM is the default (`src/surface.ts:29-30`).
- Ports: `source` (exactly 1 video) and `format` (enum) (`src/index.ts:8-16`).

**How it works.** It is a thin declaration over `@hypit/generation`'s exact-model helper (`index.ts:22-27`). The README warns that Transform outputs opaque MP4, so trim or retime must happen *before* matting (`README.md:65-67`).

**Tests.** 1: binding and format validation (`test/matting.test.ts:10-24`).

**Quality notes.** Small and clean. Cost, latency and quality are not documented here (unverified).

**Relevance: Low to medium.** A "streamer cut out over gameplay" format is plausible for UGC. Local matting (RVM, rembg) on CPU is too slow per clip, so it would have to be a remote API with metering.

**Better version.** If a campaign format needs it, call a matting API, store the alpha WebM in footage cache, and overlay it in `cutSegment` with `overlay` and `format=yuva420p`. Charge it as a metered add-on.

---

## 8. `yt-dlp`: network acquisition (and the ToS question)

**Purpose.** `hypit download <url> --to file.mp4` fetches one video with a **pinned** yt-dlp (`runtime/pyproject.toml:9`: `yt-dlp[default,curl-cffi]==2026.8.19`). It is installed explicitly by `hypit download prepare` into `<hostState>/programs/yt-dlp/<version>/.venv` (`src/environment.ts:13-19`, `33-41`). The motivation is stated plainly: "Most of the videos anybody wants to reconstruct are on TikTok, YouTube, Instagram or Bilibili" (`src/download.ts:4-6`).

**Public surface.** `isVideoUrl`, `downloadVideo`, `prepareVideoDownload` and `requireVideoDownload` (`src/index.ts:1-2`). The CLI `download` and `download prepare` (`src/cli.ts:50-76`).

**How it works.**
- **Arguments** (`download.ts:69-78`):
  - `--ignore-config --no-update --no-remote-components --no-plugin-dirs`;
  - the JS challenge solver runs on the calling Node binary: `--js-runtimes node:<execPath>`;
  - `--no-playlist`, `--format "bv*+ba/b"`, `--format-sort res:1080,vcodec:h264`;
  - the merge container follows the target extension (mp4/mkv/webm/mov);
  - 15 min timeout and 10 MB maxBuffer.
- **Staging.** It downloads to a temp directory and renames into place, copying on `EXDEV` (`download.ts:84-96`).
- **Checks.** The version is checked before each download, normalizing leading zeros (`environment.ts:21-30`). ffmpeg must be on PATH (`download.ts:60-65`).
- **Impersonation.** The locked extras include `curl-cffi` "browser-impersonation transport" (`runtime/README.md:13-15`; asserted in `test/download.test.ts:92-100`).
- **URL detection.** Only http and https count as URLs, so Windows drive paths stay files (`download.ts:36-43`; test `:13-20`).

**Tests.** 7: CLI validation and no-overwrite, never running `uv` during download, resolving the runtime from an installed package path, and the pin plus curl-cffi presence.

**Quality notes.**
- **Good engineering:** pinning, no auto-update, user config ignored, explicit preparation, and no-clobber in the CLI (`cli.ts:66`).
- **No-clobber is CLI-only.** `downloadVideo` itself `rename`s over an existing target (`download.ts:89`). The library leaves overwrite policy to callers, and says so (`README.md:18-19`).

**ToS and legal implications for us (not legal advice).**
- **Platform terms.** YouTube's terms forbid downloading content without a download link or YouTube's permission. TikTok and Instagram terms similarly bar automated collection and scraping. A **server-side** downloader in a multi-tenant SaaS has us performing that access on behalf of users. That is a platform-terms breach by *us*, not only by a single user on their own machine, which is hypit's model of a local CLI.
- **Circumvention.** hypit deliberately ships browser-TLS impersonation (curl-cffi) and a JS challenge solver. Both exist to get past bot detection and signature challenges. That moves from "tool" toward "circumvention", which raises the stakes, for example the 2020 RIAA DMCA §1201 takedown of youtube-dl on GitHub.
- **Operations.** Datacenter IPs (Railway) are routinely blocked or throttled by YouTube and TikTok, so it would be flaky and would need proxies. That is more cost and more ToS exposure.
- **Copyright.** Clippers clip *campaign* footage that the brand provides (Drive). Downloading third-party viral shorts as "format references" means storing copyrighted works. Clipper already limits references to 3 minutes (`clipper/server/formats.ts:19`) and reuses only structure, "never the reference's words, footage or claims" (`clipper/server/formats.ts:13-17`). That is a defensible fair-use posture *if the user uploads*.
- **Our current stance is right.** "TikTok, Instagram and YouTube page links can't be read; download the video and upload it" (`clipper/README.md:115`). Keep it.
- **Smaller exposure we already have.** We spoof a Chrome User-Agent for Drive (`clipper/server/footage-cache.ts:18`) and use `acknowledgeAbuse=true` on the Drive API fallback (`footage-cache.ts:60`). Those are much milder, but worth a policy review.

**Relevance: Low as code, High as a policy decision.** Do not adopt it server-side.

**Better version.**
- If users want link import, offer a **client-side** helper they run, or accept platform-sanctioned exports such as the creator's own downloads.
- For publishing-connected accounts, Outstand or platform APIs can sometimes provide the user's *own* media.
- If we ever run yt-dlp, restrict it to direct-file URLs and sites whose terms allow it, never with impersonation, and log the user's attestation of rights.

---

## 9. `recipe`: the `.svs` sheet format

**Purpose.** It is a tiny CSS-like "sheet" parser. Each dotted rule becomes one generic `Recipe {path, properties}` record, and consumers validate their own keys (`README.md:3-14`). media-operations uses it for stream-selection presets (`packages/media-operations/src/surface.ts:54-65`).

**Public surface.** `parseRecipe`, `RecipeSyntaxError`, `formatRecipeValue`, `recipeFrontend` and `recipeType` (`src/index.ts:1-5`).

**How it works.**
- A rule is `^[a-z][a-z0-9_-]*(\.[a-z]…)+` and a property is `^[a-z][a-z0-9-]*` (`parser.ts:10-12`).
- Comments are `/* */` only, and quotes are respected (`parser.ts:32-71`).
- Values are null, booleans, decimal numbers, JSON arrays or objects, quoted strings, or bare strings (`parser.ts:172-193`).
- Duplicate rules or properties are errors (`parser.ts:239-241`, `284`). Exact source spans are kept for editors (`parser.ts:249-257`).

**Tests.** 9. Highlights: alias imports compile into a build plan (`test/source-closure.test.ts:195-225`), quoted values may contain `;`, `}`, `/* */` and `</sheet>` (`:308-343`), and value spans are exact (`:358-371`).

**Quality notes.**
- **No unescaping.** Quoted strings are sliced, not unescaped, so `"a\"b"` keeps the backslash (`parser.ts:186-191`).
- **Quote-matching edge case.** A value such as `"a" "b"` passes the starts-and-ends-with-quote test and returns `a" "b`.
- No `//` comments.

**Relevance: Low.** Our presets (caption styles, brand kit) are already typed TypeScript and JSON (`clipper/shared/caption-styles.ts`). The one idea worth noting is keeping exact value spans so an editor can rewrite a value without reformatting the file.

---

## Our app today, side by side

| Concern | Clipper | hypit | Takeaway |
|---|---|---|---|
| Probe | First video stream; duration, audio, width, height (`clipper/server/media.ts:68-73`) | Every stream, exact PTS, timing status, rotation, SAR, album-art role (`packages/media-local/src/probe.ts:221-315`), at the cost of decoding every frame | Add stream-role filtering (skip `attached_pic`, pick the default audio) and rotation/SAR; skip `-show_frames` |
| Vision proxy for moments | Keyframes only (`-skip_frame nokey`), `fps=1`, drawtext `%{pts}` (`clipper/server/media.ts:81-94`) | Burned labels use the **actual decoded frame PTS** (`files.ts:375-401`, `452-455`) | **Likely bug:** with keyframe-only decode resampled to 1 fps, the burned time is the output slot's time while the picture is the nearest keyframe. Moments can be off by up to one GOP (often 2-10 s for OBS or game captures). Unverified on our footage; worth measuring |
| Scene and visual cuts | `select='gt(scene,0.3)',showinfo`, then a 0.25 s merge (`clipper/server/formats.ts:88-92`) | 32×32 RGB mean absolute difference at 12 fps, threshold 0.1, with scores (`files.ts:467-491`) | Ours is better at merging; theirs is cheaper to run on long footage and returns scores. Combine: low-res decode plus scores plus merging |
| Black or fade avoidance | Re-cut a shot up to 2 more times after `blackdetect` (`clipper/server/render.ts:278-289`), calling `blackSpans` twice on the same file (`:280`, `:282`) | none | Pre-scan the candidate window once at low resolution (black spans plus boundaries), then choose the start; one encode instead of up to three |
| Frame evidence for LLM/agent | Full proxy video as base64 (`clipper/server/moments.ts:205`, `217`) | Labelled 3×3 grids with transcript words under each cell (`files.ts:418-462`, `frame-grid.ts`) | For formats and QA ("does the caption match the picture?"), grids with words are compact, model-agnostic evidence. Our MCP agent could use them too |
| Audio mix | Static duck (game 0.22, voice 1.6), then `loudnorm -14 LUFS, TP -1.5` (`clipper/server/media.ts:146-151`) | Exact-sample plan, gains, fades, envelopes, loops; no normalization or limiter (`execute.ts:493-519`, `1236`) | Keep our loudnorm. Add real ducking (sidechain) and an optional music or SFX clip list |
| Input safety | Protocol and format whitelists on every `-i` (`clipper/server/media.ts:24-43`); env inherited (`:47`) | Env scrubbed to PATH (`process-env.ts:8-21`); no protocol whitelist | Take their env scrub (stops `OPENROUTER_API_KEY` etc. reaching ffmpeg); keep our whitelists |
| Process bounds | Stderr tail of 8 KB; stdout unbounded (`clipper/server/media.ts:50-51`) | Optional stdout cap, stderr tail of 100 KB, SIGKILL timeout (`process.ts:8-77`) | Add a stdout cap to `run` (the `sceneCuts` and raw-frame cases) |
| Acquisition | Drive or public link via `safeFetch`, size cap, in-flight dedupe, shared cache (`clipper/server/footage-cache.ts:19-20`, `52-95`) | yt-dlp with impersonation (`yt-dlp/src/download.ts:69-78`) | Don't adopt it (see §8) |

---

## Ideas worth taking (ranked)

1. **Fix the moments timestamps with real frame times.** Either drop `-skip_frame nokey` and use a cheap `fps=1` on a downscaled decode, or keep keyframe decoding but drop the `fps` resample and burn each keyframe's *own* PTS with `drawtext=%{pts}` before any rate change. Then validate the vision model's times against the real times.
   - Pattern: `packages/media-local/src/files.ts:375-401`.
   - Our code: `clipper/server/media.ts:81-94`.
   - This directly improves shot accuracy for every render.
2. **Scrub the child-process environment** for ffmpeg, ffprobe and whisper (`packages/media-local/src/process-env.ts:8-21`). It's one line in `clipper/server/media.ts:47` (`env: { PATH }`) and stops secrets leaking into subprocesses and their crash dumps.
3. **One low-resolution pre-scan per footage file, cached alongside moments.** Run a 32×32 difference pass with scores (`packages/media-local/src/files.ts:467-491`) plus `blackdetect`, in one decode. Use it to:
   - snap shot starts to visual cuts;
   - avoid black frames without re-encoding (`clipper/server/render.ts:278-289`);
   - feed pacing to formats.

   It is CPU-cheap.
4. **Labelled frame grids with transcript words** for the formats breakdown, a QA check, and the MCP agent ("show me 3×3 of shot 2 with caption words") (`packages/media-local/src/files.ts:403-462`, `frame-grid.ts:4-34`, `speech-evidence/src/transcript-document.ts:75-87`). Put labels under the picture, use real decoded times, and mark untimed gaps explicitly.
5. **Real ducking plus a clip-list audio plan** (music bed, SFX hits on overlay pops), modelled on the shape of hypit's AudioClip (window, gain, fades, loop phase; `packages/media-operations/src/types.ts:131-149`). Implement it with `sidechaincompress` or frame-rate envelopes, not per-sample `aeval`.
6. **Fail-closed stream selection** in probe: ignore attached pictures, prefer the default stream, error on ambiguity (`packages/media-operations/src/selection.ts:38-82`). Also handle rotation and SAR before `cutSegment` framing; our `scale … force_original_aspect_ratio` uses storage dimensions (`clipper/server/media.ts:108-111`), so non-square-pixel sources would be distorted (unverified on real uploads).
7. **Atomic, no-clobber output publishing:** a temp directory plus `link()` or `rename` (`packages/media-local/src/files.ts:359-373`, `614-629`). This is useful for the shared `_footage/` cache and the render outputs.
8. **Re-probe outputs and assert them** (frame count, sample count, single stream) after each ffmpeg step (`packages/media-local/src/execute.ts:735-740`, `887-898`). It turns silent ffmpeg misbehaviour into clear errors. Use it selectively, since each check costs a probe.
9. **One canonical 48 kHz stereo WAV** for internal audio, with exact frame-to-sample rounding (`packages/media/src/identity.ts:115-121`). It avoids drift between captions and audio.
10. **A raster time label that needs no drawtext** (`packages/media-local/src/files.ts:210-271`), only if a deployment's ffmpeg lacks libfreetype. Ours ships with it, so this is low priority.

## Things not to copy

- **Server-side yt-dlp with browser impersonation** (`packages/yt-dlp/src/download.ts:69-78`, `runtime/README.md:13-15`). It brings platform-ToS liability for the SaaS, anti-circumvention optics, and datacenter IP blocking. Keep "upload it yourself" (`clipper/README.md:115`).
- **Whole-file `ffprobe -show_frames` on every inspect** (`packages/media-local/src/execute.ts:271`). It is O(duration) CPU and up to 256 MB of JSON per upload, too costly per tenant on CPU-only hosts.
- **Per-sample `aeval` level automation** (`packages/media-local/src/audio-level-automation.ts:4-31`). The expression cost grows with envelope points; ffmpeg's native filters do the same job far cheaper.
- **"No normalization, no limiter" as the default mix** (`packages/media-operations/src/audio-plan.ts:88-89`). It is right for a neutral compiler, wrong for social clips. Our -14 LUFS with a true-peak ceiling is the correct product default.
- **A Python/OpenCV subprocess per image operation** (`packages/provider-image-opencv-local/src/provider.ts:97-160`). It is heavy, it has the grayscale and 16-bit bugs above, and sharp is in-process.
- **Triple description of every value** (TS type, ValueSchema and imperative validator), and the graph/Need/Producer layering. That ceremony suits a multi-author compiler, not our render pipeline.
- **Frame extraction that decodes from frame 0** (`packages/media-local/src/execute.ts:1084-1090`) and boundary detection with unbounded stdout and no merging (`files.ts:475-490`). Use input seek with a run-up, and merge nearby candidates.

---

## Coverage

Every file listed was read fully. The `uv.lock` files (`provider-image-opencv-local/runtime/uv.lock`, 56 lines, and `yt-dlp/runtime/uv.lock`, 571 lines) were scanned for pinned versions only, and `package.json` files were read where cited. Line counts are from `wc -l`.

| File | Lines | Read |
|---|---:|:---:|
