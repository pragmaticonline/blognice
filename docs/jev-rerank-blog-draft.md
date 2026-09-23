# Jev rerank: a cautious second opinion for code search

**Public author:** The Dev Team
**Topics:** ai, code-search, developer-tools, calibration, blognice
**Status:** Draft — live but unpublished, awaiting human approval to publish
**Live draft:** `POST 346` `jev-rerank-a-cautious-second-opinion-for-code-search` on `development` (`7b4d5e271c6e45e6`) — `published:false`, featured image `8/1790136460438-5ac4979e-ai.jpg`, audio `/media/8/1790136487742-b2954bfc-tts.wav` (9/9 segments complete)
**Related commits:** `f3dde64` (script added), `1717614` (pinned model, trust floor, shortlist evidence)
**Verified against:** `scripts/rerank.mjs:14-16,55-59`, `test/rerank.test.mjs:66-75`, live eval 2026-09-23 (see Verification)
**Bob AI review:** NEEDS CHANGES (2026-09-23, 6 findings, all applied) → re-review PASS (2026-09-23)

## Draft body (body_md — title not repeated)

Finding the right file is the slowest part of working in an unfamiliar codebase. Text search returns every file that mentions a keyword, including changelogs, stylesheets, and passing mentions. We wanted a cheap second opinion on ordering: given a shortlist of candidates from grep, which file actually answers the question?

The current answer is a small script, `scripts/rerank.mjs`. It sends the query and a short list of candidates to Jev in one batched request (four in this eval; the script itself enforces no input cap). Each candidate carries its path, a short excerpt, and the evidence that shortlisted it — the grep hit or import edge — rather than a summary written by the searcher. Jev returns a relevance probability per candidate, the script sorts by it, and only the winners get opened. Latency and token usage go to stderr; the API key never gets printed. Note: each excerpt and path is POSTed to the external TypeSafe endpoint (`API_URL` in `scripts/rerank.mjs:14`), so do not send secrets or customer data as snippets — the script keeps the key out of logs but cannot un-send the excerpts.

Two decisions hardened the script in commit `1717614`. First, the model is pinned to `jev-1.13.0`, never `jev-latest`, because aliases move and an eval should mean the same thing next month. Second, a trust floor of 0.5 top probability gates the ranking. Below the floor the ordering is treated as a suggestion to ignore: fall back to grep instead of opening the so-called winner. Confidence is not permission.

The floor has already earned its place in both directions. In an earlier triage session the ranking came back correctly ordered but under-confident, with the top candidate around 0.37–0.41 (prior session observation, not re-measured here). The floor rejected it, and grep did the job instead. No time saved, but no wrong file opened either — the system working as designed.

A fresh eval for this post landed on the other side. Asked "where are comment votes counted for the metrics dashboard?", with four candidates (the metrics SQL, the vote endpoint, button CSS, and an unrelated domain client as control), Jev returned the metrics file at 0.92 against 0.23, 0.07, and 0.02 — above the floor, with a clear margin, in 482 ms and about a thousand input tokens. That is the outcome the script exists for: one file opened instead of four.

So the appraisal is split, and honestly so. Jev is useful to us today as a suggestion engine, not a decider. In the single live eval behind this post (plus stubbed unit fixtures), ordering was correct; calibration varied by query — which is exactly what the floor is for. Keeping it pre-open triage only is the right call until we have a dozen logged queries with rank, probability, and whether the top hit was actually right, which does not exist yet. Then we can decide whether 0.5 stays or a relative-margin rule fits better.

Small model, small script, honest calibration. That is the whole story so far.

## Featured image

**Prompt (16:9, no text/logos/watermarks):** quiet editorial photograph of a developer workspace seen from above — a short printed list of four file cards fanned out, the top card subtly lifted and catching warm light, soft neutral desk background, muted palette, shallow depth of field, no text, no logos, no watermarks.

**Generation:** via `POST /api/v1/blogs/:blogId/images/generations` (`editorial-photo`), job `13bc3726-84b2-45e8-a904-834a672062d0` → `complete`, key `8/1790136460438-5ac4979e-ai.jpg` (`/media/8/1790136460438-5ac4979e-ai.jpg`), attached via `PATCH /posts/346`. Downloaded and checked: 1024×576 exact 16:9, viewed — blank fanned cards, no text/logos/watermarks. `brief_fallback:true` in the job response (meaning unknown, kept as observed).

## Audio

Narration via `POST /api/v1/blogs/:blogId/posts/346/audio/generations`, job `daf8f81e-659b-4656-b188-bc7a521d5a0b` → `complete`, 9/9 segments, `/media/8/1790136487742-b2954bfc-tts.wav`. TTS pipeline healthy (no melotts incident this run). Technical terms to watch ("Jev", "rerank", "calibration", "TypeSafe"): pronunciation NOT verified — no playback capability in this session, stated as unknown rather than accepted.

## Verification

- Code: `scripts/rerank.mjs:14-17` (`MODEL = "jev-1.13.0"`, `TRUST_FLOOR = 0.5`), `:55-59` (`assessRanking`), `test/rerank.test.mjs:66-75` (floor test with 0.46/0.41 fixture)
- Commits: `f3dde64` "Add Jev rerank script to triage codebase search candidates", `1717614` "Rerank: pinned model, trust floor, shortlist evidence"
- Live eval 2026-09-23: query "where are comment votes counted for the metrics dashboard?", 4 candidates, `model jev-1.13.0 scored 4 candidates in 482ms, usage: {"input_tokens":999,"output_tokens":76}`, ranked p = 0.92 / 0.23 / 0.07 / 0.02, verdict trustworthy (no untrusted-ranking warning on stderr). Ranked output in `/tmp/jev-eval-stdout.txt`, candidates in `/tmp/jev-eval-candidates.json`, stderr (latency/usage/model line) in `/tmp/jev-eval-stderr.txt`
- Prior under-confident eval (top ~0.37–0.41, correctly rejected): prior session observation, not re-measured in this session — described as such in the body, no invented log
- No widths, timings (other than the logged 482 ms), costs, or user-impact numbers beyond the above

## Publication checklist

- [x] Title not duplicated in body
- [x] Author intentional: The Dev Team
- [x] No secrets, API keys, private emails, or customer data included
- [x] Claims supported by code/commits/live eval or labelled as observation/opinion
- [x] Featured image present, 16:9, no generated text — 1024×576, visually checked
- [x] Audio complete (9/9 segments) — pronunciation NOT tested (no playback; unknown, not claimed)
- [ ] Pronunciation check + human approval received before publishing — pending
- [x] Topics relevant and ≤5
- [x] Bob AI review complete — NEEDS CHANGES, findings 1–6 applied above; re-review pending
- [x] Bob AI re-review PASS on the fixed draft
- [ ] Human approval received before publishing — pending (do not publish without it)
- [x] Draft created via Blognice API and kept unpublished (`published:false`, POST 346)

## Working notes

- Python `urllib` default UA gets Cloudflare 1010 on `www.blognice.com`; browser UA passes. `curl` worked throughout.
- API bug found live, fixed after publish: tagless `PATCH /posts/:id` 400d on tagged posts (`src/index.ts:1890-1892`). Fix keeps stored JSON-array tags via `storedPostTags` (test: `test/api-post-metadata.test.mjs`, red→green). Publish used the explicit-tags workaround.

## Next steps (workflow order)

API paths per `docs/API.md:104-125` (workflow intention; behavior as documented, not re-verified in this review).

1. Set `API_TOKEN`, resolve `development.blognice.com` `public_id` via `GET /api/v1/blogs`
2. `POST /api/v1/blogs/:blogId/posts` with `{title, body_md:<above>, published:false}` — keep unpublished
3. `POST /images/generations` 16:9 with prompt above, then `POST /posts/:id/audio/generations` with pronunciation checks
4. Run Bob AI handoff with `scripts/rerank.mjs`, `test/rerank.test.mjs`, commits `f3dde64`/`1717614`, live eval logs + this draft
5. Resolve findings, re-check checklist, obtain explicit human approval, then publish once
