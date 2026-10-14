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
