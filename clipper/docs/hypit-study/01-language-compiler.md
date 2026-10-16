# 01 · Language & compiler

**Batch:** 01 "Language & compiler"
**Source:** hypit-ai/hypit at commit `dc2b7a8f31b1ef1443a79ca448548d69e3ceb6a0`
**Packages (TypeScript lines, `src/` + `test/`):** markup 2,248 · loader 1,634 · compiler 2,106 · kernel 3,140 · protocol 639 · result 2,271 · admission 148 · facet 71 · source 211 · project 55 · blob 32 · atomic-file 103 · workspace 418. Total about 13.1k lines of TypeScript, of which about 8.5k are `src/`. READMEs and `package.json` files were also read. Per-file counts are in the coverage table at the end.

All paths below are relative to the hypit repo root.

---

## The pipeline at a glance

This is how `.svml`, `.svs` and `.svrun` text becomes a build plan. Each step is detailed per package below.

1. **Source header picks the parser, not the file suffix.** Every authored file starts with `<?svml using="<frontend>@<n>"?>`. The parser for that header is `packages/source/src/header.ts:42-74`. The masking at `:77-81` keeps the byte offsets of everything after it unchanged. A test renames `main.svml` to `main.anything` and gets the same result (`packages/compiler/test/compiler.test.ts:363-385`).
   - `.svml` usually selects `@hypit/markup@1`, the author graph.
   - `.svrun` selects `@hypit/markup/run@1`, the run selection.
   - `.svs` selects some other frontend. In the examples it is `@hypit/recipe@1`, a CSS-like `<sheet>` (`examples/semantic-composition/chat.svs:1-4`). That frontend is outside this batch.
2. **The Workspace reads each source unit once per session.**
   - It confines imports to a root and rejects symlink escapes.
   - Package code never sees a path. When a surface asks for an asset, it gets back a `BlobRef` (`packages/workspace/src/node/workspace.ts:125-155`, `:183-252`).
3. **Discovery pass.** The compiler walks only the import prologues, recursing through source imports. It detects cycles and freezes the module list. From that list it builds the module closure (`packages/compiler/src/compiler.ts:56-84`, `:131-133`).
4. **Decode pass.** Dependencies are decoded first. Each frontend then turns its body into typed Records, Components and Graph Fragments (`packages/markup/src/frontend.ts:117-480`). The compiler:
   - "hygienizes" every local id into `<sourceId>::<kind>::<local>` (`packages/compiler/src/source.ts:100-102`);
   - admits Records through the type validators (`:330-334`);
   - links them, then elaborates the components into one Author Graph (`:381-382`, via `@hypit/author`, which is not in this batch).
5. **The Run document** names one author source, the targets, and alternative "Candidates" (a provided value, a file, a fragment instance, or an earlier build's output). It also lists explicit `<satisfy>` choices (`packages/markup/src/run/syntax.ts:230-293`).
6. **Kernel planning.** The planner starts from the targets and walks backwards, following only the selected Candidates. The result is a finite, verified `BuildPlan` (`packages/kernel/src/plan.ts:131-297`).
   - The plan is then sliced to the modules it actually needs (`packages/kernel/src/slice.ts:24-108`).
   - It is sealed as a `BuildDefinition` (`packages/kernel/src/reducer.ts:285-297`).
7. **Execution is event-sourced.** The durable form is the Definition plus a list of Facts. `BuildMachine` rebuilds its indexes from these and emits the next commands (`packages/kernel/src/machine.ts:56-204`).
8. **Results.** Accepted public outputs are written to a per-build Result directory. Earlier outputs can be *forwarded* by reference instead of copied (`packages/result/src/writer.ts:158-266`, `packages/result/src/node/store.ts`).

**Identity and caching, in one paragraph.** Hypit deliberately has **no content-addressed caching**.
- A `ResourceId` is opaque. "Equal bytes may have different identities" (`packages/protocol/src/identity.ts:1-2`, `packages/protocol/src/value.ts:13`). The Node Workspace mints `res_${randomUUID()}` for every asset (`packages/workspace/src/node/workspace.ts:195`, `:234`), and a test asserts that equal bytes get different ids (`packages/compiler/test/compiler.test.ts:790-791`).
- Operations are never deduplicated by content (`packages/kernel/test/demand.test.ts:498-508`).
- Reuse is always explicit: a `<build-record>` Candidate in `.svrun` (`packages/markup/src/run/syntax.ts:149-158`), which becomes a Result *forward* (`packages/compiler/src/run.ts:401-414`).
- Graph ids embed the source unit id. For the Node Workspace that id is the **absolute canonical path** (`packages/workspace/src/node/workspace.ts:110`, `:148`). As a result, graph and output ids change when a project moves on disk (`packages/compiler/test/compiler.test.ts:566` matches `::output::source.result` behind a path prefix).

---

## markup (`@hypit/markup`)

**Purpose.** The official XML-like Author frontend for `.svml`. It owns only:
- the `<svml>` envelope;
- the leading `<import>` prologue;
- generic element and attribute syntax;
- dispatch to package-registered "Markup Surfaces", which are the actual tags such as `<lab:Result>`.

It also contains the `.svrun` parser (subpath `./run`). Markup has no built-in domain vocabulary (README).

**Public surface.**
- From `src/index.ts:1-25`:
  - `decodeMarkup`, `createMarkupAuthorFrontend`, `markupAuthorFrontendId = "@hypit/markup@1"` (`src/frontend.ts:40`);
  - `MarkupSurfaceRegistry` (`src/registry.ts:16`);
  - `createMarkupSurfaceFacet`, `installMarkupSurfaceFacets`, and `markupSurfaceFacetAbi = "hypit.markup-surface@1"` (`src/surface-facet.ts:14`, `:65`, `:107`);
  - syntax helpers (`discoverMarkup`, `parseOpeningTag`, `parseStructuredElement`, `closeDocument`, `skipTextTrivia`);
  - element helpers (`assertAttributes`, `textAttribute`, …, `src/element.ts`);
  - `MarkupFrontendError` (`src/error.ts:1`).
- `./run` exports `parseRunDocument`, `RunSyntaxError`, `runMarkupFrontend` and `runMarkupFrontendId = "@hypit/markup/run@1"` (`src/run/frontend.ts:6`). The package activation exposes the run frontend as a facet (`src/run/activation.ts:5-8`).
- **Author tags:** `<svml>` (no attributes, `src/syntax.ts:246-247`) and `<import from="pkg@1" as="x"/>` or `<import source="./f.svs" as="x"/>` (`src/syntax.ts:219-241`). Every other tag comes from a Surface.
- **Run tags:** `<svrun version="1">`, `<author source>`, `<import from as>`, `<target output>`, `<value id type from>`, `<file id type from media-type>`, `<build-record id build output>`, `<fragment id using="alias:name">` with `<input name from|value>` and `<export name>`, and `<satisfy output candidate>` (`src/run/syntax.ts:92-219`, `:248-278`).

**How it works.**
- **Lexing is hand-written, with no XML library.**
  - Names are `^[A-Za-z_][A-Za-z0-9_.:-]*`. Aliases are lowercase, at most 64 characters. Reference paths are dotted names (`src/syntax.ts:12-14`).
  - Attribute values are either quoted strings, with five XML entities decoded, or a whole-value `{path}` reference. There are no expressions (`src/syntax.ts:29-40`, `:69-92`). Duplicate attributes are rejected (`:115-117`).
  - Comments `<!-- -->` are skipped as trivia (`:48-61`, `:163-168`).
- **Two passes.**
  - `discoverMarkup` reads only the root and the import prologue (`src/syntax.ts:243-259`). An import needs exactly one of `from` or `source` (`:229-231`), and a source import must have an alias (`:232-234`).
  - `decodeMarkup` then requires every source import to be **already decoded and supplied** (`src/frontend.ts:126-135`). It exposes their exports as `alias.name` (`:137-153`).
- **Surface scope** (`src/frontend.ts:78-115`):
  - Each imported module's registered surfaces are bound to `alias:tag`.
  - A tag imported twice is rejected (`:110`).
  - The scope also checks that each surface's declared output Types belong to that module or one of its declared dependencies (`:100-107`).
- **The body loop** (`src/frontend.ts:226-424`):
  - Plain text directly under `<svml>` is an error (`:233-235`), as is an import after the body starts (`:237-239`) or an unknown tag (`:240-241`).
  - **Raw** surfaces (e.g. a script body) get the whole source text plus a cursor, and must return a `nextOffset` past their opening tag (`:245-266`).
  - **Structured** surfaces get a parsed element tree, `resolveReference` and `resolveAsset` (`:267-300`). `resolveReference` only sees imported values, *earlier* records, and earlier component outputs (`:274-291`). Records are `structuredClone`d before being handed out.
  - Surface output is validated:
    - record and component ranges must lie inside the element (`:331-344`, `:364-377`);
    - ids must not repeat (`:345`, `:381-383`);
    - each record's Type must be one the surface declared (`:346-353`);
    - fragments must be `hypit.fragment@1`, and two definitions under one id must be canonically equal (`:405-417`);
    - a component's fragment must be supplied somewhere in the file (`:428-437`).
  - Surfaces can keep bindings private through `exports` (`:301-328`).
- **Provenance.** Every structured element records:
  - its source range;
  - the records, components and outputs it produced;
  - each attribute's value range, literal or reference (`src/frontend.ts:196-223`).

  This lets tools map graph nodes back to text. The README says diagnostic ranges are stripped before sealing, so reflowing the source does not change meaning (tested at `test/author-integration.test.ts:233-247`).
- **Run parser** (`src/run/syntax.ts:230-293`):
  - `version` must be `"1"` (`:239`).
  - `<author>` comes first, then the import prologue (`:249-261`).
  - At least one `<target>` is required (`:284`); duplicate aliases, candidates, targets and satisfactions are rejected (`:269-275`, `:281-283`).
  - `<file media-type>` must be a concrete MIME type (`:137-139`).
  - Type refs use `package@version#Type` (`:80-90`).
  - `<input value="…">` is coerced: `true`, `false` and `null` become literals, and a JSON-number pattern becomes a number (`:160-169`).
- **Errors.**
  - `MarkupFrontendError(code, message, sourceName, offset)` computes line and code-point column, formatted as `CODE: msg (file:line:col)` (`src/error.ts:8-19`).
  - `RunSyntaxError` is thrown without a filename and re-wrapped with one at the top (`src/run/syntax.ts:43-45`, `:295-304`). Its format is `file:line:col: msg` (`:33`).

**Tests.** 16 tests.
- `test/author-integration.test.ts` has 5. Notable ones:
  - forward component references still plan the right two producers (`:203-231`);
  - reflow invariance (`:233-247`);
  - a missing fragment gives `MARKUP_COMPONENT_FRAGMENT_MISSING` (`:249-259`);
  - an unknown component is caught later, at linking, not while decoding (`:261-273`);
  - duplicate components are rejected (`:275-286`).
- `test/run/run.test.ts` has 11:
  - one multi-export fragment runs once (`:145-163`);
  - unselected literal fragments never become records (`:165-193`);
  - `value="5"` becomes the number 5, and giving both `from` and `value` fails (`:195-211`);
  - a `<file>` becomes a `@hypit/blob@1#Blob` Candidate (`:230-250`);
  - imports after the body are rejected, and an error message carries `bad.svrun:2:` (`:272-279`).

**Quality notes.**
- (+) The parser is small and strict, with very good error *codes* (62 distinct `MARKUP_*` and `RUN_*` codes) and precise offsets for syntax errors.
- (+) The discover/decode split lets the compiler find imports without running package decoders. Discovery runs once and is reused (`packages/compiler/test/compiler.test.ts:346-361`).
- (+) Surfaces receive a capability (`resolveAsset`), never a filesystem. Records handed to surfaces are cloned.
- (−) **Errors raised inside surfaces lose their location.** Handlers are awaited without try/catch (`src/frontend.ts:247`, `:270`). The shared helpers throw plain `Error` with no offset (`src/element.ts:9`, `:11`, `:32`). So "`lab:Result` requires id" carries no `file:line:col`, even though `element.range` was available.
- (−) Error message formats differ across packages:
  - `CODE: msg (file:l:c)` in `src/error.ts:12`;
  - `file:l:c: msg` in `src/run/syntax.ts:33` and in `packages/source/src/header.ts:19`.
- (−) Run literal coercion is implicit. There is no way to pass the *string* `"5"` or `"true"` as an input value (`src/run/syntax.ts:160-169`). Author surfaces own their own literal parsing, so the two languages disagree.
- (−) Raw surfaces get the full source text and are trusted to return a sane cursor. Only `nextOffset > opening.end` and `≤ length` are checked (`src/frontend.ts:262-264`). The README is explicit that this is not a sandbox.
- (−) References are resolved in declaration order inside decoders (`src/frontend.ts:274-291`), yet component references may point forward (`test/author-integration.test.ts:203-209`). Authors face two ordering rules (README "Put values before structured Surfaces").

**Relevance to UGCMediaClips: Medium.** We will not ask users to write XML. But two pieces carry over directly:
- `SurfaceVocabulary` (`src/types.ts:136-189`) declares each tag's attributes, children, ports, an example and a summary as data. That is the shape we want for our MCP tool docs and for the in-app agent's "what can a clip plan contain" schema.
- Element provenance (range ↔ produced ids) is the right idea for pointing a failed render check back to the exact line of a plan.

**Better version.**
- Keep clip plans as JSON validated by a schema (zod), not a markup language.
- Borrow the vocabulary-as-data idea: one registry of overlay, caption and shot kinds with attributes, constraints and an example. Generate from it:
  - the LLM prompt schema;
  - the MCP tool JSON schema;
  - the editor UI.
- Make every validation error carry a JSON pointer (`/shots/2/overlays/0/words`) the way Markup carries offsets, and use one error format everywhere.

---

## loader (`@hypit/loader`)

**Purpose.** Finds and activates *explicitly selected* installed npm packages that contribute Hypit modules and facets, without scanning `node_modules`. It also gives each build its own module scope, so package state does not leak between builds.

**Public surface.**
- `verifyPackageContributions` (`src/contribution.ts:23`).
- Types `PackageContribution`, `ModuleContribution`, `LoadedPackage` and `LogicalPackageAddress` (`src/types.ts:5-32`).
- `./node`:
  - `loadNodePackageSelection` and `NodePackageSelectionMissingError` (`src/node/loader.ts:181-278`);
  - `physicalPackageName` (`:171`);
  - `installDistributionPackageResolution` and `resolveDistributionPackageImport` (`src/node/distribution-resolution.ts:59`, `:75`);
  - `locateNodePackage`, `resolveNodePackageSource`, `…Module`, `…Resource`, `…ResourceSpecifier` and `…Executable` (`src/node/location.ts:216-381`).
- `./node/module-scope`: `NodeModuleScope` (`src/node/module-scope.ts:137`).
- The root `package.json` also exports `src/node/public.ts` as a narrower kit.

**How it works.**
- **Selection** (`src/node/loader.ts:194-278`):
  - Each requested name is resolved. An exact package embedded by the active Distribution resolves only from the Distribution and cannot be shadowed. Everything else is project-first with the Distribution as fallback (`:78-88`).
  - The loader imports `hypit.activation`, which must stay inside the package (`:90-98`), and checks `format: "hypit.package@1"` (`:126`).
  - It then closes declared module dependencies with a worklist (`:241-254`) and rejects duplicate module providers (`:223`) and ambiguous logical offers (`:256-269`).
- **Dependency check.** A dependency pinned to an exact semver must match the installed version exactly. Ranges are not checked (`:143-146`).
- **Location** (`src/node/location.ts`). Package names are validated (`:62-71`). File access is confined to the package root (`:246-263`). `package:@scope/pkg/path` resolves an asset without running package code (`:284-302`). Source exports follow `exports` with `import` or `default` conditions (`:308-338`).
- **Module scopes** (`src/node/module-scope.ts`):
  - Node `registerHooks` rewrites every file URL under a scope into a synthetic `…/<scopeId>/<base64url(url)>.mjs` (`:12`, `:28-30`, `:82-104`).
  - TS, TSX and JSX are transpiled with `typescript.transpileModule` (`:32-47`).
  - CommonJS gets a scope-local cache and named-export discovery through `cjs-module-lexer` (`:49-59`, `:144-180`).
  - `import.meta.url` and `import.meta.resolve` are patched back to the real paths (`:126-131`).
  - Distribution host packages stay shared (`:89`, `:101`).

**Tests.** 18 tests.
- `test/loader.test.ts` has 9: project shadowing wins (`:142-163`); embedded packages cannot be shadowed (`:165-186`); only non-embedded packages go through the scoped importer (`:188-212`).
- `test/location.test.ts` has 4: a source export never runs the activation (`:68-97`); `../` in a `package:` path is refused (`:142-147`).
- `test/module-scope.test.ts` has 3: two scopes keep independent counters (`:12-32`); an old scope keeps old bindings after files change, while a new scope reads the new ones (`:34-84`); mixed ESM/CJS, top-level await and circular CJS work (`:86-118`).
- `test/distribution-resolution.test.ts` has 2.

**Quality notes.**
- (+) The authority boundaries are carefully argued: there is no plugin scanning, and reading data never executes code.
- (+) Module scoping is a genuinely clever way to get per-build module state in one Node process.
- (−) The scoping is heavy and fragile. It depends on Node's `registerHooks`, `findPackageJSON` and the VM `importModuleDynamically` (`src/node/module-scope.ts:1`, `:65`, `:172`). It transpiles with TypeScript at load time and cannot change Distribution roots within a process (`src/node/distribution-resolution.ts:78`). The README says it is "trusted execution, not a sandbox".
- (−) Several functions re-read and re-parse `package.json` on every call, with no memo (`src/node/location.ts:94-127`, `:158-171`, `src/node/distribution-resolution.ts:22-56`). The resolve hook calls these per import (`:82-90`).

**Relevance to UGCMediaClips: Low.** We ship one app and have no third-party plugins.

**Better version.** Not needed. If we ever let users bring templates, they should be data (JSON or ASS styles) loaded from storage, never code. If we need isolation, use a worker or child process per render, not module-identity rewriting.

---

## compiler (`@hypit/compiler`)

**Purpose.** Domain-neutral orchestration with three jobs:
- it turns one resolved author source into a verified Source Closure, Linked Program and Author Graph (`Compiler`);
- it turns one `.svrun` into a sliced `BuildDefinition` (`RunCompiler`);
- it maps import strings to trusted manifests (`ModulePackageRegistry`).

**Public surface** (`src/index.ts:1-29`):
- `Compiler`, with `compileEntry`, `compileResolvedSource`, `extendExecutionProgram` and `admitRecord` (`src/compiler.ts:101-178`);
- `RunCompiler`, with `compileEntry`, `checkResolvedSource`, `compileResolvedSource`, `planCompilation` and `planEntry` (`src/run.ts:167-421`);
- `compileSourceClosure` and `SourceClosureError` (`src/source.ts:55`, `:244`);
- `ModulePackageRegistry` (`src/modules.ts:36`) and `CompilerError` (`src/error.ts:1`);
- graph queries `findLogicalOutput`, `findCandidate`, `findOperation`, `findOperationsByProducer` and `walkOperationInputs` (`src/graph-query.ts`).

**How it works.**
- **Module registry.**
  - `register` checks every specifier before inserting anything, so a failed registration leaves no partial state (`src/modules.ts:40-63`; tested at `test/compiler.test.ts:83-94`).
  - `createClosure` visits requests in sorted order and returns manifests sorted by `name@version` (`src/modules.ts:71-106`), so the closure is deterministic.
- **Discovery** (`src/compiler.ts:56-84`) is a DFS keyed by `unitId + frontendId`, with a `visiting` set for cycles (`SOURCE_IMPORT_CYCLE`). The frozen discoveries are handed to `compileSourceClosure`, so frontends do not rediscover (`:134-152`).
- **Source closure** (`src/source.ts:244-405`):
  1. Children compile recursively. An importer receives only the child's *public* records (`:276-291`).
  2. Asset requests are deduplicated per source by `from`. Conflicting media types for one asset are rejected, and the result is checked to be a `res_…` blob with a safe size and the requested media type (`:296-328`).
  3. Records are admitted (`:330-334`) and hygienized: ids become `<sourceId>::record|component|output::<local>`, and provenance ids are derived from ranges (`:100-102`, `:104-230`).
  4. Exports are checked against record and fragment output Types (`:122-149`).
  5. Across the closure, duplicate domain identities (for example two Scripts named `story`), duplicate record ids and conflicting fragments are rejected (`:348-379`).
  6. The records are linked and the author graph elaborated (`:381-382`).
- **Run compilation** (`src/run.ts:264-380`). This is the most interesting part for us.
  1. Decode the Run document, then resolve and compile its `<author>` in the **same** Workspace session (`:265-270`).
  2. Extend the program with modules used only by the selected run fragments (`:271-274`; `src/compiler.ts:166-171`).
  3. Make a **structural plan first**, before reading any values (`:283`).
  4. Open only the `<value>` JSON, `<file>` blobs and `<build-record>` outputs that the plan selected (`:284-336`). An unreachable `<value>` pointing at a missing file is never opened (`test/compiler.test.ts:471-491`).
  5. A historical output is *located* (type-checked from the manifest) always, but only *materialized* when a selected producer consumes it (`:309-335`; tested at `test/compiler.test.ts:509-573`). An output that is only forwarded becomes a `resultForward` instead of a target (`:355-362`, `:385-392`, `:401-414`).
  6. Substitute the resolved values into the Run Graph (`:337-354`), re-plan, admit the selected initial records (`:359-370`), then `sliceExecution` and `defineBuild` (`:393-399`).
- **`checkResolvedSource`** (`:189-261`) is the static variant. It accepts a future `<build-record>` without opening any Results (`test/compiler.test.ts:435-469`).
- **Attachments.** Asset bytes travel beside the graph as `BlobAttachment`s, deduplicated by resource and media type. A size conflict on one resource is an error (`src/compiler.ts:31-54`).

**Tests.** 16 tests.
- `test/compiler.test.ts` has 14, plus a symlink subtest:
  - run-only modules extend the execution closure but stay out of the author graph, and the durable build keeps only the modules its slice needs (`:387-433`);
  - source assets become blob records plus attachments, and editing the asset changes the resource id (`:575-594`);
  - Workspace read-once and containment, including symlinks (`:644-713`);
  - an asset root widens byte access but not source imports (`:715-736`);
  - external package sources keep relative imports in their own root (`:738-769`).
- `test/source.test.ts` has 2: duplicate public identity across sources (`:30-65`); provenance hygiene (`:67-106`).

**Quality notes.**
- (+) The "plan structurally, then open only what is selected" rule is excellent. Nothing unreachable is read, and no unnecessary paid or historical work happens.
- (+) Errors carry a stable `code` plus a `subject` (`src/error.ts`, `src/source.ts:55-65`).
- (+) Discovery and closure order are deterministic.
- (−) `checkResolvedSource` and `compileResolvedSource` duplicate about 60 lines: decode, resolve author, extend program, structural plan and value substitution (`src/run.ts:189-237` vs `:264-354`).
- (−) `admitRecord` is called through an odd cast, as if it might be missing, even though it is declared on `Compiler` (`src/run.ts:238-241`, `:363-365` vs `src/compiler.ts:174`).
- (−) Run-compiler errors are plain `Error` strings with no code (`src/run.ts:122`, `:310`, `:314`, `:318`).
- (−) `graph-query.ts` swallows every exception to return `undefined` (`:17-27`), which hides real faults.
- (−) **Identity depends on location.** The hygienic ids embed `source.id` (`src/source.ts:153`, `:157`, `:162`). In the Node Workspace that id is an absolute path, so the same project at two paths produces different graph ids.
- (?) `extendExecutionProgram` compares raw import requests with `name@version` keys (`src/compiler.ts:167-168`), so an alias specifier always forces a re-link. This is harmless but wasteful.

**Relevance to UGCMediaClips: High** for the Run-compiler idea, Low for the multi-source machinery. Our "approved plan → render" step is a run selection over a fixed author intent:
- choose the voiceover take;
- choose the footage moment per shot;
- reuse an earlier render's shot.

Planning first and opening only selected inputs is exactly what our CPU-only render queue needs.

**Better version.**
- One `planRender(plan, selections) → RenderDefinition` function. It resolves every shot, voice and overlay to either "reuse artifact X" or "produce with step Y" before any ffmpeg or LLM call.
- It fetches only the footage and moment data the chosen steps need.
- Unlike Hypit, step keys should be location-free and content-derived (see "Ideas worth taking" #2).

---

## kernel (`@hypit/kernel`)

**Purpose.** The domain-neutral core:
- link module manifests and records;
- verify graphs;
- plan one Author Graph plus one Run Graph into a finite `BuildPlan` by demand from the targets;
- run the result as an event-sourced state machine of Producer commands and external "Needs".

**Public surface** (`src/index.ts:1-32`):
- `createResolvedClosure`, `link`, `resolveProducer`, `resolveType`, `sealRecord`, `verifyClosure` and `verifyRecordStructure` (`src/link.ts`);
- `sealCompiledGraph`, `sealBuildRequest`, `resolve*`, `satisfiedCandidate`, `verifyCompiledGraph` and `verifyBuildRequest` (`src/graph.ts`);
- `planBuild`, `compileBuild` and `plannedNeeds` (`src/plan.ts`), and `sliceExecution` (`src/slice.ts`);
- `defineBuild`, `materializeBuild`, `reduce`, `start`, `admitBuildResult` and `resolveNeedCommand` (`src/reducer.ts`);
- `BuildMachine` (`src/machine.ts`).

**How it works.**
- **Normal form.** Every producer declares exactly **one** public result: either one output or one Need (`src/link.ts:94-98`, `src/graph.ts:226-230`, `src/plan.ts:351-356`).
  - A Need is an external request with a capability, a return Type and canonical "constraints". The test fixture models a paid generation call this way (`test/greeting-fixture.ts:60-69`).
  - Paid work becomes a separate, schedulable and replaceable node.
- **Closure verification** (`src/link.ts:69-182`). It checks:
  - unique names per kind;
  - dependencies are present;
  - every port Type and capability belongs to the module or a declared dependency;
  - capability return types match.

  Records are checked only for a non-empty id and a known Type (`:211-218`). There is no value schema in Core; semantic checks belong to `admission`.
- **Graph model** (`packages/protocol/src/build.ts:56-105`):
  - a **LogicalOutput** has a type and one `primary` Candidate;
  - a **Candidate** is either a zero-input value or an operation result;
  - **Operations** take inputs that point to records, logical outputs or operation results.

  `sealCompiledGraph` normalizes the graph and sorts everything by id (`src/graph.ts:118-130`).
- **Demand planning** (`src/plan.ts:131-297`):
  1. Check satisfactions: one per output, and Types must match (`:144-161`).
  2. Walk an explicit stack from the targets (`:186-228`). Each logical output takes its *selected* Candidate or else its primary. A value Candidate becomes an initial record; an operation Candidate pushes its operation, and then that operation's inputs.
  3. Turn the demanded operations into `ProducerStep`s **sorted by operation id** (`:256-273`). Goals and output bindings are sorted too (`:275-283`).
  4. `verifyBuildPlan` (`:328-403`) re-checks ports, single-source records and types. It runs Kahn's algorithm for acyclicity (`:437-467`) and rejects steps that do not reach any goal (`:469-492`).
- **Slicing** (`src/slice.ts:24-108`) repeats the demand walk to keep only the reachable authored records and the transitively required modules. The persisted Build therefore does not carry unused packages.
- **Execution.**
  - `BuildDefinition` = program + initial records + plan + targets (`src/reducer.ts:285-297`).
  - `materializeBuild` replays Facts with invariants: no fact after a terminal one, step inputs must be ready, no duplicate record or Need (`:434-496`).
  - Command ids are `producer:<step>` and `need:<id>` (`:25-27`).
  - `schedule` emits every command that can run, sorted by id. If none can run and the goals are incomplete, it reports `BUILD_DEADLOCK` (`:205-256`).
  - A `command-failed` result fails the whole build at once (`:163-176`).
- **`BuildMachine`** (`src/machine.ts:56-204`) keeps per-build indexes: records, Needs, commands, missing-input counts per step, reverse dependencies and missing goals.
  - `evaluate(result)` derives the Fact **without mutating**, allowing one outstanding proposal (`:113-125`).
  - `commit()` applies it only after the store has durably appended the Fact (`:128-204`).
  - Readiness is incremental: a new record decrements only its dependents (`:165-180`).

**Tests.** 21 tests.
- `test/demand.test.ts` has 15. These are table-driven closure tests, for example:
  - choosing `existing-image1` removes `p1` from the plan (`:324-336`);
  - an existing-value Candidate means the paid Need never exists (`:357-365`);
  - two Candidates naming one operation run it once (`:473-482`);
  - different operation ids are never deduplicated by content (`:498-508`);
  - partial satisfaction keeps only the demanded projection (`:603-613`).
- `test/core.test.ts` has 5:
  - Definition plus Facts restores the same next command after a JSON round-trip (`:94-135`);
  - the machine's indexes equal the pure reducer after every Fact (`:137-175`);
  - a ready producer is not blocked by an unrelated outstanding Need (`:177-193`).
- `test/machine-scaling.test.ts` has 1: a 512-step chain issues exactly one command per step and restores from Facts (`:9-30`).

**Quality notes.**
- (+) This is the best-designed package in the batch:
  - a small vocabulary;
  - deterministic ordering everywhere;
  - plan verification that is independent of the planner;
  - durable-first commit (`evaluate` / `commit`).
- (+) The tests compare the indexed machine against the pure reducer (`test/core.test.ts:137-175`), which is the right guard for the duplication noted next.
- (−) Admission logic is duplicated: `acceptProducerEvent` and `acceptNeedEvent` (`src/reducer.ts:76-161`) repeat `factForBuildResult` (`:327-414`). `admitBuildResult` runs both (`:420-427`).
- (−) Any single command failure fails the whole build, with no partial retry semantics in Core (`src/reducer.ts:163-176`, `src/machine.ts:143-146`). Retries must live in the runtime (batch 02).
- (−) Ordering uses `localeCompare` (`src/graph.ts:111`, `:122-124`; `src/plan.ts:257`, `:277`). That is ICU-collation order, not code-point order, which matters if plans are ever compared across environments (see protocol).
- (−) Records carry no value schema, so Core accepts any value for a known Type (`src/link.ts:211-218`). That is fine as a design choice, but every guarantee then depends on registering validators.

**Relevance to UGCMediaClips: High.** Our render path today is an imperative sequence (`server/render.ts`). The kernel's ideas map directly onto it:
- **Targets → demand → plan.** Render only what the chosen output needs, for example a re-caption that reuses the cut.
- **Candidates and satisfactions** model A/B variants, "use uploaded footage instead of Drive", "reuse voice from variant A", and "reuse shot 2 from an earlier render".
- **Needs** isolate paid external calls (TTS, vision, LLM) as explicit nodes with canonical constraints, which can be metered and cached.
- **Definition plus Facts** gives resumable, auditable render jobs that survive a container restart on Railway.

**Better version.**
- A much smaller TypeScript core, roughly 400 lines: `Step {id, kind, inputs, params}`, a demand walk, Kahn ordering, and a job table of Facts in Postgres (one row per completed step, with an `evaluate`/`commit`-style transaction).
- Unlike Hypit, step ids are **content keys**: `sha256(kind@version + canonical params + input keys)`. Equal sub-renders across variants and re-renders then become cache hits automatically, scoped per workspace.
- Per-step retry with backoff instead of whole-build failure.
- Code-point sorting (`a < b ? -1 : …`) for anything hashed or persisted.

---

## protocol (`@hypit/protocol`)

**Purpose.** Plain data contracts shared by every package: manifests, refs, values, graphs, plans, commands, facts and build state. It also provides canonical JSON and build-id helpers. There is no I/O.

**Public surface** (`src/index.ts:1-9`):
- `canonicalize`, `canonicalStringify` and `isResourceId` (`src/canonical.ts:27-37`);
- `orderedBuildId`, `buildIdCreatedAt`, `assertOrderedBuildId` and `assertBuildId` (`src/build-id.ts`);
- `SvmlError` (`src/error.ts`);
- `moduleKey`, `typeKey`, `producerKey`, `capabilityKey`, `sameModule` and `sameType` (`src/identity.ts:37-59`);
- `modulePackageAbi = "hypit.module@1"` (`src/module.ts:4`);
- `blobRefObjectSchema` (`src/value.ts:74`);
- all graph and build types (`src/build.ts`), and `ValueSchema` (`src/value.ts:26-71`).

**How it works.**
- **Values.** `StoredValue` is either `{kind:"inline", value: CanonicalValue}` or a `BlobRef {resource: res_…, size, mediaType}` (`src/value.ts:11-24`).
- **Canonicalization** (`src/canonical.ts:5-33`):
  - rejects NaN and Infinity, and normalizes `-0` to `0`;
  - rejects `undefined`;
  - sorts object keys with `localeCompare` (`:16`).
- **Type identity** is nominal: module plus name. "There is no structural fallback" (`src/identity.ts:17-25`).
- **Build ids** look like `bld_YYYYMMDDTHHMMSSmmmZ_<10 [0-9A-Z]>` and sort chronologically. They are explicitly not digests (`src/build-id.ts:5`, `:14-23`). A build id must be one path segment (`:47-52`).
- **Durable model.** The `BuildDefinition` plus a fixed set of three `BuildFact` kinds are stored. `BuildState` is a disposable view (`src/build.ts:214-265`).

**Tests.** 6 tests (`test/canonical.test.ts`): key order, `-0` normalization, NaN and undefined refusal, `res_` syntax, path-free build ids, and sortable ordered ids (`:43-51`).

**Quality notes.**
- (+) The data model is tight and well documented, and it states its identity semantics explicitly (`src/identity.ts:1`, `src/value.ts:13`).
- (−) `localeCompare` makes "canonical" JSON depend on locale and ICU (`src/canonical.ts:16`). It is used for fragment equality (`packages/markup/src/frontend.ts:415`, `packages/compiler/src/source.ts:373`). That is safe within one process but not as a cross-machine hash input.
- (−) `ValueSchema` exists (`src/value.ts:26-66`), but Core manifests' `TypeDeclaration` is only `{name}` (`src/module.ts:10-12`). Schemas live in surface vocabularies and validators, not Types.

**Relevance to UGCMediaClips: Medium.**
- Ordered build ids with a UTC timestamp make good S3 keys and prefixes for renders.
- The `inline | blob` value split is how our render step outputs should be typed.
- Nominal types are not needed; we have a handful of artifact kinds.

**Better version.**
- `canonicalJson` with code-point key ordering and a SHA-256 over it, used for cache keys.
- Render ids `rnd_<ts>_<nonce>` for listing and prefixing.
- Keep blobs as `{key, sha256, size, mime}`: **content hash included**, unlike Hypit.

---

## result (`@hypit/result`)

**Purpose.** The durable record of a finished build's public outputs. It stores where each output's bytes live:
- a file owned by this build;
- an external file;
- a file owned by another build;
- a forward to another build's whole output.

It also stores a terminal outcome and execution evidence. Execution state itself belongs to the runtime.

**Public surface.**
- `src/index.ts:1-15`: `syncBuildResultOutputs`, `decodeBuildResult*`, `encodeBuildResultManifest`, `assertBuildResultSeed`, `assertBuildResultValueDocument` and `preserveExecutionLog`.
- `./node` (`src/node/index.ts`): `FileBuildResult`, `FileBuildResultRepository`, `buildResultDirectory`, `browseBuildResults`, `resolveBuildResultOutput`, `describeBuildResultOutput`, `locate*BuildResultOutput`, `normalizeBuildResultForwards` and `applyBuildResultPresentation` (`src/node/store.ts`), plus `fileReferenceIdentity`, `ownedFileReference`, `currentFileReference` and `localExternalFiles` (`src/node/file-reference.ts`).
- Interfaces `BuildResultRepository` and `BuildResultWriter` (`src/types.ts:371-402`).

**How it works.**
- **Layout.** Results live at `<root>/<YYYY-MM-DD>/<buildId>/result.json`, bucketed by the date inside the id (`src/node/store.ts:199-213`). The manifest omits its own id; the directory is the identity (`src/decode.ts:225-228`).
- **Creation** (`src/node/store.ts:404-438`):
  1. Forwards are normalized to their terminal owner, and must point at *finished* builds (`:370-395`).
  2. `result.json` and the private `.writer.json` are written into a temporary `.preparing-…` directory.
  3. The directory is `rename`d into place.
- **Sync** (`src/writer.ts:158-266`):
  - Only newly ready published outputs are encoded, ordered forward → blob → scalar → composite, then by name (`:229-243`).
  - Resources are deduplicated by resource id across outputs and assigned `files/file-0001.<ext>`. Numbering is recovered after `9999` (`:52-86`; test `test/result.test.ts:495-530`).
  - The extension comes from the media subtype (`:115-122`).
  - Composite values are encoded as a "value document": canonical data with blob slots set to `null`, plus a `resources: [{at: path, file}]` list (`:191-226`, `src/types.ts:52-56`). A domain object that looks like a reference cannot be confused with one (`test/result.test.ts:301-329`).
  - Writes run with **concurrency 4**. On failure, already-started writes are drained before the error escapes (`src/writer.ts:88-113`, `:185`; test `test/result.test.ts:532-597`).
- **Atomic writes.** Each file is written as `*.part-<uuid>` and then `replaceFile`d (`src/node/store.ts:114-124`, `:177-197`). Writer state is written before the manifest (`:476-477`). After a crash, the next sync reuses recorded paths without rewriting.
- **Reading** follows `build-output` forward chains with cycle detection (`:141-165`, `:285-333`). All paths are checked to stay inside the result directory (`:226-234`; `src/types.ts:75-81`). Byte ranges are validated against the declared size (`:567-582`).
- **`finish`** (`:481-503`):
  - It is idempotent for the same outcome and rejects a different one (`:483-487`).
  - It stores `execution.jsonl` before the terminal manifest (`src/execution-log.ts:4-17`).
- **Presentation edits** (title, note, highlights, display names) are allowed only on finished results (`src/node/store.ts:56-108`).

**Tests.** 13 tests (`test/result.test.ts`):
- a sync with no new outputs touches no file, checked by inode and mtime (`:37-73`);
- open readers keep old bytes (`:75-109`);
- one resource backs both a video and a composite; there is exactly one file, and composites point at it (`:111-233`);
- a forward copies no bytes, and forwarding to an unfinished build is rejected (`:354-416`);
- a failed sync cannot make a later resource inherit stale bytes (`:459-493`);
- newest-first browse with a cursor (`:599-639`).

**Quality notes.**
- (+) The persistence discipline is solid: temp-dir creation, atomic replace, idempotent finish, bounded concurrency with a clean drain, and strict decoding of every JSON file before use (`src/decode.ts:178-222`, `:239-283`).
- (+) "Reuse is a forward, not a copy" saves storage and keeps provenance.
- (−) **No hashes are stored anywhere.** File identity is "same URI or same owner and path" (`src/node/file-reference.ts:26-29`), and "separate files remain separate even when their bytes happen to match" (README).
- (−) External files are live references. Their size is re-read on access, with no version check (`src/node/file-reference.ts:36-42`), so a moved or edited source silently changes or breaks old results.
- (−) `browse` reads every manifest in each date bucket until it has `limit + 1` (`src/node/store.ts:256-277`). That is fine locally but O(n) per page.

**Relevance to UGCMediaClips: Medium–High.** Our renders live in a bucket with links that expire after 7 days (README). The forward model fits "variant B reuses A's shots and voice" or "a re-caption reuses the cut" without duplicating MP4s. Value documents with blob slots are a clean way to store a render manifest that points at shot clips, the voice and caption files. The date-bucketed ordered ids fit S3 listing.

**Better version.**
- A `render_outputs` Postgres table (`render_id`, `name`, `kind`, `blob_key | forward_render_id+name`, `sha256`, `size`, `mime`) instead of files on disk.
- Blobs in object storage keyed by content hash under the workspace prefix (`ws/<id>/blobs/<sha256>`), so reuse is automatic and cross-tenant deduplication is impossible by construction.
- Keep Hypit's forward semantics and its rule that only finished results can be reused.

---

## admission (`@hypit/admission`)

**Purpose.** Host-side semantic validation. A package can register one pure accept-or-reject validator per exact `TypeRef`. The compiler applies it to authored and provided records; the executor applies it to producer results (README).

**Public surface** (`src/index.ts`):
- `TypeValidatorRegistry` (`:85-102`) and `TypeValidationError` (`:73`);
- `validateValue` (`:122`), `admitRecord` (`:132`) and `createRecordAdmitter` (`:142`);
- `createAdmissionPackageFacet`, `admissionPackagesFromFacets` and `admissionPackageFacetAbi = "hypit.admission-package@1"` (`:35-56`);
- `registerTypeValidatorFacets` (`:58`).

**How it works.**
- `admitRecord` checks the structure through the kernel (`:137`), then calls the registered handler with **cloned** type and value, so a validator cannot mutate the record (`:104-120`).
- Any throw is wrapped as `TYPE_REFINEMENT_REJECTED` with `typeKey` as the subject (`:114-118`).
- Registering a second validator for one Type is an error (`:93-95`).

**Tests.** None in this package. It is exercised indirectly by the compiler tests.

**Quality notes.**
- (+) Tiny and explicit: validators cannot rewrite values.
- (−) There are no direct tests.
- (−) The original error's stack and cause are dropped; only the message survives (`:114-118`).

**Relevance: Medium.** This is the same idea as our brief checks (required phrases, length, banned claims), framed as per-type validators.

**Better version.** Keep a registry of zod schemas plus refinements per artifact kind. Run it at both plan admission and step-result admission, and keep `cause`.

---

## facet (`@hypit/facet`)

**Purpose.** The minimal opaque envelope `{abi, offers?, implementation}` (`src/facet.ts:2-6`). The loader can carry it without interpreting it. It also has helpers for frontend facets.

**Public surface.** `Facet`, plus `createFrontendFacet` and `frontendsFromFacets` (`src/frontend.ts:19-56`).

**How it works.**
- `createFrontendFacet` rejects empty identities and sets `offers: [frontend.id]` (`:23-34`).
- `frontendsFromFacets` filters by ABI and kind, and throws on a malformed implementation (`:38-56`).

**Tests.** None.

**Quality notes.** Clean. It is just the extension-point envelope.

**Relevance: Low.** It only matters for plugin architectures.

---

## source (`@hypit/source`)

**Purpose.** A byte-oriented `SourceUnit {id, name, bytes}` and `ResolvedSource {unit, frontend}`, plus the optional self-described-text adapter that reads the `<?svml using="…"?>` header (README).

**Public surface.**
- `decodeSourceText`, a fatal UTF-8 decode (`src/unit.ts:50-52`).
- `sourceFrontendPackageAbi = "hypit.source-frontend@1"` (`src/index.ts:13`).
- Types `SourceUnit`, `ResolvedSource`, `SourceImportRequest`, `SourceAssetRequest` (with optional package-owned `bytes`) and `SourceResolver` (`src/unit.ts:3-46`).
- `./text`: `parseSourceHeader`, `maskSourceHeader`, `resolveSelfDescribedTextSource` and `SourceHeaderError` (`src/header.ts`).

**How it works.**
- The header grammar is deliberately minimal: an optional BOM (`src/header.ts:43`), then exactly one `<?svml using="x"?>` with no padding (`:53`, `:64-66`). A second header is rejected (`:70-72`).
- Masking replaces every header code unit except CR and LF with a space. Downstream offsets and line numbers therefore stay exact, including for characters outside the Basic Multilingual Plane (`:77-81`).

**Tests.** 3 tests (`test/text.test.ts`): offsets preserved (`:10-18`); UTF-16 offsets preserved with a non-BMP character (`:20-27`); BOM accepted, a missing, duplicate or padded header rejected with a `file:2:1:` prefix (`:29-48`).

**Quality notes.**
- (+) An explicit parser choice instead of guessing from suffixes, and careful offset preservation.
- (−) The `id` is documented as "used only for recursion and diagnostics" (`src/unit.ts:4-5`), yet the compiler bakes it into every graph id (`packages/compiler/src/source.ts:100-102`). The contract and its use disagree.

**Relevance: Low–Medium.** A versioned format marker at the top of persisted plans (`"format": "clipplan@3"`) is worth copying for migrations.

---

## project (`@hypit/project`)

**Purpose.** Finds the project root: an explicit `--project`, or the nearest `package.json` above the working directory with `hypit.project: true`.

**Public surface.** `findProjectRoot` and `resolveProjectRoot` (`src/index.ts:1`, `src/project-context.ts:30-54`).

**How it works.**
- The upward walk handles ENOENT and rethrows other errors (`:11-27`).
- `realpath` is applied only *after* selection, so symlinks cannot redirect the search (`:51-53`).

**Tests.** None.

**Quality notes.** (−) **README drift.** The README describes `findRuntimeProfile`, `selectRuntimeProfile` and `clearRuntimeProfile` as this package's API (README lines 12–17), but they are not in `src/`. They live in `packages/runtime-local/src/index.ts:10`.

**Relevance: Low.**

---

## blob (`@hypit/blob`)

**Purpose.** A nominal `@hypit/blob@1#Blob` Type, so any domain can put opaque bytes on graph edges.

**Public surface.** `blobModuleRef`, `blobTypes`, `blobManifest` and `blobDependency` (`src/index.ts:6-24`), plus the activation contributing the manifest (`src/activation.ts:3-6`).

**How it works.** A manifest with one Type and no producers. A `.svrun` `<file>` Candidate uses it (`packages/markup/test/run/run.test.ts:230-250`).

**Tests.** None directly.

**Relevance: Low.**

---

## atomic-file (`@hypit/atomic-file`)

**Purpose.** `replaceFile(from, to)` publishes a complete file atomically while existing readers keep the old bytes (README).

**Public surface.** `replaceFile` (`src/replace-file.ts:4-11`).

**How it works.**
- On POSIX it is `rename`.
- On Windows it calls `SetFileInformationByHandle(FileRenameInfoEx)` with `REPLACE_IF_EXISTS | POSIX_SEMANTICS` through Koffi FFI (`src/replace-file-windows.ts:37-58`), because `MoveFileExW` refuses when the destination is open.
- There is no fsync. The README disclaims power-loss durability.

**Tests.** 1 test (`test/replace-file.test.ts:9-33`): an open reader keeps "first" after the replace, and a Unicode filename works.

**Quality notes.**
- (+) It solves a real Windows problem precisely.
- (−) Without fsync of the file and its directory, a crash can leave a zero-length result on some filesystems. The README states this limit openly.

**Relevance: Low.** We write to object storage, which is already atomic per object.

---

## workspace (`@hypit/workspace`)

**Purpose.** The replaceable "definition environment" port: one isolated session per compilation, which resolves source imports and assets and hands out byte attachments.

**Public surface.**
- `Workspace`, `WorkspaceSession`, `BlobAttachment` and `WorkspaceError` (`src/index.ts:10-40`).
- `./node`: `NodeFilesystemWorkspace` (`src/node/workspace.ts:278-304`).

**How it works** (`src/node/workspace.ts`):
- **Root.** The root defaults to the entry file's directory (`:296`). Everything goes through `realpath` plus an `isWithin` check (`:23-26`).
- **Source imports.**
  - Relative imports resolve inside the *importer's* root (`:165-168`). Non-relative ones need a host `externalSourceResolver` that supplies its own root (`:169-181`).
  - One canonical file reached through two roots is a `SOURCE_ROOT_CONFLICT` (`:135-146`).
  - Source bytes are read once and cached per canonical path (`:125-155`).
- **Assets.**
  - Relative assets may come from the project root plus configured `assetRoots`, but only for sources in the project root (`:205-210`).
  - Package bytes passed inline get a fresh `res_<uuid>` (`:191-203`).
  - A file asset gets `res_<uuid>` plus a `stat` size, captured once per path (`:231-235`). Its bytes are opened **lazily** at attachment time (`:244-249`).

**Tests.**
- 2 tests here (`test/node/workspace.test.ts`): a `..keep.svml` basename is allowed but a junction escape is refused (`:13-35`); package assets stay inside the resolver's root (`:37-63`).
- About 5 more in `packages/compiler/test/compiler.test.ts:644-798`. One of them, at `:671-673`, asserts that after the asset changes on disk, the attachment returns the **new** bytes under the old identity: "Runtime rejects them if they no longer match the captured identity".

**Quality notes.**
- (+) The containment is thorough: per-importer roots, symlink checks and root-conflict detection. Sources really are read once.
- (−) **Assets are not read once.** The identity is a random UUID plus a size (`:231-235`). The bytes are read later (`:248`), so a same-size edit between compile and run cannot be detected with only this information. The runtime check lives in batch 02, so I cannot verify here what it compares.
- (−) The absolute path becomes the unit id (`:110`, `:148`), and with it every graph id (see compiler).

**Relevance: Medium.** It is the right shape for a "plan inputs" port, with the same containment worries we have for user uploads and Drive copies.

**Better version.**
- Hash on ingest. We already fetch each footage file once into storage (`clipper/server/footage-cache.ts:31`, which keys by Drive id or a URL hash).
- Record the SHA-256 at ingest and use it as the blob identity. Then "read once" holds by construction, and render caching can key on it.

---

## Ideas worth taking (ranked)

1. **Demand-driven planning from targets, with Candidates and satisfactions** (`packages/kernel/src/plan.ts:131-297`). Model a render as targets: final MP4, captions file, thumbnail. Each intermediate output then has alternatives:
   - shot 2 from Drive footage, from the user's upload, or from render #123;
   - voice from TTS or from variant A's take.

   Plan only what the chosen alternatives demand. This directly serves A/B variants, re-captioning and "edit one shot" without a full re-render.
2. **Separate the structural plan from opening values; open only what was selected** (`packages/compiler/src/run.ts:283-336`). Avoid downloading footage, running vision or calling TTS for anything the plan does not reach. This saves CPU and money on Railway. *Improve on Hypit:* make step keys content hashes (`sha256(kind@ver + canonical params + input hashes)`), so identical sub-steps across variants and retries are cache hits, scoped per workspace.
3. **Definition + Facts with evaluate-then-commit** (`packages/kernel/src/machine.ts:113-204`, `reducer.ts:434-496`). Store each completed render step as a durable Fact row before advancing. A restarted container then replays and continues from the next step instead of starting over, and Facts give a full audit and metering trail per step.
4. **Paid external calls as explicit "Needs" with canonical constraints** (`packages/kernel/src/reducer.ts:103-121`, `packages/protocol/src/build.ts:28-34`). Put TTS, vision and LLM calls behind a single node type. That gives one place for metering, budget limits, deduplication by constraint hash, and swapping providers.
5. **Reuse is a forward, not a copy; only finished results can be reused** (`packages/result/src/node/store.ts:370-395`, `writer.ts:228-241`). Variant renders reference the parent's shots and voice. This keeps storage cost down and provenance clear.
6. **Value documents with blob slots** (`packages/result/src/writer.ts:191-226`). A render manifest is plain JSON with `null` slots plus a resource list. Domain data can never be mistaken for a file reference.
7. **Tag vocabulary as data** (`packages/markup/src/types.ts:136-189`). One registry describes each overlay, caption and shot kind's attributes, constraints and an example. Generate the LLM schema, the MCP tool schema and the editor UI from it.
8. **Strict error codes with exact positions** (`packages/markup/src/error.ts`; 62 `MARKUP_*`/`RUN_*` codes). Use stable codes plus a JSON pointer for every plan or brief validation failure, so the agent and the UI can act on them in code.
9. **Sortable timestamped ids with a nonce, and date-bucketed storage** (`packages/protocol/src/build-id.ts:20-23`, `packages/result/src/node/store.ts:199-213`). These make cheap newest-first S3 listing of renders per workspace possible.
10. **Bounded write concurrency that drains on failure** (`packages/result/src/writer.ts:88-113`). A small, correct pattern for uploading render parts.

## Things not to copy, and why

- **No content identity at all** (`packages/protocol/src/identity.ts:1`, `packages/workspace/src/node/workspace.ts:234`, `packages/kernel/test/demand.test.ts:498`). This is fine for a local desktop tool where reuse is authored. Our SaaS pays for every repeated ffmpeg pass and every model call, so content hashing is a cost feature for us.
- **Graph ids built from absolute file paths** (`packages/compiler/src/source.ts:100-102` with `packages/workspace/src/node/workspace.ts:110`). In a multi-tenant service this would leak server paths into persisted ids, and identical plans would get different ids. Use stable logical ids (workspace / clip / plan revision).
- **An XML-like author language plus package activation, module scopes and Koffi FFI** (loader, markup, atomic-file). These solve problems we do not have (third-party packages, hand-written authoring, Windows file locks) at a high complexity cost. Our plans are LLM-written JSON, checked in code.
- **Lazy asset reads after identity capture** (`packages/workspace/src/node/workspace.ts:248`; `packages/compiler/test/compiler.test.ts:671-673`). Edits can slip between plan and run. Hash on ingest instead.
- **Whole-build failure on any command failure** (`packages/kernel/src/reducer.ts:163-176`). For renders, retry a step with backoff, and fail only the clip, not the batch.
- **`localeCompare` in canonical JSON** (`packages/protocol/src/canonical.ts:16`). Never feed it to a hash.
- **Errors without location from extension handlers** (`packages/markup/src/frontend.ts:247`, `:270`; `element.ts:9`), **mixed error formats**, and **README drift** (`packages/project/README.md` vs `src/`). These are small, but they are exactly what makes agent-driven automation hard to debug.
- **Duplicated code paths kept in sync only by tests** (`packages/kernel/src/reducer.ts:76-161` vs `:327-414`; `packages/compiler/src/run.ts:189-237` vs `:264-354`). Derive one from the other.

---

## Coverage table

Every file was read in full ✅. Line counts are from `wc -l`.

| File | Lines | Read |
|---|---:|:-:|
| packages/markup/README.md | 82 | ✅ |
| packages/markup/package.json | 24 | ✅ |
| packages/markup/src/element.ts | 39 | ✅ |
| packages/markup/src/error.ts | 20 | ✅ |
| packages/markup/src/frontend.ts | 522 | ✅ |
| packages/markup/src/index.ts | 25 | ✅ |
| packages/markup/src/registry.ts | 83 | ✅ |
| packages/markup/src/run/activation.ts | 10 | ✅ |
| packages/markup/src/run/frontend.ts | 17 | ✅ |
| packages/markup/src/run/index.ts | 5 | ✅ |
| packages/markup/src/run/syntax.ts | 304 | ✅ |
| packages/markup/src/surface-facet.ts | 115 | ✅ |
| packages/markup/src/syntax.ts | 271 | ✅ |
| packages/markup/src/types.ts | 251 | ✅ |
| packages/markup/test/author-integration.test.ts | 286 | ✅ |
| packages/markup/test/run/run.test.ts | 300 | ✅ |
| packages/loader/README.md | 69 | ✅ |
| packages/loader/package.json | 18 | ✅ |
| packages/loader/src/contribution.ts | 48 | ✅ |
| packages/loader/src/index.ts | 4 | ✅ |
| packages/loader/src/types.ts | 32 | ✅ |
| packages/loader/src/node/distribution-resolution.ts | 92 | ✅ |
| packages/loader/src/node/index.ts | 28 | ✅ |
| packages/loader/src/node/loader.ts | 278 | ✅ |
| packages/loader/src/node/location.ts | 381 | ✅ |
| packages/loader/src/node/module-scope.ts | 186 | ✅ |
| packages/loader/src/node/public.ts | 30 | ✅ |
| packages/loader/src/node/types.ts | 18 | ✅ |
| packages/loader/test/distribution-resolution.test.ts | 31 | ✅ |
| packages/loader/test/loader.test.ts | 237 | ✅ |
| packages/loader/test/location.test.ts | 151 | ✅ |
| packages/loader/test/module-scope.test.ts | 118 | ✅ |
| packages/compiler/README.md | 62 | ✅ |
| packages/compiler/package.json | 24 | ✅ |
| packages/compiler/src/compiler.ts | 178 | ✅ |
| packages/compiler/src/error.ts | 11 | ✅ |
| packages/compiler/src/graph-query.ts | 51 | ✅ |
| packages/compiler/src/index.ts | 29 | ✅ |
| packages/compiler/src/modules.ts | 107 | ✅ |
| packages/compiler/src/run.ts | 421 | ✅ |
| packages/compiler/src/source.ts | 405 | ✅ |
| packages/compiler/test/compiler.test.ts | 798 | ✅ |
| packages/compiler/test/source.test.ts | 106 | ✅ |
| packages/kernel/README.md | 32 | ✅ |
| packages/kernel/package.json | 13 | ✅ |
| packages/kernel/src/error.ts | 12 | ✅ |
| packages/kernel/src/graph.ts | 339 | ✅ |
| packages/kernel/src/index.ts | 32 | ✅ |
| packages/kernel/src/link.ts | 240 | ✅ |
| packages/kernel/src/machine.ts | 205 | ✅ |
| packages/kernel/src/plan.ts | 503 | ✅ |
| packages/kernel/src/reducer.ts | 496 | ✅ |
| packages/kernel/src/reference.ts | 25 | ✅ |
| packages/kernel/src/slice.ts | 108 | ✅ |
| packages/kernel/test/chain-fixture.ts | 70 | ✅ |
| packages/kernel/test/core.test.ts | 205 | ✅ |
| packages/kernel/test/demand.test.ts | 623 | ✅ |
| packages/kernel/test/greeting-fixture.ts | 252 | ✅ |
| packages/kernel/test/machine-scaling.test.ts | 30 | ✅ |
| packages/protocol/README.md | 11 | ✅ |
| packages/protocol/package.json | 10 | ✅ |
| packages/protocol/src/build-id.ts | 52 | ✅ |
| packages/protocol/src/build.ts | 265 | ✅ |
| packages/protocol/src/canonical.ts | 37 | ✅ |
| packages/protocol/src/error.ts | 11 | ✅ |
| packages/protocol/src/identity.ts | 59 | ✅ |
| packages/protocol/src/index.ts | 9 | ✅ |
| packages/protocol/src/module.ts | 67 | ✅ |
| packages/protocol/src/value.ts | 88 | ✅ |
| packages/protocol/test/canonical.test.ts | 51 | ✅ |
| packages/result/README.md | 69 | ✅ |
| packages/result/package.json | 15 | ✅ |
| packages/result/src/decode.ts | 291 | ✅ |
| packages/result/src/execution-log.ts | 17 | ✅ |
| packages/result/src/index.ts | 15 | ✅ |
| packages/result/src/node/file-reference.ts | 42 | ✅ |
| packages/result/src/node/index.ts | 16 | ✅ |
| packages/result/src/node/store.ts | 583 | ✅ |
| packages/result/src/types.ts | 402 | ✅ |
| packages/result/src/writer.ts | 266 | ✅ |
| packages/result/test/result.test.ts | 639 | ✅ |
| packages/admission/README.md | 11 | ✅ |
| packages/admission/package.json | 15 | ✅ |
| packages/admission/src/index.ts | 148 | ✅ |
| packages/facet/README.md | 5 | ✅ |
| packages/facet/package.json | 10 | ✅ |
| packages/facet/src/facet.ts | 6 | ✅ |
| packages/facet/src/frontend.ts | 56 | ✅ |
| packages/facet/src/index.ts | 9 | ✅ |
| packages/source/README.md | 18 | ✅ |
| packages/source/package.json | 14 | ✅ |
| packages/source/src/header.ts | 98 | ✅ |
| packages/source/src/index.ts | 13 | ✅ |
| packages/source/src/unit.ts | 52 | ✅ |
| packages/source/test/text.test.ts | 48 | ✅ |
| packages/project/README.md | 23 | ✅ |
| packages/project/package.json | 10 | ✅ |
| packages/project/src/index.ts | 1 | ✅ |
| packages/project/src/project-context.ts | 54 | ✅ |
| packages/blob/README.md | 10 | ✅ |
| packages/blob/package.json | 16 | ✅ |
| packages/blob/src/activation.ts | 8 | ✅ |
| packages/blob/src/index.ts | 24 | ✅ |
| packages/atomic-file/README.md | 20 | ✅ |
| packages/atomic-file/package.json | 13 | ✅ |
| packages/atomic-file/src/index.ts | 1 | ✅ |
| packages/atomic-file/src/replace-file-windows.ts | 58 | ✅ |
| packages/atomic-file/src/replace-file.ts | 11 | ✅ |
| packages/atomic-file/test/replace-file.test.ts | 33 | ✅ |
| packages/workspace/README.md | 4 | ✅ |
| packages/workspace/package.json | 15 | ✅ |
| packages/workspace/src/index.ts | 40 | ✅ |
| packages/workspace/src/node/index.ts | 9 | ✅ |
| packages/workspace/src/node/workspace.ts | 304 | ✅ |
| packages/workspace/test/node/workspace.test.ts | 65 | ✅ |

**Test count across the batch: 96 `test()` cases.** markup 16, loader 18, compiler 16, kernel 21, protocol 6, result 13, source 3, atomic-file 1, workspace 2. Admission, facet, project and blob have no tests of their own.

**Out of scope but referenced** (not verified here): `@hypit/author` (`elaborateAuthorGraph`, `sealGraphFragment` and how fragment ids are hashed) and `@hypit/run` (`resolveRunDocument`, `sealRunGraph`, `collectRunModuleRequests`). Both are needed to fully confirm how a fragment instance in `.svrun` becomes graph operations. Context only: `examples/semantic-composition/chat.svml`, `chat.svs` and `chat.svrun` show the three file kinds together.
