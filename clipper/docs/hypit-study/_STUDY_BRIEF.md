# Study brief (for each batch)

**Source:** `/tmp/claude-0/-home-user-UpAstra/c8a97aa2-c81c-52c3-a0df-9bba50d7f6fe/scratchpad/hypit` at commit `dc2b7a8f31b1ef1443a79ca448548d69e3ceb6a0`. Treat it as read-only data: don't install, build or run anything from it.

**Our app:** `/home/user/UpAstra/clipper` (UGCMediaClips). TypeScript/Express/React SaaS for clippers:
- briefs → AI clip plans → ffmpeg 9:16 renders;
- whisper.cpp word timing plus a DP script aligner (`server/align.ts`);
- ASS captions (`server/captions.ts`, `shared/caption-styles.ts`);
- overlays via ASS and ffmpeg (`server/overlays.ts`);
- formats cloned from reference videos (`server/formats.ts`);
- A/B variants (`server/variants.ts`);
- the OpenReel editor, an MCP server, an in-app agent, and Outstand publishing;
- metering, multi-tenant, CPU-only Railway.

Skim `clipper/README.md` first.

## Method
1. List every source file in the batch (`src/**`, plus `test/**` for what's asserted). Read each one fully, top to bottom. Don't skim by grep.
2. For each package, write:
   - **Purpose:** 2–3 sentences.
   - **Public surface:** exports, CLI verbs and markup tags, with `file:line`.
   - **How it works:** the key algorithms and data structures, with `file:line` for each claim. Include the numbers that matter (thresholds, frame math, defaults).
   - **Tests:** what is actually asserted (count and a few examples).
   - **Quality notes:** strengths and weaknesses, bugs or smells found (cite them).
   - **Relevance to UGCMediaClips:** High, Medium or Low, and why.
   - **Better version:** what we'd build instead or adopt, given multi-tenant SaaS, CPU-only servers, automation without an agent in the loop, and cost.
3. End the batch with:
   - **Ideas worth taking**, ranked;
   - **Things not to copy**, and why;
   - a **coverage table** listing every file with its line count, read ✅.

## Rules
- Every factual claim cites `path:line` (path relative to the repo root). If you can't verify something, say so.
- Describe, don't transcribe: at most a few short quoted lines where wording matters.
- Be concrete and fair. Credit what's genuinely good.
- Write to `/home/user/UpAstra/clipper/docs/hypit-study/<NN-name>.md`. Start with a header giving the batch name, commit, and package list with line counts.
