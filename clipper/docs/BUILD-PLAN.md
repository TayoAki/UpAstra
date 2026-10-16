# Build plan: UGCMediaClips v2

**Source PRD:** [`.claude/prds/ugcmediaclips-v2.prd.md`](../../.claude/prds/ugcmediaclips-v2.prd.md)
**Evidence:** [`docs/hypit-study/`](hypit-study/README.md), a line-by-line study of hypit `dc2b7a8f` with each batch independently re-checked.
**Rule:** we re-implement ideas. We never copy Hypit source. Every batch below names the original it must match or beat, and the "not to copy" item it must stay clear of.

## Working method

Each batch is small: one PR-sized change, ideally under 400 lines of diff, that leaves `main` deployable. Every batch runs the same loop with the vendored ECC skills (`.claude/skills/`):

1. **`search-first`.** Before writing code, check what we already have (`server/media.ts`, `align.ts`, `captions.ts`, `overlays.ts`) and what an npm package already solves. Prefer extending over adding.
2. **Plan.** For a milestone, run `/plan .claude/prds/ugcmediaclips-v2.prd.md` to write `.claude/plans/mN-*.plan.md` (Patterns to Mirror, Files to Change, Tasks, Validation). M0's plan is already written.
3. **`tdd-workflow`.** Write the batch's tests first and see them fail (RED), make them pass (GREEN), then refactor. The "Tests first" lines below are the minimum.
4. **Parity check against the original.** Re-open each hypit `path:line` the batch cites and the study-note section, then write a 3-line note in the PR or commit body:
   - **Matches:** behaviour we now reproduce;
   - **Beats:** where ours is better for SaaS (repair instead of throw, CPU-cheap, no agent needed);
   - **Avoids:** the "not to copy" item, confirmed absent.
5. **`verification-loop`.** Run `npm run typecheck && npm test && npm run build`, a security grep (no keys, no `env` passthrough), and a diff review. Record the PASS/FAIL report in the commit body.
6. **`santa-method`.** Two independent reviewers (subagents) must both PASS the diff against the batch's acceptance criteria and parity note. On FAIL: fix, then re-review.
7. **Ship.** Commit, push the branch, fast-forward `main` (Railway deploys it), then run a smoke test in production against the batch's acceptance criteria. Delete any test accounts afterwards.

**Definition of done for a batch:**
- the tests are green;
- the parity note is written;
- both reviewers PASS;
- it is deployed;
- the PRD milestone status is updated when the batch's milestone closes.

Hypit paths below are relative to the hypit repo (`packages/...`, `skills/hypit/...`, written `R/` for `skills/hypit/references/`). Paths in our app are relative to `clipper/`.

---

## M0: Safety and correctness fixes (plan: `.claude/plans/m0-safety-correctness.plan.md`)

### B0.1 Scrub the subprocess environment
- **Change:** `run()` spawns ffmpeg, ffprobe and whisper with an allowlisted env containing only `PATH`, `HOME`, `XDG_CACHE_HOME`, `LANG`, `TMPDIR`, `SSL_CERT_FILE` and `FONTCONFIG_*` (fontconfig needs a cache dir; verify captions render on Railway) (`server/media.ts:47`). Kill the whole process group on timeout (`detached` plus `process.kill(-pid)`).
- **Tests first:** spawn `env` through `run()` and assert that no `OPENROUTER_API_KEY`, `DATABASE_URL` or `*_SECRET` appears; a timed-out child that spawns a grandchild leaves no live grandchild.
- **Parity:** `packages/media-local/src/process-env.ts:8-21` (hypit scrubs only on its Provider path; its `hypit media` CLI side leaks the full env, study 09 check), and the html-video `process.ts:46-55` env allowlist; tree kill in `process-tree.ts` (study 09 #2, study 05 #7). **Beats:** we keep the bounded 8 KB stderr we already have.
- **Avoid:** secrets on argv (study 02, "not to copy").

### B0.2 Real timestamps on the vision proxy
- **Measured in the batch 09 check:**
  - `buildProxy` (`server/media.ts:81-94`) decodes keyframes only, then `fps=1` re-stamps every frame with its slot time and repeats the last earlier keyframe;
  - so the burned `%{pts}` runs **late** by 0 to (GOP − 1 s), never early;
  - the last GOP is dropped (a 20 s clip with 5 s GOPs gives frames 0–14 only).
- **Change:** burn the label before the rate change (`drawtext=%{pts}` ahead of `fps`, so each keyframe prints its own time) and use `fps=1:eof_action=pass`. Benchmark this against a full decode at 1 fps on a 20-minute file, and keep full decode if it costs under 2× (it also covers footage between keyframes).
- **Tests first:** a 20 s fixture with forced 5 s keyframes and a colour change each second. Every proxy frame's label matches its picture's real second, and the 15 s keyframe is present. Re-run: `scratchpad/check09/run.sh` (local only).
- **Parity:** `packages/media-local/src/files.ts:375-401` (study 09 #1, check). **Beats:** hypit's extraction decodes from frame 0 (`execute.ts:1084-1090`); we seek.
- **Avoid:** whole-file `-show_frames` probing.

### B0.3 BT.709 colour on the final encode
- **Measured in the batch 05 check:**
  - our untagged output decodes `#E5484D` as 240,86,74 under BT.709, a shift of about +11/+14/−3;
  - ASS captions, comments and tier colours drift the same way, not only the PNG stickers;
  - the obvious fix, a trailing `scale=out_color_matrix=bt709`, re-matrixes BT.709 footage (`#3366CC` comes out 49,94,192).
- **Change:** blend in RGB, then convert once. The filter chain is `scale=in_color_matrix=bt709:in_range=tv,format=rgb24,ass=…`, then the stickers `overlay=…:format=rgb`, then `scale=out_color_matrix=bt709:out_range=tv,format=yuv420p`, with `-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv` (`server/media.ts:159-170`, `server/overlays.ts:301-305`). Measure the speed cost and record it.
- **Tests first:** both overlays and footage decode within ±3 of the source: `#E5484D` gives 228,70,75 and `#3366CC` gives about 46,98,198. ffprobe shows bt709 tags. Reference outputs: `scratchpad/check05/`.
- **Parity:** html-video `capture.ts:143-150` (study 05 #3, check). **Beats:** hypit's tail conversion is safe only because it encodes from RGB browser frames; ours composites over YUV footage.

### B0.4 CJK-safe CTA timing and length checks
- **Measured in the batch 07 check:**
  - `sentences()` (`server/captions.ts:28-33`) splits only on ASCII `.!?` plus a space, so a `。！？` narration is one sentence;
  - `render.ts:305-309` then counts it with `split(" ")` = 1, which puts the CTA (and the end of the tier overlays) at the last word;
  - `words()` (`shared/rules.ts:50`) counts unspaced zh/ja as about 1 word, so the "voiceover fits" check and the `WORDS_PER_SECOND` length maths (`rules.ts:102`, `scripts.ts:18/50/142`, `variants.ts:96`, `src/components/ClipCard.tsx:107`) are meaningless for CJK.
- **Change:**
  - `sentences()` also splits on `。！？!?` with no trailing space;
  - the CTA anchor uses `scriptWords(lastSentence, language).length` (`server/align.ts:42`);
  - `words()` counts with the same segmenter, and CJK uses about 2 characters per "word" until B5.3 replaces the estimate.
- **Tests first:**
  - a ja and a zh narration: the CTA starts at the last sentence's first token ±1 frame;
  - a 300-character Chinese script for a 15 s clip fails "voiceover fits";
  - every existing Latin result is unchanged.
- **Parity:** study 07 §13.3 #8, check.

### B0.5 Overlay layout collisions
- **Measured in the batch 08 check** (`server/overlays.ts`, 1080×1920):
  - tier items 4–6 sit only `px(26)` below items 1–3 and overlap them by about 22 px;
  - items 7–9 get exactly the same position as 4–6;
  - names in Archivo Black ("Boxed") overflow the 283 px slot, and a third-slot name can run off the frame;
  - a comment checks only the previous comment, so C can reset to the top of the band and draw over a still-visible A;
  - 3 stacked 3-line comments end 86 px below the footage band;
  - during a tier board, all comments share the same y.
- **Change:**
  - lay tier rows out as a real grid: rows sized for the item count, with a second line per tier when there are more than 3 items, shrinking the font to fit;
  - place each comment against **all** comments visible at its start, clamped to the band, falling back to a smaller card or a later start.
- **Tests first:** a rectangle-intersection check over every placed box for 1–12 tier items and 1–5 overlapping comments of 1–3 lines gives no overlaps and every box inside the frame and band. Run it for each bundled font, using advance widths from fontkit.
- **Parity:** ranking `render.ts:321` (row fit), `:472-476`; comment-sticker `program.ts:460-473` (study 08 #4, check). **Beats:** hypit throws; we repair.

---

## M1: Resumable, step-cached renders

### B1.1 Step receipts
- **Why (batch 02 check):**
  - every resume re-records the voiceover: a fresh temp dir per render (`server/render.ts:135`) and `speak()` always runs (`:203`);
  - a resumed format breakdown re-pays for vision (`server/formats.ts:151`);
  - resumes skip `checkAIBudget` entirely (it is reached only via `spendAI` at enqueue, `server/llm.ts:48`);
  - the boot scan doesn't resume formats (`server/db.ts:147-155`).
- **Change:** a `render_steps` record per render: `{renderId, step, key, status: started|done|failed, outputKey, costUsd, at}`. Write `started` before every paid or expensive step (TTS, vision, transcription, cut, compose) and `done` with the output key after it.
- **Tests first:**
  - kill a render after TTS. On resume, the TTS mock is called 0 more times and the render completes.
  - an unknown outcome (a `started` with no `done` on a paid step) is surfaced as "needs attention", never silently repeated;
  - a resume runs `checkAIBudget` before any paid step;
  - the boot scan also resumes format breakdowns.
- **Parity:** at-most-once receipts in `packages/runtime-local/.../worker.ts:85-117` and `executor.ts:388-407` (study 02 #2). **Beats:** hypit fails in-flight jobs on restart (`supervisor.ts:103-106`); we resume from the last `done`.
- **Avoid:** whole-build failure on one step.

### B1.2 Content-hash step keys and cross-variant reuse
- **Change:** `key = sha256(kind@version + canonical params + input keys)`, scoped per workspace. A `done` step with the same key is reused as a forward, never a copy, so A/B variants share shots and voice.
- **Tests first:**
  - two variants with the same footage and voice run the cut step once;
  - bumping `kind@version` invalidates the cached step;
  - canonical JSON sorts keys by code point (not `localeCompare`).
- **Parity:** `packages/kernel/src/plan.ts:131-297`; `packages/result/src/node/store.ts:370-395` (study 01 #1, #2, #5). **Beats:** hypit has no content identity (`packages/protocol/src/identity.ts:1`).
- **Avoid:** ids built from absolute paths, and `localeCompare` (study 01, "not to copy").

### B1.3 One weighted capacity controller
- **Change:** replace the three single-slot queues (render, captions, formats) with one controller. Each job type has a CPU weight, workspaces are served round-robin, and in-flight work is claimed first.
- **Tests first:**
  - with capacity 2, a weight-2 render blocks two caption jobs;
  - two workspaces alternate;
  - an enqueue wakes the controller with no polling delay.
- **Parity:** `packages/runtime/src/capacity.ts:1-51` (study 02 #1). **Beats:** the check found hypit's runtime-local admits builds oldest-first (`sqlite-state.ts:615-618`). Its round-robin cursor (`scheduler.ts:176-196`) works only inside one build. Ours is round-robin across tenants, which is a SaaS need.
- **Avoid:** 25 ms busy polling, and the O(n) reservation scan.

### B1.4 Cancel and log
- **Change:** `POST /api/clips/:id/render/cancel`, with a durable stop where the first cause wins, and a per-render execution log (`step`, `ms`, the stderr tail) stored with the output. Add a "Retry upload only" path for the "result attention" state.
- **Tests first:**
  - cancel mid-cut kills ffmpeg and leaves the clip `cancelled`;
  - deleting a clip, caption job or format stops its running job (today it doesn't, batch 02 check);
  - a 429 or 5xx from OpenRouter retries with `Retry-After` and backoff (today only the 400 fallback exists, `server/llm.ts:197-201`);
  - the log endpoint returns the steps in order, with `omitted` counts.
- **Parity:** `sqlite-state.ts:783-801`, `packages/runtime-local/src/log.ts:14-47`, `result-writer.ts:174-194` (study 02 #5, #6).

---

## M2: Captions that always fit

### B2.1 Per-word separators
- **Change:** each timed word carries `sep` (`" "` or `""`), set by script segmentation. `groupWords`, `buildAss`, the editor caption parts (`server/render.ts:353`) and `CaptionsView` join with `sep` instead of `" "`.
- **Tests first:** Japanese, Chinese and mixed EN/JA text produce no stray spaces in ASS and editor parts; Latin output is unchanged (golden snapshot).
- **Parity:** `packages/caption/src/types.ts:5-6`, `packages/caption-fine/src/spacing.ts:6-16` (study 06 #1).

### B2.2 Measured line budget, re-split instead of throw
- **Change:** measure group width with the libass-measured widths from M0 (`server/font-metrics.ts`, `scripts/measure-fonts.mjs`) against `W − 2·margin`. Also measure **uploaded brand fonts** at upload time the same way and store the widths with the font; today unknown fonts use the bundled maximum + 30%, which is safe but shrinks text more than needed (M0 santa review), insert `\N`, and re-split a group that needs more than 2 lines at the best word boundary, recursively.
- **Tests first:**
  - a long German compound and a 40-character brand name never exceed the safe width or 2 lines;
  - groups are re-split, never dropped.
- **Parity:** `packages/caption-fine/src/render.ts:628-639`, `:719-724` (study 06 #2). **Beats:** hypit throws on overflow; we repair.

### B2.3 Bottom-anchored block, scaled outline, pause-aware highlight
- **Change:**
  - use `\an2`, with `y` as the bottom edge;
  - outline = size/12, shadow ≈ size/40;
  - the highlight holds through gaps under 0.35 s and drops on longer ones (the threshold is tuned in tests).
- **Tests first:**
  - a 3-line group grows upward;
  - a size override of 2× doubles the outline;
  - a 1 s pause shows no active word.
- **Parity:** caption-fine `README.md:73`, `render.ts:594-598`, `manifest.ts:101-129`, `render.ts:646-663` (study 06 #3, #6, #7).

### B2.4 Four new presets and the spring entrance
- **Change:**
  - add "box highlight", "underline", "fill sweep" (`\kf`) and "accumulate", all native ASS;
  - make the entrance spring 72% → 105% → 95% → 100% in chained `\t`;
  - give custom styles a strict schema.
- **Tests first:**
  - an ASS snapshot per preset;
  - `\kf` produces one event per group;
  - unknown style keys are rejected.
- **Parity:** caption-fine `render.ts:441-516`, `:939-967`, `:365-373`, `style.ts:98-133` (study 06 #5, #9, #10).
- **Avoid:** the ~110-knob parameter explosion (study 06, "not to copy"); we ship 8–12 curated presets.

---

## M3: Shots that land on their words

### B3.1 Phrase-bound shots
- **Change:** the planner gives each shot a `phrase` (words in the narration). Render sizes each shot from the aligned phrase start to the next shot's phrase start, replacing proportional seconds (`server/render.ts:252-262`). If a phrase can't be aligned, that shot falls back to proportional sizing and the fallback is logged.
- **Tests first:**
  - with a mocked alignment, each shot starts within 1 frame of its phrase;
  - one missing phrase triggers the fallback for that shot only;
  - total length is preserved.
- **Parity:** `R/production/component-design.md:140-144`, `R/playbooks/formats/narration-led-demo.md:30-49` (study 11 #1, #2). **Beats:** hypit needs an agent to author the bindings; our planner emits them and render checks them.

### B3.2 Visual pre-scan: snap to cuts, skip black frames
- **Change:** one low-res pass per footage file, cached with the moments. It combines a 32×32 frame-difference score with `blackdetect`. Shot in-points snap to the nearest cut within 0.4 s and avoid black spans.
- **Tests first:** the black/white/black fixture (as in `tests/formats.test.ts`) yields cuts at 4 s and 8 s; a shot asked to start at 3.8 s snaps to 4.0 s.
- **Parity:** `packages/media-local/src/files.ts:467-491` (study 09 #3).
- **Avoid:** an unbounded boundary stdout; nearby candidates are merged.

### B3.3 Planner rules: evidence, not noun illustration
- **Change:** add the short imperative role list (context, proof, B-roll, screen) and the "visual evidence" rule to the clip planner prompt. Metered prompt tokens must not grow by more than 150.
- **Tests first:** a prompt snapshot; a token count assertion.
- **Parity:** study 11 #2.
- **Avoid:** the abstract prose register (study 11, "not to copy").

---

## M4: Overlays and sound that move with speech

### B4.1 Reveal → settle schedule
- **Change:** each overlay item gets a reveal window from its cue to the next cue, then a settled span. Tier items stage, then glide (split `\move` events). Windows are cumulative for tier lists and exclusive for comments, and triggers must be strictly increasing (clamped and logged, not thrown).
- **Tests first:**
  - three tier cues at 1, 2 and 3 s give windows [1,2) [2,3) [3,end);
  - a reversed cue is clamped and logged.
- **Parity:** `packages/ranking/src/schedule.ts:445-519`; study 07 #7 (`resolveTriggeredSchedule`); study 08 #1.
- **Avoid:** per-frame keyframe baking.

### B4.2 Motion fitting
- **Change:** a short window compresses appear+move proportionally, and the glide still ends at the window end. This replaces the fixed 180 ms drop and 2.8 s holds.
- **Tests first:** a 0.3 s window keeps the motion inside it; a 3 s window uses the full-length motion.
- **Parity:** `schedule.ts:699-743` (study 08 #2).

### B4.3 Fit validation with repair
- **Known from the M0 review:** comment cards now avoid the hook, pop words and stickers, but stickers and pop words can still sit on a tier board (and stickers on each other's corners when more than 4 are up at once).
- **Change:**
  - the grid fix from B0.5 is extended to Top-N and podium;
  - long tier names are measured and wrapped with an ellipsis (replacing `wrap()` by character count at `server/overlays.ts:88-104`);
  - comment cards fit their text box.
- **Tests first:**
  - 9 items in one tier never overlap (a rectangle-intersection check);
  - a 60-character name stays inside its cell.
- **Parity:** ranking `render.ts:321`, `:472-476`; comment-sticker `program.ts:460-473` (study 08 #4, #7). **Beats:** hypit throws (`ranking/src/manifest.ts:625`).

### B4.4 SFX and ducking (opt-in per brief)
- **Change:**
  - SFX events come from the same phase frames as the overlay reveals and are mixed with `adelay`/`amix` at a per-kind gain, before `loudnorm`;
  - music ducks under speech with `sidechaincompress`.
- **Tests first:**
  - an overlay at 2.0 s produces an SFX onset at 2.0 s ±10 ms (an energy probe);
  - integrated loudness is −14 LUFS ±1;
  - SFX off means a bit-identical audio graph to today's.
- **Parity:** ranking `schedule.ts:826-866`, `render.ts:652-697`; `R/playbooks/craft/sound-mix.md:35-44` (study 08 #3, study 11 #7).
- **Avoid:** per-sample `aeval`, and an "unnormalized mix" default (study 09, "not to copy").

### B4.5 Comment card polish
- **Change:**
  - −2.5° tilt;
  - a pop with the rotation unwinding;
  - a float during the hold;
  - a fade-up exit;
  - a speech tail;
  - a "Reply to @x" header, shown only when supplied and never fabricated.
- **Tests first:** an ASS snapshot; with no author given, there is no "Reply to" line.
- **Parity:** `packages/comment-sticker/src/author.ts:86-147` (study 08 #6).

---

## M5: Script that says one thing and shows another

### B5.1 Display/spoken markup
- **Change:**
  - `<display|spoken>`, `word{emphasis}`, `@{moment}` and `||` in `narration`;
  - TTS gets the spoken side;
  - captions get the display side, with N:M unit timing;
  - overlays may cue on `@{moment}`;
  - the planner emits the markup.
- **Tests first:**
  - `<$5|five dollars>` makes the TTS mock hear "five dollars" while the caption shows "$5", timed over both spoken words;
  - an unknown moment is a validation error with a JSON pointer.
- **Parity:** `R/creation/script-and-time.md:58-111`; `packages/narrative-caption/src/project.ts:31-57` (study 07 #2, study 11 #6).
- **Avoid:** an XML author language.

### B5.2 M:N aligner upgrade
- **Change:** extend `alignScript` (`server/align.ts:54`) with 1..4×1..4 groups, an unbounded exact split/merge for longer runs when the concatenations are equal, omission 0.5 and insertion 0.35 (which differ from our free edges, so keep ours at the edges), a 0.055 cost for "same letters, different segmentation", continuous edit-distance costs, deterministic tie-breaks and character-proportional splitting. Keep the free edges and the retake trim.
- **Tests first:**
  - "website" vs "web site";
  - a brand merged or split by ASR;
  - CJK;
  - every existing `tests/align.test.ts` case still passes;
  - overlapping or nested ASR word windows (e.g. `one [0.1,0.5]`, `two [0.4,0.8]` with "big" omitted) are clamped to monotonic and logged, never thrown. Hypit throws here (`narrative-temporal/src/identity.ts:42-43`, study 07 check).
- **Parity:** study 07 §1, §13.1.
- **Avoid:** charging for leading chatter, and throw-on-imperfection sealing.

### B5.3 Speech estimate v2
- **Change:** count syllables (Latin) and characters (CJK), expand digits, and calibrate per voice and language from measured `spokenSec`. This replaces `WORDS_PER_SECOND = 2.6` (`shared/rules.ts:49`, used in `scripts.ts` and `variants.ts`).
- **Tests first:**
  - "1,250" is estimated as "one thousand two hundred fifty";
  - after 5 calibration samples, the error is under 10% on held-out fixtures.
- **Parity:** study 07 #4, study 11 #5.
- **Avoid:** digits counted as zero.

### B5.4 Confidence-weighted alignment and speech bounds
- **Change:** use whisper.cpp token probabilities (`-ojf`) with a `0.5 + 0.5·score` cost multiplier, and bound unmatched edge words by the `silencedetect` speech envelope.
- **Tests first:** a low-confidence ASR word loses a tie against a high-confidence one; unmatched trailing words never extend past the end of speech.
- **Parity:** study 07 #5, #6.

---

## M6: Agents that can see and plan spend

### B6.1 `get_frames`, `contact_sheet` and `scene_cuts` MCP tools
- **Change:**
  - use Hypit's defaults: 3 columns × 480 px cells, `clamp(round(1.5·s), 4, 9)` frames, 3 rows per page;
  - support `aroundPhrase` with an `occurrence` parameter;
  - labels go under the picture and use real decoded times;
  - the tools return MCP image content or signed URLs.
- **Tests first:**
  - a 6 s window gives 9 frames;
  - `aroundPhrase` resolves against the timed words;
  - the sheet image is 1440 px wide.
- **Parity:** the CLI `media tile/tiles/frames/boundaries` commands (study 03 #1); `packages/media-local/src/files.ts:403-462` (study 09 #4).

### B6.2 Strict schemas, structured errors and `next` hints
- **Change:**
  - every MCP tool uses `.strict()` zod schemas;
  - errors take the form `{ok:false,error:{code,message,help}}`, with stable codes (`QUOTA_EXCEEDED`, `FOOTAGE_MISSING`, `QA_FAILED`, …);
  - every state-changing tool returns `next:[{tool,args,why}]`;
  - every result carries `format:"ugc.<tool>@1"`.
- **Tests first:**
  - `formatID` (a typo) gives `INVALID_ARGUMENT`;
  - every tool's result carries `format`;
  - `render_clip` returns a `next` hint pointing to `wait_for_renders`.
- **Parity:** cli `output.ts:1028-1039`, `arguments.ts:299-305` (study 03 #3–#5).

### B6.3 Preflight and dry run
- **Change:** `preflight_render(clipIds)`, plus `dryRun` on `render_clip` and `brief_to_shorts`. These report whether footage is cached, which moments are pending (a vision cost), the voice cost, the queue position, remaining quota and blockers. A real call refuses before queuing, with "nothing was charged".
- **Tests first:** a dry run makes 0 paid calls and its estimate matches the real run within 10%; an over-quota request is refused with no usage recorded.
- **Parity:** `build-planning.ts:409-439` (study 03 #2).

### B6.4 `transcribe`, `estimate_voiceover`, `cancel_render`, `get_render_log`, and cheaper waits
- **Change:**
  - add the four tools;
  - give each clip a status endpoint, so `wait_for_renders` doesn't refetch the full `/state`;
  - back off from 100 ms to 1 s on change;
  - end a wait when the worker has stopped, with evidence, instead of timing out.
- **Tests first:** `transcribe` returns word timings; the wait uses the status endpoint and ends early on a stopped worker.
- **Parity:** study 03 #6–#9.

---

## M7: Instant preview and review

### B7.1 Browser libass preview
- **Change:** render the stored ASS over a proxy `<video>` with a libass WASM build, so caption and overlay edits preview with no render meter. Add a recompose-only server path, which runs only compose from cached steps.
- **Tests first:**
  - Playwright: changing a caption style updates the preview with 0 render calls;
  - a recompose-only render reuses the cut steps (B1.2).
- **Parity:** studio `preview/render.ts:28-61` (study 04 #1). **Beats:** no Chrome compositing on the server.

### B7.2 Revisioned plan edits
- **Change:** every clip-plan edit (ClipCard, the editor bridge, MCP `edit_clip`) carries `baseRevision`. A stale edit gets 409. An edit that fails QA rolls back.
- **Tests first:** concurrent agent and human edits give one 409 and no lost write; a QA-failing edit leaves the plan unchanged.
- **Parity:** studio `server.ts:188-238`, `:412-455` (study 04 #2).

### B7.3 Timestamped review comments
- **Change:** each clip gets comments `{at, text, resolved}`. The in-app agent can read them, and "apply comments" re-plans.
- **Tests first:** create, resolve and list comments; the agent context includes the unresolved ones.
- **Parity:** studio `feedback*.ts` (study 04 #5).

### B7.4 Hover-scrub and a storyboard atlas
- **Change:**
  - add a muted, lazy second player for hover-scrub in `RenderPanel` and `FormatsView`;
  - build one `tile` PNG atlas per footage file, cached in S3.
- **Tests first:** the atlas has at most 360 tiles for any length (hypit caps only videos up to 360 s, study 04 check) and is cached on the second request.
- **Parity:** studio `ui/scrub-preview.ts`, `storyboard.ts` (study 04 #4, #9).

---

## M8: New formats

### B8.1 Top-N column and podium overlays
- **Change:** two new overlay kinds that reuse the B4.1 schedule.
- **Tests first:** ASS snapshots; the fit check from B4.3 passes.
- **Parity:** `packages/ranking/src/render.ts:464-650` (study 08 #5).

### B8.2 Quiz answer strip
- **Change:** a new overlay built from the emoji sticker pipeline (`server/overlays.ts:261`).
- **Tests first:** the strip stays in frame for 2–4 answers.
- **Parity:** `packages/interview-emoji-reveal/src/program.ts:196-199` (study 08 #9).

### B8.3 Richer format breakdowns
- **Change:**
  - `cleanBreakdown` (`server/formats.ts:179`) records `anchor`, `job`, persistent systems and the measured speech rate;
  - `formatForPlanner` passes relationships, not raw seconds;
  - transformation lenses ("remove a system → redistribute its job") cover footage that lacks the reference's elements.
- **Tests first:** fixture snapshots of `cleanBreakdown` and `formatForPlanner` (study 11, "not to copy": test the examples).
- **Parity:** `R/creation/reference-video.md:17-21`, `:39-43`, `:212-214`; `R/creation/transformations.md:31-44` (study 11 #4, #10).

---

## Order and sizing

| Order | Batch | Size | Depends on |
|---|---|---|---|
| 1 | B0.1–B0.5 | S each (B0.5 M) | — |
| 2 | B1.1 → B1.2 → B1.3 → B1.4 | M, M, M, S | B1.1 first |
| 3 | B2.1 → B2.2 → B2.3 → B2.4 | S, M, S, M | B2.1 before B2.2 |
| 4 | B3.2 → B3.1 → B3.3 | M, M, S | the aligner as it is today |
| 5 | B4.1 → B4.2 → B4.3 → B4.5 → B4.4 | M, S, M, S, M | B4.1 |
| 6 | B5.3 → B5.2 → B5.1 → B5.4 | S, L, L, S | B5.2 before B5.1 |
| 7 | B6.2 → B6.3 → B6.1 → B6.4 | S, M, M, M | B1.4 for cancel and log |
| 8 | B7.2 → B7.1 → B7.3 → B7.4 | M, L, S, S | B1.2 for recompose |
| 9 | B8.1–B8.3 | M, S, M | B4.1, B4.3 |

## Never build (from the study's "not to copy" lists)
- Headless-Chrome compositing of footage (study 05).
- An author markup language, package system, generic build graph or producer ceremony (studies 01, 04, 06–10).
- Server-side yt-dlp (study 09).
- WhisperX or torch on Railway (study 07).
- Throwing at render time on imperfect input: we repair and log (studies 06, 07, 08).
- Per-frame keyframe baking, or per-sample `aeval` (studies 08, 09).
- Inline `data:` URL bodies, and uploads that are never cleaned up (study 10).
- Beauty-superlative casting templates (study 11).
