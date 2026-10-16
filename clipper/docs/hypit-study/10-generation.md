# 10 — Generation providers

- **Batch:** Generation providers (image / video / speech generation contracts, six gateway Providers, eleven exact-model packages, two prompt-kit packages)
- **Source:** hypit @ `dc2b7a8f31b1ef1443a79ca448548d69e3ceb6a0` (read-only, nothing built or run)
- **Size:** 20 packages, 11,661 lines under `src/**` + `kits/**`; 17,305 lines including tests, READMEs and `package.json`.

| Package | Role | src+kits lines | test lines | test() sites |
| --- | --- | ---: | ---: | ---: |
| `generation` | shared request/port/mapping contracts | 2,057 | 580 | 17 |
| `provider-hypihub` | default gateway Provider (OAuth, uploads, pricing, speech, WhisperX) | 1,699 | 1,775 | ~55 (several parameterised) |
| `provider-tokendance` | TokenDance gateway (Ark + MiniMax protocols) | 654 | 55 | 4 |
| `provider-monid` | Monid `/v1/run` gateway | 642 | 41 | 2 |
| `provider-hiapi` | HiAPI `/v1/tasks` gateway | 635 | 68 | 4 |
| `provider-beatapi` | BeatAPI tasks gateway | 588 | 66 | 3 |
| `provider-pollo` | Pollo AI gateway | 503 | 50 | 3 |
| `seedance` | Seedance 2 / fast / mini / 2.5 video model | 808 | 324 | 14 |
| `seedance-kits` | 7 `.svs` prompt templates (speaker, b-roll, podcast…) | 365 | 25 | 1 |
| `gpt-image` | GPT Image 2 model (+ `/clean` denoise variant) | 550 | 325 | 5 |
| `gpt-image-kits` | `phone-ugc-v1` image prompt template | 34 | 0 | 0 |
| `pixverse` | PixVerse V6 / C1 video | 516 | 0 | 0 |
| `grok-imagine` | Grok Imagine video + 1.5 preview | 344 | 0 | 0 |
| `wan` | Wan 2.7 Image / Pro | 317 | 0 | 0 |
| `nano-banana` | Nano Banana 2 / Pro image | 305 | 0 | 0 |
| `seedream` | Seedream 5 Lite image | 262 | 0 | 0 |
| `minimax-h3` | MiniMax H3 video | 289 | 0 | 0 |
| `mimo-speech` | Xiaomi MiMo v2.5 voice design + clone | 393 | 110 | 5 |
| `fishaudio-speech` | Fish Audio voice design + clone | 388 | 115 | 6 |
| `elevenlabs-speech` | ElevenLabs voice design (`eleven_ttv_v3`) | 312 | 67 | 2 |

Paths below are relative to the hypit repo root (`packages/...`) or to the UpAstra repo root for our app (`clipper/...`).

---

## The architecture in one picture

```
Author source (SVML)          Model package (exact model)            Provider package (one gateway)
<seedance:ReferenceVideo …>  ─► GenerationPortTable (ports+rules) ─► GenerationWireMapping (data)
   prompt = Text edge            draft → bind media/text → finalize     routes (model id by port presence)
   Reference = Blob edges        → GenerationRequest {ports:{…}}        fields: port → wire field
                                                                         + Provider code: upload, submit,
                                                                           poll, collect, errors, pricing
                                                     ▼
                                    GeneratedVideoSet / ImageSet / AudioSet (BlobRefs, never URLs)
                                                     ▼
                                    select-primary-* → ordinary Blob for ffmpeg-style consumers
```

Three separations do all the work:
1. **The model owns the input vocabulary** (`GenerationPortTable`: which ports exist, cardinalities, combination rules). Providers never redeclare it (`packages/generation/src/ports.ts:3-12`).
2. **The Provider owns the wire names**, as *data*: a `GenerationWireMapping` per capability (`packages/generation/src/mapping.ts:15-60`). One mapping engine (`compileWireRequest`) serves every model × service pair.
3. **The Provider owns execution policy**: credentials, upload transport, submit/poll/collect, retries, timeouts and pricing. The generation package explicitly does none of this (`packages/generation/README.md:27-29`).

---

## 1. `@hypit/generation`

**Purpose.** Provider-neutral contracts that exact image/video/audio model packages and gateway Providers both depend on, so neither depends on the other. It defines the request envelope, port tables, port→wire mapping, result-set types, and a helper (`/model`) that builds the repetitive Type → Producer → Need → Graph Fragment shell for an exact model.

**Public surface.**
- `src/index.ts:1-79`: `sealGenerationPortTable`, `assertGenerationPortTable`, `generationPort`, `isMediaPort` (ports); `compileWireRequest`, `selectWireModel`, `selectWireModelForRequest`, `mappingSupportsRequest`, `assertMappingCoversPorts` (mapping); `bindGenerationMedia`, `bindGenerationText`, `sealGenerationRequestDraft`, `finalizeGenerationRequestDraft`, `sealGenerationPortRequest`, `verifyRequestAgainstPorts`, schema derivers (request); `sealGenerated{Image,Video,Audio}Set` and verifiers (identity); `generationTypes`, `generationProducers`, `generationManifest`.
- `/model` subpath (`package.json` exports; `src/model.ts`): `defineExactModelModule` (`src/model.ts:442`), `createExactModelPrimaryGenerationFragment` (`:679`), `plannedExactModelRequest` (`:266`), `exactModelsFromFacets` (`:166`), facet ABI `hypit.exact-model@1` (`:142`).
- Types `GeneratedImageSet`/`VideoSet`/`AudioSet` (`src/types.ts:3-13`).

**How it works.**
- *Port table.* `{ model, result: audio|image|video, ports[], requires[] }` (`src/ports.ts:78-84`). Scalar kinds: text (optional `maxChars`), token, enum, number (integer/min/max), boolean (`:17-27`). Media ports declare accepted roles and optional per-item fields such as `personReference` (`:42-47`) with a `strictlyIncreasing` item rule for trim windows (`:37-40`). Cross-port rules: `atMostOneOf`, `requiresPresent`, `requiresAnyOf`, and `weightedTotal` (a shared reference budget) (`:66-76`). Port names must match `/^[a-z][A-Za-z0-9]*$/` (`:94`). The table is validated structurally at seal time (`:136-211`).
- *Request.* `GenerationRequest = { ports: Record<port, value[]> }`; an absent port is an omitted key (`src/request.ts:24-27`). Media values are `{ role, artifact: BlobRef, fields? }` (`src/ports.ts:86-90`). `verifyPortsAgainstTable` checks cardinality, scalar kinds, media-type prefix per role (`image/`, `video/`, `audio/`), item fields and every combination rule (`src/request.ts:237-301`; the weighted budget is at `:287-295`).
- *Drafts.* While graph inputs are still being attached, media and text ports are "deferred": absent is allowed, present is fully checked (`src/request.ts:303-315`). Each `bindGenerationMedia` / `bindGenerationText` call appends one value and re-validates (`:350-390`). Finalization runs the full table check (`:392-398`).
- *Wire mapping.* Field mapping kinds: `value`, `string`, `valueArray`, `url`, `urlArray`, `itemObject` (URL plus mapped item fields), each with an optional `whenAbsent` default. Media mappings may name `resourceFields`, which go to the upload/URL resolver rather than the JSON body (`src/mapping.ts:22-41`). `routes` select the service model id: the first route whose `whenPresent` ports are all present wins (`:44-47`, `:71-78`).
- *Compile.* `compileWireRequest(mapping, request, resolve)` first selects the route and refuses any supplied port or item field the mapping can't carry (`:113-118`, `:154-173`), *before* resolving or uploading anything. It then writes constants, `whenAbsent` defaults and each mapped field, awaiting the resolver for media (`:119-150`). Tests assert zero uploads on refusal (`test/mapping-fields.test.ts:17-26`).
- *Coverage check.* `assertMappingCoversPorts` proves a mapping is complete for a port table: names match; every port is mapped; `url` is only used for `maxItems: 1`; multi-value scalars use `valueArray`; required item fields are mapped; no two ports write the same wire field; constants don't collide; and the route list ends with exactly one unconditional route (`:186-249`).
- *Results.* Sets are 1..16 images, 1..8 videos, 1..16 audios of BlobRefs (`src/schema.ts:31-62`); prompts are capped at 20,000 chars by the shared schema (`:9-13`). `select-primary-*` producers return member `[0]` (`src/component.ts:16-31`).
- *Exact-model shell.* `defineExactModelModule` derives per endpoint: request type, `…Draft` type, a binding type and producer per media port, a text-binding producer per text port, a finalize producer, and the generate producer whose Need is the capability (`src/model.ts:195-227`, manifest `:454-518`). `plannedExactModelRequest` walks the declared assembly chain backwards (with cycle detection, `:306`) so the planner can show a request whose upstream media doesn't exist yet as symbolic `pendingMedia` (`:266-379`). Providers use this for pricing before files exist.

**Tests.** 17 `test()` sites. Examples: the schema derived from a port table rejects undeclared ports (`test/ports.test.ts:93`); media role enforces media type (`:110`); `atMostOneOf` modes (`:130`); one mapping compiles every port shape and routes by port presence (`:151`); coverage rejects a forgotten port and a wrong shape (`:190`, `:208`); an unmapped optional item field is refused before any upload, while `false` survives (`test/mapping-fields.test.ts:17-45`); planning leaves an upstream file symbolic (`test/model.test.ts:102`).

**Quality notes.**
- (+) Mapping-as-data plus `assertMappingCoversPorts` is the strongest idea in the batch. A Provider's support for a model is a reviewable table, and drift is caught structurally.
- (+) "Refuse before upload" is enforced in the engine, not left to each Provider (`src/mapping.ts:118`, `:153-173`).
- (+) Results are persisted Blob refs, never transient signed URLs (`README.md:23-25`).
- (−) Heavy ceremony. Each exact model gets ~5 nominal types and 3+N producers (`src/model.ts:454-518`) for what is, at runtime, "validate a JSON object".
- (−) Smell: `createExactModelPrimaryGenerationFragment` computes a `shape` string it never uses (`src/model.ts:754-757`). The same dead code is in `packages/gpt-image/src/fragment.ts:88`.
- (−) The prompt cap is defined twice: 20,000 in the shared schema (`src/schema.ts:9-13`), and model tables that declare their own (e.g. Seedance 2.5 allows 30,000, `packages/seedance/src/index.ts:39`). Which one wins depends on the admission path; I didn't trace the core. *(unverified)*

**Relevance: High (design), Low (code).** We need exactly this split (model capability table ↔ gateway mapping) if we add generated B-roll or images. We don't need the graph/Need/Fragment machinery.

**Better version.** One TypeScript file: `type ModelSpec = { id, kind, ports: zod schema, rules }` and `type Mapping = { model, route(req)→serviceModel, fields: Record<port, FieldMap> }`, reusing `compileWireRequest`'s semantics (refuse-unmapped-before-upload, `whenAbsent`, `resourceFields`) plus a unit test that runs `assertMappingCoversPorts` for every mapping. Skip drafts and fragments. Our requests are built in one place by the planner, not assembled from graph edges.

---

## 2. `@hypit/provider-hypihub` (the reference Provider)

**Purpose.** The default gateway Provider for hypit's own service, HypiHub (`https://hypit.ai/v1`). It implements every model in this batch except Wan, plus speech (voice design/clone), WhisperX alignment and portrait matting. It handles OAuth or API-key credentials, negotiated multipart uploads, a catalogue check before paying, async job submit/poll/collect, and pricing reads (`README.md:3-5`, `src/mapping.ts:53-167`).

**Public surface.** `createHypiHubProvider`, `hypiHubProviderModuleRef`, `CreateHypiHubProviderOptions` (`src/index.ts:1-2`). The Runtime adapter `use: "@hypit/provider-hypihub"` accepts config keys `baseUrl, apiKey, defaultConcurrency, actionLimits, capabilityConcurrency, pollIntervalMs, requestTimeoutMs, oauthRequestTimeoutMs, pricingRequestTimeoutMs, operationTimeoutMs, uploadConcurrency, uploadPartTimeoutMs, uploadPartAttempts, downloadAttempts, transcriptionModel` (`src/activation.ts:18-34`). `baseUrl` must be HTTPS or loopback (`:36-41`). `diagnoseHypiHubProvider` backs `hypit doctor` (`src/provider.ts:373`).

**How it works.**
- *Capabilities.* Audio routes are `lifecycle: "immediate"`; image and video are `"asynchronous"`; WhisperX is immediate with capacity group `transcription` (`src/provider.ts:651-664`). The default pool concurrency is 4 (`:649`). Optional per-capability limits are validated against known names (`:547-552`).
- *Credentials.* One declared slot `apiKey`, defaulting to `credentialRef("local","hypihub.oauth")` (`src/provider.ts:636`). Acquisition is OAuth2 PKCE with scopes `user:profile`, `user:inference` (`:637-648`). `createHypiHubAuth` treats a raw secret as a static key, or decodes an OAuth envelope (`src/oauth.ts:51-60`). It refreshes 60 s before expiry (`:10`, `:113-116`) through a single-flight promise (`:64-71`), and writes rotated tokens back only through the slot's `replace` callback (`:97-104`). A 401 triggers one refresh and one retry (`src/provider.ts:186-201`).
- *Request preparation.* `route.prepare` applies the HypiHub-only GPT Image limits (2K excludes `5:4, 4:5, 3:1, 1:3, 9:21`; 4K excludes `3:1, 1:3, 9:21`; `background` only at 1K) (`src/routes.ts:39-56`). It selects the model and operation, using `image_edits` when any media port is populated, decided *before* uploading (`:73-83`). Video bodies get lowercased resolution and top-level reference arrays (`:116-143`).
- *Catalogue check before paying.* `GET /models/{model}` must list the operation. A 429, 5xx or transport failure returns "unknown" and proceeds with a warning; a missing operation fails before upload (`src/provider.ts:128-146`, `:452-456`).
- *Uploads.* References are deduplicated per invocation by `(resource, fields)` (`src/provider.ts:458-468`). `POST /files/uploads` with `sha256` and the first 512 bytes as `head_base64` (`src/upload.ts:384-396`) negotiates either `s3_multipart` or `api_multipart` (`:402-406`):
  - `s3_multipart`: server-chosen part size; concurrency ≤ 8; ≤ 10,000 parts (`:302-306`). Parts are signed in batches of ≤ 128 (`:207-237`), and the signed `content-length` and checksum headers are verified against the local part (`:239-251`). Each part gets up to `uploadPartAttempts` tries (default 3, max 8) with a fresh signature per retry and a 500 ms × n backoff (`:253-297`). All workers settle before the upload is cancelled with DELETE on failure (`:338-366`).
  - Control calls retry on 408/429/5xx (and 409 `upload_incomplete`), with at most 4 attempts and 500 ms·2ⁿ backoff or `Retry-After`. Calls on an existing session are capped at min(timeout, 120 s). A new session is retried only on an explicit 429. Daily and storage quota errors fail fast (`:151-175`).
  - Whole-file concurrency is a process-wide gate keyed by origin + SHA-256(token), and the strictest limit wins (`:94-117`).
- *Submit / poll / collect.* `start` POSTs `/images/generations`, `/images/edits` or `/videos` with `idempotency-key: context.operation` (`src/provider.ts:489-494`), and checkpoints a handle `{contract, jobId, route, startedAt}` (`:75`, `:502-504`). A transport failure on submit returns `HYPIHUB_SUBMISSION_UNKNOWN` and is not retried (`:115-120`, `:496-497`). `poll` enforces `operationTimeoutMs` (default 20 min, `:556`) from `startedAt` (`:518-523`): `queued|running|in_progress` → wake in `pollIntervalMs` (default 10 s, `:592`); `failed|queue_expired|canceled` → service error with `error_code` (`src/errors.ts:49-59`). Transport errors, 429 and 5xx keep the handle and reschedule, honouring `Retry-After` capped at the deadline (`src/provider.ts:107-114`, `:531`). `collect` re-reads `/jobs/{id}/assets` (fresh URLs), downloads each asset (3 attempts, `:203-217`) and stores bytes (`:440-445`).
- *Speech.* `POST /audio/speech` with `output: "b64_json"`. It accepts raw audio bytes, a single JSON item, or `previews[]`, each item as Base64 (validated) or a URL to download (`src/provider.ts:249-299`). Each preview becomes one member of the audio set.
- *Errors.* `HypiHubHttpError` carries the code, method, route, status, model, `X-Request-Id` and `Retry-After`. URLs in reasons are redacted, and only non-JSON bodies are truncated, to 2,000 chars (`src/errors.ts:14-47`).
- *Cost.* `readPricing` returns HypiHub's authenticated `GET /pricing?model=` document verbatim, cached per model, with no local price formula (`src/provider.ts:335-352`; `README.md:180-188`). The model for pricing uses `pendingInputs`, so it works before references exist (`:320-332`).
- *Defaults.* Request 300 s, OAuth 30 s, pricing 30 s, operation 20 min, part 5 min, part attempts 3, download attempts 3 (`src/provider.ts:553-559`). Remote alignment model `victor-upmeet/whisperx` (`:595`).

**Tests.** About 55 `test()` sites across 4 files (~1,775 lines). Examples: OAuth rotation only through the declared slot, and a static key that never refreshes (`test/oauth.test.ts:9-55`); stopping before paid submission when an upload fails (`test/provider.test.ts:606`); poll transport errors stay pending while the deadline fails (`:797`); the catalogue operation is checked before resolving references, across 5 availability states (`:871-904`); terminal jobs keep service codes and receipts (`:1025`); upload control retries without a new session, retry budget, 128-part signing, shared concurrency gates, and cancellation waiting for workers (`test/upload.test.ts:29-293`).

**Quality notes.**
- (+) Production-grade async lifecycle: idempotency key, checkpointed handle, "unknown outcome" instead of double-paying, deadline-capped retries, fresh asset URLs at collect.
- (+) Careful secret hygiene: signed URLs are redacted from every surfaced error (`src/errors.ts:14-16`, `src/upload.ts:295-296`).
- (−) There is no `assertMappingCoversPorts` test for HypiHub, unlike every smaller Provider. Its PixVerse V6 mapping omits the model's `seed`/`multiClip` ports (`src/mapping.ts:38-51` vs `packages/pixverse/src/index.ts:37-38`), so the coverage assertion would fail. The README documents this as deliberate refusal-by-name (`README.md:38-39`), but a test should pin it.
- (−) `collect` retries on 5xx or transport errors with no deadline (`src/provider.ts:540` passes no `deadlineAt`), so a persistently failing asset host is retried forever by the scheduler. The same pattern appears in all six Providers.
- (−) An HTTP error on a request with a string body re-parses `init.body` as JSON (`src/provider.ts:190`). It's harmless today because every string body is JSON.
- (−) The upload logger defaults to `console.error` per part (`src/upload.ts:139`, constructor), which is noisy in a multi-tenant server.

**Relevance: High** as a template for the job lifecycle (we already run long ffmpeg jobs). Low as a dependency: HypiHub is hypit's own paid gateway.

**Better version.** For a CPU-only multi-tenant Railway server: a `gen_jobs` table `{id, workspaceId, provider, model, request_hash, handle JSON, status, wake_at, cost, receipt}`, plus a worker that calls `start/poll/collect` with exactly HypiHub's semantics (idempotency key = job id; unknown-on-transport; deadline from `started_at`; fresh URLs at collect; bytes to S3). Add a collect deadline. Cost: record the provider's quoted price at submit, and its billed amount if the API returns one, into `recordAI`-style metering (`clipper/server/usage.ts:57`).

---

## 3. `@hypit/provider-tokendance`

**Purpose.** TokenDance gateway Provider: Seedance ×4 and MiniMax H3 (async), and Seedream 5 Lite (sync) (`README.md:13-20`).

**Public surface.** `createTokenDanceProvider`, `tokenDanceProviderModuleRef` (`src/index.ts:1-2`). Config keys: `baseUrl, apiKey, defaultConcurrency, actionLimits, pollIntervalMs, requestTimeoutMs, operationTimeoutMs` (`src/activation.ts:18-26`).

**How it works.**
- Model ids: `seedance-2.0`, `-fast`, `-mini`, `seedance-2.5`, `seedream-5.0-lite`, `minimax-h3` (`src/mapping.ts:30-60`). The protocol is chosen per capability: `ark-video`, `ark-image` or `minimax-video` (`src/routes.ts:155-157`).
- Video bodies fold media into an Ark-style `content[]` of typed, role-tagged items (`first_frame`, `last_frame`, `reference_image/video/audio`) (`src/routes.ts:97-113`). `web_search: true` becomes `tools:[{type:"web_search"}]` (`:115-125`).
- Seedream maps `quality` × `aspect_ratio` to an explicit pixel size table: basic (2K) / high (3K) / ultra (4K), e.g. 9:16 → `1600x2848 / 2304x4096 / 3040x5504`. It sends `watermark: false` (`src/routes.ts:66-70`, `:127-138`).
- Pre-submit refusals: Seedance 2.5 frame mode requires `adaptive`; Seedream needs a size entry; MiniMax text-to-video needs an explicit ratio (`src/routes.ts:72-95`).
- References: Ark accepts images < 30 MB and audio ≤ 15 MB inline as `data:` URLs within a 64 MB body. Video is URL-only, so it needs `publicAssetUrl`. MiniMax uploads go through `/minimax/v1/files/upload` → `mm_file://id` (`src/routes.ts:38-42`; `src/provider.ts:106-116`, `:131-152`, body cap `:160-162`).
- Submit has **no idempotency key** (`src/provider.ts:205-207`). Poll statuses are `queued|running`, then `succeeded` stores the video URL in the handle (`:234-238`). Operation timeout defaults to 30 min (`:260`). Pricing is a static page link only (`:280`).

**Tests.** 4: every mapping covers its model's ports; Seedance frames become role-tagged content; Seedream size selection; MiniMax T2V without ratio is unsupported (`test/routes.test.ts:17-54`).

**Quality notes.** (+) Clean, small, faithful to the documented protocols. (−) No idempotency key. The URL is captured at poll time and downloaded at collect (it may expire). Inline Base64 of up to 64 MB per request means memory pressure. The resolver dedupes by resource only, ignoring fields (`src/provider.ts:134`). That's fine because no fields are transmitted.

**Relevance: Medium.** A cheap Seedance/MiniMax route. The `data:` URL trick avoids needing public asset URLs for images.

**Better version.** Same as HypiHub's lifecycle; prefer providers that accept an idempotency key.

---

## 4. `@hypit/provider-monid`

**Purpose.** Monid workspace Provider: Seedance ×4, MiniMax H3, Wan 2.7 Image/Pro, all via `POST /v1/run {provider, endpoint, input}` and `GET /v1/runs/{id}` (`README.md:9-21`).

**Public surface.** `createMonidProvider`, `monidProviderModuleRef`. Config keys are identical to TokenDance's (`src/activation.ts`, same shape).

**How it works.**
- Each mapping carries the Monid `service` (`bytedance`/`minimax`/`alibaba`), and the route "model" is the endpoint path (`src/mapping.ts:12`, `:19-90`). MiniMax adds the constant `model: "MiniMax-H3"` with resolution defaulting to `2K` (`:43-59`).
- Refusals: Wan 4K only from a prompt alone; Wan `count > 4` only inside an image set; MiniMax T2V needs a ratio; Seedance `webSearch: true` unsupported; Seedance 2.5 frame mode must be `adaptive` (`src/routes.ts:48-79`). The MiniMax ratio defaults to `adaptive` in frame/reference modes (`:110-113`).
- References are uploaded to Monid's workspace file system: `sfs /put` (sign) → PUT bytes → `sfs /cat ttl: "1d"`, each a short run polled at ≤ 5 s (`src/provider.ts:134-160`, `:264`). Files are never removed (`README.md:58-59`).
- A synchronous run may return a non-2xx HTTP status *with* a run body, which is treated as a run (`src/provider.ts:120-122`). Terminal statuses are `COMPLETED|FAILED|BLOCKED|STOPPED|TIMED_OUT`. A COMPLETED run whose `providerResponse.httpStatus` ≥ 400 is a failure (`src/errors.ts:36-57`). Output URLs are searched across several shapes (`src/provider.ts:93-104`).
- No idempotency key on `/v1/run` (`src/provider.ts:127-129`).

**Tests.** 2: mapping coverage, and the Seedance ModelArk body (`test/routes.test.ts:15-41`).

**Quality notes.** (+) Handles a "200-ish run with a provider error inside" envelope correctly. (−) Uploaded references accumulate in the customer's workspace forever. That would be a storage leak per tenant for us. `outputUrls` guesses among 7 shapes (`src/provider.ts:96-103`), which is fragile.

**Relevance: Low–Medium.** Only route here to Wan 2.7.

**Better version.** If used, delete uploaded refs after collect.

---

## 5. `@hypit/provider-hiapi`

**Purpose.** HiAPI Provider: Seedance ×4, Seedream, MiniMax H3, GPT Image 2, Nano Banana 2/Pro, Grok Imagine ×2, all through one `POST /v1/tasks` / `GET /v1/tasks/{id}` (`README.md:9-27`).

**How it works.**
- HiAPI splits a model into per-mode ids, expressed purely as routes. For example Seedance 2.5 → `reference-to-video` if there's a reference video, else `image-to-video` if there's a frame, image or audio, else `text-to-video` (`src/mapping.ts:39-49`). Seedream, GPT Image and Grok choose `image-to-*` when images are present (`:50-55`, `:80-93`, `:104-117`). This is the best demonstration of the route mechanism.
- Refusals encode documented limits: Seedance-mini has no web search; 2.5 I2V only `adaptive`; 480p only on R2V; Seedream `high` (3K) is unsupported; MiniMax 2K only, ≤ 5 reference images; GPT Image `background` and `auto` only at 1K, 2K/4K ratio exclusions, ≤ 6 refs; Grok no 1080p, and 1.5 needs exactly one image (`src/routes.ts:64-101`).
- References: images and audio inline as `data:` URLs, with per-model caps (e.g. 30 MB image / 15 MB audio / 120 MB combined images for Seedance 2.5; 10 MB for Seedream I2I) (`src/routes.ts:25-33`; `src/provider.ts:115-142`). Video needs `publicAssetUrl`.
- Submit carries `idempotency-key: context.operation` (`src/provider.ts:157-159`). Statuses: `queued|handling|archiving` pending, `success` / `fail` terminal (`:187-199`). Responses are unwrapped from `{data}` (`:103`).

**Tests.** 4: coverage; Seedance 2.5 model by request shape; Seedream quality → resolution with 3K unsupported; GPT `background` refused before references resolve (`test/routes.test.ts:21-68`).

**Quality notes.** (+) Broadest catalogue of the small Providers, idempotent submit, explicit documented limits. (−) Inline Base64 again; URLs captured at poll time.

**Relevance: Medium–High.** One key reaches Seedance, MiniMax, Grok, GPT Image, Nano Banana and Seedream.

---

## 6. `@hypit/provider-beatapi`

**Purpose.** BeatAPI Provider: Seedance ×4, MiniMax H3, Grok 1.5, GPT Image 2, Nano Banana 2/Pro (`README.md:14-24`).

**How it works.**
- One alias serves every mode. The opening and closing frames travel as one ordered `images` array. Because a mapping can't write one wire field from two ports (`packages/generation/src/mapping.ts:234-236`), the mapping writes `first_frame`/`last_frame` and `normalize` folds them (`src/mapping.ts:14-17`; `src/routes.ts:79-82`).
- Refusals: no web search; mini has no generated audio; Seedance 2 has no 1080p with reference images; 2.5 needs a 4–30 s duration (not `-1`); MiniMax last frame needs a first frame; Grok 1.5 ≤ 1 image at 1080p; GPT Image has no `background`; Nano Banana 2 ≤ 10 refs and no `1:4, 4:1, 1:8, 8:1` (`src/routes.ts:40-73`). `jpg` becomes `jpeg` for Nano Banana 2 (`:85`).
- References go to `POST /v1/files purpose=input`, with a type and size whitelist: images and audio ≤ 50 MB, MP4/MOV ≤ 100 MB (`src/provider.ts:40-44`, `:121-137`).
- Idempotent submit to `/v1/{image|video}s/tasks` (`src/provider.ts:175-179`). The service's `retry_after_seconds` overrides the header (`src/errors.ts:29-30`).

**Tests.** 3: coverage; ordered frames; dropped-when-false / refused-when-true fields (`test/routes.test.ts:19-66`).

**Quality notes.** (+) The proper upload endpoint avoids Base64 bodies, and there's an idempotency key. (−) Uploaded files have no lifecycle or cleanup.

**Relevance: Medium.**

---

## 7. `@hypit/provider-pollo`

**Purpose.** Pollo AI Provider: MiniMax H3, Grok 1.5, GPT Image 2, Nano Banana 2/Pro. Pollo offers no Seedance or Seedream (`README.md:14-23`).

**How it works.** The route "model" is the request path, e.g. `/v1/generation/minimax/minimax-h3/video` (`src/mapping.ts:14-60`). Auth uses the `x-api-key` header (`src/provider.ts:86`). MiniMax references become typed `refs[]` (`src/routes.ts:63-75`). Grok 1.5 sends a single `image` and refuses any ratio but `auto`. GPT Image is limited to 9 ratios; Nano Banana refuses `auto` (`:39-56`, `:76-81`). Pollo accepts references **only** by URL, so any reference without `publicAssetUrl` fails before submission (`src/provider.ts:104-115`). A task is done when all `generations[]` are `succeed` (`:158-172`). No idempotency key (`:129-131`).

**Tests.** 3 (`test/routes.test.ts:19-50`).

**Relevance: Low.** It needs our own public asset hosting (we have S3, so feasible).

---

## 8. `@hypit/seedance`

**Purpose.** The exact Seedance video model package: four capabilities (`seedance-2`, `-fast`, `-mini`, `-2.5`), each with its own port table, and three author Surfaces (`TextVideo`, `FrameVideo`, `ReferenceVideo`) that make the three incompatible invocation shapes unrepresentable (`README.md:17-25`).

**Public surface.** `seedanceModels`, `seedancePorts`, `sealSeedanceRequest`, `seedanceEndpoints[ByModel]`, `seedanceMarkupSurfaces`, the component/definition/manifest (`src/index.ts:14-340`); `validateSeedanceAudio`/`Inputs` (`src/validation.ts`); fragment helpers (`src/fragment.ts`). Markup tags: `<seedance:TextVideo|FrameVideo|ReferenceVideo>` with `<seedance:Reference image|video|audio person-reference>` children.

**How it works (the numbers).**
- Prompt ≤ 20,000 chars (30,000 for 2.5). Reference images ≤ 9 (30), videos ≤ 3 (10), audio ≤ 3 (10). First/last frame ≤ 1 each (`src/index.ts:39-44`).
- Resolution: `seedance-2` offers 480p/720p/1080p/4k; 2.5 offers 480p/720p/1080p; fast and mini offer 480p/720p (`src/index.ts:46-55`). Aspect ratios: `1:1, 4:3, 3:4, 16:9, 9:16, 21:9, adaptive` (`:18`).
- Duration: integer 4–15 s, or for 2.5 an enum of `-1` (auto, "source-edit") or 4–30 (`src/index.ts:22`, `:57-64`).
- Rules: frames exclude every reference kind; a last frame needs a first frame. For Seedance 2 (not 2.5), reference audio needs a visual reference, and the total reference budget is 12 (`src/index.ts:68-80`).
- Surface defaults: `720p`, `9:16`, `generate-audio=false`, `web-search=false` (`src/surface.ts:177-190`). Every image/video reference must declare `person-reference="true|false"`, with no default and no face detection (`src/surface.ts:143-148`; `README.md:66-81`). HypiHub forwards it as `is_person_reference` at upload time (`packages/provider-hypihub/src/upload.ts:392`).
- M4A/`audio/mp4` reference audio is rejected at decode, and again at binding and finalization (`src/validation.ts:5-16`; `src/surface.ts:108`).

**Tests.** 14 sites, including 5 parameterised over all four models: M4A rejected at decode and binding; person classification survives binding → finalization → generation; future audio stays symbolic in planning; the three Surfaces make incompatible shapes unrepresentable (`test/surface.test.ts:39-168`, `test/validation.test.ts:49-132`).

**Quality notes.** (+) Model limits are encoded once and providers inherit them. (+) The explicit `person-reference` flag is a sound answer to the upstream "real face" moderation (TokenDance notes Seedance rejects real-face references there, `packages/provider-tokendance/README.md:30-32`). (−) `webSearch` is always sent (`false` by default) even on Frame/Reference shapes (`src/surface.ts:189`), and each Provider has to drop it. (−) Duration is author-literal with no estimation in the graph (`README.md:27-31`). That's fine for an agent author; we'd compute it from the voiceover length.

**Relevance: High.** Seedance is the strongest candidate for generated UGC/talking-head and B-roll footage, and these limits are exactly what we'd validate against.

**Better version.** A zod schema per variant generated from this table, plus a planner rule: `duration = clamp(ceil(voiceSec + 0.5), 4, 15)`, with `person-reference` derived from our own asset metadata (creator selfie = true, product shot = false).

---

## 9. `@hypit/seedance-kits` — the UGC prompt templates

**Purpose.** Seven data-only `TextTemplate` sources (`.svs` sheets) rendered by `text:Render` into the Seedance prompt. They are not wrappers or executors (`README.md:3-4`, `:18-20`). Exports: `./speaker, ./broll, ./podcast, ./call, ./street-interview, ./motion-reference, ./camera-reference` (`package.json:7-15`).

**How it works.** Each sheet declares ordered blocks: `fixed` text, `axis` blocks (one parameter chosen from named `choice`s with a default), and `slot`s filled by Text (`dialogue`, `action`, `story`, `direction`). Blocks are joined with paragraph separators. The content is the value:
- **speaker-v1** (talking-head UGC) (`kits/speaker-v1.svs`):
  - Fixed contract: "realistic vertical phone-shot talking-head… @image1 is the visible speaker and scene reference… @audio1 is the speaker's voice-timbre reference" (`:16`). A script contract: "Deliver the supplied script exactly in order with clear lip-sync… Do not rewrite, summarize, add, remove, or reorder words" (`:19-23`). Text hygiene: "Add no subtitles, captions, labels, logos… readable on-screen text" (`:115-119`).
  - Axes: `composition-stability` (flexible-ugc / soft-locked* / strict-locked), `camera-motion` (none* / subtle-punch-in-return), `edit-rhythm` (continuous-take* / pause-trim-jump-cuts), `performance` (natural-explainer* / high-energy-ugc / calm-authority / reactive-playful), `gesture` (restrained / compact / natural* / expressive) (`:4-113`; defaults `:4-11`).
  - The README recommends `pause-trim-jump-cuts` for ordinary direct-to-camera UGC (`README.md:100-127`).
- **broll-v1** (`kits/broll-v1.svs`): silent "B-roll micro-film". Axes: `material-mode` (practical-real UGC phone feel*, screen-demo, product-beauty, proof-capture, stylized-vfx), `story-shape`, `edit-language`, `camera-language` (reference-locked*, selfie-vlog, handheld-follow, push-reveal, product-macro), `motion-intensity`. Fixed hygiene: no captions or overlays (`:13-51`).
- **podcast-v1 / call-v1 / street-interview-v1**: two-person formats with explicit speaker and voice maps (`@image1/@audio1` = A, `@image2/@audio2` = B). The street interview is a closed set of three camera setups with a microphone-ownership contract (`kits/street-interview-v1.svs:13-15`).
- **motion-reference / camera-reference**: transfer body motion or camera language from `@video1` onto the `@image1` subject, explicitly excluding the other property (`kits/motion-reference-v1.svs:5-7`, `kits/camera-reference-v1.svs:5-7`).

**Tests.** 1 test over 7 cases: each sheet parses, renders with sample bindings, and contains its marker text (`test/kits.test.ts:7-25`).

**Quality notes.** (+) Very good prompt engineering: contracts separated from creative choices, and the axes are small closed vocabularies a planner can pick from. Hygiene blocks match our need, since we burn our own captions. (−) Tests check only one marker per kit; there are no golden renders.

**Relevance: High.** Directly reusable as prompt text for "generated creator" or b-roll clips. Our captions and overlays already come from ASS, which is exactly why the kits forbid on-screen text.

**Better version.** Port the sheets into a TS `PromptKit = { fixed: string[], axes: Record<axis, Record<choice,string>>, slots }` with a 20-line renderer. Let the plan model choose axis values (it already chooses hook style) and record them as clip traits for the "What's working" learning loop.

---

## 10. `@hypit/gpt-image`

**Purpose.** The GPT Image 2 exact model, plus a `@hypit/gpt-image/clean@1` module that appends a denoise transform as a visible second operation (`README.md:13-17`).

**How it works.** Ports: prompt ≤ 20,000 chars; 16 aspect ratios including `auto`, `2:1`, `9:21`; resolution `1K|2K|4K`; optional `background` `transparent|opaque|auto`; ≤ 16 reference images (`src/index.ts:15-42`). There are no combination rules; provider-specific limits live in Providers (`README.md:10-11`). The cleanup program is NLM denoise in YCrCb (luma 2, chroma 10, template 7, search 21, saturation recovery 1.02), then PNG encode (`src/cleanup-program.ts:4-16`). The surface is `<gpt:Image id prompt aspect-ratio resolution [background]>` with `<gpt:Reference image>` children (`src/surface.ts:109-183`).

**Tests.** 5: raw and clean surfaces keep edges explicit; hidden inline prompts are rejected; a B-roll graph where one shared holding image feeds 3 GPT requests + 3 transforms + 1 Seedance-mini, and pinning a candidate prunes one branch (`test/surface.test.ts:42-93`, `test/broll-graph.test.ts:187-223`).

**Quality notes.** (+) Shipping a deterministic post-process (denoise) as part of the "official" variant is a good pattern for de-AI-ing generated stills. (−) Dead `shape` variable (`src/fragment.ts:88-91`).

**Relevance: Medium–High.** Generated stills (product-in-hand, first frames for Seedance) are the typical first step of a UGC-style pipeline.

---

## 11. `@hypit/gpt-image-kits`

**Purpose / how it works.** One template, `phone-ugc-v1`. A fixed capture paragraph ("a single frame from a video actually shot on an iPhone… without an oily, overprocessed finish… no depth-of-field blur… natural skin texture") is followed by optional `person`, required `shot` and optional `setting` slots (`kits/phone-ugc-v1.svs:8-33`; `README.md:3-26`).

**Tests.** None.

**Relevance: High.** This is the anti-"AI look" prompt we'd want for any generated frame. Copy the wording.

---

## 12–17. Other exact-model packages

All follow the same shape: a port table, `defineExactModelModule`, and one or two structured Surfaces whose decoders validate attributes and child references, seal a draft, and emit an assembly fragment. None has tests.

| Package | Capability | Key limits (cited) | Surfaces |
| --- | --- | --- | --- |
| `pixverse` | `pixverse-v6`, `pixverse-c1` | prompt ≤ 5,000; quality `540p/720p`; duration 1–15; refs ≤ 10 (V6) / 7 (C1); V6 ≤ 2 ref videos, which carry the duration; `seed`, `multiClip` V6-only; frames exclude refs; ratio excluded with a first frame (`packages/pixverse/src/index.ts:20-78`); duration required unless ref video (`src/validation.ts:5-12`) | `<pix:Video>`, `<pix:ReferenceVideo>` (`src/surface.ts:189-250`) |
| `grok-imagine` | `grok-imagine-video`, `…-1.5-preview` | prompt 5,000 / 4,096; duration 6–30 / 1–15; ≤ 7 images; preview adds `auto` ratio (`packages/grok-imagine/src/index.ts:12-46`) | `<grok:Video>`, `<grok:PreviewVideo>` |
| `wan` | `wan-2.7-image`, `-pro` | prompt ≤ 5,000; ≤ 9 refs; `1K/2K` (+`4K` pro); `count` ≤ 12; `imageSet` excludes `extendedReasoning`; no aspect ratio or negative prompt (`packages/wan/src/index.ts:16-44`) | `<wan:Image>`, `<wan:ProImage>` |
| `nano-banana` | `nano-banana-2`, `-pro` | prompt 20,000 / 10,000; refs 14 / 8; 15 / 11 ratios; `1K/2K/4K`; `png/jpg` (`packages/nano-banana/src/index.ts:12-38`) | `<nano:Image>`, `<nano:ProImage>` |
| `seedream` | `seedream-5-lite` | prompt ≤ 3,000; 8 ratios; quality `basic/high/ultra` = 2K/3K/4K; `nsfwCheck` explicit; ≤ 14 refs (`packages/seedream/src/index.ts:10-29`) | `<seedream:TextImage>`, `<seedream:ReferenceImage>` (`src/surface.ts:38-84`) |
| `minimax-h3` | `minimax-h3` | prompt ≤ 7,000; duration 4–15; resolution `768P/2K`; 6 ratios; refs 9 img / 3 vid / 3 audio, ≤ 12 total; audio needs a visual; frames exclude refs and ratio (`packages/minimax-h3/src/index.ts:19-57`) | `<h3:TextVideo|FrameVideo|ReferenceVideo>` |

**Quality notes.**
- (+) Model limits are where they belong, and each Provider adds only service quirks.
- (−) The decoders are ~80% copy-paste: `sameType`, `exact`, `text`, `ref` and `localName` are redefined in every `surface.ts`.
- (−) The README for MiniMax H3 uses `resolution="768P"` in examples, but HiAPI refuses anything other than `2K` (`packages/provider-hiapi/src/routes.ts:84-86`), and HypiHub/TokenDance/Monid default to 2K. The model-level default is effectively Provider-dependent.
- (−) No tests.

**Relevance.** Medium as reference data (limit tables to validate against); Low as code.

---

## 18–20. Speech: `mimo-speech`, `fishaudio-speech`, `elevenlabs-speech`

**Purpose.** "Voice design" (natural-language description + sample text → a reusable voice-reference audio) and "voice clone" (reference audio + text → speech) as exact models. Each package contains no URL, credential or wire format (`packages/mimo-speech/README.md:11-13`).

**Public surface.**
- MiMo: `mimo-v2.5-tts-voicedesign {text, voiceDescription}` and `mimo-v2.5-tts-voiceclone {text, instruction?, voiceReference (1 audio)}` (`packages/mimo-speech/src/index.ts:20-42`). Tags `<mimo:VoiceDesign id speech>` with the description as body, and `<mimo:VoiceClone id speech voice>` with an optional delivery instruction as body (`src/surface.ts:71-87`, `:161-188`). Outputs `<id>.reference` / `<id>.audio`.
- Fish Audio: `voice-design-1 {text, voiceDescription}`, `voice-clone {text, voiceReference}`. VoiceClone *rejects* a body rather than silently dropping it (`packages/fishaudio-speech/src/index.ts:20-40`; `src/surface.ts:173-175`).
- ElevenLabs: `eleven_ttv_v3` voice design only. Text and description each ≤ 1,000 chars; the documented floors (100 and 20) are left to the service (`packages/elevenlabs-speech/src/index.ts:12-27`). The service returns several previews, and member `[0]` is exposed (`README.md:5-8`).
- None exposes preset voices (`packages/provider-hypihub/README.md:202-203`). All are served only by HypiHub's `POST /v1/audio/speech` (`packages/provider-hypihub/src/mapping.ts:129-166`). Fish Audio clone sends the constant `voice_description: "reference"` (`:152-158`).

**Tests.** 5 / 6 / 2: model shapes; the package contributes its Surfaces; VoiceDesign publishes one `reference`; VoiceClone binds audio and refuses non-audio (`packages/mimo-speech/test/mimo-speech.test.ts:55-98`, `packages/fishaudio-speech/test/fishaudio-speech.test.ts:55-103`, `packages/elevenlabs-speech/test/elevenlabs-speech.test.ts:42-56`).

**Quality notes.** (+) "Voice identity is just an audio Resource" is elegant: the same reference can feed Seedance's `referenceAudio` so the generated presenter speaks in the designed voice (`packages/mimo-speech/README.md:27-28`). (−) Three near-identical packages (`diff` of `surface.ts` shows only names and the body rule differ).

**Relevance: Medium–High.** A per-brand designed voice is a real upgrade over our 8 preset `gpt-audio-mini` voices (`clipper/shared/types.ts:259`). It also gives us voice consistency between a TTS voiceover and a generated talking-head clip.

---

## Cross-cutting: the provider abstraction vs. our `llm.ts`

### What each Provider does on the lifecycle

| | Submit | Idempotency | Poll | Collect | Upload of refs | Pricing | Credentials |
| --- | --- | --- | --- | --- | --- | --- | --- |
| HypiHub | POST images/generations, images/edits, videos (`provider-hypihub/src/provider.ts:489-494`) | `idempotency-key` = operation | `/jobs/{id}`, 10 s, 20 min deadline | re-fetch `/jobs/{id}/assets` | negotiated S3 multipart / API multipart, checksummed | live `GET /pricing?model=` doc | OAuth PKCE w/ refresh, or API key |
| TokenDance | Ark tasks / MiniMax | none | 10 s, 30 min | URL from poll | `data:` URL (≤ 30 MB img, 15 MB audio, 64 MB body); MiniMax file API | page link | API key |
| Monid | `/v1/run` | none | `/v1/runs/{id}` | URLs from poll | workspace sfs, 1-day signed URL, never deleted | page link | API key |
| HiAPI | `/v1/tasks` | yes | `/v1/tasks/{id}` | URLs from poll | `data:` URLs (per-model caps) | page link | API key |
| BeatAPI | `/v1/{image,video}s/tasks` | yes | `/v1/tasks/{id}` | URLs from poll | `/v1/files` (≤ 50/100 MB) | page link | API key |
| Pollo | path per model | none | `/v1/generation/{id}/status` | URLs from poll | caller-supplied public URL only | page link | `x-api-key` |

Shared semantics (identical code in all six, e.g. `provider-hypihub/src/provider.ts:100-120`, `provider-hiapi/src/provider.ts:61-85`):
- **Submit:** a transport failure → `*_SUBMISSION_UNKNOWN`, failed, never auto-resubmitted.
- **Poll:** transport errors, 429 and 5xx → stay pending, wake after `Retry-After` or the poll interval, capped at the operation deadline. Anything else fails.
- **Collect:** same retry policy, but no deadline.
- Every error message redacts URLs.

### Which models are reachable through which key

| Model (capability) | HypiHub | TokenDance | Monid | HiAPI | BeatAPI | Pollo | Via our OpenRouter key? |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | --- |
| Seedance 2 / fast / mini / 2.5 (video) | ✓ | ✓ | ✓ | ✓ | ✓ | – | No (not a chat-completions model) *(unverified against today's OpenRouter catalogue)* |
| MiniMax H3 (video) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | No *(unverified)* |
| PixVerse V6 / C1 (video) | ✓ | – | – | – | – | – | No *(unverified)* |
| Grok Imagine video | ✓ | – | – | ✓ | – | – | No *(unverified)* |
| Grok Imagine 1.5 preview | ✓ | – | – | ✓ | ✓ | ✓ | No *(unverified)* |
| GPT Image 2 (image) | ✓ | – | – | ✓ | ✓ | ✓ | Possibly; OpenRouter exposes some OpenAI image-output models via `modalities` *(unverified for this exact model)* |
| Nano Banana 2 / Pro (image) | ✓ | – | – | ✓ | ✓ | ✓ | Likely: these are Gemini image models, which OpenRouter serves with image output in chat completions *(verify slugs)* |
| Seedream 5 Lite (image) | ✓ | ✓ | – | ✓ | – | – | *(unverified)* |
| Wan 2.7 Image / Pro | – | – | ✓ | – | – | – | *(unverified)* |
| MiMo / Fish Audio / ElevenLabs voice design & clone | ✓ | – | – | – | – | – | No. OpenRouter's audio output is chat audio with preset voices (what `speak` uses) |
| WhisperX alignment | ✓ | – | – | – | – | – | n/a (we run whisper.cpp locally) |

Sources for the ✓ cells: each Provider's `src/mapping.ts`. The OpenRouter column is from general knowledge, not from this repo, and needs a check of OpenRouter's live model list (filter by output modality) before we commit.

**Bottom line:** video generation needs at least one separate gateway key. HiAPI or BeatAPI give the widest coverage with an idempotent submit; HypiHub is the most robust but is hypit's own service. Image generation may be reachable through OpenRouter (Nano Banana family). Voice design and cloning need a separate key.

### Comparison with `clipper/server/llm.ts`

| Concern | hypit Providers | Our `llm.ts` |
| --- | --- | --- |
| Model selection | Model fixed by the author's capability; the Provider maps it to a service id by request shape (routes) | Per-role env override with defaults (`clipper/server/llm.ts:8-17`, `:155`) |
| Transport | Per-gateway client, async job lifecycle, checkpointed handle | One synchronous chat-completions POST (OpenRouter, else OpenAI) (`:23-35`, `:175-208`) |
| Input validation | Full port table + Provider limits *before* any paid call | None beyond prompt construction; `response_format` fallback on 400 (`:198-201`) |
| Retries | Poll-time retry on 429/5xx/transport with `Retry-After`; no blind resubmission | None in `chatJSON`/`forwardChat`. `render.ts` re-records an off-script voice take once (`clipper/server/render.ts:200-222`) |
| Timeouts | Request 300 s, operation 20–30 min | 120 s chat (`clipper/server/llm.ts:195`), 180 s agent/voice (`:91`, `:227`) |
| Cost | HypiHub: live pricing document per model; others: a pricing page link. No billed-cost capture | Billed `usage.cost` from OpenRouter on every call → `recordAI` (`:52`, `:96`, `:206`, `:256`; `clipper/server/usage.ts:57`); daily per-workspace cap (`clipper/server/llm.ts:41-50`) |
| Credentials | Per-Endpoint credential slot, OAuth refresh written back through a narrow `replace` | One server-wide env key |
| TTS | Voice design/clone models returning audio-set Resources (b64 or URL), multiple previews | `speak`: streamed `gpt-audio-mini`, `pcm16` 24 kHz, 8 preset voices, rejects < 4,800 bytes of audio (`clipper/server/llm.ts:211-259`; `clipper/shared/types.ts:259`) |
| Error evidence | Code, route, status, model, request id; URLs redacted | `AI ${status}: first 300 chars` (`clipper/server/llm.ts:94`, `:202`) |

Our metering is *better* than hypit's here: we record actual billed cost per call. hypit records none for generation and leaves pricing to a page or document. Hypit is far ahead on long-running jobs and on pre-flight validation.

---

## Ideas worth taking (ranked)

1. **The seedance-kits / phone-ugc prompt text** (`packages/seedance-kits/kits/*.svs`, `packages/gpt-image-kits/kits/phone-ugc-v1.svs`). This is immediate value for any generated creator clip or still: closed axis vocabularies for a planner, an exact-script lip-sync contract, and "no on-screen text" hygiene that fits our ASS captioning.
2. **The async job lifecycle from HypiHub** (`packages/provider-hypihub/src/provider.ts:482-544`): idempotency key, checkpointed handle in the DB, `SUBMISSION_UNKNOWN` instead of re-paying, a deadline from `startedAt`, `Retry-After`-aware rescheduling, fresh asset URLs at collect, bytes into our own S3. It fits our Railway worker model and survives restarts.
3. **Mapping-as-data + coverage test** (`packages/generation/src/mapping.ts:113-249`): one `compileWireRequest`, per-gateway tables, refuse-unmapped-before-upload, and a CI test proving every mapping covers its model. It lets us switch video gateways without touching the planner.
4. **Model limit tables** (Seedance `src/index.ts:33-82`, MiniMax, Grok…), as zod schemas the planner validates against before spending money. Pair them with each gateway's refusal list (e.g. `packages/provider-hiapi/src/routes.ts:64-101`).
5. **Voice identity as an audio Resource** (`packages/mimo-speech/README.md:27-28`): design a brand voice once, store the reference, reuse it for TTS voiceovers and as Seedance `referenceAudio`. It's a natural upgrade to `VoiceOption`.
6. **Explicit `person-reference` classification** on visual references (`packages/seedance/src/surface.ts:143-148`), derived from our asset metadata, so face-moderation rules are respected deliberately.
7. **Catalogue check before paying** (`packages/provider-hypihub/src/provider.ts:128-146`): a cheap GET that turns "model renamed or unavailable" into a pre-flight error, not a wasted upload.
8. **Post-process generated stills** with a deterministic denoise (`packages/gpt-image/src/cleanup-program.ts:4-16`). We can do the equivalent with ffmpeg `hqdn3d`/`nlmeans` on CPU.

## Things not to copy

- **The Type → Producer → Need → Fragment ceremony** (`packages/generation/src/model.ts:442-658`). Five nominal types per model is built for an agent-authored, content-addressed build graph. Our planner builds a request in one function.
- **Inline `data:` URL references** (TokenDance, HiAPI: up to 64 MB JSON bodies, `packages/provider-tokendance/src/routes.ts:38-42`). This means memory spikes on a shared CPU box. Upload to our S3 and pass signed URLs (all gateways accept URLs, or have a `publicAssetUrl` hook).
- **Uploads that are never cleaned up** (Monid sfs, `packages/provider-monid/README.md:58-59`; BeatAPI files). This is per-tenant storage leakage.
- **Collect with no deadline** (`packages/provider-hypihub/src/provider.ts:540` and the same line in every Provider). Add one.
- **Six near-identical Provider files** with copied `failure`/`retrying`/`unknownSubmission` helpers and per-surface copies of `exact`/`ref`/`sameType`. Write one generic async-job client with per-gateway adapters instead.
- **Author-literal durations** (`packages/seedance/README.md:27-31`). With no agent in the loop, derive the duration from the measured voiceover.
- **Leaving cost as a page link.** Keep our pattern of recording the billed amount per call, and also store the gateway's quoted price at submit for budgeting checks (`checkAIBudget`).

---

## Coverage

Every file in the 20 packages is listed below. Line counts are from `wc -l` at the stated commit. `src/**`, `kits/**`, READMEs and the key `package.json` fields were read in full. Test files were read for their test names and assertions.

