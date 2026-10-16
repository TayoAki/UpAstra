# Plan: Overlays and sound that move with speech

**Source PRD**: `.claude/prds/ugcmediaclips-v2.prd.md`
**Selected Milestone**: 4 (B4.1–B4.5 in `clipper/docs/BUILD-PLAN.md`; B4.3's grid fit landed early in M0 as B0.5)
**Complexity**: Medium–Large

## Summary
- Tier items reveal at the board's centre on their cue, hold, then glide into their cell before the next item is named, with motion fitted to the speech.
- Comment cards get the polish of hypit's comment sticker.
- An opt-in "sound design" switch per brief adds generated pop and whoosh effects on the same reveal and glide times, and ducks game audio under the voice with a sidechain instead of a flat volume.

## Patterns to Mirror
| Category | Source | Pattern |
|---|---|---|
| Overlay events | `clipper/server/overlays.ts` `overlayEvents` | ASS Dialogue lines per overlay, `\move`/`\t` animation |
| Layout | `tierLayout`, `commentLayout` (M0) | pure geometry, tested by box checks |
| Audio mix | `clipper/server/media.ts` `compose` | WAV passes, `amix` → `loudnorm` |

## Tasks
### Task 1: Reveal → settle schedule (B4.1) with motion fitting (B4.2)
- **Action**: a pure `tierSchedule(starts, boardEnd)` returning, per item, `{ start, glideStart, glideEnd, end }`. The window runs to the next cue (at most 2 s); the pop is ≤ 25% of it (≤ 0.18 s), the glide ≤ 35% (≤ 0.35 s), and the hold takes the rest. Drawn as three events: staged (large, at the board centre, popping in), gliding (`\move` plus `\t(\fs)`), and settled.
- **Validate**:
  - with cues 1, 2, 3 every glide ends before the next cue;
  - a 0.3 s window fits pop and glide inside it;
  - the settled event lasts until the board ends;
  - the staged item stays inside the board.

### Task 2: Comment card polish (B4.5)
- **Action**:
  - −2.5° tilt;
  - a pop that unwinds the rotation;
  - a gentle float while held;
  - a fade-up exit;
  - "Reply to @x" only when `user` was supplied (never a made-up "viewer").
- **Validate**: an ASS check of the tags; a comment with no user has no "Reply to" line; the layout tests still pass.

### Task 3: Sound design, opt-in per brief (B4.4)
- **Action**:
  - `brief.soundDesign`, a toggle in the brief editor;
  - effects generated with ffmpeg (a sine "pop", a band-passed noise "whoosh"), so there are no licensed assets;
  - SFX events come from the overlay schedule: pops on reveals, comments and emoji, whooshes on glides;
  - each is placed with `adelay` at a per-kind gain and mixed before `loudnorm`;
  - game audio is ducked under the voice with `sidechaincompress` instead of a flat 0.22;
  - with the toggle off, the audio graph is byte-identical to today's.
- **Validate**:
  - an SFX onset within ±10 ms of the overlay time, found by an energy probe;
  - integrated loudness of −14 ±1 LUFS;
  - with the toggle off, the filter string is unchanged.

## Parity check against hypit
- **B4.1/4.2:** `packages/ranking/src/schedule.ts:445-519`, `:699-743`. **Avoids:** per-frame keyframe baking, and throwing on short windows.
- **B4.4:** ranking `schedule.ts:826-866`, `render.ts:652-697`; `R/playbooks/craft/sound-mix.md:35-44`. **Avoids:** per-sample `aeval`, and an unnormalised mix.
- **B4.5:** `packages/comment-sticker/src/author.ts:86-147`.

## Acceptance
- [x] All tasks complete; validation passes; santa-method PASS (both reviewers)
