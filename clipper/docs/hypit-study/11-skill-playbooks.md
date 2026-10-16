# 11 · Agent skill & playbooks

**Batch:** 11, Agent skill & playbooks
**Source:** `hypit-ai/hypit` at commit `dc2b7a8f31b1ef1443a79ca448548d69e3ceb6a0`, read-only
**Scope:** `skills/hypit/` (66 files, 9,820 lines: 61 Markdown docs plus 1 YAML, 3 SVS/SVRun, 1 SVML and 1 TS example). Every file was read in full, top to bottom.

| Group | Files | Lines |
| --- | --- | --- |
| Skill root (`SKILL.md`, `agents/openai.yaml`) | 2 | 332 |
| `references/creation/` | 5 | 976 |
| `references/environment/` | 4 | 1,172 |
| `references/playbooks/` (index + 7 formats) | 8 | 758 |
| `references/playbooks/craft/` (11 crafts + 2 examples) | 13 | 1,771 |
| `references/production/` (29 docs + 8 examples) | 34 | 4,811 |

All paths below are relative to the repo root. `SK` = `skills/hypit/`, `R` = `skills/hypit/references/`.

---

## 0. What this batch is

The skill is an **agent operating manual**: a system-prompt-sized `SKILL.md` that sets a persona and a routing table, plus about 60 reference pages the agent reads on demand. It contains no code that runs. The only code is examples: `R/production/examples/visuals.ts` and the `.svml/.svs/.svrun` samples. CI explicitly ignores `skills/**` (`.github/workflows/ci.yml:8`, `:14`), so nothing checks links, examples or syntax.

The writing style matters for how we use it:

- It is **principle-first and deliberately number-light.** It says over and over that fixed counts are the wrong tool. Examples: "A fixed word or character count cannot make that choice" (`R/playbooks/craft/captions.md:75`), "rather than imposing a fixed silent delay" (`R/playbooks/formats/street-interview.md:43-44`), and don't place internal events at "20%, 50% and 80% of the outer Window" (`R/production/component-design.md:142-144`).
- The few hard numbers that do appear are tested defaults for particular models or tools. Section 3 collects them.
- Its central idea is **semantic time.** Graphics, cuts, sounds and captions bind to *meaning in the script* (Selections = spans, Moments = points). They never bind to reference seconds, so a new delivery moves the presentation with it (`SK/SKILL.md:68-75`, `R/creation/script-and-time.md:160-163`, `:248-251`).

`SK/agents/openai.yaml:1-4` is a 4-line Codex/OpenAI agent card: a display name, a short description, and a default prompt that invokes `$hypit`.

---

## 1. Group-by-group notes

### 1.1 Skill root — `SK/SKILL.md` (328 lines)

**Purpose.** It casts the agent as "director and producer" (`SK/SKILL.md:8-15`) of a generation-first pipeline: create people, places, voices and performances with models, and compose them with authored components. It also routes every question to one owning reference page.

**Public surface.**
- Persona and voice: "Speak aloud as the work develops" (`:37-42`); match the sensibility the video calls for, from "quick internet wit" to "playful absurdity" (`:30-31`).
- Mandatory pre-reads: read image direction and the Kit before writing any image prompt (`:106-110`), voice direction before choosing a voice (`:111`), and video direction before any video prompt (`:112-117`).
- Standing responsibilities (`:218-262`): Money, Existing work, Execution, Secrets, Evidence, Files are the memory, Project ownership, and "Done means watched."
- A 57-row routing table that maps each question to its reference page (`:264-323`).

**How it works (key directives).**
- Performance-led work: "author meaning in Script and let the accepted performance give it time" (`:68-69`). "Selections carry explanations or comparisons; Moments carry answers or payoffs" (`:71-72`).
- Reference footage is "evidence first". It becomes a model input only when continuous temporal behavior can't be carried by prose or stills (`:76-79`).
- For creator-led social video: "favor compelling casting, an appealing voice and a clear attitude toward the subject and listener" (`:102-104`).
- Brief = the user's goal. Treatment = the agent's creative answer (`:175`).
- Money: establish accounts, covered work and budget *before* paid work, and keep that agreement in the Brief (`:220-225`).
- "Done means watched": watch and listen to the actual deliverable and judge it against Brief and Treatment (`:256-262`).

**Quality notes.**
- (+) Clear ownership model. Every fact has one owning file or page.
- (−) The routing table has duplicate destinations: `audio-clips.md` at `:295` and `:302`, `visual-clips.md` at `:301` and `:313`. The rows also overlap semantically.
- (−) The prose is dense and abstract ("domain projectors can translate local evidence through equal-length absolute Windows", `:52-53`). It is costly in tokens for an LLM and hard for a human.

---

### 1.2 Creation — `R/creation/*` (976 lines)

#### `brief.md` (93) — Brief vs Treatment

- **Brief** holds only what the user can authoritatively supply: outcome, audience, platform, mandatory claims, CTA, references and what to inherit from each, replacements, private assets, hard duration and budget, reserved choices (`R/creation/brief.md:14-22`). Quote the user's wording where reinterpretation is risky. "Do not expand an example video's Hook into a format rule" (`:24-25`).
- Faithful adaptation **inherits unmentioned relationships**: structure, layer roles, promise/payoff, visual and audio systems (`:27-29`). Ask the user only about materially different goals, private facts, value choices, deliverables or spending (`:29-32`). "Routine casting, art direction, shot choice, Caption treatment… belong to the Agent" (`:31-32`).
- The agreed paid scope lives in the Brief, with "proposed estimate" kept distinct from "accepted", and "estimate" distinct from "ceiling" (`:34-41`).
- **Treatment** is written in director language (premise, Hook/reveal/payoff/CTA, pacing, systems needed), with no package names (`:45-60`). If contrast carries the premise, "say what expectation the piece sets up and how its words, situation, reveal or response play with it" (`:62-64`).
- One script only: adopted words live once, in Source (`:73-79`). Revise the *owner* of a changed fact (`:81-93`).

#### `project-files.md` (237) — working memory layout

- Two separate archives: `references/<ref>/{source.*, ANALYSIS.md, TIMELINE.md, transcript.json, evidence/}` and `productions/<target>/{BRIEF, TREATMENT, PROGRESS, authors, recipes, runs, assets}` (`R/creation/project-files.md:89-114`). One reference can feed many productions (`:120-129`).
- One job per document: ANALYSIS = whole-piece model; TIMELINE = timed realization; PROGRESS = "short photograph of the work now". These files are rewritten, not logged (`:136-162`).
- Resume from files and Results after context compaction. "Loss of conversation context is not a reason to submit the same paid work again" (`:220-225`).
- Handoff needs `.hypit/results/` intact, because Results forward outputs to earlier Builds (`:195-199`).

#### `reference-video.md` (244) — how to "clone" a reference

This page is the most transferable to our `formats.ts`.

- **Read the whole, then the details.** Follow hook → argument → payoff → intended response. For each designed element, record its content, spatial relationship, entry, active behavior, persistence and exit, located against the words or pauses it serves (`R/creation/reference-video.md:12-21`).
- **Name the viewer function** of each choice: "establishes a person, contrasts two claims, accumulates proof, amplifies a reaction, makes a process legible, or hands attention to the next idea" (`:19-21`).
- Motion names are only starting points. Inspect path, scale/opacity, pace, overshoot/settle and neighbors (`:32-37`).
- **Systems outlive camera cuts.** An object that survives a cut belongs to a longer-lived system. A new entry may replace, add or cover (`:39-43`).
- Transcribe with an explicit `--language`. Group Chinese characters into phrases. WhisperX spellings of coined names don't prove a pronunciation error (`:70-90`).
- Tooling: `probe`, `cut`, `frames`, `tile/tiles --transcript --around "phrase"`, `boundaries`, `fetch`. Every-frame grids for motion (`:94-162`).
- **Sampling caveat:** "A wider overview can miss a brief event even when neighboring samples look unchanged" (`:130-133`). Adjust range, interval and cell size to the question (`:123-128`).
- Inspect every meaningfully different caption configuration: speaker treatment, placement, emphasis, Cue shape, animation (`:164-166`).
- Separate what is visible from what you infer (`:168-170`).
- TIMELINE sections are named by source time and phase. The worked example ("6.07–8.27 · The workload accelerates") shows illustrations swapping per spoken noun, with "increasingly short holds" that make the workload feel excessive (`:188-198`).
- **Turn understanding into direction:** record the *expressive relationship* ("a reveal answers a question… an exit makes room for the next claim"), not just seconds (`:212-214`). The new script decides the new count and timing (`:216-220`).

#### `script-and-time.md` (259) — script structure, pronunciation, duration

- The script is the sole verbal authority. It holds no timecodes, prompts or styles (`R/creation/script-and-time.md:15-20`).
- Structures: Segment (performable passage), Role Cue, Dual Text (display vs spoken), `||` caption handoff, word attributes, Selection (span) and Moment (point) (`:22-33`). A Cue is "a timed block of displayed speech, not a line of text" (`:47-50`).
- **Pronunciation via Dual Text** (`:58-67`). Table at `:74-81`: `<CSS|see ess ess>`, `<API|A P I>`, `<SQL|sequel>`, `<Zuno|zoo no>`, `<Lumi|露米>`. Chinese prices and years: `<¥19.9|十九块九>`, `<2026|二零二六>` (`:113-115`). Carry the same reading to every occurrence (`:108-111`).
- Segment boundaries follow passages and delivery length, not picture cuts. One continuous narration can carry many B-roll changes. Natural cuts between clips are "often part of its appeal" for edited UGC (`:148-152`).
- Pick timing per relationship. The trigger and the entrance duration are separate choices: "`at={answer}` locates the answer; ten frames can give its arrival a particular character" (`:173-179`).
- **Estimate before choosing durations** (`:181-221`):
  - `hypit estimate` counts pronunciation units: English **syllables, not words**; Mandarin Han characters ≈ syllables, with embedded English counted by syllable (`:199-201`).
  - `--pace slow|normal|fast`. "Brisk, tightly cut social delivery often suits `fast`" (`:197-198`).
  - `--padding` reserves time for an intended reaction or pause. Rounding is `none|ceil|round` (`:204-208`).
  - Use the reference's units-per-second as a candidate rate. "Fitting every line into the shortest supported duration can make the whole delivery rushed" (`:210-214`).
  - If the estimate doesn't fit, reshape the passage: merge a short line with its response, or split a long one where the thought turns (`:216-221`).
  - The estimate sizes generation. Alignment supplies the real word positions afterwards (`:223-229`).
- Anchors decide who owns a pause (`:241-246`). "Do not copy a reference timestamp into the target or preserve an incidental lead/lag" (`:248-251`).
- Route each timing problem to its owner (wrong cue → script; rhythm → duration or Treatment; bad render → component; bad clip → prompt) (`:255-259`).

#### `transformations.md` (143) — adapting a reference to a new person or product

- Preserve the semantic timing relationship rather than seconds (`R/creation/transformations.md:15-18`).
- **Transform a role across every manifestation:** a presenter may also be an avatar, a voice, a B-roll subject or a phone image; a product may be a prop, a screen, a demo, a claim and the CTA (`:20-23`).
- Preserve purpose, not form ("A cat can perform confidence through a planted pose", `:25-29`).
- **Transformation lenses** (`:31-44`): subject/identity; product/brand; script/language/CTA; platform/duration/aspect; style; **adding or removing a system** ("redistribute the job formerly done by that system rather than leaving a narrative hole", `:41-42`); multiple references ("state which function comes from each", `:43-44`).
- Worked cases: "Make this with my face" (`:72-89`) and "Use my product" (podcast → budgeting app, where the objection "You expect me to type every coffee?" is answered by a receipt-scan demo, `:91-107`).
- Generation is ordinary production. "Real" is an aesthetic, not provenance (`:111-114`). Prefer reference-conditioned video when identity or continuity matters; use first/last frame only when the endpoint is the design (`:120-125`). Keep reference graphs shallow and avoid intermediate-only images (`:129-138`).

---

### 1.3 Environment — `R/environment/*` (1,172 lines)

**Purpose.** Installing and updating the CLI and skill, choosing a model service (HypiHub vs BYOK), Runtime Profile wiring, credentials, capacity, and local WhisperX and browser preparation.

**Notable content.**
- Three lifecycles: skill, executable, project (`R/environment/distribution.md:12-22`).
- "Recommend HypiHub as the integrated hosted route. Support BYOK as an ordinary route" (`R/environment/model-and-provider.md:37-41`). OAuth is relayed through the chat via `curl …/callback?code=…&state=…` (`:123-129`).
- "'OpenAI-compatible' branding do[es] not establish matching upload, reference, job, result or authentication protocols". A narrower Provider must report its limits rather than "silently reducing duration, dropping references or changing resolution" (`:174-177`).
- Diagnose by error class: missing adapter, rejected credential, unavailable model, unsupported input and exhausted quota each need a different action (`:290-293`).
- WhisperX example: `small` / `cpu` / `int8`, "not universal quality recommendations" (`R/environment/local-tools.md:229-249`). Use a multilingual large model when quality matters and hardware allows (`:267-271`).
- Capacity is modeled per resource: request concurrency, browser workers and browser budget (`R/environment/profile.md:202-234`). The example `defaultConcurrency 2, workers 4, browserCapacity 6` means only one 4-browser render fits at a time (`:231-232`).
- Network mirrors (HF_ENDPOINT, uv, npm, TUNA) are scoped per command (`R/environment/local-tools.md:321-391`).

**Relevance: Low.** We are a hosted multi-tenant SaaS, not a local CLI. The one transferable idea is **error-class-specific diagnostics** for provider failures, which `server/alerts.ts` and `isUserError` partly cover already.

---

### 1.4 Playbooks: formats — `R/playbooks/index.md` + `formats/*` (758 lines)

`index.md` (75) defines **format** (a whole-work relationship: who carries the argument, how attention moves, what pays off) vs **craft** (one local directing problem) (`R/playbooks/index.md:6-11`). A format page "is not a category the project must declare" (`:67-68`).

#### Talking head / UGC — `talking-head.md` (83)
- One character-and-scene image carries every talking clip. Offset the person (e.g. slightly right) to leave room for an icon. "the image prompt describes the person and visible setting, while the icon belongs to its component" (`R/playbooks/formats/talking-head.md:13-19`).
- Reusable frontal view: "face toward the lens, with no head tilt or rotation" (`:21-24`).
- "Natural cuts are part of the desired result." Small pose changes between passages read as a creator's edited recording (`:31-33`).
- `speaker-v1` Kit with `edit-rhythm: pause-trim-jump-cuts` (`:37-48`).
- Give a few actions a reason (a shrug dismisses, a lean makes a punchline personal). "Let speech, Caption or MG carry exact numbers while the hand makes a readable emphatic gesture" (`:50-53`). Example direction: "affectionate roast… amused certainty… brief disbelieving look… small knowing shrug" (`:57-61`).
- Failure modes: "A static expression, mechanically repeated gestures or relentless intensity" (`:80-83`).

#### Ranking / listicle — `ranking-listicle.md` (71)
- "The board remembers earlier judgments while the current person, evidence and performance explain the next one" (`R/playbooks/formats/ranking-listicle.md:3-5`).
- A **partially filled board** at the start implies an ongoing ranking (preset items) (`:9-11`). Keep these concepts separate: the outer window (board exists), preset (initial state), and activation (enters on an event, then persists) (`:13-22`).
- Example layout: host on the right, active subject's icon on the left, board and evidence in the lower region (`:26-29`).
- The board must stay readable through B-roll inserts (`:31-33`). If the board already owns its drop sound, don't add a duplicate audio track (`:35-37`).
- Icons identify the subject. Use found or supplied assets when exact identity or version matters, and check crop, padding and transparency at display size (`:41-54`). Comic inserts can take their own visual language (`:56-59`).

#### Two-person podcast — `two-person-podcast.md` (102)
- Generate the main host first, then derive the partner's complementary view: opposite screen side and gaze, mic from the other side, a different sector of the same place (`R/playbooks/formats/two-person-podcast.md:8-15`).
- Reference graph: most views are "one hop from their useful parent". Lifestyle scenes come from the main host, not from each other (`:19-31`).
- Silent listeners stay alive (a glance down and back, a posture adjustment) (`:44-46`). Prop handoffs need legible possession across cuts (`:48-61`).
- A split-screen opening establishes both people before the first question ends (`:68-82`).
- **Coverage follows a thought, not every noun:** one 3-scene silent montage spans a Selection. Give it "enough room to play through once at native speed"; the Selection may outlast the clip; the incoming voice precedes the picture return (a J-cut); avoid a frozen tail or retiming to fill (`:86-93`). Use separate clips when exact scene-to-cue correspondence matters (`:95-98`).
- Host-colored captions identify the speaker even over full-frame B-roll (`:100-102`).

#### Street interview — `street-interview.md` (92)
- Three-view method: generate a shared two-shot, then derive a guest close-up and an interviewer close-up that keeps part of the guest at the edge (`R/playbooks/formats/street-interview.md:8-19`).
- Cut toward who matters: answers favor the guest close-up; a neutral question stays wide; disbelief earns the interviewer close-up. "rather than alternating cameras on a timer" (`:31-33`). No invented travel shot between cameras (`:36-37`).
- Before and after: the guest is busy (looking into a bag), the interviewer steps in, the guest looks up. At the end the guest begins to turn away. No fixed silent delay (`:41-48`).
- Gestures: "amused certainty, a compact shrug". "Avoid exaggerated emotion, constant motion and exact numerical finger poses" (`:64-66`).
- **A reveal is one event across layers:** one answer Moment updates an emoji-strip slot, starts a short sound and triggers a colored flash. Earlier answers stay; future ones stay as "?" (`:70-72`). Captions, icons, flash and sound are designed as one treatment (`:74-76`).
- Head-tracked captions are optional. Tracked guest captions and fixed interviewer captions can coexist (`:84-92`).

#### Short drama — `short-drama.md` (85)
- Each passage has a dramatic job: want → change in meaning → consequence → reveal (`R/playbooks/formats/short-drama.md:10-13`). A Segment is a performable passage, not a shot or turn (`:14-17`).
- Leave time for pauses, reactions and actions beyond the speech estimate (`:19-23`).
- A few views per location support many clips. Add a new image only when a view must establish a plot fact (`:41-46`).
- "The background carries story": status, intimacy, a planted object (`:61-69`).
- Review for causality: "the viewer should know who is acting, what changed, and why the next view or scene follows" (`:83-85`).

#### Presenter-led visual explainer — `presenter-led-explainer.md` (163)
- Continuing objects give "a memory of the argument" (`R/playbooks/formats/presenter-led-explainer.md:10-13`). A failed action needs an attempt *and* a perceptible consequence (`:22-26`).
- The presenter can move between full-frame, inset and cutout. The semantic event motivates the change; cut, move or fade follows the rhythm (`:47-51`).
- For footage that will mostly fill the frame, generate at the final aspect ratio. "A tight source crop cannot later supply missing hands or setting" (`:60-64`).
- Restyling changes palette, type, edges, depth and motion *together*; "recoloring a glossy interface alone may leave its old visual character intact" (`:94-98`).
- A reference production is linked: 137 s, 17 performance clips (`:147-148`).

#### Narration-led work — `narration-led-demo.md` (87)
This is the format closest to our product: campaign footage plus an AI voiceover.
- Defined by independent, audio-only A-roll with the pictures designed around it (`R/playbooks/formats/narration-led-demo.md:8-11`). Face visibility is not the test (`:13-16`).
- "One spoken spine and many visual answers". A new angle or screen state is a new visual answer inside the same performance (`:25-28`).
- Picture roles: **context shot**, **proof shot**, **B-roll**, **screen media**, **MG/Typography** (`:30-37`).
- **"Build visual evidence, not noun illustration"**: a speed claim needs a visibly fast action; a product claim needs the product in use. "Merely showing a generic image of every noun in the narration produces activity without proof" (`:46-49`).
- Every span needs a deliberate picture; check for empty or inherited edges between decisions (`:71-73`). Captions stay spoken text; steps, labels and CTA copy have their own roles (`:77-78`).
- Review: "does every visual change clarify, prove, pace, or intensify what is being said?" (`:82-87`).

---

### 1.5 Playbooks: craft — `R/playbooks/craft/*` (1,771 lines)

#### Captions — `captions.md` (253)
- Role decides the type: speech displayed while it is delivered is Caption; a title held long after is Typography (`R/playbooks/craft/captions.md:3-6`).
- "A short handoff can land a punchline; a longer phrase can let an explanation breathe… rather than prescribing a fixed Cue length" (`:34-36`).
- **Grouping rules:** keep "a name, negation, article and noun, preposition and object, phrasal verb, or quantity and unit together" (`:63-67`). Give a payoff or contrast its own handoff (`:65-66`).
- **Language changes the reading unit:** English uses words, Chinese uses characters. A Chinese Cue can hold more characters than an English Cue holds words. Count the display side and measure width with the real font (`:71-82`). Mixed script: a Latin brand can occupy several Han widths (`:82`). Korean spacing is authored (`:81`).
- Emphasis is chosen separately from grouping: stable phrase, current-word highlight, or **trail** (spoken words stay highlighted) (`:92-100`). `karaoke-transition: step` activates whole units; `wipe` sweeps within glyphs (`:98-102`). Reveal modes are `all`, `on-start` and `typewriter` (`:111-115`).
- Judge outline and shadow from real glyphs at delivery size, and keep the counters of heavy glyphs open (`:161-164`). Check readability on both light and dark frames, and "avoid hiding the important face or product" (`:172-175`).
- Head-tracked captions only when the reference visibly uses them or the user asks; "A visible face alone does not choose it" (`:177-180`).
- Three layers: **Family** (structural language), **Recipe/Style** (one coherent treatment), **Parameters** (`:191-197`).
- Review heuristic: "Repeated tiny handoffs can ask the viewer to reacquire text too often; an overfull block can ask one visual state to carry too much" (`:249-251`).

#### Caption tracking — `caption-tracking.md` (126)
- Who comes from the script Role, where from the person's view in the final composition, when from the speech. The previous speaker's caption hands off when the next speaker starts (`R/playbooks/craft/caption-tracking.md:10-14`).
- Detector tracks are not identities. "Selecting the first or largest face alone can attach the guest's Caption to the interviewer" (`:47-51`).
- Mapping recipe: the clock (placement start, trim, rate), the geometry (`[x, y, w, h]` from edges, then through crop/inset/panel to the canvas), and the head extent `(x - pL*w, y - pT*h, w*(1+pL+pR), h*(1+pT+pB))` with "no universal face-to-head multiplier". Missing data → `null`; interpolate only within a shot (`:57-71`). Exactly one box or `null` per program frame (`:73`).
- Inspect clearance above hair and hats, top-edge clipping, jitter and wrong-person jumps (`:123-125`).

#### B-roll — `b-roll.md` (94)
- **Exact correspondence** (the claim needs this picture now) vs **a visual thought across several pictures** (habit, process, attitude) (`R/playbooks/craft/b-roll.md:27-35`). "the generation request's duration does not set its display duration" (`:29-30`).
- J-cut: the partner's voice starts while the last lifestyle picture stays (`:64-68`). End a picture on the thought, the action and the reading time; holding, looping or retiming is a deliberate choice (`:70-73`).
- Adjacent pictures meet at a semantic boundary. Watch for unintended flashes or gaps; "a nominally continuous Window cannot make an exhausted source… fill the picture" (`:77-81`).

#### Sound and mix — `sound-mix.md` (70)
- Listen to what the material already contributes before adding anything. "Designed quiet can be just as expressive" (`R/playbooks/craft/sound-mix.md:21-26`). There is no stock library (`:28-30`).
- **Ducking:** "Music and effects can yield around a name, number, claim, punchline or quiet reaction, then take more space in a pause" (`:35-39`).
- "Repeating an effect because another cut occurred can exhaust its meaning" (`:42-44`).
- Bind a sound to the event it answers (a script Moment, or the component's own event) (`:48-52`). A picture cut need not cut the acoustic world (`:62-65`).

#### Graphic composition — `graphic-compositions.md` (85)
- Decide what the eye finds first and what changes at the next beat (`R/playbooks/craft/graphic-compositions.md:10-13`).
- "A large pale panel behind pale clothing can flatten the shot" (`:17-18`).
- Translate a vibe into a few shared choices: palette, type, edges, depth, motion (`:21-24`). When you remove a label, recompose the space; don't leave a hole (`:26-28`).
- "Protect the mouth, meaningful gesture, product fact or text that carries this beat" (`:44-48`).
- Text, data and repeated relationships go in editable structure; photos and artwork stay media (`:56-59`).

#### Motion graphics — `motion-graphics.md` (68)
- Direct the change, not just the entrance: "A satisfying entrance cannot compensate for a settled state that fails to show the claim" (`R/playbooks/craft/motion-graphics.md:11-14`).
- Object identity continues through changes; a clean cut is also a strong handoff (`:16-20`).
- Motion character carries feeling: a springy arrival is playful, a hard replacement gives force, slow construction invites study (`:22-26`).
- Derive movement from relationships ("A pointer arrives at the control it presses") (`:57-59`).

#### Screen demonstrations — `screen-demonstrations.md` (51)
- Screenshot = state, recording = interaction, authored component = concept (`R/playbooks/craft/screen-demonstrations.md:10-15`).
- "a sharp full-resolution capture can still be unreadable when shrunk into a phone-sized inset" (`:27-31`). Show a before and an after, and tell page scroll apart from viewport motion (`:33-39`).

#### Reference relationships — `generated-dependencies.md` (38)
- Second-view table: same capture language, a new person, a complementary shot, a different sector of the same setting (`R/playbooks/craft/generated-dependencies.md:7-16`). Keep references close to the image that actually knows the relationship (`:30`). The image graph is not the shot order (`:38`).

#### Image direction — `image-direction.md` (95) + `examples/image-direction.md` (123) + `examples/conversation-images.md` (218)
- Two ideas: the model has visual habits, so direct the few decisive dimensions; "A few decisive strokes carry the picture" (`R/playbooks/craft/image-direction.md:9-11`).
- Phone-UGC prompts use four paragraphs: Capture (fixed Kit text) / Person / Shot / Setting (`:17-24`). Seven questions for a presenter image (`:30-38`).
- Tested casting wording for GPT Image 2: "**girl** or **boy** followed by the actual adult age", plus a strength and kind of beauty, and "very broad shoulders and excellent head-to-shoulder proportions" against the large-head/narrow-shoulder look (`:44-48`).
- Idle state: a continuable activity, not a frozen instant (`:54-56`).
- Setting: a named place plus a few story objects and a two-color palette carried by real materials ("terracotta and green") (`:66-68`).
- GPT Image 2 is the usual model; **2K** for full-screen or video references, **1K** for an inset (`:87`). Full-screen examples use `9:16` and `2K` (`R/playbooks/craft/examples/image-direction.md:6-7`).
- Full fixed capture paragraph: "single frame from a video actually shot on an iPhone… no depth-of-field blur… natural light" (`R/playbooks/craft/examples/conversation-images.md:14`).
- Use screen-left and screen-right rather than "her left" (`:81-82`). Derive each product-holding view from its own host's view (`:93-94`). "Transfer the decision, not the decorative inventory" (`:213-218`).

#### Voice direction — `voice-direction.md` (99) and voice and performance — `voice-and-performance.md` (231)
- Cast "a voice the audience will want to keep hearing" (`R/playbooks/craft/voice-direction.md:4-6`). A one-paragraph voice brief: vocal character, appealing qualities, way of addressing someone (`:32-35`). Two examples at `:46-57`. Pitch and pace are independent (`:60-63`).
- The sample line exercises the needed delivery, e.g. "Wait, you did all that with one photo? Okay, now you've got my attention." (`:72-74`).
- **About 5 s** of clean speech makes a good Voice Reference: no music, clipping or long silence (`R/playbooks/craft/voice-and-performance.md:109-116`).
- **No synthetic silent handles and no duration-consuming crossfades between A-roll clips.** Both eat into word windows and cause overlapping speech. A direct join is the default for creator speech (`:68-78`).
- "Is the speaker off screen?", "where does the audio come from?" and "what kind of passage is this?" are three distinct questions (`:184-190`). The worked paper-reveal example shows the same visual meaning different constructions (`:192-205`).

#### Video direction — `video-direction.md` (314)
- Direct the reason for an action: the attitude toward the subject and the listener (`R/playbooks/craft/video-direction.md:68-72`). Example: "venting to a friend with affectionate exasperation… At the price, her eyebrows rise…" (`:85-89`). "Attaching a hand movement to every phrase adds choreography without necessarily strengthening the expression" (`:93-95`).
- Restraint with a purpose (`:112-114`). Contrast must become a performable attitude (`:134-137`).
- Spoken subject ≠ visible action. Video models literalize metaphors, so use concrete visible language (`:151-168`).
- "Natural emphatic gestures are usually more reliable than asking fingers to display an exact number" (`:176-177`). Give the encounter edges: start occupied, finish by beginning to leave (`:178-180`).
- Chroma backdrop for isolation; a transparent still reference doesn't make video transparent (`:184-195`).
- Input responsibility table (`:199-208`).
- **Seedance 2 Mini at 720p** is the usual starting point (`:230-232`). Prefer reference-directed generation (`:242-246`).
- "For ordinary direct-to-camera social video, prefer pause-trim jump cuts at phrase boundaries" (`:263-266`). A jump cut written into the prompt doesn't trim anything; real trims are media operations (`:286-289`).
- "For brisk social delivery with trim cuts, `fast` is a useful starting choice" (`:297-298`). If the estimate doesn't fit, reshape the passage (`:304-309`).

---

### 1.6 Production — `R/production/*` (4,811 lines)

**Purpose.** The authoring language (SVML/SVS/SVRun), the media → Timeline → Tracks → Film pipeline, Runs and reuse, Builds and paid scope, Studio and Companions, and component authoring. Most of it documents Hypit mechanics that batches 01–10 cover at code level. Here the focus is the *judgment* it encodes.

**Judgment worth noting.**
- **Review checklist** (`R/production/review.md:97-115`):
  - performance contains the intended action ("Clip or component motion does not substitute for missing action");
  - B-roll covers the intended explanation;
  - events land on the intended word ("A scene that starts on the correct phrase can still reveal its result on the wrong word");
  - shared layout survives handoffs;
  - every caption configuration stays readable;
  - typography hierarchy is right;
  - composition has room.
- Unintended one-frame flashes at handoffs: find the owning cause (window, playback, opacity, background lifetime, crop) (`:122-126`). See the whole film at delivery size, because a component can "cover a face, compete with a Hook, arrive on the wrong word" (`:68-70`).
- Compare a reconstruction **by function**, not pixels, at corresponding *words* (`:134-151`). The repair-owner table is at `:155-161`. If a change didn't improve things, revisit the explanation (`:163-167`).
- **Reuse table**: what to keep vs recompute for each kind of edit (caption-only, marker move, cue regroup, timeline change, B-roll swap, presenter swap, product swap, new wording) (`R/production/authoring.md:170-180`). Moving a marker reuses alignment when tokens are unchanged (`:186-189`). "Do not satisfy a changed Track… with its old rendered Output" (`:193-194`).
- **Paid scope** (`R/production/builds.md:134-161`): estimate from Provider rates; a new command is not a new authorization; ask only when work grows beyond scope, cost or account. `plan` lists every external Need before submission (`:91-98`). `pricing` is read-only and network-backed (`:111`). If a request appears because a Candidate was lost, repair the Run before asking to spend (`:128-132`).
- **Caption family authoring** (`R/production/caption-authoring.md`):
  - "Never put keyword search, matching or content selection in a Recipe"; mark words with script attributes instead (`:14-20`).
  - Rebuild display text from `separatorBefore` + `text`, "never… by joining speech Tokens with spaces" (`:60-63`).
  - A family may derive lines and pages but "does not split or merge Cues"; "A narrow width must not silently rewrite the Script into new Cues" (`:100-104`).
  - Cue-wide progress bars differ from per-unit speech emphasis; test with uneven unit durations and a pause (`:112-116`).
- **Caption Uses**: the last matching Use wins, styles replace rather than merge, and a mid-cue style change keeps the original word times, so karaoke doesn't restart (`R/production/caption-presentation.md:46-50`, `:54-66`).
- **Fonts**: synthetic bold and italic are disabled; "Declaring weight 700 does not turn a regular-only file into a bold face" (`R/production/fonts-and-text.md:39`, `:57-59`). Fallback order is a design choice (`:36-39`).
- **Prompt Kits**: text programs with `fixed`, `slot`, `axis` and `variant` blocks. Precedence is template defaults < Recipe < `text:Param` (`R/production/prompt-kits.md:101-109`, `:147-150`). "Turn something into a Kit when preserving the exact text or exposing a small repeated choice improves real productions" (`:7-10`).
- **Component design**: internal events get their own semantic inputs, not percentages of an outer window (`R/production/component-design.md:140-151`). Choose the temporal input from what the component does (cover = Selection, reveal = Instant that persists) (`:153-156`). Arrival, settle, replace and depart each need appropriate time (`:158-161`).
- **Determinism**: compute state directly from the requested frame so scrubbing and partial renders agree (`R/production/track-authoring.md:181-184`). Verify internal triggers with uneven delivery, because stretching only the outer window hides bugs (`:207-210`).
- **Model input metadata**: Seedance needs `person-reference="true|false"` on every image or video reference (`R/production/vocabulary.md:46-49`).

**Numbers.**
- Normalized audio is a 48 kHz render stem (`R/production/media.md:109`).
- Example mix: music `gain 0.18`, fades `12f` in and `18f` out; reveal hit `gain 0.45`, `fade-out 3f`, a 600 ms window (`R/production/audio-clips.md:14-26`).
- Fit math: 1600×900 into 600×600 gives 600×337.5 under `contain` and about 1066.7×600 under `cover` (`R/production/spatial.md:68-71`).
- Capture viewport `540x960 --scale 2` → 1080×1920 (`R/production/browser-capture.md:13-14`, `:24-25`).
- Native page recording needs Chrome ≥ 153 (`:94`).
- Downloads prefer H.264 near 1080p (`R/production/video-downloads.md:20`).
- Studio default port is 5179; comments live in `FEEDBACK.json` as `{id, run, at, text, resolved}` (`R/production/studio.md:24-25`, `:87-94`).

**Quality notes.**
- (−) The canonical example contradicts the doctrine. `R/production/examples/production.svml:22` defines a `proof` Selection and `:50-52` declares a semantic Projection, yet the proof label is timed by clock (`proof-label from="opening.start+2s" for="2s"`, `:48`, consumed at `:64-65`), and nothing consumes the projection. The skill itself says to bind such graphics to Selections (`R/creation/script-and-time.md:236-239`).
- (−) Editing debris: `R/playbooks/craft/sound-mix.md:54-55` links "Audio Clip" and "Audio Clips" to the same page as if they were two things. `R/playbooks/formats/narration-led-demo.md:65` and `R/playbooks/craft/voice-and-performance.md:213-214`, `:219` cite paths as code spans rather than links.
- (−) Template ordering differs between examples: `R/production/source-syntax.md:126-136` puts dialogue first, while `R/production/examples/direction.svs:4-13` puts direction first. This is harmless but undocumented.
- (+) The ownership tables (`R/production/review.md:155-161`, `R/production/authoring.md:170-180`, `R/environment/profile.md:268-279`) are excellent operational design.

---

## 2. Tests

No tests exist for this batch. The skill contains documentation and examples only, and CI excludes `skills/**` from triggering runs (`.github/workflows/ci.yml:6-16`). Nothing validates the SVML examples against the installed vocabulary, which is how the dead projection in `examples/production.svml` survived. **Assertion count: 0.**

---

## 3. Concrete heuristics and numbers (consolidated)

| Topic | Heuristic / number | Cite |
| --- | --- | --- |
| Speech density | Count syllables (EN) or Han characters (ZH), not words; pace `slow/normal/fast`; brisk social → `fast` | `R/creation/script-and-time.md:197-201`; `R/playbooks/craft/video-direction.md:297-298` |
| Speech padding | Reserve extra time for intended reactions, demos and held pauses | `R/creation/script-and-time.md:204-205` |
| Reference rate | Derive a candidate rate from the reference's units/sec; don't cram into the shortest supported duration | `R/creation/script-and-time.md:210-214` |
| Edit rhythm | Pause-trim jump cuts at phrase boundaries for direct-to-camera | `R/playbooks/craft/video-direction.md:263-266`; `R/playbooks/formats/talking-head.md:45-46` |
| A-roll seams | No silent handles, no crossfades between speech clips; join directly | `R/playbooks/craft/voice-and-performance.md:68-78` |
| Camera choice | Cut toward who matters now, never on a timer | `R/playbooks/formats/street-interview.md:31-33` |
| Hook | Don't turn an example's hook into a format rule | `R/creation/brief.md:24-25` |
| B-roll | Exact correspondence vs one visual thought; let a montage play through once at native speed; J-cut the next voice; no frozen tail | `R/playbooks/craft/b-roll.md:27-35`; `R/playbooks/formats/two-person-podcast.md:86-93` |
| Visual evidence | Proof, not noun illustration | `R/playbooks/formats/narration-led-demo.md:46-49` |
| Caption grouping | Keep name, negation, article+noun, prep+object, phrasal verb, qty+unit together; payoff gets its own handoff; no fixed count | `R/playbooks/craft/captions.md:63-67`, `:75` |
| Caption emphasis | `current` vs `trail`; `step` vs `wipe`; reveal `all/on-start/typewriter` | `R/playbooks/craft/captions.md:98-115` |
| Caption review | Too many tiny handoffs vs an overfull block; readable on light and dark; don't cover face or product | `R/playbooks/craft/captions.md:172-175`, `:249-251` |
| Head-tracked caption | Only if reference or user wants it; head box = face plus authored padding fractions; one box or null per frame | `R/playbooks/craft/caption-tracking.md:3-6`, `:66-73` |
| Reveal | One Moment drives slot update, sound and flash together; earlier answers persist | `R/playbooks/formats/street-interview.md:70-76` |
| Ranking | Preset items imply an ongoing board; activation persists; avoid double drop sounds | `R/playbooks/formats/ranking-listicle.md:9-22`, `:35-37` |
| Mix | Duck under names, numbers, claims and punchlines; don't repeat an effect per cut | `R/playbooks/craft/sound-mix.md:35-44` |
| Example gains | Music 0.18 (fade 12f/18f), hit 0.45 (600 ms, fade 3f) | `R/production/audio-clips.md:14-26` |
| Gestures | No exact finger counts; let captions or MG carry numbers | `R/playbooks/craft/video-direction.md:176-177` |
| Images | GPT Image 2, `9:16`, 2K full-screen / 1K inset; 4-paragraph Capture/Person/Shot/Setting | `R/playbooks/craft/image-direction.md:17-24`, `:87` |
| Video model | Seedance 2 Mini 720p default; reference-directed preferred | `R/playbooks/craft/video-direction.md:230-246` |
| Voice ref | ~5 s clean sample, compact per-speaker refs | `R/playbooks/craft/voice-and-performance.md:109-116` |
| Internal events | Own semantic anchors, never 20/50/80% of the outer window | `R/production/component-design.md:140-144` |
| Sampling refs | Wide samples miss brief events; densify around changes | `R/creation/reference-video.md:130-133` |
| Spend | Agreement covers described work; new commands aren't new asks; ask when scope, cost or account changes | `R/production/builds.md:134-161` |

---

## 4. Relevance to UGCMediaClips

**Overall: High for craft and creation (the knowledge); Low for environment and production mechanics (the Hypit-specific DSL and CLI).**

How it maps onto our product:

- Our clips are mostly **narration-led**: an AI voiceover over campaign gameplay or footage. `server/render.ts:24`, `:188-235` voices the narration and cuts shots. So `R/playbooks/formats/narration-led-demo.md` is the format closest to our default product. The ranking and street-interview reveal patterns map onto our existing `tier`, `emoji` and `text` overlays (`shared/types.ts:165-170`).
- **The biggest conceptual gap is semantic time for shots.** We already bind *overlays* to spoken words (`server/scripts.ts:22`, `shared/overlays.ts:10-13`). But `server/render.ts:252-262` sizes *shots* by scaling each plan's `seconds` against the measured voice duration. That is exactly the "percentage of the outer window" pattern the skill warns against (`R/production/component-design.md:140-144`). Rewording or re-voicing shifts proof shots off the claims they support.
- Our speech-rate model is a single `WORDS_PER_SECOND = 2.6` (`shared/rules.ts:49`). Hypit counts syllables with pace presets and padding (`R/creation/script-and-time.md:188-208`).
- Our caption grouping is count-plus-punctuation (`shared/caption-styles.ts:105-121`). It will happily split "the / best", "not / bad" or "3 / goals". The skill gives concrete linguistic keep-together rules (`R/playbooks/craft/captions.md:63-67`).
- Our format breakdown (`server/formats.ts:21-37`) already asks for beats, pacing, captions and overlays. But it records **seconds** (`atSec`, `start`/`end`), not the expressive relationship the skill insists on (`R/creation/reference-video.md:212-214`). It also samples at a flat 2 fps (`server/formats.ts:100`), which the skill says misses brief events (`R/creation/reference-video.md:130-133`).
- Image, video and voice generation craft (casting, Kits, Seedance) is **Low** today. We cut supplied footage on CPU-only Railway. It becomes **Medium** if we add AI B-roll or AI talking heads.

---

## 5. Which knowledge to encode, and where

The rule of thumb: **encode as code** anything checkable or computable from data we already have (word timings, scene cuts, overlay cues, caption groups). **Encode as prompt text** the generative judgment the planner and analyzer LLMs make on every run. **Leave as agent guidance** the collaborative and judgment-heavy workflows, which only matter when a human is in the loop.

### 5.1 Automated logic (deterministic code, no agent needed)

| # | What | Where in our app | Source |
| --- | --- | --- | --- |
| A1 | **Phrase-anchored shots.** Add `shots[].cue` (a phrase copied from the narration, like overlay cues). After `align.ts` times the voiceover, cut each shot to start at its cue's first word, with the previous shot ending there. Fall back to proportional `seconds` only when there is no cue. Let the outgoing shot own the pause by default, with an option to flip ownership. | `server/render.ts:252-262`, `shared/overlays.ts` (reuse `cueInScript`), `server/scripts.ts` SYSTEM + `toDraft` | `R/creation/script-and-time.md:160-163`, `:241-246`; `R/production/script-syntax.md:218-233`; `R/production/component-design.md:140-144` |
| A2 | **Syllable-based duration estimate** with pace presets (`normal` ~ conversational, `fast` default for brisk clips) and per-format padding. Calibrate the rate from a cloned reference's own transcript (syllables per spoken second). This replaces the single `WORDS_PER_SECOND`. | `shared/rules.ts:49`, `:102`; `server/scripts.ts:48`, `:142`; store the measured rate on `FormatBreakdown` in `server/formats.ts` | `R/creation/script-and-time.md:188-214` |
| A3 | **Linguistic caption grouping.** In `groupWords`, never end a group on an article, preposition, negation, auxiliary or number when the next word completes it. Keep number+unit, "not X" and multi-word names (from brief `requiredPhrases` / product name) together. For CJK, group by characters up to a width budget measured with the actual font, not a fixed count. | `shared/caption-styles.ts:105-121`, `server/captions.ts:73` | `R/playbooks/craft/captions.md:63-82` |
| A4 | **Caption QA checks**: minimum on-screen time per group (no flicker handoffs), maximum characters per group at style size (no overfull block), and the CTA/required phrase kept in one group. Surface failures in clip QA. | `server/captions.ts`, `shared/rules.ts` (`checkClip`) | `R/playbooks/craft/captions.md:249-251`; `R/production/review.md:110-111` |
| A5 | **"Trail" karaoke mode** (spoken words stay highlighted) alongside the existing current-word karaoke. It is cheap in ASS (`\k` vs per-word color resets). | `shared/caption-styles.ts:5` (`CaptionAnimation`), `server/captions.ts` | `R/playbooks/craft/captions.md:98-100` |
| A6 | **One Moment, many layers.** When several overlays share a cue, start them on the same word. Optionally add a short SFX or flash only on reveal-type overlays (`tier`, `emoji`), never on every cut. | `server/overlays.ts:52`; render audio mix | `R/playbooks/formats/street-interview.md:70-76`; `R/playbooks/craft/sound-mix.md:41-44` |
| A7 | **Speech-aware music ducking**: when music is added (the editor supports it, `README.md:43`), drop gain around spoken spans, more around overlay-cued numbers and claims, and lift in pauses. ffmpeg `sidechaincompress` or volume envelopes from word times. | render mix / editor export | `R/playbooks/craft/sound-mix.md:35-39`; gains `R/production/audio-clips.md:14-26` |
| A8 | **Handoff integrity checks** after cutting: no shot shorter than ~2 frames, no source exhausted before its window (black or frozen tail), no gap between shots. We partly do the black check already (`server/render.ts:278-279`). | `server/render.ts` | `R/production/review.md:122-126`; `R/production/visual-clips.md:50-52`; `R/playbooks/craft/b-roll.md:77-81` |
| A9 | **Denser reference sampling** in format breakdown: keep 2 fps overall, but sample the first ~3 s (the hook) and ±0.5 s around each detected scene cut at 6–10 fps in the proxy. This catches brief pop-ups without much extra cost. | `server/formats.ts:94-104` | `R/creation/reference-video.md:123-133` |
| A10 | **Display vs spoken text for TTS** (Dual Text). Store an optional `say` map (e.g. `"3v3" → "three versus three"`, brand pronunciations) applied only to the TTS input. Captions keep the display form, and alignment maps the spoken tokens back to display words. | `server/render.ts:203` (`speak(clip.narration…)`), `server/align.ts` | `R/creation/script-and-time.md:58-111`; `R/production/script-syntax.md:61-67` |
| A11 | **No crossfades or silent padding at voice seams** when variants or multi-take voices are stitched. | `server/variants.ts`, render | `R/playbooks/craft/voice-and-performance.md:68-78` |
| A12 | **Reuse-boundary table as cache keys**: caption, overlay and style edits reuse voice + alignment + cut shots; a marker or cue move reuses alignment; a narration change re-voices. This avoids re-paying TTS. | `server/render.ts`, `server/caption-jobs.ts`, metering in `server/usage.ts` | `R/production/authoring.md:170-189` |

### 5.2 Prompt text (LLM planner and analyzer, every run)

**`server/scripts.ts` SYSTEM** (`:13-25`). Add these compact rules:

1. Shots must be **visual evidence for the line they cover** (context, proof, reaction, payoff), not an illustration of each noun. Prefer one shot that holds through a whole thought over a cut per noun. *Source:* `R/playbooks/formats/narration-led-demo.md:30-37`, `:46-49`; `R/playbooks/craft/b-roll.md:27-35`.
2. Each shot gets a `cue` (narration words where it starts), following the overlay-cue convention, to feed A1. *Source:* `R/creation/script-and-time.md:160-163`.
3. **Payoff timing**: put the reveal or punchline word at the start of a new caption group, and cue any overlay on that word, not the setup. *Source:* `R/playbooks/craft/captions.md:65-66`; `SK/SKILL.md:71-72`.
4. **Numbers and exact facts** go in narration, captions or `text` overlays, never only in the picture. *Source:* `R/playbooks/formats/talking-head.md:52-53`.
5. **Ranking clips**: optionally open with 1–2 tiers pre-filled ("ongoing ranking"). Each new item is introduced and judged in its own sentence, and its `tier` overlay is cued on the verdict word. *Source:* `R/playbooks/formats/ranking-listicle.md:9-22`.
6. **Attitude**: state in one line how the narrator regards the subject and the viewer (e.g. "affectionate roast", "excited friend sharing a find") and keep it consistent. This becomes the TTS voice and tone hint. *Source:* `SK/SKILL.md:102-104`; `R/playbooks/craft/video-direction.md:68-72`.
7. **When adapting a format**: if our footage can't carry a reference system (no face cam, no UI), redistribute its job to overlays, text or a different shot rather than dropping the beat. *Source:* `R/creation/transformations.md:41-42`, `:20-23`.
8. Add an optional `say` field for words TTS should pronounce differently from how they display (A10).

**`server/formats.ts` SYSTEM** (`:21-37`). Reshape the breakdown toward relationships:

1. For every beat and overlay, add **`anchor`**: what it responds to in the speech or action ("on the verdict word", "covers the claim about speed", "after the question, before the answer"), plus **`job`**: the viewer function from this closed list: *establish, contrast, accumulate proof, amplify reaction, make process legible, hand off*. Keep `atSec` as evidence only. *Source:* `R/creation/reference-video.md:17-21`, `:212-214`; `R/creation/script-and-time.md:248-251`.
2. For each **persistent visual system** (board, strip, counter, caption treatment), record its entry, persistence across cuts, how new items enter (replace, add or cover) and its exit. *Source:* `R/creation/reference-video.md:39-43`, `:164-166`.
3. Add `formatFamily` from a closed set: `narration-led`, `talking-head`, `ranking`, `podcast`, `street-interview`, `short-drama`, `explainer`, `other`. The planner then pulls the matching rules from §5.2 and the playbooks. *Source:* `R/playbooks/index.md:55-65`.
4. Add `speechRate`: measured syllables per second over spoken spans (computed in code from the transcript, A2), and `editRhythm`: `pause-trim jump cuts | continuous | montage-on-beat`. *Source:* `R/creation/script-and-time.md:210-212`; `R/playbooks/craft/video-direction.md:263-266`.
5. Mark claims as `observed` vs `inferred`, and do not turn the reference's literal hook into the recipe's template. *Source:* `R/creation/reference-video.md:168-170`; `R/creation/brief.md:24-25`.
6. Note captions per **configuration** (speaker color, emphasis mode current/trail, words per group range, whether captions hide during demos). *Source:* `R/creation/reference-video.md:164-166`; `R/playbooks/craft/captions.md:92-115`.

`formatForPlanner` (`server/formats.ts:215-231`) should then pass `anchor`, `job`, `formatFamily`, `speechRate` and `editRhythm` instead of raw `start`/`end` seconds, so the planner binds to *its own* narration.

**`shared/caption-styles.ts` presets.**
- Add a `trail` animation preset (A5).
- Add a "speaker color" option for two-voice clips (host-colored captions) for podcast-style or reply-to-comment formats. *Source:* `R/playbooks/formats/two-person-podcast.md:100-102`.
- Document per-preset recommended group size as a *range*, used by A3 as a width budget. *Source:* `R/playbooks/craft/captions.md:34-36`, `:75`.

### 5.3 Agent guidance (`server/agent.ts` system prompt, `:27-41`), short additions only

1. **Repair at the owner.** Map user feedback to the owning edit: wording or cue → `edit_clip` narration or overlays; look → caption style or brand kit; wrong picture → shot footage or moment; whole idea wrong → replan. *Source:* `R/production/review.md:155-161`; `R/creation/brief.md:81-93`.
2. **Reuse, don't re-pay.** After a failed render or a caption-only change, re-render without replanning or re-voicing. Report what was reused. *Source:* `R/production/authoring.md:132-138`; `R/creation/project-files.md:224-225`.
3. **Spending.** State the expected cost of plan, render and voice batches up front. One agreement covers that batch; ask again only when scope grows. This fits our metering in `server/usage.ts`. *Source:* `R/production/builds.md:134-161`.
4. **Ask only what only the user can answer** (goal, private facts, budget, publishing). Choose hooks, caption style, shots and overlays yourself. *Source:* `R/creation/brief.md:27-32`.
5. **Done means watched.** After `wait_for_renders`, check the clip's QA (transcription check, caption QA from A4) before calling it ready, and name any limitation. *Source:* `SK/SKILL.md:256-262`.

### 5.4 Leave as human or agent reference only (don't encode)

- All of `R/environment/*`: local CLI install, Profiles, WhisperX prep, mirrors. These don't apply to a hosted SaaS.
- The SVML/SVS/SVRun language, Studio, Companions and component-packaging pages (`R/production/{source-syntax,script-syntax,runs,builds (mechanics),studio*,track-authoring,component-*,vocabulary}.md`). Batches 01–08 decide what to adopt at the architecture level.
- Generative casting and Kit prompts (`R/playbooks/craft/image-direction.md`, the examples, `voice-direction.md`, most of `video-direction.md`). These only matter if we add AI talking heads or AI B-roll. If we do, the 4-paragraph Capture/Person/Shot/Setting structure and the "attitude toward subject and listener" direction are the parts worth porting into a prompt template.
- Head-tracked captions (`R/playbooks/craft/caption-tracking.md`). This needs a face detector (GVI is paid per call). Revisit only if the format breakdown reports a reference using it. The `null`-per-frame and padding-fraction model is the right data shape if we do.
- Short-drama and podcast multi-view generation graphs: these are generation-only.

---

## 6. Ideas worth taking (ranked)

1. **Bind shots to narration phrases, not proportional seconds** (A1 + prompt rule 2). This is the single largest quality gain: proof shots stay on their claims through re-voicing, variants and edits. It reuses alignment we already compute. *Cite:* `R/production/component-design.md:140-144`; `server/render.ts:252-262`.
2. **"Visual evidence, not noun illustration" planner rule**, plus the context/proof/B-roll/screen/MG role list. *Cite:* `R/playbooks/formats/narration-led-demo.md:30-49`.
3. **Linguistic caption grouping + caption QA** (A3, A4). *Cite:* `R/playbooks/craft/captions.md:63-82`, `:249-251`.
4. **Format breakdown records relationships (`anchor`, `job`, persistent systems, family, measured rate)** instead of raw seconds. *Cite:* `R/creation/reference-video.md:17-21`, `:39-43`, `:212-214`.
5. **Syllable-based duration with pace presets, calibrated from the reference** (A2). *Cite:* `R/creation/script-and-time.md:188-214`.
6. **Dual display/spoken text for TTS** (A10). It fixes brand and number pronunciation without changing captions. *Cite:* `R/creation/script-and-time.md:58-111`.
7. **One Moment drives overlay + SFX + flash; reveal-only SFX; speech-aware ducking** (A6, A7). *Cite:* `R/playbooks/formats/street-interview.md:70-76`; `R/playbooks/craft/sound-mix.md:35-44`.
8. **Reuse-boundary table as render cache policy** (A12). It saves TTS and transcription spend. *Cite:* `R/production/authoring.md:170-189`.
9. **Repair-owner table in the in-app agent prompt.** *Cite:* `R/production/review.md:155-161`.
10. **Transformation lenses**, especially "removing a system → redistribute its job", for format cloning onto footage that lacks the reference's elements. *Cite:* `R/creation/transformations.md:31-44`.

## 7. Things not to copy

- **The prose register.** The skill spends thousands of tokens on abstract relational prose ("equal-length absolute Windows", `SK/SKILL.md:52-53`). For our planner and analyzer prompts, which run on every request and are metered, keep rules short and imperative. Port the *rules*, not the paragraphs.
- **Casting language for generated presenters.** The tested GPT Image wording relies heavily on beauty superlatives and "girl/boy" for adults, with repeated "very fair skin" across examples (`R/playbooks/craft/image-direction.md:44-46`; `R/playbooks/craft/examples/image-direction.md:33`, `:54`, `:70`, `:102`; `R/playbooks/craft/examples/conversation-images.md:50`, `:181`). It's empirically tuned for one model, and it's a brand-safety and bias risk for a multi-tenant SaaS serving advertisers. If we ever generate presenters, write our own neutral casting templates.
- **Agent-in-the-loop dependence.** Much of the quality comes from the agent watching grids, iterating and asking (`R/creation/reference-video.md:45-51`; `R/production/studio.md:119-132`). We run unattended. Convert the checks into code (A4, A8) rather than relying on a reviewing agent.
- **Undocumented-by-tests examples.** CI ignores the skill (`.github/workflows/ci.yml:8`), and the canonical example has a dead projection and a clock-timed label that contradicts the doctrine (`R/production/examples/production.svml:48-52`). If we ship prompt or format examples, test them (e.g. snapshot-test `cleanBreakdown` and `formatForPlanner` on fixtures).
- **Local-tooling assumptions** (WhisperX prep, mirrors, browser downloads, OAuth via chat relay, `R/environment/model-and-provider.md:123-129`). These don't fit hosted, multi-tenant, CPU-only Railway.
- **Head tracking via paid GVI per clip** as a default. It's opt-in craft in Hypit (`R/playbooks/craft/captions.md:177-180`) and would be a cost trap for us.

## 8. Better version (for us)

A **"format rules" module**: a small typed table keyed by `formatFamily` (narration-led, ranking, reply-to-comment, POV, talking-head). Each entry holds 4–8 terse rules distilled from §5.2, an `editRhythm`, a pace preset, a caption grouping range and an overlay pattern.

- `formats.ts` classifies a reference into a family and measures its rate in code.
- `scripts.ts` injects only that family's rules into SYSTEM, which keeps tokens low.
- `render.ts` enforces timing by binding shots and overlays to aligned cue words.
- The caption and handoff QA checks replace the "agent watches the grid" loop.

This keeps Hypit's best idea (meaning-bound timing plus format-specific craft) and fits an unattended, metered, CPU-only pipeline.

---

## 9. Coverage table

| File (relative to `skills/hypit/`) | Lines | Read |
| --- | ---: | :---: |
| SKILL.md | 328 | ✅ |
| agents/openai.yaml | 4 | ✅ |
| references/creation/brief.md | 93 | ✅ |
| references/creation/project-files.md | 237 | ✅ |
| references/creation/reference-video.md | 244 | ✅ |
| references/creation/script-and-time.md | 259 | ✅ |
| references/creation/transformations.md | 143 | ✅ |
| references/environment/distribution.md | 176 | ✅ |
| references/environment/local-tools.md | 409 | ✅ |
| references/environment/model-and-provider.md | 303 | ✅ |
| references/environment/profile.md | 284 | ✅ |
| references/playbooks/index.md | 75 | ✅ |
| references/playbooks/formats/narration-led-demo.md | 87 | ✅ |
| references/playbooks/formats/presenter-led-explainer.md | 163 | ✅ |
| references/playbooks/formats/ranking-listicle.md | 71 | ✅ |
| references/playbooks/formats/short-drama.md | 85 | ✅ |
| references/playbooks/formats/street-interview.md | 92 | ✅ |
| references/playbooks/formats/talking-head.md | 83 | ✅ |
| references/playbooks/formats/two-person-podcast.md | 102 | ✅ |
| references/playbooks/craft/b-roll.md | 94 | ✅ |
| references/playbooks/craft/caption-tracking.md | 126 | ✅ |
| references/playbooks/craft/captions.md | 253 | ✅ |
| references/playbooks/craft/examples/conversation-images.md | 218 | ✅ |
| references/playbooks/craft/examples/image-direction.md | 123 | ✅ |
| references/playbooks/craft/generated-dependencies.md | 38 | ✅ |
| references/playbooks/craft/graphic-compositions.md | 85 | ✅ |
| references/playbooks/craft/image-direction.md | 95 | ✅ |
| references/playbooks/craft/motion-graphics.md | 68 | ✅ |
| references/playbooks/craft/screen-demonstrations.md | 51 | ✅ |
| references/playbooks/craft/sound-mix.md | 70 | ✅ |
| references/playbooks/craft/video-direction.md | 314 | ✅ |
| references/playbooks/craft/voice-and-performance.md | 231 | ✅ |
| references/playbooks/craft/voice-direction.md | 99 | ✅ |
| references/production/audio-clips.md | 52 | ✅ |
| references/production/authoring.md | 229 | ✅ |
| references/production/browser-capture.md | 112 | ✅ |
| references/production/builds.md | 317 | ✅ |
| references/production/caption-authoring.md | 162 | ✅ |
| references/production/caption-presentation.md | 72 | ✅ |
| references/production/component-design.md | 223 | ✅ |
| references/production/component-sharing.md | 146 | ✅ |
| references/production/component-visuals.md | 150 | ✅ |
| references/production/examples/detail.svrun | 12 | ✅ |
| references/production/examples/direction.svs | 14 | ✅ |
| references/production/examples/look.svs | 5 | ✅ |
| references/production/examples/material.svrun | 5 | ✅ |
| references/production/examples/production.svml | 74 | ✅ |
| references/production/examples/production.svrun | 5 | ✅ |
| references/production/examples/visuals.ts | 63 | ✅ |
| references/production/fonts-and-text.md | 142 | ✅ |
| references/production/image-operations.md | 78 | ✅ |
| references/production/index.md | 73 | ✅ |
| references/production/media.md | 232 | ✅ |
| references/production/prompt-kits.md | 161 | ✅ |
| references/production/rendering.md | 140 | ✅ |
| references/production/review.md | 174 | ✅ |
| references/production/runs.md | 158 | ✅ |
| references/production/script-syntax.md | 236 | ✅ |
| references/production/snapshots.md | 90 | ✅ |
| references/production/source-syntax.md | 169 | ✅ |
| references/production/spatial.md | 202 | ✅ |
| references/production/studio-companions.md | 191 | ✅ |
| references/production/studio.md | 253 | ✅ |
| references/production/system.md | 104 | ✅ |
| references/production/timeline.md | 73 | ✅ |
| references/production/timing.md | 73 | ✅ |
| references/production/track-authoring.md | 223 | ✅ |
| references/production/tracks.md | 47 | ✅ |
| references/production/video-downloads.md | 47 | ✅ |
| references/production/visual-clips.md | 86 | ✅ |
| references/production/vocabulary.md | 124 | ✅ |
| **Total (66 files)** | **9,820** | ✅ |
