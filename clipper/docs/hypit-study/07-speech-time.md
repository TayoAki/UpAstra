# 07 · Speech, alignment & time

**Batch:** 07 "Speech, alignment & time"
**Source:** `hypit` at commit `dc2b7a8f31b1ef1443a79ca448548d69e3ceb6a0` (read-only; nothing installed, built or run)
**Compared against:** `clipper/server/align.ts` (147 lines), `clipper/server/transcribe.ts` (76), `clipper/server/render.ts` (383), plus the helpers render.ts calls (`captions.ts` `timeWords`, `media.ts` `speechSpans`, `overlays.ts` `placeOverlays`, `shared/rules.ts` `WORDS_PER_SECOND`).

| Package | src lines | test lines | docs + package.json | Tests |
| --- | ---: | ---: | ---: | --- |
| `packages/whisperx` (`@hypit/whisperx`) | 614 | 341 | 128 | 10 |
| `packages/provider-whisperx-local` (TS 462 + Python 855) | 1,317 | 508 | 355 (+ `uv.lock` 3,381) | 7 TS + 18 Python |
| `packages/narrative-speech-alignment` | 1,054 | 431 | 75 | 16 |
| `packages/speech-estimate` | 439 | 181 | 118 | 13 |
| `packages/speech-evidence` | 412 | 119 | 61 | 6 |
| `packages/narrative` | 390 | 0 | 56 | 0 |
| `packages/narrative-temporal` | 799 | 136 | 69 | 6 |
| `packages/temporal` | 1,190 | 220 | 128 | 15 |
| `packages/timeline` | 142 | 0 | 55 | 0 |
| `packages/timeline-author` | 1,194 | 302 | 185 (+ a 720×1280 placeholder `preview/Track.png`) | 13 |
| `packages/script` | 2,064 | 945 | 264 | ~50 declarations; 3 expand over fixture lists |
| `packages/author` | 1,125 | 458 | 94 | 6 |
| **Total** | **10,740** | **3,641** | | |

Line counts come from `wc -l`. The ~10.7k in the brief matches the `src` total.

---

## 0. Summary

1. **The aligner is the gem of this batch.** `narrative-speech-alignment` aligns a known script to recognized words. Clipper solves the same problem in `align.ts`, but hypit's version is clearly better in three ways:
   - it uses an M:N dynamic program with explicit group types (exact, split, merge, replacement, omission, insertion);
   - its cost scales with the recognizer's confidence scores;
   - it splits word times inside merge groups character by character.

   It quantizes to frames once, at the end. §1 and §13 have the details.
2. **Some of that machinery never runs in the shipped path.** The one shared wire interpreter, `interpretWhisperXTranscript`, hard-codes `chars: []` in both of its branches (segments at `packages/whisperx/src/transcript.ts:78`, top-level words at `:93`). Both evidence providers in the repo go through it: `provider-whisperx-local/src/provider.ts:57`, `:180`, and the out-of-batch remote `provider-hypihub/src/provider.ts:620-624` (OpenAI-style `verbose_json` word timestamps). The Python service also calls `align(..., return_char_alignments=False)` (`packages/provider-whisperx-local/runtime/src/hypit_whisperx_service/engine.py:193-200`). A `git grep` of the whole hypit repo for `speechActivity` and `chars:` finds no non-test producer: the only writers are the type and schema in `speech-evidence/src/index.ts:55`, `:100`, the locator's internal buckets (`locate.ts:174-175`), and test fixtures (`speech-align.test.ts:68-73`, `evidence.test.ts:49-50`, `provider-hypihub/test/provider.test.ts:774`). The aligner's character timing and VAD bounds are therefore only exercised by hand-built test fixtures. In production, every group's characters are synthetic, even-split letters of the word window (`locate.ts:245`, `:206-227`), so merge groups "divide the evidence word by letter count". Unmeasured edge runs are bounded by the whole Segment: a leading run by `[0, first located start)` and a trailing run by `[last located end, frameCount)`, or all of `[0, frameCount)` when nothing is located (`locate.ts:352-355`, `:373-374`). *(corrected in check: it is one interpreter with two branches, used by two providers; edge bounds made precise)*
3. **Likely crash path.** The locator deliberately lets overlapping or backward evidence through (`locate.ts:77`, and the test at `speech-align.test.ts:289-302`). The next step, `sealNarrativeAlignment`, then rejects any token whose start or end goes backwards (`packages/narrative-temporal/src/identity.ts:36-47`). An omitted word next to overlapping WhisperX words gets a zero-width window at the left neighbour's end (`locate.ts:373-375`). That can make the following token's start earlier than the filled token's start, which throws instead of degrading. No test covers locate followed by materialize on overlapping evidence. This is inferred from reading the code; I did not run it.
   - **Check: confirmed by an end-to-end static trace (not executed).** Take script "one big two" with evidence `one [0.1,0.5]`, `two [0.4,0.8]` at the test clock of 1000 fps. The DP picks exact, omission (0.5), exact, because the cheapest alternative, a 2:1 "one big"↔"one" merge, costs 0.5·0.8 + 0.055 + 0.06 = 0.515 (`align.ts:71-77`, `:237`). `fillMissingTiming` gives "big" `left = 8000`, `right = 6400`, `usableRight = 8000` (`locate.ts:373-375`). That is a zero-width window, which `projectSampleTiming` widens to `[500,501)` (`:419-422`). "two" stays `[400,800)`. `alignNarrative` → `materializeNarrativeAlignment` → `sealNarrativeAlignment` (`local.ts:95-98`, `materialize.ts:47-49`) then hits `start 400 < previousStart 500` and throws "NarrativeAlignment Token … is invalid" (`narrative-temporal/src/identity.ts:42-43`). Nested windows (a later word ending before the earlier one ends) also throw on the `end < previousEnd` clause without any omission. Neither evidence sealing (`speech-evidence/src/index.ts:170-218`) nor the wire interpreter (`whisperx/src/transcript.ts:32-43`) rejects overlap or ordering. How often WhisperX or HypiHub emit such windows is plausible but not measured.
4. **WhisperX contract.** It is a warm, single-flight, loopback-only Python service:
   - `GET /health` returns an identity handshake;
   - `POST /transcribe` takes `{audio_path, language}` and returns `{language, segments[{text,start,end,words[{text,start,end,score}]}]}`.

   It is ASR plus wav2vec2 alignment of the ASR's *own* transcript, not forced alignment of the script. The script DP runs afterwards, exactly as in clipper.
5. **Time model.** Everything is in integer frames on a rational clock, with half-open `[start,end)` windows and exact `bigint` arithmetic:
   - `timeline-author` builds the program length from a small DAG of `from`/`until`/`for` and `earliest()`/`latest()`;
   - `temporal` adds a *triggered schedule* (cumulative and exclusive windows), which maps directly onto our tier overlays.

   I also found a probable lowering bug in `temporal/markup` (§9.5).
6. **`script` is the second idea worth taking.** Its `<display | spoken>` "Dual Text", `||` caption cue breaks, `{emphasis}` word attributes and `@{moment!}` anchors solve problems clipper currently handles with fuzzy matching: brand pronunciation, number captions, overlay cue words and highlight words.

---

## 1. `@hypit/narrative-speech-alignment` — the M:N monotonic aligner

**Purpose.** This package is a deterministic, provider-neutral locator. It takes one authored Script Segment plus measured speech evidence in 16 kHz sample coordinates. It returns a frame for every token boundary, quantized once into the Segment's local frame domain. It never calls a model and keeps no alternative paths (`README.md:3-21`).

**Public surface** (`src/index.ts:1-8`):
- `alignWordGroups` (`align.ts:120`);
- `alignNarrative` (`local.ts:30`);
- `materializeNarrativeAlignment` (`materialize.ts:27`);
- `alignCharacters`, `alignmentCharacters`, `normalizeForAlignment` (`normalize.ts`);
- `SpeechAlignmentError` (`error.ts:1`);
- one Producer, `align-narrative`, with inputs narrative, segment, domain and evidence, and output `NarrativeAlignment` (`manifest.ts:12-23`, `component.ts:17-32`).

### 1.1 Normalization
- Words are compared after NFKC normalization, `toLocaleLowerCase("en")`, and removal of everything except letters, marks and numbers (`normalize.ts:1-6`). Script tokens are normalized by an identical function in the parser (`packages/script/src/parser.ts:57-62`). The exact-match fast path depends on the two staying identical.
- Clipper's `norm` additionally strips diacritics (NFKD plus combining-mark removal, `clipper/server/align.ts:21`). Hypit keeps marks, so "café" and "cafe" differ there.

### 1.2 The DP (`align.ts`)
- **Fast path.** If every source token's normalized text equals the evidence word at the same index, the code returns 1:1 `exact` groups in O(n) (`align.ts:129-139`). The test covers 800 tokens (`speech-align.test.ts:142-159`).
- **State.** The table holds `(sourceIndex, evidenceIndex)` cells over a full `(n+1)×(m+1)` array. Each cell carries:
  - `cost`;
  - `exactTokens`, `omissions`, `insertions` and `complexity`;
  - a back-pointer and the chosen group (`align.ts:10-19`, `:140-158`).
- **Transitions from each reachable cell** (`align.ts:188-260`):
  - **paired group** `s×e` with `1 ≤ s,e ≤ 4` (`DEFAULT_MAX_GROUP = 4`, `:8`; loops at `:214-218`);
  - **unbounded exact split or merge.** If the concatenated next k evidence words spell exactly the next source token (or the reverse), a `1:k` or `k:1` pair is also offered even when k > 4 (`exactRunLength` at `:80-89`, used at `:219-223`). A Chinese reading of "ElevenLabs" emitted as 10 letters still forms one `split` (test at `:413-421`);
  - **source omission**, cost **0.5** per token (`:224-241`);
  - **evidence insertion**, cost **0.35** per word (`:242-258`).
- **Paired cost** (`pairedCost`, `:63-78`):
  - If the concatenated normalized texts are identical, the cost is **0** for 1:1 and a flat **0.055** for any other segmentation (`:71`). A tokenization difference therefore never grows with word length.
  - Otherwise the cost is `charEditDistance/maxLen × reliability + 0.055 × (s+e−2) + 0.06 × (s+e − 2·exactWordLCS)` (`:72-77`).
  - `reliability` = `0.5 + 0.5 × mean(score)` over the evidence words, or **0.8** when no scores exist (`:25-32`). Low-confidence recognition makes a mismatch *cheaper*, which is a nice touch.
  - `exactWordLCS` is a word-level LCS inside the group (`:34-48`). It rewards groups whose words partly match exactly.
- **Group labels** (`relation`, `:50-61`):
  - `exact` is 1:1 with an identical normalized word;
  - `merge` is many source words to one evidence word;
  - `split` is one source word to many evidence words;
  - `replacement` is any other pair;
  - `source-omission` and `evidence-insertion` have an empty side.
- **Deterministic tie-break** (`better`, `:91-99`): lower cost (ε = 1e-9), then more exact tokens, then fewer omissions, then fewer insertions, then lower complexity.
- **Ends are not free.** The backtrace starts at `(n, m)` (`:262-272`). Leading and trailing chatter are charged 0.35 per word, unlike clipper's free edges (§13).
- **Complexity.** The worst case is ~16·n·m `pairedCost` calls. Each one re-normalizes strings, runs a char edit distance and runs a word LCS. There is no band or pruning. That is fine for one Segment (tens to hundreds of words) but quadratic in memory and time for long material.

### 1.3 From groups to times (`locate.ts`)
1. **Validation.** The evidence `domainId` must equal the basis domain. `sampleFrames` must equal `frameCount·16000·den/num`, rounded half-up (`:126-133`, `:34-43`). Overlapping, collapsed or backward provider windows are deliberately allowed; only windows outside `[0, sampleFrames]` or with exactly one end missing are rejected (`:77-92`).
2. **Partitioning.** Words, characters and VAD spans are assigned to Segments by midpoint (`partitionEvidence`, `:162-200`). With one Segment this is a no-op, because the basis is forced to exactly one Segment (`:105-107`).
3. **Character timing.**
   - The provider's characters are aligned to the word's expected characters with a deterministic Levenshtein backtrace in which diagonal steps win ties (`normalize.ts:35-79`, used at `locate.ts:229-260`).
   - Unmatched characters get *synthetic* times: an even split of the word window (`:206-227`).
   - Word scores are averaged with their characters' scores (`:266-278`).
4. **Per-group placement** (`locatePairedGroup`, `:298-339`):
   - A single source token takes the whole group window: min start to max end over the group's words and characters (`:280-296`, `:325-327`).
   - With several source tokens (merge or replacement), each token takes the first and last timed evidence characters paired with its own characters. The first token's start and the last token's end snap to the group window (`:328-333`).
   - Empty or reversed results become "unmeasured" (`:334-335`).
5. **Filling gaps** (`fillMissingTiming`, `:358-390`).
   - Each run of unmeasured tokens is spread between the left neighbour's end and the right neighbour's start. Weights are normalized character counts, minimum 1 (`:376-378`).
   - The outer bounds are the VAD span envelope, or the whole Segment when there is no VAD (`speechBounds`, `:341-356`).
   - If the right bound is before the left, `usableRight = max(left, right)` produces zero-width windows (`:375`).
6. **Quantization, done once** (`:392-423`):
   - the start frame is `floor(sample·num / (16000·den))`;
   - the end frame is `ceil(...)`, clamped to frameCount;
   - an empty result becomes the single containing frame `[f, f+1)` with `f = min(frameCount−1, startFrame)`. The start frame is also clamped to frameCount (`:414`, `:421-422`). *(detail added in check)*

   Several tokens can therefore share frames. The "pigeonhole" test checks three tokens inside two frames: `[10,11],[10,12],[11,12]` (`speech-align.test.ts:338-356`).
7. **Boundaries.** Segment anchors map to frame 0 and frameCount. Token anchors map to the token's start and end frames (`:466-477`).

`materializeNarrativeAlignment` checks that every token has a non-empty frame window. It then publishes only *boundary ids → frames*. Token timing lives in boundaries, not in token objects (`materialize.ts:27-50`). Sealing then runs `assertNarrativeAlignmentIdentity`, which requires non-decreasing token starts and ends (`packages/narrative-temporal/src/identity.ts:36-47`). That rule collides with the permissive locator (Summary §0.3).

### 1.4 Tests (16, `test/speech-align.test.ts`)
Examples of what is asserted:
- exact words give frame windows `[100,400],[500,900]` at a 1000-fps test clock (`:121-140`);
- with character evidence, M:1 "can not"↔"cannot" splits at character times `[100,360],[420,780]`, not by letter count (`:184-206`);
- 1:N "website"↔"web site" wraps both words `[200,820]` (`:208-221`);
- a filler "uh" stays an insertion without absorbing neighbours (`:223-250`);
- an omitted word receives the whole gap `[400,600]` (`:252-271`);
- VAD bounds contain tokens when there are no words (`:273-287`);
- overlap is preserved (`:289-302`);
- locating is total even for gibberish (`:304-319`);
- a collapsed WhisperX word (`start == end`) is filled from its neighbours (`:321-336`);
- quantization at 30 fps: 0.111–0.289 s becomes frames `[3,9)` (`:375-395`);
- backward character measurements are treated as missing (`:397-411`);
- CJK merge and split (`:413-431`).

### 1.5 Quality notes
- **Strong:**
  - a principled cost model with confidence weighting;
  - exact-segmentation awareness;
  - deterministic tie-breaks;
  - integer sample and frame math with explicit rounding (bigint half-up, floor for starts, ceil for ends);
  - the guarantee that every token is located;
  - good fixture tests named after real failure modes.
- **Weak:**
  - The character and VAD code paths have no producer in the repo (§0.2), so the headline test at `:184-206` does not describe production behaviour.
  - No banding, and `pairedCost` recomputes normalization inside the innermost loop (`:67-68`, `:192-197`).
  - Leading chatter is charged instead of trimmed. With no VAD, a leading omitted token is stretched from frame 0.
  - The permissive locator conflicts with strict sealing (§0.3).
  - `partitionEvidence` is multi-Segment code that can only ever see one Segment.

**Relevance: High.** This is the same job as `clipper/server/align.ts`, and it does it better in the cases we hit: merged brand names, split compounds, and numbers read as words.

**Better version for us.** Keep clipper's free-edge DP and the chatter trim that render.ts relies on, then add:
- M:N groups (cap 3 per side), plus the unbounded exact split and merge rule;
- the "identical concatenation costs 0.055" rule;
- confidence-weighted costs, using whisper.cpp token probabilities (needs `-ojf` full JSON; we currently request `-oj`, `transcribe.ts:49`);
- a proportional character split inside merge groups;
- gap filling bounded by our existing `silencedetect` spans rather than by neighbours alone;
- enforced monotonic, non-overlapping output (captions want that);
- one quantization to 30-fps frames at the end.

All of this is pure CPU, a few hundred lines, and needs no new dependencies.

---

## 2. `@hypit/speech-evidence` — provider-neutral evidence contract

**Purpose.** These are the types every speech provider returns. They also own the "project normalized media to 16 kHz evidence audio" Need, and the `hypit.transcript@1` file view (`README.md:1-30`).

**Public surface** (`src/index.ts`):
- the types `SpeechEvidenceAudio`, `SpeechWordEvidence`, `SpeechCharacterEvidence`, `SpeechActivitySpan`, `SpeechTranscriptPassage` and `AlignedTranscriptEvidence` (`:15-62`). Every time is an optional `startSample`/`endSampleExclusive` pair; scores are 0–1;
- `sealAlignedTranscriptEvidence` (`:143`) and `assert…Identity` (`:161-218`);
- `speechEvidenceSampleBoundary` (`:148-155`);
- the transcript-document helpers `transcriptDocumentFromEvidence`, `parseTranscriptWords`, `wordsAt` and `phraseRanges` (`transcript-document.ts:17-111`);
- the Producer `request-speech-evidence-audio` (`component.ts:26-73`).

**How it works.**
- Evidence audio is defined as 16 kHz mono. The 48 kHz master sample count is converted with rounding half-up (`:152`), so `480,001 → 160,000` and `480,002 → 160,001` (test at `evidence.test.ts:16-23`). *(corrected in check: the test's values are ten times those first quoted)* The 48 kHz master is hard-coded.
- `transcriptDocumentFromEvidence` writes seconds to 3 decimals. Missing times stay missing (`transcript-document.ts:12-52`).
- `wordsAt` returns active words using half-open spans, plus ±3 words of context (`:75-87`).
- `phraseRanges` matches whole consecutive words after NFKC normalization and stripping punctuation and whitespace. It returns every occurrence and throws if a boundary time is missing (`:94-111`).

**Tests (6).** They cover:
- the rational sample projection;
- identity checks, such as a word with only a start being invalid and a character `wordIndex` out of range being invalid;
- domain/media mismatch rejection (`evidence.test.ts:68-93`);
- `wordsAt` overlap and gap behaviour;
- repeated-phrase matching including CJK (`transcript-document.test.ts:5-26`).

**Quality.** Clean and strict. The validation logic is triplicated: here, in `locate.ts:77-150`, and in the schema at `:64-104`.

**Relevance: Medium.** Two pieces are worth having: the `phraseRanges` "find all whole-word occurrences" helper (our formats and moments code could use it), and the convention that missing times stay missing.

---

## 3. `@hypit/whisperx` — capability, CLI and wire interpretation

**Purpose.** This package selects the WhisperX model family as a capability (`whisperx-alignment`). It wires the three-step graph (project audio → request WhisperX → align narrative). It also owns `hypit transcribe` (`README.md:1-56`).

**Public surface:**
- the markup tag `<whisperx:Alignment id narrative segment media domain language/>` (`manifest.ts:20-60`, decoder at `surface.ts:24-48`);
- the CLI verb `transcribe <audio|video> --to <file> --language <code> [--runtime] [--project] [--json]` (`cli.ts:85-147`);
- the exports `interpretWhisperXTranscript`, `verifyWhisperXAlignmentRequest`, `assertWhisperXEvidenceWav`, `whisperXRequestForEvidenceAudio` and `parseWhisperXLanguage` (`index.ts:1-15`).

**How it works:**
- **Request contract.** The request is `{domainId, audio: Blob(audio/wav), sampleFrames, language}` (`types.ts:13-18`). The language must match `^[a-z]{2,3}$` and not be `und`; "auto" is refused (`types.ts:6-11`, tests at `whisperx.test.ts:70-77`; the file has only 140 lines). *(corrected in check)*
- **WAV check.** The WAV is parsed chunk by chunk and must be PCM, mono, 16 kHz, s16, with `data` bytes equal to `sampleFrames·2` (`evidence.ts:30-59`).
- **Wire interpretation** (`transcript.ts:64-96`):
  - `segments[].words[]` is preferred; top-level `words[]` is the fallback;
  - word text comes from `text` or `word`;
  - seconds are converted to samples with `Math.round(sec·16000)`;
  - a window that is reversed or beyond `sampleFrames` becomes *untimed*, not an error (`:32-43`). An end time a rounding hair past the audio end therefore loses its timing silently;
  - `chars` is always `[]` (`:78`, `:93`).
- **Graph.** The graph is a three-operation Fragment (`fragment.ts:14-29`). An empty Segment (no tokens) uses a boundary-only fragment and never calls WhisperX (`surface.ts:29-33`, `fragment.ts:31-40`).
- **CLI.**
  - It refuses to overwrite an existing file (`cli.ts:51-68`, `flag: "wx"`).
  - It uses a fixed `domainId: "cli-transcribe"` (`:107`).
  - It de-duplicates progress lines (`:118-123`).

**Tests (10).** They cover:
- the CLI writes seconds and the provider/pricing line;
- an unserved capability fails before spending (`cli.test.ts:94-118`);
- the language is required before the host opens;
- ambiguous or unsupported endpoint selection is explained;
- the language passes through markup.

The test titled "retains individual character windows" (`cli.test.ts:139-165`) only checks word windows, which is misleading given `chars: []`.

**Relevance: Medium** for the contract shape, **Low** for the package itself.

---

## 4. `@hypit/provider-whisperx-local` — the WhisperX service contract

**Purpose.** A trusted local Provider and a packaged warm Python service (`runtime/`) that runs faster-whisper ASR followed by WhisperX wav2vec2 word alignment (`README.md:1-36`, `runtime/README.md:1-20`).

### 4.1 Wire contract
- **`GET /health`** (`application.py:45-51`) returns `{ok:true, protocol:"hypit.whisperx-service@1", serviceVersion:"0.1.0", model, device, compute, batchSize, whisperxVersion}`.
  - The Node side checks every field on **every request** before transcribing (`src/provider.ts:142-165`).
  - The managed-program probe checks the same fields with a 2 s timeout (`src/program.ts:143-160`).
- **`POST /transcribe`** (`application.py:53-88`, `server.py:50-82`):
  - the content type must be `application/json` (415 otherwise);
  - `Content-Length` is required (411) and capped at 64 KiB (413) (`config.py:80-83`);
  - the body is exactly `{audio_path, language?}`; unknown fields return 400 `UNKNOWN_FIELD`;
  - `audio_path` must be absolute, resolve inside `HYPIT_WHISPERX_INPUT_ROOTS` (default: the OS temp dir, `config.py:53`), be a regular file of at most 512 MiB, and be PCM mono 16 kHz s16 (`audio.py:30-66`).
- **Response:** `{language, segments:[{text, start?, end?, words:[{text, start?, end?, score?}]}]}`. Partial times are dropped, never invented (`engine.py:47-90`; test at `test_service.py:121-137`).
- **Errors:** `{error:{code,message}}` with these statuses:
  - 400 `INVALID_INPUT`;
  - 503 `BUSY` (a second concurrent request; the lock is non-blocking at `engine.py:170-171`);
  - 503 `RESOURCE_NOT_PREPARED`;
  - 500 `INFERENCE_FAILED`.

### 4.2 Engine
- The pinned versions are `whisperx==3.8.6` (`pyproject.toml:10-13`, re-checked in `check.py:31-32`). The lockfile has torch/torchaudio 2.8.0, faster-whisper 1.2.1, ctranslate2 4.8.1, pyannote-audio 4.0.7 and transformers 4.57.6 (`uv.lock:3016`, `:3098`, `:556`, `:495`, `:2239`, `:3210`).
- The defaults are model `small`, cpu, `int8`, batch 8 (`config.py:40-75`, `provider.ts:22-29`).
- Each request runs `asr.transcribe(samples, batch_size, language)`, then loads the per-language aligner lazily and caches it, then calls `whisperx.align(..., return_char_alignments=False)` (`engine.py:157-207`).
  - Python accepts `auto`/`detect` and maps it to `None` (`engine.py:27-37`), but the TS side never sends it.
- The aligner choice is WhisperX's own torchaudio/HF table (`models.py:46-52`). An `.en` model with a non-English language fails fast (`engine.py:158-161`).
- **No downloads at inference time.** HF calls are local-files-only, and `nltk.download` and `torch.hub.download_url_to_file` are monkey-patched to raise (`models.py:21-32`). Preparation is a separate command (`prepare.py`, `models.py:115-131`).

### 4.3 Node provider
- Loopback-only base URL (`provider.ts:105-106`; also `activation.ts:26-31`).
- The audio is staged to a temp file and the *path* is sent (`:137-141`, `:167-175`). The protocol cannot work across hosts.
- 10 min timeout, response capped at 64 MiB by streaming read (`:119-120`, `:59-97`), `pricing: {kind:"local"}`, concurrency 1 (`:125-126`).
- The managed program does `uv sync --frozen` and then prepares models (`program.ts:124-140`).

**Tests (7 TS + 18 Python).** Examples:
- the identity mismatch is reported as "mismatch", not "down" (`program.test.ts:45-62`);
- seconds become samples exactly: 0.1 s → 1,600 (`provider.test.ts:48-71`);
- staged bytes are unchanged and the language passes through (`:73-146`);
- unknown request fields are rejected;
- busy returns 503;
- the input-root path jail holds;
- inference refuses downloads (`test_models.py:39-54`).

**Quality.** The operational hygiene is excellent: identity handshake, frozen lockfile, a hard split between preparation and inference, an explicit busy status instead of a hidden queue, and a path jail. On the other hand:
- path passing ties the service to one machine;
- a full `/health` round trip runs before every request (`provider.ts:143-165`), on top of the managed-program lifecycle probe (`program.ts:143-160`). "Twice per request" was not substantiated: the per-request path makes one health call. *(corrected in check)*
- character alignments are thrown away.

**Relevance: Medium-Low.** WhisperX with torch, pyannote and wav2vec2 is a poor fit for CPU-only Railway: the model loads take GBs and minutes. That is my judgement from the dependency set, not a measurement. The contract ideas transfer to our whisper.cpp wrapper: identity handshake, explicit busy status, "missing stays missing".

---

## 5. `@hypit/speech-estimate` — speech duration before generation

**Purpose.** A deterministic, provider-free answer to "how long will this text take to say?". The author uses it to pick a literal duration before requesting generation (`README.md:1-24`).

**Public surface:**
- `estimateSpeechDuration(text, policy)` (`program.ts:171-185`);
- `countSpeechEstimateUnits` (`:113-126`) and `detectSpeechEstimateLanguage` (`:35-43`);
- the policy helpers (`policy.ts:16-70`);
- the CLI `hypit estimate (<source.svml> --segment <id> | --text <text|file>) [--language auto|en|zh|ja|es] [--pace slow|normal|fast | --rate N] [--rounding none|round|ceil] [--padding s] [--json]` (`cli.ts:85-138`).

**How it works:**
- `seconds = units / rate + padding`, then rounding. A result of zero or less throws, and the error suggests `ceil` (`:180-183`).
- Rates (units per second; `program.ts:11-21`):

  | Language | slow | normal | fast |
  | --- | ---: | ---: | ---: |
  | en | 4.2 | 4.6 | 5.6 |
  | zh | 4.2 | 5.25 | 6.5625 |
  | ja | 6 | 7.5 | 9.375 |
  | es | 4.72 | 5.9 | 7.375 |

  The README is honest that these are authoring presets, not calibrations, and that ja and es are inherited heuristics (`README.md:31-52`).
- **English units are syllables.** CMUdict stress digits are counted (`:53-58`). Hyphenated parts are counted separately. Unknown words use a vowel-group heuristic (`:60-68`).
- **zh and ja** count one unit per Han or kana code point, plus English syllables for embedded Latin words (`:117-123`). **es** uses a vowel-nucleus approximation (`:84-111`).
- **Digits count 0.** `words()` matches `\p{N}`, but the English normalizer strips everything outside a–z (`:45-51`). The test asserts `"45%" → 0` (`estimate.test.ts:24`). The README tells authors to spell numbers out (`README.md:26-29`).
- **Auto-detect:** kana beats Han, Han beats ASCII/4, then a Spanish stop-word ratio of at least 18% (`:27-43`).

**Tests (13).** Examples:
- "Video editing begins with meaning, not a pile of clips on a timeline." is 20 syllables and rounds to 4 s (`estimate.test.ts:27-34`);
- 49 × "day" gives slow/normal/fast = 12/11/9 s (`:36-47`);
- `用 video 做视频` is 7 units (`:133`);
- the Spanish sample is 17 units (`:151`).

**Quality.** Small, honest and well cited. The silent zero for digits is a trap: "Top 5 tips" undercounts.

**Relevance: High.** Clipper estimates length as `words / 2.6` with a whitespace split (`clipper/shared/rules.ts:49-50`, `:101-103`; used in `scripts.ts:18`, `:50`, `:142` and `variants.ts:96`). That is wrong for CJK, where a sentence counts as one "word", and crude for long words.
- *(check)* One more use: the UI estimate `src/components/ClipCard.tsx:107` (`~{words/2.6}s spoken`). `words()` is `split(/\s+/)` (`rules.ts:50`). For an unspaced zh/ja narration that is about 1 "word", so the pre-render "Voiceover fits the clip" check (`rules.ts:101-103`) almost always passes, and `scripts.ts:50`/`:142` derive `lengthSec` as roughly `min + 2` or `min + 3`. After a voiced render the measured `spokenSec` replaces the estimate (`rules.ts:101`).

**Better version for us.**
- Count syllables (a heuristic, or CMUdict if we accept a dictionary dependency) and Han/kana characters, as hypit does, but **expand digits** ("45" → "forty five") before counting.
- **Calibrate the rate per voice from our own renders.** We already store the measured `spokenSec` (`render.ts:365`), so `rate = units/spokenSec` can be stored per voice option and per language. No research presets needed.

---

## 6. `@hypit/script` — prose-first authored speech (Narrative + Caption)

**Purpose.** A raw Markup Surface for `<script>`. It parses named Segments, Role Cues, Dual Text, Selection and Moment markers, caption cue breaks and word attributes. It emits:
- one `Narrative` (tokens plus 2M+2N anchors: M tokens, N Segments);
- a `CaptionDocument` and its binding;
- per-Segment `dialogue` and `speech` Text;
- Selection and Moment refs (`README.md:1-70`, `surface.ts:56-151`).

**Public surface** (`src/index.ts:1-21`): `parseScript`, `formatScript`, `adjustScriptSelection`/`adjustScriptMoment`/`scriptAnchorEditSites`, the narrative and caption value builders, `decodeScriptSurface`, the Studio domain facet (`studio.ts`) and `ScriptSyntaxError`. The tag syntax is summarized in `manifest.ts:30-90`:
- `<seg>…</seg>` or `<seg/>` for a Segment;
- `<ROLE>` for a Role Cue;
- `<display | spoken>`, `<display|>` and `<|spoken>` for Dual Text;
- `@{a}…@{/a}`, `@{~a}`, `@{/a~}`, `@{m!}` and `@{~m!}` for Selections and Moments;
- `||` for a cue break;
- `word{emphasis,importance=2}` for word attributes;
- `<!-- -->` for comments.

**How it works (key points):**
- **Single-pass scanner.**
  - Text runs cross comments and markers, and lexical analysis happens once per complete run (`parser.ts:140-194`).
  - A marker, cue break or attribute that falls inside a word plus its attached punctuation is a hard error (`:161-170`).
- **Lexical units** (`lexical.ts:6-13`):
  - numbers including `1,234.56`;
  - each Han, Hiragana or Katakana character;
  - Latin, Hangul or other words, which end at a CJK script boundary. `用Hypit生成` becomes `用 | Hypit | 生 | 成` (test at `script.test.ts:142-152`).
- **Dual Text** (`parser.ts:619-638`, `consumeSpeechSide` at `:459-534`):
  - the display side goes to Caption and the spoken side to speech, dialogue and Narrative tokens;
  - each Dual is one indivisible N:M Caption unit (`narrative.ts:39-41`);
  - the speech side must contain a spoken word (`:520-524`);
  - markers belong to the speech side (`:364-377`).
- **Marker affinity** resolves to an adjacent token boundary. At structural edges it snaps to the Segment boundary and never crosses into the neighbouring Segment (`:769-789`).
- **Anchors** are exactly `segment-start, (token-start, token-end)*, segment-end` per Segment, and the count is asserted to equal `2M+2N` (`:797-819`).
- **Caption cues** break on `||`, on Role or Turn changes, and on every Segment close (`narrative.ts:101-124`).
- **Source edits.** Marker writeback removes the old markers, re-parses, inserts at the anchor's edit site, re-parses again and verifies that the bindings and all public content are unchanged (`edit.ts:90-146`). The formatter also re-parses and refuses to change semantics (`format.ts:40-70`).

**Tests (~50).** They include:
- 15 authored-spacing strings preserved, covering Korean, CJK and quotes (`display-spacing.test.ts:12-20`);
- 14 Moment fixtures round-tripped through *every* anchor with idempotent spelling (`edit.test.ts:22-35`);
- every start/end pair for Selections (`:68-79`, `:81-105`);
- the Dual N:M binding (`script.test.ts:89-99`);
- punctuation attaching to display words without timing units (`:120-140`);
- Markup integration (`markup-integration.test.ts`).

**Quality.** A very careful parser that verifies its own round trips. It is also heavy: 852 lines in the parser, and `parseScript` runs up to three times per marker edit. It is tied to hypit's Markup/Studio framework.

**Relevance: High for ideas, Low for the code.**
- *Dual Text* fixes two current clipper weaknesses:
  - captions must match the brief's spelling ("BCC", "2012", brand names), while the TTS should say "B C C" or "twenty twelve";
  - the aligner has to reconcile the two.
- *Moments* (`@{name!}`) replace our fuzzy overlay cue-word search (`overlays.ts:28-56`). That search fails when the cue is not in the voiceover, and render.ts then logs "Left out N overlay(s)" (`render.ts:317-320`).
- `{emphasis}` maps directly onto the highlight words of our Hormozi and karaoke styles.

**Better version.** Add a *tiny* subset of the syntax to the plan's `narration` field:
- `<display|spoken>`;
- `@{name!}`;
- `word{emphasis}`;
- `||`.

Implement it with a 100–150-line tokenizer that emits `{speechText, captionWords[], units: captionUnit→tokenRange, moments, emphasis}`. Send `speechText` to TTS and align against the spoken tokens. Captions show the display words, timed by unit. The LLM writing plans can emit this markup directly. We do not need Segments, Roles, Selections, source-preserving edits or the formatter.

---

## 7. `@hypit/narrative` — authored-content value type

**Purpose.** The Narrative type (Segments, Tokens, Turns, Selections, Moments, Anchors) with validators and three content queries (`README.md:1-30`, `types.ts:1-89`).

**How it works.**
- `assertNarrativeIdentity` checks unique ids. It requires Segments to partition tokens in order, and anchors to be *exactly* the ordered Segment and token boundaries. It also checks Turn coverage and that Selection anchors are in order (`identity.ts:22-92`).
- `narrativeSelectionTokenRange` and `narrativeTokensForSelection` map anchors to half-open token ranges (`selection.ts:11-50`). Lookups are linear `find` calls.

**Tests:** none in this package. It is exercised from the script tests (`narrative-views.test.ts:94-127`).

**Relevance: Low.** The useful idea, "anchor ids rather than times", is already captured in §6.

---

## 8. `@hypit/narrative-temporal` — local alignment → absolute timeline

**Purpose.** It owns `NarrativeAlignment`: Narrative boundary ids located on one local domain. It also owns `NarrativeProjection`: several alignments mapped onto one Timeline through equal-length Windows. Selection, Segment and Moment boundaries can then be revealed as absolute Instants and Windows (`README.md:1-35`).

**Public surface:**
- the tags `<semantic:Projection id narrative timeline><semantic:Map alignment domain window/>…`, `<semantic:Instant id projection at [boundary]/>` and `<semantic:Window id projection during/>` (`surface.ts:220-270`);
- the functions `projectNarrativeAlignment`, `createNarrativeProjection`, `selectionFrameSpan`, `segmentFrameSpan`, `tokenFrameSpan`, `momentFrame` and `materializeSegmentBoundaryAlignment` (`index.ts:1-11`).

**How it works:**
- Projection is pure translation: `window.start + localFrame`. The clocks must be equal and `window length == domain.frameCount`; nothing is stretched, clipped or looped (`projection.ts:14-32` via `temporal/src/domain.ts:31-57`).
- Combining many Maps uses a balanced binary tree of combine Producers (`surface.ts:137-149`).
- Projection creation rejects:
  - mixed Narratives;
  - a different Timeline;
  - repeated Segments, tokens or boundaries;
  - out-of-range frames (`projection.ts:34-66`).
- An empty Segment maps to `[0, frameCount]` (`materialize.ts:19-37`).
- Validation requires non-decreasing token starts and ends (`identity.ts:36-47`); see §0.3.

**Tests (6).** They cover:
- the duplicate-boundary and missing-boundary errors (`identity.test.ts`);
- that the surfaces build the expected fragment shapes, including 2 combines for 3 Maps (`surface.test.ts:40-55`);
- the Studio declaration filter.

**Relevance: Low-Medium.** Clipper has one voice placed at t=0 (after trimming). Translating local timing to the program is one addition (`render.ts:240`). The strict "equal length, no stretching" rule is worth stating as an invariant if we ever place several voice takes.

---

## 9. `@hypit/temporal` — absolute-time protocol

**Purpose.** It defines the coordinate values `TemporalInstant` (a frame on one timeline), `TemporalWindow` (non-empty `[start,end)`), `TemporalExtent` (an unpositioned frame count on a clock) and `LocalTemporalDomain`. It also provides exact arithmetic and the author-syntax helpers in `/markup` (`README.md:1-43`, `EDITING.md`).

**How it works:**
- **Rationals.** `bigint` numerator and denominator with GCD normalization (`rational.ts:17-27`). Durations come in three forms: frames (integer), milliseconds (integer) and seconds (rational) (`types.ts:2-5`, `rational.ts:54-72`).
- **Quantization** is to the nearest frame boundary, with an exact half going to the later frame (`rational.ts:74-80`). `projectTemporalInstant` rejects anything outside `[0, frameCount]` before quantizing (`projection.ts:46-56`). Example: 500 ms at 30000/1001 fps is frame 15 (`temporal.test.ts:72-78`).
- **Samples.** `temporalDurationInSamples` rounds once into a 48 kHz sample domain (`sample.ts:20-43`). At NTSC, 15 frames is 24,024 samples (`temporal.test.ts:104-111`).
- **Windows.** `composeTemporalWindow` rejects reversed and zero-length windows (`projection.ts:95-103`). `assertWindowRelation("disjoint")` checks overlap without reordering its input (`:105-117`).
- **Triggered schedule** (`schedule.ts:13-52`):
  - the input is an outer span, a terminal frame and strictly increasing triggers in `[outer.start, terminal)`;
  - the output is *cumulative* windows `[trigger, outer.end)` and *exclusive* windows `[trigger, nextTrigger or terminal)`;
  - test at `temporal.test.ts:122-133`.
- **Markup helpers.** `parseTemporalDuration("1.5s") → {seconds, 3/2}` (`markup/index.ts:53-67`); instants such as `start+12f`, `end-2s` and absolute values (`:80-94`); Window construction from exactly two of `from`, `until` and `for` (`:215-238`).

**9.5 Probable bug.** For the `until + for` form, `constructWindow` first materializes a `start` operation from `timeline.start` (`markup/index.ts:161`, input from `:234-236`). It then replaces `start` with the shift result (`:195`). The original `materialize-start` operation stays in the fragment but feeds no export. `verifyGraphFragment` rejects any unreachable operation (`packages/author/src/fragment.ts:291-298`), and the Author linker runs it on every component (`author.ts:181`). So a standalone `<time:Window … until=… for=…/>` should fail to link. No test covers this form: `markup.test.ts` covers only `from+for` and `from+until`, and `timeline-author/test/surface.test.ts:114-127` covers only `from`/`until`. I found this by reading the code and have not run it.
   - **Check: confirmed by static trace (not executed).** The `until+for` branch passes a literal `start: {ref:"timeline.start"}` (`markup/index.ts:234-237`). `materialize("start")` therefore pushes a `materialize-start` operation (`:156-159`, called at `:161`). With `direction === -1`, `shift` is based on `end` (`:181`), and `start` is reassigned to `shift` (`:195`). The exports are `compose` (inputs `shift` and `materialize-end`), `start` (→ `shift`) and `end` (→ `materialize-end`) (`:198-204`), so nothing references `materialize-start`. `sealGraphFragment` does not verify (`author/src/fragment.ts:183-191`). `verifyGraphFragment` collects reachable operations from the exports and asserts `UNREACHABLE_FRAGMENT_OPERATION` for any other (`:265-298`). It runs on every Author component (`author.ts:181`) and on elaboration (`fragment.ts:321`). The only caller of `createTemporalWindowConstruction` is the standalone `decodeAbsoluteWindowSurface` (`timeline-author/src/surface.ts:153-170`). Windows inside `<time:Timeline>` use timeline-author's own fragment compiler and are unaffected (`surface.test.ts:87-99` passes `until="end" for="1001ms"` there). The only other `until … for` test in the repo, `caption-fine.test.ts:542`, asserts that caption-fine *rejects* the form, so it is not coverage.

**Tests (15).** Rational and NTSC arithmetic, out-of-range instants, window composition and identity, the disjoint relation, the triggered schedule, and the markup lowering of literal and reference forms.

**Relevance: Medium.**
- Clipper does all its timing in float seconds, with ad-hoc clamps in render.ts (§13.3). One integer-frame representation with half-open windows would remove a class of off-by-a-frame caption and CTA glitches.
- The triggered schedule is exactly our tier overlays ("stay until CTA", `overlays.ts:52`) and generalizes to "one at a time" pop-ups.

---

## 10. `@hypit/timeline` — the completed Timeline value

**Purpose / How it works.** `Timeline = {id, frameRate:{numerator,denominator}, frameCount}` and nothing more (`types.ts:1-17`). The package provides validation, `timelineDurationSeconds`, and exact frame→sample boundaries rounded half-up (`identity.ts:21-59`).

**Tests:** none here. The sample math is tested in temporal and speech-evidence.

**Relevance: Low-Medium.** Adopting "a clip is `{fps, frameCount}`" as our render invariant is cheap.

---

## 11. `@hypit/timeline-author` — building a Timeline from a DAG

**Purpose.** Author syntax that resolves the program `end` and publishes named absolute Instants and Windows (`README.md:1-148`):

```
<time:Clock id frame-rate="30|30000/1001"/>
<time:Timeline id clock end="latest(speech.end,outro.end)">
  <time:Window id from|until|for/>
  <time:Instant id at/>
</time:Timeline>
```

There are also standalone `<time:Window timeline …>` and `<time:Instant timeline at offset>` forms (`manifest.ts:63-139`, `surface.ts:153-188`; surface.ts has 188 lines). *(corrected in check)*

**How it works:**
- **Point grammar.**
  - Points can be `start`, `end`, `12f|250ms|1.5s`, `name`, `name.start|end`, `earliest(…)` and `latest(…)`, with an optional trailing `±duration` (`fragment.ts:164-205`; the offset is split from the right at depth 0 in `:78-93`).
  - The names `start`, `end`, `timeline` and `window` are reserved (`:97`).
  - Forward references are allowed. Cycles are rejected by the generic fragment verifier (test at `program.test.ts:81-106`), including `end` depending on a Window that ends at `end`.
- **Construction ops** are plain integer arithmetic (`program.ts:35-137`):
  - spans must be non-empty and points must be ≥0;
  - `for` takes a literal duration or a `TemporalExtent` reference, for example a generated voice's measured length (`README.md:100-112`);
  - `latest()` and `earliest()` are pairwise max and min.
- **Exact frames only.** Construction durations must be whole frames (`program.ts:40-47`). With a static Clock this is validated at decode time with a friendly message (`surface.ts:87-101` *(corrected in check)*; test at `surface.test.ts:72-85`, which rejects `4.25s`, `250ms` and `start+250ms` at 30 fps).
  - Consequence: at 29.97 fps, `"1s"` is rejected and you must write `1001ms`.
  - The temporal markup path *rounds* instead (`temporal/src/projection.ts:53`). The two rules disagree.
- `parseDuration` is a copy of `temporal/markup`'s `parseTemporalDuration` (`fragment.ts:39-57` vs `temporal/src/markup/index.ts:53-67`).
- **Studio inverse.** Editing a Window rewrites `from`/`for` atomically, according to which binding owns which edge. `earliest()`/`latest()` are read-only (`studio.ts:82-309`).

**Tests (13).** Examples:
- a 90-frame voice plus `outro` 12 frames later for 3 s gives `frameCount 192` and `tail [102,192)` (`program.test.ts:28-38`);
- the forward, backward and between span forms;
- cycles are rejected;
- the export naming and order (`surface.test.ts:34-60`);
- `1001ms` is accepted at 30000/1001 (`:87-99`).

**Quality.** A tidy, minimal design, though the frame-exact strictness is user-hostile at NTSC rates.

**Relevance: Medium (as a design).** Our render "program" is effectively:
- `hook = [0, 3.2s)`;
- `speech = [0, voice.extent)`;
- `cta = [lastSentence.start, end)`;
- `end = max(brief.min, speech.end + 0.8s)`;
- shots partitioning `[0, end)`.

All of it is computed imperatively in floats (`render.ts:246-311`). Writing it as a small typed cue sheet resolved in integer frames would make EditParts (`render.ts:336-353`) and the OpenReel timeline agree to the frame. It needs no DSL; a TypeScript function returning named frame windows is enough.

---

## 12. `@hypit/author` — Author-module linker and Graph Fragments

**Purpose.** Parser-independent linking of authored component calls into a Core graph. It works in two phases: predeclare every export, then resolve and type-check, reject cycles and elaborate hygienic fragment instances (`README.md:1-94`, `author.ts:148-308`).

**How it works:**
- `sealGraphFragment` derives its id from the sorted `producer:operation` list and the exports, so the id is content-addressed (`fragment.ts:183-191`).
- `verifyGraphFragment` checks port binding, types and cycles, and requires every operation to be reachable from an export (`:215-299`).
- Instances get `operation:<instance>:<local>` ids, so two instances never content-dedupe (`:312-379`).

**Tests (6).** Forward references, cycle rejection, type mismatch, a shared generation op across exports, distinct instances, and no escape through raw graph references.

**Relevance: Low.** This is framework plumbing with no counterpart in clipper. It matters here only because its reachability rule exposes the §9.5 bug.

---

## 13. Detailed comparison with clipper

### 13.1 `hypit narrative-speech-alignment` vs `clipper/server/align.ts`

| Aspect | clipper `align.ts` | hypit aligner |
| --- | --- | --- |
| Normalization | NFKD, strip combining marks, lowercase, keep `\p{L}\p{N}` (`:21`) | NFKC, `en` lowercase, keep `\p{L}\p{M}\p{N}` (`normalize.ts:1-6`) |
| Word split | Space split, or `Intl.Segmenter` for zh/ja/th/lo/km/my/yue with punctuation glued (`:42-52`) | Script lexical units: one per Han/kana character, numbers with separators, script-boundary splits (`script/src/lexical.ts:6-13`) |
| Groups | 1:1 substitution, skip-script and extra-spoken only | 1..4 × 1..4 groups plus unbounded exact split/merge, labelled (`align.ts:50-61`, `:214-223`) |
| Substitution cost | Tiered by normalized char distance: 0 / 0.5 (≤0.34) / 1.2 (≤0.6) / 2.5 (`:63-68`) | Continuous: `dist×reliability + 0.055·extra + 0.06·unmatched` (`:63-78`) |
| Gap costs | Skip script **1.5**, extra spoken **1** (`:63-64`) | Omission **0.5**, insertion **0.35** (`:237`, `:254`) |
| Confidence | Unused (whisper.cpp `-oj` has no probabilities) | Mean score scales the mismatch cost (`:25-32`) |
| Leading/trailing chatter | **Free** (`D[0][j]=0`, minimum over the last row, `:72`, `:76-77`); counts are reported for trimming (`:145`) | Charged as insertions; the Segment is assumed to be exactly the performance |
| Timing of matched words | The spoken word's time; pairs with cost 2.5 are dropped (`:85`, `:99-101`) | The group window, or per-character times inside multi-token groups (`locate.ts:298-339`) |
| Merged words ("Car League" ↔ "CarLeague") | One word pairs; the other is interpolated, with a "no room" fallback that halves the previous word's time (`:114-118`) | An explicit `merge` group; tokens split by character pairing (synthetic letter-proportional in production, §0.2) |
| Unmatched runs | Spread by `len+1` between paired neighbours; the tail fallback is `0.3 s × count` or the last spoken end (`:105-131`) | Spread by normalized char count between neighbours, bounded by the VAD envelope or the whole Segment (`:358-390`) |
| Monotonic / overlap | Starts forced non-decreasing; end ≥ start + 0.05 s; overlap possible (`:133-134`) | Locator allows overlap; sealing requires non-decreasing starts and ends and throws otherwise (§0.3) |
| Quantization | Float seconds, ASS centiseconds (`captions.ts:18-24`) | One floor/ceil to frames; min 1 frame (`locate.ts:392-423`) |
| Tie-break | Implicit, by backtrace order (diagonal, then up, then left; `:84-92`) | Explicit 5-level comparator (`align.ts:91-99`) |
| Complexity | O(nm) with a cheap per-cell distance | O(16nm) heavier calls, plus an O(n) exact fast path |
| Output metrics | `matched`, `span`, `extra{before,after,inside}`, used for retakes and trimming | None; it always succeeds or throws |

**Verdict.** Hypit's cost model and group handling are better. Clipper's free edges plus metrics are better *for TTS*: voice models add chatter, and render.ts uses `extra` and `matched` to retake and trim (§13.3). The right merge is clipper's framing with hypit's groups.

### 13.2 `clipper/server/transcribe.ts` vs the WhisperX contract

| | clipper | hypit |
| --- | --- | --- |
| Engine | whisper.cpp `whisper-cli`, `ggml-base`, CPU, threads ≤ 8 (`transcribe.ts:25-26`, `:49`) | faster-whisper `small` int8 on CPU, then wav2vec2 CTC word alignment (`engine.py:157-207`) |
| Audio | ffmpeg → 16 kHz mono s16 temp WAV per call (`:47`) | The caller must supply canonical 16 kHz WAV; the service refuses anything else (`audio.py:60-65`) |
| Language | `auto` allowed; detected language returned (`:49`, `:53`) | Explicit code required at the TS layer (`whisperx/src/types.ts:6-11`) |
| Glossary bias | `--prompt` with ≤20 brand terms (`:48-50`) | None |
| Word times | `-ml 1 -sow` one-word segments; sub-word pieces without a leading space are glued; `[Music]`/`(laughs)` dropped (`:61-76`) | Aligned word times plus score; missing times stay missing |
| Process model | A spawn per call, no warm state (model load per call) | Warm process, single-flight, explicit `503 BUSY` |
| Units | Float seconds | Integer 16 kHz samples |

**Take-aways.**
- (a) whisper.cpp word timing from `-ml 1` uses token-timestamp heuristics. WhisperX's CTC alignment is generally tighter. That is a general claim I did not measure here.
- (b) A cheaper upgrade path on CPU is whisper.cpp's own DTW token timestamps, plus `-ojf` for token probabilities to feed confidence-weighted costs. Both are flags of whisper.cpp itself and need a check against our pinned build.
- (c) Keeping a warm whisper-server process would avoid reloading the model per call. Hypit's identity handshake (model, version, threads) is a good pattern if we do.

### 13.3 How `clipper/server/render.ts` uses them, and where hypit's model would help
- **Retake loop.**
  - Each TTS take is transcribed with a glossary and aligned (`render.ts:196-219`).
  - The score is `matched − inside/20`. The loop stops when `matched ≥ 0.85 && inside ≤ 3`, with at most 2 takes (`:221-224`).
  - Hypit has no counterpart. Keep this.
- **Trim.**
  - If `matched ≥ 0.6` and there is chatter, the take is cut to `[span.start−0.12, span.end+0.3]`, and every word is shifted (`:228-241`).
  - Otherwise timing falls back to `silencedetect` spans (−35 dB, 0.25 s, `media.ts:175-188`) and a sentence-to-span or length-weighted spread (`captions.ts:41-70`).
- **Duration.** `max(brief.min, spoken + 0.8)`, clamped to 5–180 s and rounded to 0.01 (`:246-248`).
- **CTA start, with a CJK bug.**
  - `ctaFrom` = the start of the last sentence's first word, clamped to `[1, duration−2.5]` (`:303-311`).
  - That word is found by counting `sentence.split(" ")` words backwards from the end of `timed` (`:306-308`). But `timed` comes from `scriptWords`, which uses `Intl.Segmenter` for zh/ja/th and similar languages (`align.ts:42-52`).
  - For those languages a sentence has 1 space-separated "word", so the CTA starts at the *last word* instead of the last sentence.
  - *(check: confirmed.)* `alignScript(clip.narration, tr.words, tr.language)` (`render.ts:214`) builds `al.words` from `scriptWords(script, language)`. That uses `Intl.Segmenter` when `NO_SPACES.has(language)`, where `NO_SPACES` = zh/ja/th/lo/km/my/yue (`transcribe.ts:35`, `align.ts:42-52`, `:98`). `timed` is `al.words` (`render.ts:240`). On the other side, `sentences()` splits only on ASCII `[.!?]` followed by whitespace (`captions.ts:28-33`). A CJK narration punctuated with `。！？` is therefore a single "sentence", and `split(" ").length` is 1. With mixed spacing (e.g. "用 Hypit 生成") it is a small count unrelated to the Segmenter's token count. Result: `lastSentenceStart = timed[timed.length − 1].start` (`render.ts:306-308`), and `ctaFrom = clamp(·, 1, duration − 2.5)` (`:311`). In practice the CTA lands at about `min(lastWordStart, duration − 2.5)`, and tier overlays end there too (`overlays.ts:52`, via `render.ts:317`). Only the aligned path is affected; the spans fallback at `:309` does not use the word count.
  - Hypit's anchor model avoids this class of error: a Selection or Segment boundary is a token anchor id, never a recount.
- **Overlays.** These are found by normalized cue-word search over timed words (`overlays.ts:28-56`). Tiers stay until the CTA (a cumulative schedule). Moments (§6) and `resolveTriggeredSchedule` (§9) are the principled versions.
- **Units.** Everything is float seconds:
  - EditParts are rounded to milliseconds (`render.ts:335-353`);
  - ASS uses centiseconds (`captions.ts:18-24`);
  - shots are proportional with a 1.5 s floor (`:262-263`).

  A single frame clock (30 fps), with every window half-open in integer frames, would keep ASS, EditParts and ffmpeg cuts consistent.

---

## 14. Ideas worth taking (ranked)

1. **Upgrade `align.ts` with hypit's M:N group DP.** Keep clipper's free edges, the `extra` and `matched` metrics, and retake/trim. Add:
   - 1..3×1..3 groups plus an unbounded exact split/merge when the concatenations are equal;
   - the "same letters, different segmentation" cost of 0.055;
   - continuous edit-distance costs;
   - deterministic tie-breaks;
   - character-proportional splitting inside merge groups.

   This targets real failures (brand names merged or split, "website"/"web site", CJK) with no new dependencies (§1, §13.1).
2. **Adopt a minimal Dual Text, Moment and emphasis syntax in `narration`:** `<display|spoken>`, `@{name!}`, `word{emphasis}`, `||`.
   - TTS gets the spoken side; captions get the display side, with N:M unit timing.
   - Overlays anchor on Moments instead of fuzzy cue words, which ends "overlay left out".
   - Emphasis drives highlight styles.

   The LLM plan writer can emit it (§6).
3. **Integer-frame time model in render.** One `fps` (30) and half-open `[startFrame,endFrame)` windows for hook, speech, CTA, shots and overlays. Quantize alignment output once (floor starts, ceil ends, minimum 1 frame) and derive ASS, EditParts and ffmpeg cut points from frames (§9-§11, §13.3).
4. **Speech estimate v2.** Count syllables and CJK characters, expand digits, and calibrate per voice and language from measured `spokenSec`. This replaces `WORDS_PER_SECOND = 2.6` in rules, scripts and variants (§5).
5. **Bound gap interpolation by speech activity.** We already compute `silencedetect` spans. Use their envelope, not neighbours alone and not the whole clip, as the outer bounds for unmatched leading and trailing script words (§1.3 step 5).
6. **Confidence-weighted costs** from whisper.cpp token probabilities (`-ojf`), using hypit's `0.5 + 0.5·score` multiplier (§1.2).
7. **`resolveTriggeredSchedule` for overlays:** cumulative windows (tier lists) vs exclusive windows (pop-up comments), with strictly increasing triggers validated (§9).
8. **Fix the CTA-start CJK bug** by anchoring to the token index of the last sentence's first script word, computed with the same `scriptWords` segmentation (§13.3).
9. **Service hygiene for a warm whisper process** (if we add one): an identity handshake on `/health`, an explicit `BUSY`, missing times kept missing, and a path jail (§4).
10. **`phraseRanges`** (all whole-word occurrences, punctuation-insensitive) for formats and moments transcript search (§2).

## 15. Things not to copy

- **The package and manifest ceremony.** Twelve packages, Producers, Fragments, admission facets and Studio inverse relations to do what clipper does in ~400 lines. That fits an agent-authored DSL, not a SaaS render queue.
- **WhisperX plus torch, pyannote and wav2vec2 on Railway CPU.** The model loads are heavy, it is single-flight per process, and the loopback path-passing protocol ties it to one host. Our whisper.cpp stack fits CPU-only, multi-tenant deployment better (§4).
- **Mandatory explicit language.** Our users upload arbitrary videos; auto-detect is a feature (`transcribe.ts:49`). Hypit refuses `auto` (`whisperx/src/types.ts:6-11`).
- **Charging leading and trailing chatter instead of trimming it.** For TTS output our free-edge DP plus trim is the right model (§13.1).
- **Throw-on-imperfection sealing.** Strict monotonic validation after a permissive locator turns a measurement wobble into a failed build (§0.3). In an automated pipeline, clamp and log instead.
- **Frame-exact-only literals** that reject `1s` at 29.97 fps (§11). Round once, with a documented rule, as `temporal` does elsewhere.
- **Speech-estimate digits counting as zero** (§5). Expand numbers instead.
- **Code paths without a producer.** Character and VAD timing are tested only on synthetic fixtures (§0.2). If we add character-level timing, wire a real source first.

---

## 16. Coverage table

All files were read top to bottom unless noted otherwise. Paths are relative to `packages/`.

| File | Lines | Read |
| --- | ---: | :---: |
| whisperx/README.md | 84 | ✅ |
| whisperx/package.json | 44 | ✅ |
| whisperx/src/activation.ts | 20 | ✅ |
| whisperx/src/cli.ts | 147 | ✅ |
| whisperx/src/component.ts | 62 | ✅ |
| whisperx/src/evidence.ts | 72 | ✅ |
| whisperx/src/fragment.ts | 40 | ✅ |
| whisperx/src/index.ts | 15 | ✅ |
| whisperx/src/manifest.ts | 95 | ✅ |
| whisperx/src/surface.ts | 48 | ✅ |
| whisperx/src/transcript.ts | 97 | ✅ |
| whisperx/src/types.ts | 18 | ✅ |
| whisperx/test/cli.test.ts | 201 | ✅ |
| whisperx/test/whisperx.test.ts | 140 | ✅ |
| provider-whisperx-local/README.md | 127 | ✅ |
| provider-whisperx-local/package.json | 35 | ✅ |
| provider-whisperx-local/runtime/.python-version | 1 | ✅ |
| provider-whisperx-local/runtime/README.md | 136 | ✅ |
| provider-whisperx-local/runtime/deploy/hypit-whisperx.service.example | 28 | ✅ |
| provider-whisperx-local/runtime/pyproject.toml | 28 | ✅ |
| provider-whisperx-local/runtime/src/hypit_whisperx_service/\_\_init\_\_.py | 6 | ✅ |
| provider-whisperx-local/runtime/src/hypit_whisperx_service/\_\_main\_\_.py | 29 | ✅ |
| provider-whisperx-local/runtime/src/hypit_whisperx_service/application.py | 91 | ✅ |
| provider-whisperx-local/runtime/src/hypit_whisperx_service/audio.py | 66 | ✅ |
| provider-whisperx-local/runtime/src/hypit_whisperx_service/check.py | 42 | ✅ |
| provider-whisperx-local/runtime/src/hypit_whisperx_service/config.py | 88 | ✅ |
| provider-whisperx-local/runtime/src/hypit_whisperx_service/engine.py | 207 | ✅ |
| provider-whisperx-local/runtime/src/hypit_whisperx_service/models.py | 131 | ✅ |
| provider-whisperx-local/runtime/src/hypit_whisperx_service/prepare.py | 37 | ✅ |
| provider-whisperx-local/runtime/src/hypit_whisperx_service/resources.py | 57 | ✅ |
| provider-whisperx-local/runtime/src/hypit_whisperx_service/server.py | 101 | ✅ |
| provider-whisperx-local/runtime/uv.lock | 3,381 | ⚠️ generated lockfile: header and key package pins extracted, not read line by line |
| provider-whisperx-local/src/activation.ts | 102 | ✅ |
| provider-whisperx-local/src/index.ts | 5 | ✅ |
| provider-whisperx-local/src/program.ts | 161 | ✅ |
| provider-whisperx-local/src/provider.ts | 194 | ✅ |
| provider-whisperx-local/test/program.test.ts | 73 | ✅ |
| provider-whisperx-local/test/provider.test.ts | 146 | ✅ |
| provider-whisperx-local/test/service/test_models.py | 74 | ✅ |
| provider-whisperx-local/test/service/test_service.py | 215 | ✅ |
| narrative-speech-alignment/README.md | 43 | ✅ |
| narrative-speech-alignment/package.json | 32 | ✅ |
| narrative-speech-alignment/src/activation.ts | 10 | ✅ |
| narrative-speech-alignment/src/align.ts | 273 | ✅ |
| narrative-speech-alignment/src/component.ts | 32 | ✅ |
| narrative-speech-alignment/src/error.ts | 9 | ✅ |
| narrative-speech-alignment/src/index.ts | 8 | ✅ |
| narrative-speech-alignment/src/local.ts | 49 | ✅ |
| narrative-speech-alignment/src/locate.ts | 479 | ✅ |
| narrative-speech-alignment/src/manifest.ts | 24 | ✅ |
| narrative-speech-alignment/src/materialize.ts | 50 | ✅ |
| narrative-speech-alignment/src/normalize.ts | 79 | ✅ |
| narrative-speech-alignment/src/types.ts | 41 | ✅ |
| narrative-speech-alignment/test/speech-align.test.ts | 431 | ✅ |
| speech-estimate/README.md | 96 | ✅ |
| speech-estimate/package.json | 22 | ✅ |
| speech-estimate/src/cli.ts | 147 | ✅ |
| speech-estimate/src/index.ts | 15 | ✅ |
| speech-estimate/src/policy.ts | 70 | ✅ |
| speech-estimate/src/program.ts | 192 | ✅ |
| speech-estimate/src/types.ts | 15 | ✅ |
| speech-estimate/test/cli.test.ts | 29 | ✅ |
| speech-estimate/test/estimate.test.ts | 152 | ✅ |
| speech-evidence/README.md | 30 | ✅ |
| speech-evidence/package.json | 31 | ✅ |
| speech-evidence/src/activation.ts | 10 | ✅ |
| speech-evidence/src/component.ts | 73 | ✅ |
| speech-evidence/src/index.ts | 218 | ✅ |
| speech-evidence/src/transcript-document.ts | 111 | ✅ |
| speech-evidence/test/evidence.test.ts | 93 | ✅ |
| speech-evidence/test/transcript-document.test.ts | 26 | ✅ |
| narrative/README.md | 30 | ✅ |
| narrative/package.json | 26 | ✅ |
| narrative/src/activation.ts | 9 | ✅ |
| narrative/src/component.ts | 31 | ✅ |
| narrative/src/identity.ts | 115 | ✅ |
| narrative/src/index.ts | 13 | ✅ |
| narrative/src/manifest.ts | 27 | ✅ |
| narrative/src/schema.ts | 56 | ✅ |
| narrative/src/selection.ts | 50 | ✅ |
| narrative/src/types.ts | 89 | ✅ |
| narrative-temporal/README.md | 35 | ✅ |
| narrative-temporal/package.json | 34 | ✅ |
| narrative-temporal/src/activation.ts | 27 | ✅ |
| narrative-temporal/src/component.ts | 75 | ✅ |
| narrative-temporal/src/identity.ts | 49 | ✅ |
| narrative-temporal/src/index.ts | 11 | ✅ |
| narrative-temporal/src/manifest.ts | 65 | ✅ |
| narrative-temporal/src/materialize.ts | 37 | ✅ |
| narrative-temporal/src/projection.ts | 123 | ✅ |
| narrative-temporal/src/schema.ts | 14 | ✅ |
| narrative-temporal/src/studio.ts | 75 | ✅ |
| narrative-temporal/src/surface.ts | 270 | ✅ |
| narrative-temporal/src/types.ts | 53 | ✅ |
| narrative-temporal/test/identity.test.ts | 23 | ✅ |
| narrative-temporal/test/studio.test.ts | 25 | ✅ |
| narrative-temporal/test/surface.test.ts | 88 | ✅ |
| temporal/EDITING.md | 51 | ✅ |
| temporal/README.md | 43 | ✅ |
| temporal/package.json | 34 | ✅ |
| temporal/src/activation.ts | 16 | ✅ |
| temporal/src/component.ts | 57 | ✅ |
| temporal/src/domain.ts | 57 | ✅ |
| temporal/src/extent.ts | 43 | ✅ |
| temporal/src/index.ts | 132 | ✅ |
| temporal/src/markup/context.ts | 23 | ✅ |
| temporal/src/markup/index.ts | 321 | ✅ |
| temporal/src/projection.ts | 117 | ✅ |
| temporal/src/rational.ts | 80 | ✅ |
| temporal/src/sample.ts | 43 | ✅ |
| temporal/src/schedule.ts | 52 | ✅ |
| temporal/src/studio.ts | 151 | ✅ |
| temporal/src/types.ts | 98 | ✅ |
| temporal/test/markup.test.ts | 87 | ✅ |
| temporal/test/temporal.test.ts | 133 | ✅ |
| timeline/README.md | 29 | ✅ |
| timeline/package.json | 26 | ✅ |
| timeline/src/activation.ts | 10 | ✅ |
| timeline/src/component.ts | 19 | ✅ |
| timeline/src/identity.ts | 59 | ✅ |
| timeline/src/index.ts | 4 | ✅ |
| timeline/src/manifest.ts | 33 | ✅ |
| timeline/src/types.ts | 17 | ✅ |
| timeline-author/README.md | 148 | ✅ |
| timeline-author/package.json | 37 | ✅ |
| timeline-author/preview/Track.png | (binary, 720×1280) | ✅ viewed: a placeholder cartoon frame |
| timeline-author/src/activation.ts | 33 | ✅ |
| timeline-author/src/component.ts | 44 | ✅ |
| timeline-author/src/fragment.ts | 284 | ✅ |
| timeline-author/src/index.ts | 23 | ✅ |
| timeline-author/src/manifest.ts | 139 | ✅ |
| timeline-author/src/program.ts | 137 | ✅ |
| timeline-author/src/studio.ts | 309 | ✅ |
| timeline-author/src/surface.ts | 188 | ✅ |
| timeline-author/src/types.ts | 37 | ✅ |
| timeline-author/test/program.test.ts | 106 | ✅ |
| timeline-author/test/studio.test.ts | 39 | ✅ |
| timeline-author/test/surface.test.ts | 157 | ✅ |
| script/README.md | 223 | ✅ |
| script/package.json | 41 | ✅ |
| script/src/activation.ts | 25 | ✅ |
| script/src/edit.ts | 179 | ✅ |
| script/src/error.ts | 13 | ✅ |
| script/src/format.ts | 70 | ✅ |
| script/src/index.ts | 21 | ✅ |
| script/src/lexical.ts | 96 | ✅ |
| script/src/manifest.ts | 102 | ✅ |
| script/src/narrative.ts | 261 | ✅ |
| script/src/parser.ts | 852 | ✅ |
| script/src/studio.ts | 164 | ✅ |
| script/src/surface.ts | 151 | ✅ |
| script/src/types.ts | 130 | ✅ |
| script/test/display-spacing.test.ts | 80 | ✅ |
| script/test/edit.test.ts | 117 | ✅ |
| script/test/markup-integration.test.ts | 244 | ✅ |
| script/test/narrative-views.test.ts | 127 | ✅ |
| script/test/prose-boundaries.test.ts | 78 | ✅ |
| script/test/script.test.ts | 214 | ✅ |
| script/test/studio-companion.test.ts | 85 | ✅ |
| author/README.md | 73 | ✅ |
| author/package.json | 21 | ✅ |
| author/src/author.ts | 308 | ✅ |
| author/src/fragment.ts | 505 | ✅ |
| author/src/frontend-facet.ts | 30 | ✅ |
| author/src/index.ts | 75 | ✅ |
| author/src/source.ts | 207 | ✅ |
| author/test/author.test.ts | 210 | ✅ |
| author/test/fragment.test.ts | 248 | ✅ |

Clipper files read for the comparison:
- `clipper/server/align.ts` (147) ✅
- `clipper/server/transcribe.ts` (76) ✅
- `clipper/server/render.ts` (383) ✅
- the relevant parts of `clipper/server/captions.ts` (1-120), `media.ts` (`speechSpans`), `overlays.ts` (`placeOverlays`), `caption-jobs.ts` (`transcribeJob`), `formats.ts` (transcript use) and `shared/rules.ts` (`WORDS_PER_SECOND`, the length check).

## Check

Second-reviewer check against `hypit@dc2b7a8f` and `/home/user/UpAstra/clipper` (read-only; nothing run).

**Totals:** about 265 claims checked (each `path:line` citation, number, threshold, test count and test value), with 256 confirmed, 8 corrected, 0 removed and 0 marked unverified. One unsubstantiated claim ("health check runs twice per request") was rewritten rather than removed.

**Corrections, each marked *(corrected in check)* in place:**
1. §0.2 now names the single interpreter `interpretWhisperXTranscript` with two `chars: []` branches, used by both providers (whisperx-local and the out-of-batch `provider-hypihub`), and states the edge-gap bounds precisely.
2. §2: the sample-projection test values are `480,001 → 160,000` and `480,002 → 160,001`.
3. §3: the language-refusal test is at `whisperx.test.ts:70-77`, not `:271-278`.
4. §4.3: the per-request health check runs once; the lifecycle probe is separate.
5. §11: the static-clock validation is at `timeline-author/src/surface.ts:87-101`, not `:227-241`.
6. §11: the standalone surfaces are at `surface.ts:153-188`, not `:178-327`.
7. §1.3 step 6: the quantization detail (start clamp, containing frame `min(frameCount−1, start)`) has been added.
8. §5: the `WORDS_PER_SECOND` usage list was missing `src/components/ClipCard.tsx:107` and the effect of the whitespace word count on CJK.

**Priority items:**
- **Aligner constants: all confirmed.** Omission 0.5 (`align.ts:237`) and insertion 0.35 (`:254`). The 0.055 segmentation and grouping cost (`:71`, `:74`). Mismatch reliability `0.5 + 0.5·mean(clamped score)`, default 0.8 when no scores (`:25-32`). The word-LCS term 0.06 (`:76-77`). Group sizes 1–4 (`DEFAULT_MAX_GROUP = 4`, `:8`, loops `:214-218`). The unbounded exact split or merge is offered only when the run exceeds 4 (`:219-223`). Tie-break order: cost (ε 1e-9), then more exact, fewer omissions, fewer insertions, lower complexity (`:91-99`). The backtrace from `(n,m)` means ends are charged (`:262-272`). Frame quantization: floor for the start, ceil for the end, both clamped to frameCount, and an empty result becomes `[f, f+1)` (`locate.ts:392-423`).
- **Empty chars and no VAD in production: confirmed** by a whole-repo `git grep` for `speechActivity` and `chars:`. The only non-test writers are the hard-coded empty arrays in `whisperx/src/transcript.ts:78`, `:93`. The Python side passes `return_char_alignments=False` (`engine.py:199`).
- **Bug 1 (permissive locator vs `sealNarrativeAlignment`): confirmed** by a static end-to-end trace with a concrete input (§0.3). Its frequency on real WhisperX output is plausible, not measured.
- **Bug 2 (`until+for` leaves an unreachable `materialize-start`): confirmed** by static trace (§9.5). The failure is at Author link time (`author.ts:181` → `fragment.ts:291-298`), for the standalone `<time:Window timeline … until for/>` only.
- **Our app CTA on CJK: confirmed** (§13.3). The aligned `timed` words come from `Intl.Segmenter` (`align.ts:42-52`, `render.ts:214`, `:240`). The count comes from `sentences(...).at(-1).split(" ")` (`render.ts:305-308`). `sentences()` does not split on `。！？` either (`captions.ts:28-33`), so the CTA collapses to `min(lastWordStart, duration − 2.5)`.

**Coverage:** every file in the 12 packages was listed with `find` and `wc -l`: 168 tracked files, 167 text plus `Track.png`. All per-file line counts and the per-package src/test totals match the table exactly. **Files added to coverage: none.**

**Verdict: Verified ✅.** About 3% of claims needed a correction (under 10%), and coverage is complete. The corrections were mostly citation line numbers. No numeric constant in the aligner was wrong, and both suspected bugs hold up under trace.
