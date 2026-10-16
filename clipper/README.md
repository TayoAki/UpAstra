# UGCMediaClips

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
- **AI Editor chat:** describe an edit ("add a punch-in zoom on every shot", "make the captions bigger"). It runs on UGCMediaClips's AI key and counts toward the workspace's daily AI limit, so no API key is entered in the browser. Edits that change the project ask for approval first.
- **Save to UGCMediaClips:** the browser exports the edit and uploads it as the clip's video. The server converts the audio to AAC and moves the MP4 index to the front. The parts are kept, so the clip can be opened again; rendering again replaces the edit.
- **Browser:** the editor needs Chrome or Edge (WebCodecs with H.264).
- **Build:** `editor/build.sh` builds OpenReel from the pinned commit in `editor/OPENREEL_COMMIT` with the patches in `editor/` (see `editor/NOTICE.md`). The Dockerfile runs it. Locally, run `bash editor/build.sh` to put it in `editor-dist/`.

## Captions

**Word-perfect captions**
- **Voiced renders:** each caption word comes from the script; its timing comes from the voiceover. [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) transcribes the voice, and the script is aligned to that transcript.
  - If the voice model adds words before or after the script, they're cut.
  - If a take strays inside the script, it's recorded again once.
- **Languages:** about 99 spoken languages, detected automatically. Languages written without spaces (Chinese, Japanese, Thai) are segmented properly.

**Styles and brand kit**
- **Eight styles:** bold pop, karaoke, Hormozi, one word, boxed, neon, minimal and subtitle, rendered with libass.
- **Brand kit (Settings → Brand & captions):**
  - default style, colours and casing;
  - uploaded TTF/OTF fonts, checked with `fc-scan`.
- **Per campaign:** a campaign can pick its own style on its Brief tab.
- **Bundled fonts:** Poppins, Anton, Bebas Neue and Archivo Black. They're under the SIL OFL; the license files are in `fonts/`. Noto fonts cover other scripts.

**Captions page:** captions any uploaded video with speech.
- Fix words line by line; each line keeps its timing.
- Pick a style and render. The output keeps the video's own shape.
- Download or share it.
- MCP tools: `caption_video` and `get_caption_job`.

**Setup:** the Docker image builds `whisper-cli` and includes the multilingual base model. Locally, set `WHISPER_BIN` and `WHISPER_MODEL`, or put the model at `models/ggml-base.bin`.

## Scheduling & publishing (Outstand)

With an [Outstand](https://www.outstand.so/) API key, users connect their own TikTok, Instagram, YouTube, Facebook, X, Threads, LinkedIn and Bluesky accounts, then post or schedule rendered clips.

**How it works**
- **Accounts are tagged per workspace** (Outstand's `tenant_id`). Each workspace only ever sees its own accounts.
- **Videos are copied to Outstand's media storage**, which keeps them 60 days, so scheduled posts outlive our 7-day links.
- **Webhooks** mark posts live (with their public URL) or failed. They're verified against the raw body with HMAC-SHA256.
- **Views sync back** from Outstand's analytics every 30 minutes. They feed earnings and What's working with no manual entry.

**Platform limits through Outstand's shared apps**
- **TikTok:** posts go to the creator's inbox as a draft unless "Post directly" is chosen. Direct posting is capped across all Outstand customers. Reliable direct posting at scale needs your own audited TikTok app, connected to Outstand as BYOK.
- **YouTube:** the shared app's daily upload pool is small, so use BYOK for volume.
- **X:** needs BYOK.

**Setup**

| Variable | |
| --- | --- |
| `OUTSTAND_API_KEY` | Organization API key (`sk_live_…`); the organization needs an active plan |
| `OUTSTAND_WEBHOOK_SECRET` | The signing secret you set on the webhook in Outstand |
| `OUTSTAND_SYNC_MINUTES` | View sync interval (default 30) |

1. In the Outstand dashboard, add a webhook pointing to `https://<your-app>/api/outstand/webhook`.
2. Subscribe it to `post.published`, `post.error` and `account.token_expired`.
3. Give it the same signing secret as `OUTSTAND_WEBHOOK_SECRET`.

**MCP tools:** `list_social_accounts`, `schedule_clip`, `list_schedule` and `cancel_scheduled_post`.

## Clipping Agent

The **Agent** page is a chat that runs the whole loop for you: give it a brief and it can add the campaign, find moments, plan, check and render clips, caption videos and schedule posts. It uses the same MCP tools that outside agents get, connected in memory and acting as the signed-in user, so the same brief rules, limits and Activity log apply.

- Anything that publishes (`schedule_clip`, `cancel_scheduled_post`) pauses until you approve or decline it.
- Each model call counts against the daily AI allowance (`AI_DAILY_LIMIT`). Set the model with `AGENT_MODEL`; it defaults to the main AI model.
- A run stops after 30 steps. A run cut off by a server restart is marked stopped; send a message to continue it.

## Usage and costs

Every AI call is metered against its workspace in dollars, as billed by the provider. Renders, caption jobs and published posts are counted too. **Settings → Usage** shows this month's cost by task, cost per clip, and today's AI budget.

- `AI_DAILY_BUDGET_USD` (default `5`): AI dollars a workspace may spend per UTC day, on top of the `AI_DAILY_LIMIT` call count.
- `ADMIN_EMAILS`: comma-separated operator emails. These users also see every workspace's usage for the month.
- Compute and posting are estimated: `COST_RENDER_SEC` (default `0.0001` per second of rendered video), `COST_CAPTION_SEC` (`0.00008`) and `COST_POST` (`0.007`, Outstand per post).
- The agent and the editor chat mark prompt-cache breakpoints for Anthropic models, so repeated system prompts, tools and history are read from cache (about 1/20 of the price).

## Headless: MCP and API

Everything in the dashboard can be run by an AI agent or a script. Create a key in **Settings → Agent access** (shown once, stored hashed, one per workspace). It works for every workspace action except account and key management. Agent actions are marked "agent" in Activity.

- **Remote MCP server:** `https://<your-app>/mcp` (Streamable HTTP, stateless), with the header `Authorization: Bearer co_agent_…`.
  - Claude Code: `claude mcp add --transport http ugcmediaclips https://<your-app>/mcp --header "Authorization: Bearer co_agent_…"`
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

## Running it for real users

**Accounts and email**
- Sign-up sends a confirmation link. "Forgot password" emails a one-time reset link that expires after 1 hour; using it signs out every other session.
- Settings → Your account lets people change their password or sign out everywhere.
- Email goes through [Resend](https://resend.com): set `RESEND_API_KEY` and `EMAIL_FROM` (an address on a domain you've verified in Resend).
- Links are built from `APP_URL`, never from the request's Host header.
- Without `RESEND_API_KEY`, nothing is sent. In development the links are printed to the log; in production they aren't, because they sign people in.
- Until someone confirms their email, their workspace's daily AI budget is `AI_UNVERIFIED_BUDGET_USD` (default $1). This only applies while email is configured.

**Limits**
- Per workspace per day: `AI_DAILY_BUDGET_USD` (default $5) and `AI_DAILY_LIMIT` (default 150 calls).
- Across the whole server per day: `AI_GLOBAL_DAILY_BUDGET_USD` (default $100).
- Queue caps per workspace: `MAX_QUEUED_RENDERS` (20) and `MAX_QUEUED_CAPTION_JOBS` (5).
- Logins are limited per address (IPv6 grouped by /64) and per account. Sign-ups and resets are limited per address.

**Restarts and deploys**
- Renders and caption jobs cut off by a restart resume on their own, at most twice each.
- On startup, after `RESUME_DELAY_SEC` (default 45), the server finds workspaces with interrupted work and picks it up.
- `RENDER_CONCURRENCY` sets how many renders run at once (about 1.6 vCPU and 2 GB each).

**Footage**
- Drive footage is downloaded once and cached in the bucket.
- When Drive's public download limit blocks a file, a `GOOGLE_API_KEY` (an API key with the Drive API enabled) lets the server try Drive's API instead.

**Monitoring**
- `ALERT_WEBHOOK_URL` takes a Slack or Discord incoming webhook. It receives unexpected server errors, crashes, failed renders, caption jobs and agent runs, email failures, and the server-wide AI budget running out.
- The same problem alerts at most once per 15 minutes, and at most 30 alerts go out per hour.
- Problems users fix themselves (a blocked Drive file, a bad link) don't alert.
- `/api/health` checks the database and returns 503 if it's down.

**Security**
- Pages are served with a Content Security Policy (except the third-party editor at `/editor`), plus HSTS, `nosniff`, `DENY` framing and a strict referrer policy.
- ffmpeg only reads real audio/video containers, from local files or our own storage's signed links.
- Fetching links from briefs is limited to public addresses. The check happens at connect time, so DNS rebinding can't get around it.
- The editor's AI proxy forwards only the fields the editor needs.

**Legal**
- `#/terms` and `#/privacy` are linked from sign-up and the account menu. They're a starting draft: have them reviewed.
- Set `LEGAL_NAME` (your company's legal name) and `CONTACT_EMAIL` (shown on both pages).
