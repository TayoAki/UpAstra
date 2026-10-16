# Plan: Safety & correctness fixes

**Source PRD**: `.claude/prds/ugcmediaclips-v2.prd.md`
**Selected Milestone**: 0 — Safety & correctness fixes
**Complexity**: Small (4 independent batches, B0.1–B0.4 in `clipper/docs/BUILD-PLAN.md`)

## Summary
Four small fixes the hypit study found in our pipeline:
- subprocesses inherit secrets;
- the vision proxy's burned-in timestamps can drift from real frame times;
- the final encode isn't BT.709-tagged;
- CTA timing miscounts CJK sentences.

Each fix ships separately, test first.

## Patterns to Mirror
| Category | Source | Pattern |
|---|---|---|
| Subprocess | `clipper/server/media.ts:45-64` | `run()` wraps `spawn`, keeps the last 8 KB of stderr, SIGKILLs on timeout |
| ffmpeg args | `clipper/server/media.ts:81-94` | args arrays built inline with `netArgs(url)` |
| Segmentation | `clipper/server/align.ts:42` | `scriptWords(script, language)` is the single source of word units |
| Tests | `clipper/tests/formats.test.ts:41-44`, `:113-118` | lavfi fixtures generated in `beforeAll`; `it.skipIf(!ffmpegAvailable())` |
| Errors | `clipper/server/media.ts:57-58` | `Error` with the command and the stderr tail; nothing secret logged |

## Files to Change
| File | Action | Why |
|---|---|---|
| `clipper/server/media.ts` | UPDATE | env allowlist and process-group kill in `run()`; the `buildProxy` timestamp fix |
| `clipper/server/render.ts` | UPDATE | BT.709 convert and tag in compose; CJK-safe CTA anchor (`:305-309`) |
| `clipper/server/overlays.ts` | UPDATE | sticker overlay in `format=rgb` (`:301-305`) |
| `clipper/tests/media-env.test.ts` | CREATE | env scrub and tree-kill tests |
| `clipper/tests/proxy-time.test.ts` | CREATE | proxy timestamp accuracy test |
| `clipper/tests/color.test.ts` | CREATE | bars-through-pipeline colour test |
| `clipper/tests/render.test.ts` | UPDATE | CJK CTA cases |

## Tasks
### Task 1: Env allowlist and tree kill (B0.1)
- **Action**: Pass `env` to `spawn` with only `PATH, HOME, XDG_CACHE_HOME, LANG, LC_ALL, TMPDIR, SSL_CERT_FILE, FONTCONFIG_FILE, FONTCONFIG_PATH`, and `detached: true`. On timeout, `process.kill(-p.pid, "SIGKILL")`.
- **Mirror**: the existing `run()` shape.
- **Validate**: `npx vitest run tests/media-env.test.ts` passes: `run("sh", ["-c","env"])` shows no `OPENROUTER_API_KEY`, and a `sh -c "sleep 60 & wait"` that times out leaves no `sleep` alive.

### Task 2: Real proxy timestamps (B0.2)
- **Action**: Move `drawtext=%{pts}` ahead of `fps`, so each keyframe prints its own time, and use `fps=1:eof_action=pass` so the last keyframe isn't dropped. Benchmark a full 1 fps decode (drop `-skip_frame nokey`) on a 20-minute 1080p input, and switch to it if it is under 2× slower. Record both wall times in the commit.
- **Mirror**: the `buildProxy` args style.
- **Validate**: a 20 s fixture with keyframes forced every 5 s and the colour changing each second. Each proxy frame's label equals the second of its picture, and a frame from 15 s exists (today the label runs late by up to 4 s, and frames stop at 14).

### Task 3: BT.709 (B0.3)
- **Action**: Blend in RGB and convert once: `scale=in_color_matrix=bt709:in_range=tv,format=rgb24,ass=…` → sticker `overlay=…:format=rgb` → `scale=out_color_matrix=bt709:out_range=tv,format=yuv420p`, with the four `-color*` tags. Don't add only a trailing `out_color_matrix`: the batch 05 check measured that it shifts BT.709 footage.
- **Mirror**: the existing filter chain in compose.
- **Validate**: `color.test.ts`: ffprobe reports `bt709` in all three tags, and `#E5484D` overlay → 228,70,75 ±3 and `#3366CC` footage → 46,98,198 ±3, decoded as BT.709.

### Task 4: CJK CTA anchor (B0.4)
- **Action**: Replace `sents[...].split(" ").length` with `scriptWords(lastSentence, language).length`.
- **Mirror**: `align.ts:42`.
- **Validate**: in `render.test.ts`, the ja and zh narrations give a CTA start equal to the timed start of the last sentence's first token.

## Validation
```bash
cd clipper && npm run typecheck && npm test && npm run build
grep -rn "process.env" server/media.ts   # only the allowlist read
```
Then a production smoke test after deploy: render one clip; ffprobe shows bt709; the clip plays on iOS Safari and Android Chrome.

## Risks
| Risk | Likelihood | Mitigation |
|---|---|---|
| ffmpeg needs an env var we stripped (fontconfig, TLS CA for https inputs) | Med | Allowlist `FONTCONFIG_*` and `SSL_CERT_FILE`; run the full render test suite plus a Drive URL input |
| Full decode makes the proxy slow on long footage | Med | Benchmark gate in Task 2, with the keyframe-PTS fallback |
| A colour change visibly shifts existing brand colours | Low | The bars test; compare before and after on a brand-colour CTA |

## Parity check against hypit (fill in per task in the commit body)
- **B0.1:** `packages/media-local/src/process-env.ts:8-21`; study 09 #2, study 05 #7.
- **B0.2:** `packages/media-local/src/files.ts:375-401`; study 09 #1.
- **B0.3:** html-video `capture.ts:148-149`; study 05 #3.
- **B0.4:** study 07 §13.3.

## Acceptance
- [ ] All tasks complete
- [ ] Validation passes (verification-loop PASS report in each commit)
- [ ] Two santa-method reviewers PASS each batch
- [ ] Patterns mirrored, not reinvented
- [ ] Parity notes written; no "not to copy" item introduced
