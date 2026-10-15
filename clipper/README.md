# Clip Operator

A standalone SaaS for clippers: paste a clipping campaign brief, get its rules, footage and clip plans, and track every post and what each campaign owes you.

## What it does

1. **Reads the brief.** Paste a Google Doc link (shared "anyone with the link"), any public page, or the text itself. The AI (or a rules reader, without a key) pulls out:
   - payout: CPM, max per post, budget, minimum views
   - phrases that must be spoken, the call to action and where it goes
   - banned claims, account rules and minimum engagement
   - length, platforms, hook examples, facts clips may state, and footage links
2. **Finds the footage.** Public Google Drive folders in the brief are listed with thumbnails. Backup copies of the same file are skipped.
3. **Writes clip plans.** Each plan has a hook, a voiceover, on-screen text, 2–5 shots naming exact footage files, and a caption with hashtags. Every plan is checked in code against the brief:
   - every required phrase is spoken
   - the call to action is in the last lines
   - the length fits, and the voiceover fits the length
   - no banned claims
   - every shot uses campaign footage

   A plan that fails a check gets one AI rewrite with the exact failures.
4. **Tracks posts.** Log where each clip went live, update its views and engagement, and see estimated earnings under each campaign's terms (CPM, capped per post), then mark posts paid.

5. **Renders videos.** An approved plan becomes a finished 1080×1920 MP4:
   - **Footage:** each source file is fetched once into storage. Google Drive limits full downloads of popular public files, so you can also upload your own copy on the Footage tab.
   - **Moments:** a vision model (Gemini through OpenRouter) watches a 1 fps preview with timestamps burned in, and logs goals, saves and other highlights. These are cached per file and fed back into new plans.
   - **Voiceover (optional):** read by an OpenRouter audio model. With "No voice", the script is captioned on screen for you to record.
   - **Assembly (ffmpeg):** each shot is cut at the best matching moment, framed for 9:16 with a blurred fill, and given the hook at the top, word-timed captions and a call-to-action card at the end. The voice goes over ducked game audio, normalized to −14 LUFS.

   A render of cached footage takes about a minute. Costs per clip: about $0.01 to analyze each new 8-minute footage file, and about $0.001 for the voice.

6. **Learns what works** (the "What's working" page). Each clip records its traits: hook style (question, challenge, POV, reveal…), format, length, voice and the moment it opens on.
   - **Fair comparison:** every post with a view count is compared with its own account's typical views at about 3 days old. Every views update is kept, so a post's 3-day number survives later updates; posts under a day old don't count yet.
   - **Thin data:** a trait with only a few posts is pulled toward "normal" and labeled *too early*, *early signal* or *solid*, so one lucky post can't steer anything.
   - **Playbook:** this lists proven patterns, ones to avoid, and what's still untested. New plans lean on what's proven and avoid what isn't working (with or without AI). About 30% of plans are tagged "Test" and try something untested, so the system keeps learning. A campaign uses its own data once it has 8 comparable posts; until then it uses the whole workspace.
   - **Findings:** an AI summary of the numbers (do more, stop doing, test next), with a rules-only version when AI is off.

   Patterns are reliable after about 20–30 tracked posts.

## Editor

Every rendered clip can be opened on a timeline with **Edit in editor**: the [OpenReel](https://github.com/Augani/openreel-video) editor (MIT), served at `/editor/`.

- **What it loads:** the render's own parts. The shots go on a video track, the AI voiceover on an audio track, the hook and call to action as text, and word-timed captions. You can trim, reorder, restyle captions, add zooms, transitions and music, and more.
- **AI Editor chat:** describe an edit ("add a punch-in zoom on every shot", "make the captions bigger"). It runs on Clip Operator's AI key and counts toward the workspace's daily AI limit, so no API key is entered in the browser. Edits that change the project ask for approval first.
- **Save to Clip Operator:** the browser exports the edit and uploads it as the clip's video. The server converts the audio to AAC and moves the MP4 index to the front. The parts are kept, so the clip can be opened again; rendering again replaces the edit.
- **Browser:** the editor needs Chrome or Edge (WebCodecs with H.264).
- **Build:** `editor/build.sh` builds OpenReel from the pinned commit in `editor/OPENREEL_COMMIT` with the patches in `editor/` (see `editor/NOTICE.md`). The Dockerfile runs it. Locally, run `bash editor/build.sh` to put it in `editor-dist/`.

## Headless: MCP and API

Everything in the dashboard can be run by an AI agent or a script. Create a key in **Settings → Agent access** (shown once, stored hashed, one per workspace). It works for every workspace action except account and key management. Agent actions are marked "agent" in Activity.

- **Remote MCP server:** `https://<your-app>/mcp` (Streamable HTTP, stateless), with the header `Authorization: Bearer co_agent_…`.
  - Claude Code: `claude mcp add --transport http clip-operator https://<your-app>/mcp --header "Authorization: Bearer co_agent_…"`
- **Local stdio server** (Claude Desktop, or clients without remote MCP): `CLIP_API_URL=https://<your-app> CLIP_API_KEY=co_agent_… npm run mcp`
- **Plain HTTP API:** the same `/api/...` routes the dashboard uses, with the same header.

Tools:

| Tool | What it does |
| --- | --- |
| `brief_to_shorts` | Takes a brief link or text, writes plans, approves the ones that pass, and queues renders. Plans that break a rule wait for review. |
| `add_campaign`, `get_campaign`, `overview` | Campaigns, brief rules, footage, clips and earnings |
| `find_moments` | Logs highlights in one footage file with the vision model |
| `plan_clips`, `edit_clip`, `review_clip` | Write, change and approve or reject plans. QA re-runs on every change. |
| `render_clip`, `wait_for_renders`, `get_clip` | Renders, then returns signed video links (valid 7 days, no login needed) |
| `log_post`, `update_post_metrics`, `list_posts` | Track posts. Each views update is kept for the learning system. |
| `whats_working` | The learning report, playbook and written findings |

The `make_shorts` prompt runs the whole flow from a brief. Agents can't post to social platforms: you upload, then log the post.

## Layout

- **Left rail:** overview, new campaign, review queue, posts & earnings, settings, and the account menu.
- **Sidebar:** campaigns, grouped by status.
- **Tabs and main area:** each campaign has Brief & rules, Clips, Posts & earnings and Footage tabs.
- **Right panel:** the campaign's payout, its must-dos, who may post, footage and pipeline.
- **Bottom bar:** AI and render status, plus totals.

## Run it

```bash
npm install
npm run dev        # API :8788 + web :5174
npm test
```

Without `DATABASE_URL`, data lives in `./data` as JSON files. Without `OPENROUTER_API_KEY`, briefs are read by the rules reader and plans are assembled from the brief's own hooks and facts. See `.env.example`.

## Deploy (Railway)

This is a separate service from Studio Operator, built from this folder:

- Root directory `clipper`, which uses `railway.json` and the `Dockerfile`.
- Variables: `DATABASE_URL`, `SESSION_SECRET`, `OPENROUTER_API_KEY`, `APP_URL`, and the `S3_*` bucket settings. Optional: the model variables, `AI_DAILY_LIMIT` and `RENDER_CONCURRENCY`.
- The image includes ffmpeg. Give the service at least 2 GB of memory; footage is staged on local disk while it's copied to the bucket.
- Tables are prefixed `co_`, so it can share a Postgres instance without touching other apps' tables.
- Run 1 replica: workspace documents are cached in memory.
