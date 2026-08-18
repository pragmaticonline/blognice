# Development blog writing workflow

Use this handoff when preparing a post for `development.blognice.com`. The
workflow is deliberately human-approved: drafting, image generation, audio, and
reviews may be automated, but publication requires an explicit final approval.

## Writer brief

```text
Write a development-blog post for development.blognice.com.

Topic: [INSERT TOPIC]

Explain the decision, implementation, trade-offs, failures, and fixes in a
technically honest way that a non-specialist can follow. Do not repeat the
title in the body. Do not invent measurements, deployments, reviews, or user
impact; mark anything unverified as unknown.

Use the Blognice API rather than direct database writes. Create the draft first
and keep it unpublished until review is complete. Add up to five relevant blog
topics/hashtags. Generate a 16:9 featured image through the Blognice image API,
with no visible text, logos, or watermarks. Generate narration through the
audio API and check technical pronunciations before accepting it.

Ask BIG AI to review the technical accuracy and ask Zuck to perform an
independent QA review. Resolve disagreements explicitly. Publish only after
both reviews pass and a human gives final approval.

Use `The Dev Team` as the public author unless a specific contributor is being
credited. Mention AI, BIG AI, Zuck, Steve, Saul, or Tackleberry only when their
contribution is relevant to the post.
```

## BIG AI technical-review handoff

Give BIG AI the draft, the relevant source files, and the test/deployment
evidence. Use this brief:

```text
You are BIG AI, the senior technical reviewer for Blognice.

Review this development-blog draft against the supplied code and evidence.
Check factual accuracy, security wording, tenant isolation, API behavior,
Cloudflare runtime claims, billing/email claims, and whether the post implies
work that was not actually completed. Look for duplicated titles, missing
qualifications, private data, and claims that need a source or test.

Return:
- PASS or NEEDS CHANGES
- findings ordered by severity
- the exact sentence or claim affected
- the evidence supporting your finding
- a concrete correction or missing test

Do not silently rewrite the draft. Do not approve a claim merely because it
sounds plausible; distinguish verified facts, reasonable inference, and opinion.
```

BIG AI reviews technical truth first. Zuck then provides an independent,
read-only QA review rather than acting as BIG AI's replacement.

## Reviewer lifecycle and evidence rules

Agent capacity is shared across the session. A completed reviewer can continue
to count against the concurrency limit until it is explicitly closed, so close
each finished agent as soon as its report has been recorded.

Treat orchestration failures separately from review findings:

- `PASS` or `NEEDS CHANGES` is a review result only when the agent returned a
  report for the requested context.
- A spawn, timeout, or capacity failure means the review is incomplete; close
  finished agents and retry rather than inferring approval.
- Never describe a reviewer as having reviewed a change when no report was
  returned. Distinguish an agent finding from a bridge or context limitation.
- For multipart reviews, record the packet list, packet failures, synthesis
  result, and whether the final verdict was complete or provisional.

## Required sequence

1. Confirm the topic, scope, and intended public author.
2. Gather verified facts from the code, tests, deployment logs, and relevant
   support responses. Do not include secrets or private customer data.
3. Create a draft through the account API.
4. Add topics/tags and generate a 16:9 featured image.
5. Request narration and check the resulting audio job until it completes.
6. Ask BIG AI for a technical review.
7. Ask Zuck through the read-only QA bridge, for example:

   ```powershell
   npm run qa:zuck -- --prompt "Review this development-blog draft for factual accuracy, unsupported claims, security disclosures, and missing tests." --file src/index.ts --file src/metrics.ts
   ```

8. Save the returned reports in the working notes, then close each completed
   reviewer thread before starting another review or huddle.
9. If an agent cannot be spawned or does not return a report, record the review
   as incomplete; close stale completed threads and retry rather than inferring
   approval.
10. Apply or reject findings based on evidence. Record any rejected finding in
   the working notes.
11. Confirm the title appears only in the title field, the image exists, audio
   completed, topics are present, and the post is still a draft.
12. Obtain explicit human approval, then publish once.

## Publication checklist

- [ ] Title is not duplicated in the body.
- [ ] Public author is intentional; otherwise use `The Dev Team`.
- [ ] No secrets, API keys, private emails, or customer data are included.
- [ ] Claims are supported by code, tests, logs, or clearly labelled as opinion.
- [ ] Featured image is present, 16:9, and contains no generated text.
- [ ] Audio is complete and technical terms have been pronunciation-tested.
- [ ] Topics/tags are relevant and within the platform limit.
- [ ] BIG AI review is complete.
- [ ] Zuck QA report is `PASS` or all findings are resolved.
- [ ] Human approval was received before publishing.

## Reusable UI patterns (learned 2026-08-18)

**Responsive disclosure without re-measuring the grid:**
- Desktop: wrapper `display: contents` + `panel[hidden] { display: contents !important; }` so hidden overflow does not inflate `grid-template-columns: 1fr + 2.5rem` (`src/render.ts:485-487`). All items remain visible in the vertical column.
- Mobile `@640px`: `more { display:inline-flex }`, `wrap/panel { display:flex; flex-direction:row; flex-wrap:wrap }`, `panel[hidden] { display:none !important }`. Toggle via `data-share-more`/`data-share-panel`, `aria-expanded`, `blur()` + outside-click/Escape (`src/render.ts:906-915`, `src/admin.ts:842-905`).
- See `Eight buttons, two viewports, one grid` (`POST 63`, `482cbfb`/`a6d2fab`/`91459cf`) and `feat(metrics): tooltip per day bar... (#109)`.

**Long tables / lists:**
- Cap at 10 visible rows, overflow in `metrics-more-panel[hidden]` (`LIMIT 50/25` in `src/metrics.ts:126-132`), `Show X more` / `Hide` button (`data-metrics-more`). Reuses the same disclosure, no nested scroll.

**Tooltips:**
- Bar `data-tooltip` + `aria-label` + `tabindex=0` with `::after` pill (`src/admin.ts:265-268`), same token as `.share-button::after`. Keep native `title` only as fallback or remove to avoid duplicate.
