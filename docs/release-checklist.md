# Blognice release checklist

Working release plan for taking Blognice from internal testing to a public
launch. This document records both the operational tasks and the reasoning
behind the release decisions.

## Current release position

- [ ] Define the release version and target launch date.
- [ ] Confirm the production branch is up to date and the working tree is clean.
- [ ] Decide which features are public-launch ready: browser push, narration,
      AI image generation, subscriptions, custom domains, and analytics.
- [ ] Keep unfinished features disabled or clearly marked as experimental.
- [ ] Record final BIG, Zuck, and Tackleberry review outcomes in the relevant
      working documents.

## Engineering and operations

- [ ] Run `npm run typecheck`.
- [ ] Run the complete test suite.
- [ ] Verify the production GitHub Actions deployment from the merge to `main`.
- [ ] Verify production migrations and migration tracking for every release
      migration; do not apply unrelated pending migrations blindly.
- [ ] Verify D1, R2, queues, scheduled tasks, and required Worker bindings.
- [ ] Verify production secrets are configured without recording their values.
- [ ] Verify health checks, error logging, audit logging, and rollback steps.
- [ ] Test signup, login, blog creation, post publication, image upload,
      narration, subscriptions, custom domains, and account recovery.
- [ ] Confirm generated media has a retention and cleanup policy.

## Browser push and narration

- [ ] Verify browser push opt-in, unsubscribe, permission-denied, and expired
      subscription behavior in supported browsers.
- [ ] Confirm new blogs default to the intended push setting and existing-blog
      migration state is documented.
- [ ] Verify push delivery retries, dead-letter handling, replay, quotas, and
      tenant isolation.
- [ ] Verify narration generation completes, serves valid audio, handles model
      failures, and records useful staff audit details.
- [ ] Generate and listen to narration for the launch content.

## Zuck bridge follow-up

- [ ] Start each review by checking for completed agent threads from earlier
      work; close them before spawning new reviewers.
- [ ] Close every completed BIG, Zuck, Tackleberry, or other review agent after
      its report has been copied into the relevant working document.
- [ ] Record capacity, spawn, timeout, and transport failures as incomplete
      reviews; never label them PASS, NEEDS CHANGES, or “reviewed.”
- [ ] Keep a review ledger with reviewer, scope, report status, timestamp, and
      whether the result is complete or provisional.
- [ ] Fix the remaining review-packet limitation: multiple complete ranges can
      still exceed the bridge's global context budget.
- [ ] Prefer automatic packet splitting by logical concern (for example:
      ingress, storage, queue processing, replay, client behavior, and tests).
- [ ] Require every packet to carry an explicit manifest of included and
      omitted files/ranges.
- [ ] Combine packet results only when every required packet is complete; keep
      incomplete reviews as `NEEDS CHANGES` or provisional.
- [ ] Preserve secret redaction, path canonicalization, symlink protection,
      malformed-response handling, and read-only guarantees.
- [ ] Have Zuck review the bridge change, then obtain an independent BIG review
      and a security review from Tackleberry.
- [ ] Do not treat a Zuck PASS as the sole merge or release authority.

## Legal, privacy, and trust

- [ ] Review Terms, Privacy, Cookies, AI-provider terms, and regional wording.
- [ ] Verify public legal links open anonymously from a clean browser session.
- [ ] Document what data is sent to external AI providers and the retention or
      review implications.
- [ ] Confirm analytics consent behavior for applicable regions.
- [ ] Confirm cookie/storage disclosures match actual browser storage, sessions,
      push subscriptions, and notification preferences.
- [ ] Review security contact, abuse reporting, account deletion, and data
      export/deletion procedures.

## Documentation and launch story

- [ ] Finish the public product overview and quick-start documentation.
- [ ] Explain the project's open-source methodology: decisions, trade-offs,
      review reports, tests, migrations, and operational lessons live alongside
      the implementation.
- [ ] Publish the browser-push article after its image and narration are
      verified.
- [ ] Prepare screenshots, a short product demo, and accessible image alt text.
- [ ] Prepare concise launch copy for the website, GitHub, email, and social
      channels.
- [ ] Credit contributors and review agents accurately, including the limits of
      AI-generated review.

## Product Hunt submission

- [ ] Create or confirm the Product Hunt maker account and project ownership.
- [ ] Choose the launch name, tagline, category, and one-sentence explanation.
- [ ] Prepare the Product Hunt description focused on the reader outcome:
      owning a fast, simple blog without assembling a large publishing stack.
- [ ] Prepare the first comment explaining the motivation, open-source approach,
      documented design reasoning, and what feedback would be most useful.
- [ ] Prepare a product URL, launch-day URL checks, logo, gallery images, and a
      short demo video or GIF.
- [ ] Confirm all screenshots and claims are current, accessible, and do not
      expose private data, API keys, internal tenant names, or test credentials.
- [ ] Schedule the launch for a day when the team can respond to comments.
- [ ] Coordinate an honest announcement to existing testers and the community;
      do not use misleading engagement or vote solicitation.
- [ ] Monitor comments, uptime, signup errors, queue health, and support load
      throughout launch day.
- [ ] Record Product Hunt feedback and convert actionable findings into GitHub
      issues or follow-up design documents.

## Press release and Redpress

- [ ] Decide whether Redpress is the distribution service and confirm the
      account, pricing, audience, submission requirements, and publication
      date.
- [ ] Draft the press release with a clear headline, launch date, product
      description, founder/project quote, open-source positioning, and contact
      details.
- [ ] Include the practical story behind Blognice: documented design choices,
      the read-only Zuck QA bridge, independent review, and the lessons from
      operating the project.
- [ ] Fact-check every claim, metric, model name, cost figure, customer quote,
      and feature description against the released product.
- [ ] Obtain final human approval for the release text, quoted names, links,
      screenshots, and any AI-provider references.
- [ ] Prepare the press kit: logo, product image, screenshots, founder bio,
      project URL, GitHub URL, and media contact email.
- [ ] Remove private tenant data, credentials, internal URLs, API keys, and
      unannounced roadmap items from all press materials.
- [ ] Submit or schedule the release through Redpress and confirm the final
      rendered copy and destination links before publication.
- [ ] Coordinate publication timing with the Product Hunt launch and direct
      announcements so the team can answer questions promptly.
- [ ] Track pickup, referral traffic, signups, and press questions; record
      corrections and follow-up opportunities in the release notes.

## Release gate

The release is ready only when:

1. Required automated tests and typecheck pass.
2. Production deployment and migrations are verified.
3. Critical user journeys work on a clean browser session.
4. No unresolved critical or high security/legal blocker remains.
5. The Zuck bridge review is complete-context or explicitly marked provisional,
   with BIG and Tackleberry review where appropriate.
6. Rollback, support, and incident contacts are known.
7. Product Hunt materials and launch claims match the released product.

## Post-release

- [ ] Watch errors, latency, queue retries, failed narration, push delivery, and
      signup conversion during the first 24 hours.
- [ ] Respond to support and Product Hunt feedback.
- [ ] Review costs and external AI usage separately from application errors.
- [ ] Hold a short retrospective and update this checklist with what changed.
