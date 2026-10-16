# Check brief (independent verification of a study batch)

You are the second reviewer, after ECC's santa-method. You didn't write the notes, so your job is to verify them against the original source, not to agree with them.

**Original:** `/tmp/claude-0/-home-user-UpAstra/c8a97aa2-c81c-52c3-a0df-9bba50d7f6fe/scratchpad/hypit` (commit `dc2b7a8f31b1ef1443a79ca448548d69e3ceb6a0`). Read-only; don't run anything from it.

## Method
1. Read the batch notes fully.
2. For **every** `path:line` citation, open that location in the original and check the claim:
   - the code exists;
   - it does what the note says;
   - the numbers (thresholds, defaults, counts) match.
   Check the "Our app" comparisons against `/home/user/UpAstra/clipper` too.
3. Check coverage: list every source file in the batch's packages (`src/**`) and confirm the coverage table includes each one with a correct line count (`wc -l`). Add any missing file, and read it enough to summarise it.
4. Edit the notes file in place:
   - Correct wrong claims: fix the text and append ` *(corrected in check)*`.
   - Remove claims you can't substantiate, or mark them `*(unverified)*`.
   - Add notable omissions you find (cited).
5. At the end of the file, add a `## Check` section with:
   - totals: claims checked, confirmed, corrected, removed or unverified;
   - files added to coverage;
   - a verdict: `Verified ✅` if under 10% of claims needed a correction and coverage is complete; otherwise `Verified with corrections ⚠️` and the main issues.

Only edit that one notes file.
