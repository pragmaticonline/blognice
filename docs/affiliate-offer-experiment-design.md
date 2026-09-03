# Affiliate offer funnel experiment design

Status: implemented behind an off-by-default production switch; activation prerequisites remain open

## Objective

Determine whether a shorter, value-led affiliate offer produces more first paid Blognice subscriptions than the current full-page offer, without changing the referral discount, founding prices, eligibility rules, or checkout behavior.

The primary question is not which page attracts more clicks. It is which presentation produces more provider-confirmed paid accounts per eligible referral journey.

## First experiment

Experiment key: `affiliate-offer-v1`

Allocation: 50% control, 50% variant.

Control:

- The current `/affiliate-offer` page.
- Headline: “Save 10% for your first 12 paid months.”
- The current homepage-derived feature, comparison, example, pricing, open-source, and FAQ sections.

Variant:

- A shorter offer page led by “Save 10% and lock in $36/year.”
- One primary CTA above the fold: “Claim 10% and lock in $36/year.”
- The founding-member value comparison appears immediately below the hero: $36/year now, planned $119/year standard price, and the planned first-1,000-paying-members cutoff.
- Retain concise trust, included-features, pricing, continuity, and FAQ content; omit the long product-tour sections.
- Preserve the same signup destination, 10% referral benefit, $36/year and $5/month live prices, $119/year and $12.99/month planned prices, and subscription-continuity promise.

Changing several layout elements is deliberate: this experiment tests a focused sales funnel against the editorial product page, not an isolated headline color or word.

## Canonical funnel

```text
valid referral link
  → Experiment Assignment
  → Experiment Exposure
  → CTA click
  → account signup
  → checkout start
  → provider-confirmed first payment
  → Experiment Conversion
```

An Experiment Conversion is the first confirmed paid activation, not a signup, Checkout Session creation, webhook delivery, invoice retry, or renewal.

## Assignment and continuity

- Only a visitor with a valid, active Affiliate referral is eligible.
- Assignment happens before the first `/affiliate-offer` response and is immutable for that referral journey.
- Extend the signed `bn_ref` referral payload with an opaque random journey ID, experiment key, and variant. Do not add a second experiment cookie.
- New assignments use cryptographically secure randomness and a 50/50 split. Affiliate identity, country, device, and arrival time must not influence the variant.
- Existing valid referral cookies without experiment fields remain valid. On the first eligible offer request after activation, upgrade the cookie payload and assign a variant.
- Repeated visits, refreshes, signup validation failures, and login transitions retain the same assignment.
- Referral replacement remains impossible under the existing Attribution rules; an experiment must not weaken or extend referral eligibility.
- At signup, associate the Experiment Assignment with the new account in the same durable workflow that captures Attribution. The account association cannot later move to another assignment or variant.
- Checkout snapshots the experiment key and variant alongside the existing affiliate checkout metadata. Stripe and NOWPayments adapters carry this context without treating provider metadata as the source of truth.

## Persistence

D1 is authoritative for unique exposures and paid conversions.

### `funnel_experiments`

- `experiment_key` primary key
- `status`: `draft`, `running`, `paused`, or `completed`
- `control_variant`, `allocation_basis_points`
- `started_at`, `stopped_at`, `created_at`
- immutable presentation-version identifiers for both variants

Only one experiment may be running for the affiliate offer route. Presentation versions cannot be edited after the first exposure; a material change requires a new experiment key.

### `funnel_experiment_assignments`

- opaque random `journey_id` primary key
- `experiment_key`, `variant`
- Affiliate Profile ID and referral policy version
- `assigned_at`, first `exposed_at`, first `cta_clicked_at`
- nullable unique `account_id`, `signup_at`, `checkout_started_at`

Store no IP address, user agent, email address, Stripe customer ID, or raw referral-cookie value. One journey has at most one assignment and one account has at most one assignment for an experiment.

### `funnel_experiment_conversions`

- `experiment_key`, `account_id` unique together
- assignment journey ID and variant
- normalized provider and authoritative Revenue Occurrence or payment reference
- `converted_at`, cadence, and collected eligible amount in integer minor units

The insert is idempotent. Duplicate or out-of-order webhooks cannot create another Experiment Conversion. Refunds remain financial adjustments in the affiliate ledger; they do not erase the historical first-payment conversion. Revenue reporting may separately show net collected revenue.

## Events and measurement

Extend `AFFILIATE_EVENTS` with consent-aware trend events:

- `affiliate_offer_exposure`
- `affiliate_offer_cta`
- `affiliate_checkout_start`
- existing `affiliate_signup`
- existing `affiliate_conversion`

Include experiment key and variant in bounded Analytics Engine blob fields. Do not include journey ID or account identity. Queries must use `_sample_interval` because Analytics Engine can sample.

D1 supplies exact experiment totals. Analytics Engine supplies fast daily trends and Affiliate-level aggregate reporting. The staff results page must label Analytics Engine trends approximate and D1 totals exact.

The primary metric is:

```text
unique Experiment Conversions / unique Experiment Exposures
```

Secondary metrics are CTA clicks, completed signups, checkout starts, paid conversion by annual/monthly cadence, and collected revenue per exposure. The dashboard must show raw denominators; percentages alone are insufficient.

## CTA measurement

Do not rely on browser JavaScript. Point experiment CTAs at a same-origin Worker endpoint that atomically records the assignment's first click and redirects to `/signup`. This works with script blocking and prevents repeated clicks from inflating the unique-click count.

## Privacy and abuse boundaries

- The experiment reuses the referral journey already required to deliver the requested affiliate offer; it does not create cross-site tracking.
- D1 stores an opaque journey identifier and operational funnel state only.
- Consent rules continue to govern Analytics Engine writes. Exact operational assignment and conversion records must be added to the privacy/retention review before activation.
- Bots, staff smoke tests, preview overrides, invalid referral codes, and direct unauthenticated visits to `/affiliate-offer` are excluded from experiment results.
- Rate limiting and bot classification may flag a journey, but historical rows are retained with an exclusion reason rather than deleted.
- Affiliates cannot select a variant or receive customer-level experiment data.

## Decision rule

Before activation, record a frozen baseline paid-conversion estimate and choose the minimum detectable relative uplift. Use those values to calculate and store the required sample per variant; do not choose a sample target after observing results.

The staff dashboard may declare a winner only when all are true:

- the precomputed sample target is met in both variants;
- the experiment has run for at least 14 complete UTC days and two full weekly cycles;
- a two-sided 95% confidence interval for the difference in paid-conversion rates excludes zero;
- no material difference exists in payment failures, refunds, abuse exclusions, or Affiliate mix that invalidates the comparison.

Stop after 42 days if the target is not reached and report the result as inconclusive. Do not repeatedly inspect significance and stop early. A P0/P1 defect, incorrect price, broken attribution, or checkout regression permits an operational abort; that is not a winning result.

## Controls and staff reporting

Production configuration exposes `AFFILIATE_OFFER_EXPERIMENT=off|affiliate-offer-v1`. Missing, unknown, or malformed configuration fails to control.

- `off`: render the current control and create no new assignments.
- experiment key: use the matching immutable experiment definition.
- pausing stops new assignments and sends unassigned journeys to control; existing assignments remain stable and measurable.
- completing preserves all existing assignments and results while sending new journeys to the selected permanent presentation.

Add a Cloudflare Access-protected staff page at `/staff/experiments/affiliate-offer` showing status, dates, exact D1 funnel totals, approximate daily trends, conversion intervals, cadence, revenue, exclusion counts, and the configured stopping target. No public or Affiliate dashboard should expose global experiment results.

## Why not Workers gradual deployments

Workers gradual deployments are a release-safety mechanism. Even with version affinity, using Worker versions as experiment variants would couple marketing assignment to application deployment, complicate signup/payment attribution, and introduce version skew across unrelated routes. Keep gradual deployments for canaries and rollbacks; render both experiment variants from one tested Worker version.

## Implementation slices

1. Domain and migration: experiment definitions, assignments, conversions, uniqueness constraints, and retention/exclusion fields.
2. Assignment seam: backward-compatible referral-cookie payload upgrade and immutable 50/50 assignment.
3. Rendering seam: extract the current offer renderer, add the focused variant, exact CTA copy, and safe control fallback.
4. Funnel persistence: exposure, server-side CTA redirect, signup association, and checkout-start snapshot.
5. Conversion seam: idempotent Stripe and NOWPayments first-payment recording linked to authoritative provider facts.
6. Analytics: consent-aware variant events and sampling-aware daily queries.
7. Staff UI: experiment controls, exact funnel table, trend chart, confidence interval, and explicit inconclusive states.
8. Rollout: preview fixtures, a separate A/A verification run, production flag off, smoke test, then a fresh frozen 50/50 experiment start.

## Required validation

- Cookie signing, tamper rejection, key rotation, legacy payload upgrade, expiry, and variant stability.
- Concurrent first exposure creates one assignment.
- Refreshes and repeated CTA clicks do not inflate unique counts.
- Signup validation errors and session creation preserve the variant.
- Attribution and Experiment Assignment cannot be replaced or crossed between accounts.
- Checkout metadata agrees with D1 but cannot overwrite it.
- Stripe and NOWPayments duplicate, delayed, refunded, and out-of-order events create exactly one conversion.
- Direct offer access, invalid referrals, bots, staff previews, and disabled configuration are excluded.
- Control and variant have identical prices, discounts, subscription rules, canonical/noindex behavior, and signup destination.
- Desktop, 390px mobile, keyboard focus, reduced motion, no-JavaScript CTA, back/forward, and refresh flows pass browser review.
- Full test suite, typecheck, both Worker dry-runs, Bruv, Stickler, and a production smoke test pass before activation.

## Activation prerequisites

- Approve the variant copy and rendered design.
- Complete privacy and retention review for exact journey-level D1 records.
- Measure and freeze baseline conversion, minimum detectable uplift, sample target, and experiment dates.
- Build and verify the staff results page before assigning production traffic.
- Keep the production flag `off` until A/A validation proves stable assignment and end-to-end payment attribution.

## Implementation status — 2026-09-03

Slices 1–8 are implemented, deployed, and verified dormant. Migration 054 creates the exact assignment and conversion stores and seeds `affiliate-offer-v1` as `draft`; migration 055 makes exposed presentations immutable and snapshots experiment context into both provider checkout records. The main and staff Worker configurations both remain `AFFILIATE_OFFER_EXPERIMENT=off`, so deployment does not assign traffic.

The automated A/A allocation fixture verifies an exact 5,000/5,000 split over all 10,000 allocation buckets. Provider-seam tests cover Stripe and delayed/duplicate NOWPayments facts. The staff page is available at `/staff/experiments/affiliate-offer` behind Cloudflare Access and labels D1 totals exact and Analytics Engine trends approximate.

Activation is intentionally a later operational decision. Before changing the flag, an authorized owner must approve the copy and privacy/retention treatment, freeze the baseline, detectable uplift, sample target and dates in D1, verify staff Analytics Engine credentials, and run a live payment-attribution canary. Deployment of the dormant implementation is not activation.
