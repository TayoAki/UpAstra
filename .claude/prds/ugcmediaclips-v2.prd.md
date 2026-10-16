# UGCMediaClips v2: better than Hypit for unattended, multi-tenant clipping

*Written with ECC `/plan-prd`. Evidence comes from a line-by-line study of [hypit-ai/hypit](https://github.com/hypit-ai/hypit) at `dc2b7a8f`, about 103k lines across 86 packages plus 9.6k lines of skill playbooks, used under our commercial license. Each batch was independently re-checked against the source; see `clipper/docs/hypit-study/`. Implementation detail lives in `clipper/docs/BUILD-PLAN.md` and `.claude/plans/`, not here.*

## Problem
Clippers and agencies use UGCMediaClips to turn a campaign brief and raw footage into many 9:16 short-form clips, with no editor and often no human in the loop. Today a clip can come out with shots that drift off the line they illustrate, captions that break on long or CJK lines, overlays that ignore the pace of the speech, and silent audio around overlay pops. A container restart re-pays for TTS and vision. Each of these costs a re-render (money), a manual fix (time), or a clip that underperforms (the user's payout).

Hypit shows how these problems can be solved: phrase-bound timing, a fitted overlay schedule, a line-budgeted caption engine, and a durable, resumable executor. But it is a local, agent-driven desktop compiler. It renders through headless Chrome, throws on imperfect input, and relies on an agent to inspect every result. We want its craft without its cost model.

## Evidence
- **Shot sizing.** Shot lengths are proportional seconds, not tied to the words they illustrate. Hypit's playbooks bind shots to narration phrases and call this the main quality lever (study 11 §6.1).
- **Captions:**
  - captions join words with a space, which breaks CJK;
  - there is no line budget;
  - outline doesn't scale with size;
  - the karaoke highlight holds through long pauses.

  All four were confirmed in the independent check (study 06, Verified ✅).
- **Overlays:**
  - tier items collide from the 4th item, and items 7–9 overprint 4–6; comments can draw over each other (measured in the study 08 check);
  - long tier names truncate at a fixed character count;
  - hold times are fixed and ignore speech pace (study 08).
- **CTA timing** uses a space-split word count, so it is wrong for CJK scripts (study 07 §13.3).
- **Moment timestamps.** The vision proxy decodes keyframes only and then resamples to 1 fps, so the burned-in timestamps can drift from real frame times, which lands shots on the wrong moment (study 09 §1).
- **Process environment.** ffmpeg and whisper inherit the full process environment, including API keys (study 05, study 09).
- **Colour.** No explicit BT.709 tagging or conversion is done when RGBA overlays are composited; a colour shift is likely (study 05). *Assumption — needs validation with a colour-bar render.*
- **Restarts.** A redeploy on Railway restarts in-flight renders. We resume, but at most twice and from the start, and with no step receipts, so paid steps can repeat (study 02).
- **User demand** for sound effects, ducking and new overlay kinds (podium, Top-N column, quiz strip). *Assumption — needs validation via user interviews and template usage data.*

## Users
- **Primary:** a clipper or agency operator running brand campaigns at volume. They upload or link footage, pick a brief and a format, and want 10–50 publishable clips without opening an editor. The need is triggered by a new campaign or a payout deadline.
- **Secondary:** an AI agent (Claude Desktop/Code over MCP, or our in-app agent) driving the same pipeline. It needs structured errors, previews it can see, and preflight costs.
- **Not for:**
  - long-form editors;
  - people who want a general programmable video compiler or a markup language (Hypit's niche);
  - anyone expecting server-side downloads from platforms (ToS risk).

## Hypothesis
We believe that **phrase-bound shots, a line-budgeted caption engine, a speech-fitted overlay and SFX schedule, and a resumable step-cached render pipeline** will **raise the share of clips that publish with no manual fix, and cut cost per published clip** for **clippers and agencies running campaigns at volume**.

We'll know we're right when **at least 85% of rendered clips are scheduled without an edit or re-render, and AI plus compute cost per published clip falls by 25%**, with no rise in render failures.

## Success Metrics
| Metric | Target | How measured |
|---|---|---|
| Clips published with no edit or re-render | ≥ 85% (baseline TBD — needs validation) | `clips` status history: rendered → scheduled with no edit or render events in between |
| Cost per published clip (AI + compute) | −25% vs. baseline month | `usage.ts` monthly totals ÷ published clips |
| Re-paid steps after a restart | 0 | step receipts: a paid step with two `started` receipts |
| Caption overflow (text outside safe area) | 0 in the QA suite; < 0.5% in production QA | caption QA check per render |
| Shot-to-phrase alignment | ≥ 95% of shots start within 150 ms of their phrase | render manifest: shot start vs. aligned phrase start |
| Render failures | no increase (≤ current rate) | render job status |
| Agent task success over MCP | baseline +20% | MCP eval set: brief → scheduled clip, with no human step |

## Scope
**MVP:** the five quality fixes plus the resumable pipeline:
- phrase-bound shots;
- caption line budget and per-word separators;
- the speech-fitted overlay schedule;
- the env, colour and timestamp fixes;
- per-step receipts with resume.

All of it is CPU-only, with no new paid providers, and keeps today's API and MCP contracts backwards compatible.

**Next (after the MVP proves out):**
- SFX and ducking;
- new overlay kinds;
- display/spoken script markup;
- the M:N aligner;
- browser caption preview;
- agent vision tools (frames, contact sheets);
- structured MCP errors with preflight;
- timestamped review comments.

**Out of scope**
- **Billing and publishing changes:** owned elsewhere, per the user's instruction.
- **Headless-Chrome compositing:** about 3 PNG codec passes per frame on CPU; ffmpeg and libass stay the compositor.
- **A markup or authoring language, package system or generic build graph:** our plans are LLM-written JSON checked in code; the ceremony costs more than it buys.
- **Server-side yt-dlp downloads:** platform-ToS and IP-block risk.
- **WhisperX, torch or pyannote on Railway:** too heavy for CPU-only; whisper.cpp stays.
- **Generated presenters and video generation (Seedance etc.):** a later PRD. The async-job lifecycle is designed for it now, so it can be added.
- **Head-tracking caption regions:** they need paid per-frame tracking, with marginal value for gameplay footage.

## Delivery Milestones
<!-- Status: pending | in-progress | complete -->

| # | Milestone | Outcome | Status | Plan |
|---|---|---|---|---|
| 0 | Safety & correctness fixes | Keys never reach subprocesses; colours match the source; moment timestamps are real; CJK CTA is timed right; tier and comment overlays never overlap | pending | `.claude/plans/m0-safety-correctness.plan.md` |
| 1 | Resumable, step-cached renders | A redeploy never re-pays a step; identical sub-steps across variants are reused; users can cancel a render and read its log | pending | BUILD-PLAN M1 |
| 2 | Captions that always fit | No caption leaves the safe area; CJK and mixed scripts space correctly; the highlight follows speech; four new presets | pending | BUILD-PLAN M2 |
| 3 | Shots that land on their words | Each shot is bound to the phrase it illustrates and snaps to visual cuts | pending | BUILD-PLAN M3 |
| 4 | Overlays & sound that move with speech | Tier and comment overlays reveal on cue and settle; overlays fit or are repaired; SFX hits and ducking | pending | BUILD-PLAN M4 |
| 5 | Script that says one thing and shows another | Brands and numbers pronounced right; overlays anchor to named moments; better alignment on hard scripts | pending | BUILD-PLAN M5 |
| 6 | Agents that can see and plan spend | MCP frames and contact-sheet tools, preflight costs, structured errors, `next` hints, transcribe and cancel | pending | BUILD-PLAN M6 |
| 7 | Instant preview & review | Caption and overlay changes preview in the browser with no render; timestamped review comments feed the agent | pending | BUILD-PLAN M7 |
| 8 | New formats | Podium, Top-N column and quiz-strip overlays; richer format breakdowns | pending | BUILD-PLAN M8 |

## Open Questions
- [ ] What is today's "published with no edit" baseline? We need a month of status history before claiming the 85% target.
- [ ] Does the BT.709 shift show on real phones (iOS and Android players), or only in tooling?
- [ ] Should display/spoken markup be visible to users in the script editor, or only written by the planner?
- [ ] Is SFX wanted by default, or opt-in per brief? Some brands forbid added sound.
- [ ] Which libass WASM build (licence, size) suits the browser preview?
- [ ] Per-step receipts: a Postgres table, or JSONB on the render document? This depends on the expected write rate per render.

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Phrase-bound shots run short when the aligner misses a phrase | Med | High | Fall back to proportional sizing per shot, and log it; aligner tests on hard scripts |
| A line-budget re-split changes the look of existing presets | Med | Med | Golden ASS snapshots per preset; ship behind a style version flag |
| A step cache serves a stale output after a code change | Low | High | Step key includes `kind@version`; bump the version on any change to that step |
| SFX annoys viewers or breaks brand rules | Med | Med | Opt-in per brief; per-kind gain; loudness-normalised mix |
| Scope creep toward Hypit's generality | Med | High | Each batch carries a "not to copy" check against the study notes |
| Licence: Hypit's terms forbid multi-tenant use without a commercial licence | Low (licensed) | High | We hold a commercial licence; we re-implement ideas, never copy source; the study notes describe rather than transcribe |

---
*Status: APPROVED FOR PLANNING. Milestone 0 has a `/plan` artifact; later milestones are batched in `clipper/docs/BUILD-PLAN.md`.*
