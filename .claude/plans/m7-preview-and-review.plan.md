# Plan: Instant preview and review

**Source PRD**: `.claude/prds/ugcmediaclips-v2.prd.md`
**Selected Milestone**: 7 (B7.2 → B7.1 → B7.3 → B7.4 in `clipper/docs/BUILD-PLAN.md`)
**Complexity**: Large

## Summary
- Plan edits carry a revision, so an agent and a person editing at once can't silently overwrite each other, and an edit can't quietly break a passing plan.
- Caption and overlay changes preview in the browser over a proxy video, and a "recompose" re-renders only the final compose from cached steps.
- Timestamped review comments that the agent can read and act on.
- Hover-scrub, with a storyboard atlas cached per footage file.

## Patterns to Mirror
| Category | Source | Pattern |
|---|---|---|
| Plan edits | `clipper/server/app.ts` `PUT /clips/:id` | patch, re-check QA, save |
| Step cache | `clipper/server/steps.ts` | the cut steps are reused, so a recompose only composes |
| Frames | `clipper/server/frames.ts` (M6) | ffmpeg tile; stored in the video store |
| UI | `clipper/src/components/RenderPanel.tsx`, `ClipCard.tsx` | `useApp().run` with a toast |

## Tasks
### Task 1: Revisioned plan edits (B7.2)
- **Action:**
  - `Clip.revision` is bumped on every change;
  - `PUT` with `baseRevision` gets a 409 when stale;
  - an edit that turns a passing plan into a failing one is refused with 422 and saves nothing, unless `allowFailing`;
  - ClipCard, OverlayEditor and MCP `edit_clip` send `baseRevision`;
  - the UI offers "save anyway" on a 422 and reloads on a 409.
- **Validate:**
  - two edits from the same base revision give one 200 and one 409, and the first edit's fields survive;
  - a QA-breaking edit to a passing plan leaves it unchanged.

### Task 2: Preview and recompose (B7.1)
- **Action:**
  - the render stores its ASS (`parts.assKey`) and a 540-wide proxy;
  - the editor-side preview draws the ASS over the proxy in the browser with a libass WASM build (pinned on the CDN, loaded lazily);
  - `POST /clips/:id/recompose` re-runs only the final compose from cached steps (cuts, voice) with the current caption style and overlays.
- **Validate:**
  - a recompose reuses all cut steps and the voice step;
  - the preview loads the ASS with no render call;
  - the Playwright check that a style change updates the preview with 0 render calls.

### Task 3: Timestamped review comments (B7.3)
- **Action:**
  - `Clip.comments[] {id, at, text, author, resolved}`;
  - CRUD routes;
  - the in-app agent's context lists unresolved comments;
  - MCP `list_comments` and `resolve_comment`, plus `apply_comments`, which re-plans from them.
- **Validate:** create, resolve and list comments; the agent context includes the unresolved ones.

### Task 4: Hover-scrub and storyboard atlas (B7.4)
- **Action:**
  - `GET /footage/:id/storyboard`, an atlas of at most 360 tiles per file, cached in storage;
  - hover-scrub in RenderPanel and FormatsView.
- **Validate:** at most 360 tiles for any length; the second request is served from the cache.

## Parity check against hypit
- **B7.1:** studio `preview/render.ts:28-61` (study 04 #1).
- **B7.2:** studio `server.ts:188-238`, `:412-455` (study 04 #2).
- **B7.3:** studio `feedback*.ts` (study 04 #5).
- **B7.4:** studio `ui/scrub-preview.ts`, `storyboard.ts` (study 04 #4, #9).

**Avoids:** Chrome compositing on the server.

## Acceptance
- [x] All tasks complete; validation passes; santa-method PASS (both reviewers)
