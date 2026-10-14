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

Video rendering is phase 2. An OpenShorts/Remotion worker will turn approved plans into finished 9:16 videos with voiceover and captions. It is set up with `RENDER_SERVICE_URL`.

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
- Variables: `DATABASE_URL`, `SESSION_SECRET`, `OPENROUTER_API_KEY`, `APP_URL`, and optionally `EXTRACT_MODEL`, `SCRIPT_MODEL` and `AI_DAILY_LIMIT`.
- Tables are prefixed `co_`, so it can share a Postgres instance without touching other apps' tables.
- Run 1 replica: workspace documents are cached in memory.
