# Blognice

Blognice is a multi-blog publishing platform in which accounts own billing and may participate in referral-based promotion.

## Affiliate program

**Affiliate Profile**:
The account-level enrollment that allows a verified Blognice account to promote Blognice under accepted Affiliate Terms.
_Avoid_: Affiliate account, partner account

**Affiliate**:
A Blognice account with an active Affiliate Profile. Paid Blognice membership is not required.
_Avoid_: Partner, publisher affiliate

**Referral Code**:
The unique, case-insensitive code identifying an Affiliate in referral links and customer discount entry.
_Avoid_: Coupon code, promo ID

**Attribution Opportunity**:
The period in which an unpaid, unattributed account may be associated with an Affiliate; it closes permanently at the account's first eligible payment.
_Avoid_: Open referral, pending affiliate

**Attribution**:
The immutable association between a referred Blognice account and the Affiliate credited for it.
_Avoid_: Lead ownership, referral claim

**Eligible Revenue**:
Collected Blognice subscription revenue from qualifying plan charges after discounts, taxes, refunds, and credits, but before payment-processing fees.
_Avoid_: Gross revenue, invoice total

**Revenue Occurrence**:
A unique, provider-confirmed qualifying charge or adjustment from which an Affiliate commission can be determined.
_Avoid_: Webhook event, transaction

**Commission Entry**:
An immutable signed amount recording earned commission or an adjustment to it.
_Avoid_: Balance update, commission status

**Available Commission**:
Commission whose maturation time has passed and which is not reserved or already allocated to a payout.
_Avoid_: Approved commission, cleared earnings

**Payout**:
A reviewed allocation of available Commission Entries for external payment to an Affiliate.
_Avoid_: Withdrawal, transfer

## Funnel experiments

**Funnel Experiment**:
A versioned, time-bounded comparison of approved sales-funnel presentations that preserves the same underlying product, price, and referral terms.
_Avoid_: Gradual deployment, split release

**Experiment Assignment**:
The immutable association of one eligible referral journey with one Funnel Experiment variant.
_Avoid_: Cohort, traffic split

**Experiment Exposure**:
The first successful rendering of the assigned variant during an eligible referral journey.
_Avoid_: Page view, impression

**Experiment Conversion**:
The first provider-confirmed paid Blognice subscription for an account associated with an Experiment Assignment.
_Avoid_: CTA click, signup, checkout

## Affiliate rollout handoff — 2026-09-02

The accepted affiliate specification is implemented and deployed. Do not repeat migration 053.

Production state:

- D1 migration `053-affiliate-program.sql` was applied directly because the remote `d1_migrations` ledger is empty and Wrangler incorrectly lists the entire migration history as pending.
- Pre-migration D1 Time Travel bookmark: `00001809-00000000-000050da-3c5b6149b3c9987c569cd417a98af9ba`.
- Migration verification found 21 affiliate tables, all expected indexes, six existing paid/crypto accounts backfilled as referral-ineligible, and no foreign-key violations.
- Main Worker, including the affiliate UI redesign, was deployed successfully as version `8e6f5bf6-18b8-4791-896b-9f86647e4a3c`.
- Staff Worker affiliate implementation is deployed behind Cloudflare Access. Its live Stripe secret is configured.
- Affiliate enrollment is activated with terms/policy version `affiliate-1` and terms URL `https://www.blognice.com/affiliate-terms`.
- Approved terms source: `AFFILIATE_TERMS.md`; publication source: `affiliate-terms.html`.
- Exact approved production response digest: `sha256:1014af2de33b2d73d9b7f27b93ab3ee7d68479e2bacc9999ac2d4b71788d0e61`.
- Stripe live coupon `blognice-affiliate-10-12m` is valid: 10% off, repeating for 12 months.
- Existing Stripe platform webhook retains subscription events and now includes `invoice.paid`, refunds, credit notes, and dispute events.
- Dedicated Stripe Connect endpoint `we_1UBEP0AqOquRLVdtSKAbacaL` sends `account.updated`; its distinct signing secret is installed as `STRIPE_CONNECT_WEBHOOK_SECRET`.
- Stripe Connect is limited consistently to `US,CA,GB,TH`.
- `blognice-push` and `blognice-indexnow` each retain one active `blognice` consumer with batch size 10 and five retries. Wrangler repeatedly returned code 10013 while refreshing those two existing consumer triggers, but direct Cloudflare API inspection confirmed they remain present.
- Production smoke checks: homepage 200, admin redirects to login, Affiliate Terms 200 with matching digest, policy navigation links Affiliate Terms, unsigned Stripe/NOWPayments callbacks return 400, and staff redirects through Cloudflare Access.

Validation before rollout:

- Full `tsx` suite: 330/330 passing before the legal-page addition.
- Focused Stripe/index suite after distinct Connect-secret support: 26/26 passing.
- Legal-page suite after Affiliate Terms publication: 7/7 passing.
- Typecheck, `git diff --check`, main dry-run, and staff dry-run passed.
- Stickler recheck: zero P0/P1/P2 test gaps; report at `/tmp/stickler-report.md` (temporary and may not survive a new environment).
- BIG review previously returned PASS.

Security follow-up:

- The Cloudflare API token and Stripe live secret were pasted into chat. Rotate both immediately, then update the corresponding Worker secrets. Never copy their values into this file or any repository file.

Working-tree state:

- The affiliate implementation, migration, docs, terms, tests, and configuration remain uncommitted. Preserve all current changes; do not reset or overwrite them.
- No git commit was created during implementation or deployment.

Completed slice — affiliate UI redesign:

- Completed and deployed on 2026-09-03: authenticated account shell, explicit Billing/Affiliate navigation, enrollment facts/card layout, accessible referral copy control, KPI cards, humanized statuses, four-country selector, payout setup/history cards, responsive rules, and consistent secondary buttons.
- Validation: authenticated production HTTP seam passes, full suite 332/332, typecheck, `git diff --check`, production dry-run, Bruv review with no P0/P1, and Stickler recheck with zero gaps.
- Bruv report: `/tmp/bruv-report.md`; Stickler report: `/tmp/stickler-report.md` (temporary paths may not survive a new environment).
- Remaining optional P2: add a dashboard backlink to Affiliate Terms only as a newly approved terms version because changing published legal bytes invalidates the current `affiliate-1` digest.

- Steeve's review identified that `/admin/affiliate` felt visually detached because `affiliateDashboardPage` called `shell(...)` without the authenticated `account`, omitting the normal admin shell/navigation.
- Both enrollment and dashboard states now pass `account` into the shared shell, with explicit Billing/Affiliate account navigation.
- The raw sequential markup was replaced with status/action banners, a referral-code/link card with accessible Copy feedback, responsive KPI cards, a Stripe payout-setup card, a four-country `<select>`, human-readable status badges, and responsive payout history/empty states.
- Enrollment now uses a responsive value-proposition plus enrollment-card layout showing 50% commission, 10% customer discount for 12 paid service months, 60-day maturation, and the US$100 threshold.
- Reuse the established admin shell and Billing page visual language; remove inline styles and retain keyboard focus, mobile behavior, `aria-live` copy feedback, alert semantics, and 44px touch targets.
- Keep Affiliate Terms as a legal-document surface; optional improvements are a table of contents, print styles, and a backlink to the affiliate dashboard.

## Affiliate offer experiment handoff — 2026-09-03

- The complete experiment implementation is in migration `054-affiliate-offer-experiments.sql`, `src/funnel-experiment.ts`, `src/funnel-experiment-report.ts`, the signed referral-cookie extension, main Worker funnel routes, Analytics Engine fields/queries, and the Access-protected staff page at `/staff/experiments/affiliate-offer`.
- Both production configurations explicitly keep `AFFILIATE_OFFER_EXPERIMENT=off`. Do not turn it on merely because the dormant code is deployed.
- Migration 054 seeds `affiliate-offer-v1` in `draft`; activation must freeze the baseline, MDE, sample target, and dates, change D1 status to `running`, then change the main Worker flag in a controlled release.
- Exact conversions come only from normalized provider-confirmed Affiliate Revenue Occurrences after checkout. Stripe and NOWPayments retries are idempotent; Analytics Engine events are consent-aware approximate trends only.
- Release validation: 347/347 full tests, focused A/A, bot exclusion, lifecycle, checkout snapshot, and delayed-provider coverage, typecheck, diff check, both Worker dry-runs, production deployment, Bruv, Stickler, and dormant-route smoke checks passed.
- Migration 054 was applied to production through guarded workflow run `33777930984`. Pre-migration D1 Time Travel bookmark: `00001936-00000000-000050db-9af4501433f2dbff7e4026f6b4596919`. Verification found all three tables, four expected indexes, the 50/50 experiment in `draft`, and no foreign-key violations.
- Migration 055 hardens presentation immutability after exposure and adds D1/Stripe/NOWPayments checkout snapshots of experiment key and variant. Apply and verify it before considering activation.
- Staff Analytics Engine trends remain unavailable until `CF_ANALYTICS_TOKEN` is installed on the `blognice-staff` Worker. Exact D1 totals remain available; do not activate before this prerequisite is resolved and verified.
- Public HTTP coverage validates enrollment and active dashboard states. The complete suite passed 332/332; typecheck, diff check, and production dry-run passed.
- Bruv reported no P0/P1 issues and one intentionally deferred P2: adding a dashboard backlink to the approved Affiliate Terms would change its accepted digest and should wait for a new terms version. Stickler reported zero test gaps.
