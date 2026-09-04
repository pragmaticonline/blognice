# Production operations

This is the canonical bootstrap and upgrade runbook for Blognice. Production
commands always include `--remote` where D1 state is involved and explicitly
name the relevant production configuration.

## Prerequisites

- Node.js 22 and dependencies installed with `npm ci`.
- Wrangler authenticated to the intended Cloudflare account.
- A Cloudflare zone and the Workers, D1, R2, Queues, Analytics Engine, Workers
  AI, and Cloudflare Access capabilities used by the configuration.
- `wrangler.production.jsonc` and `wrangler.staff.production.jsonc` copied from
  their tracked examples and populated with production identifiers.

## Fresh installation

1. Create the `blognice` and `blognice-posts` D1 databases and put their IDs in
   both production configurations where applicable.
2. Load `schema.sql` into `blognice` and `schema-posts.sql` into
   `blognice-posts`. A fresh installation does not replay migrations or load
   demo seeds.
3. Create the `blognice-media` and `blognice-metrics` R2 buckets.
4. Create `blognice-audio`, `blognice-email`, `blognice-email-dlq`,
   `blognice-push`, `blognice-push-dlq`, and `blognice-indexnow` queues. Keep
   their bindings aligned with `wrangler.production.example.jsonc`; the staff
   Worker is also an `EMAIL_QUEUE` producer.
5. Configure public and staff secrets independently, validate both bundles,
   deploy the public Worker, then deploy the staff Worker.
6. Verify public signup/login, one tenant page, a staff login through Access,
   and one job through each enabled queue before opening traffic.

The exact bootstrap commands are kept in the README beside the contributor
entry point.

## Existing installation migrations

Back up both D1 databases before any migration. Record applied filenames in the
change record for the deployment. Apply every outstanding portable schema
migration in the order shown below, exactly once:

| Database | Portable migrations, in order |
| --- | --- |
| INDEX (`blognice`) | `001-accounts-multiblog.sql`, `004-tenant-accent-color.sql`, `005-tenant-public-id.sql`, `006-collaborators.sql`, `007-tenant-favicon.sql`, `008-tenant-slug-aliases.sql`, `009-tenant-topics.sql`, `012-membership-display-name.sql`, `014-staff-administration.sql`, `015-subscription-management.sql`, `016-email-delivery-log.sql`, `017-stripe-billing.sql`, `018-password-reset.sql`, `019-password-resets.sql`, `020-ai-credits.sql`, `020-email-verification.sql`, `021-pronunciation-dictionary.sql`, `034-reliability.sql`, `035-billing-event-ordering.sql`, `036-ai-refund-atomicity.sql`, `037-billing-event-tiebreak.sql`, `038-checkout-subscription-ordering.sql`, `040-subscriber-double-opt-in.sql`, `041-nowpayments-crypto.sql`, `042-post-popularity.sql`, `043-tenant-footer-name.sql`, `044-tenant-social-links.sql`, `047-browser-push.sql`, `049-browser-push-owner-opt-in.sql`, `050-blog-navigation-links.sql`, `051-header-link.sql`, `052-staff-expansion.sql`, `053-affiliate-program.sql`, `054-affiliate-offer-experiments.sql`, `055-affiliate-experiment-hardening.sql`, `057-vip-status.sql` |
| POSTS (`blognice-posts`) | `002-post-featured-image.sql`, `003-post-audio.sql`, `006-post-authorship.sql`, `010-post-tags.sql`, `011-post-author-name.sql`, `013-post-author-visibility.sql`, `039-post-notification-once.sql`, `045-pages.sql`, `046-audio-generation-guard.sql`, `048-post-browser-push.sql`, `056-post-meta-description.sql` |

Use these command forms, replacing the filename with each outstanding entry:

```sh
npx wrangler d1 execute blognice --remote --file=./migrations/FILENAME.sql --config wrangler.production.jsonc
npx wrangler d1 execute blognice-posts --remote --file=./migrations/FILENAME.sql --config wrangler.production.jsonc
```

The following files are Blognice-instance content and pronunciation history,
not portable schema upgrades. Review them individually before use elsewhere:

| Database | Instance-specific migrations, in order |
| --- | --- |
| INDEX (`blognice`) | `023-development-topics.sql`, `026-technical-pronunciations.sql`, `028-ai-pronunciation.sql`, `029-ai-phonetic-pronunciation.sql`, `030-ai-letter-pause.sql`, `031-ai-tested-pronunciation.sql`, `032-calmer-pronunciation.sql`, `033-aiye-eye-pronunciation.sql` |
| POSTS (`blognice-posts`) | `022-development-inaugural-posts.sql`, `024-development-post-attribution.sql`, `025-fix-development-post-markdown.sql`, `027-development-authors-post.sql` |

Migration 053 introduces the affiliate
program; 054 and 055 introduce and harden its offer experiment. The manually
dispatched affiliate workflow applies only that affiliate sequence and is not a
general migration runner.

After migration, run both deployment dry runs and smoke-test the journeys that
touch changed tables. Do not deploy code that expects an unapplied schema.

## Configuration and secrets

Configuration values belong in the ignored production JSONC files. Secret
values are entered interactively with `wrangler secret put NAME --config
CONFIG`; never place them in tracked files.

Public Worker secrets, set with `--config wrangler.production.jsonc`:

| Secret | Enables |
| --- | --- |
| `API_TOKEN` | Platform automation API |
| `CF_API_TOKEN` | Cloudflare for SaaS custom hostnames |
| `CF_ANALYTICS_TOKEN` | Analytics Engine reporting queries |
| `MAILNICE_API_KEY` or `RESEND_API_KEY` | Verification and transactional email |
| `MAILNICE_WEBHOOK_SECRET` | MailNice/Postal bounce/complaint/open/click webhook verification (optional, enables `email_bounced`/`email_complained` Analytics) |
| `STRIPE_SECRET_KEY` | Stripe Checkout, Portal, and Connect API calls |
| `STRIPE_WEBHOOK_SECRET` | Platform Stripe webhook verification |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | Connected-account webhook verification |
| `AFFILIATE_REFERRAL_COOKIE_SECRETS` | Signed referral cookie; current key first, retained rotation keys after it |
| `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET` | NOWPayments annual billing |
| `VAPID_PRIVATE_KEY`, `PUSH_IP_HMAC_SECRET` | Browser-push delivery and abuse-resistant rate-limit identity |
| `INDEXNOW_MASTER_SECRET` | Per-host IndexNow key derivation |
| `DYNADOT_API_KEY`, `DYNADOT_API_SECRET` | Dynadot registration operations |

Public non-secret values are represented in the production example. Optional
integration values include `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`,
`STRIPE_PORTAL_CONFIGURATION_ID`, the legacy `STRIPE_PRICE_ID` fallback, and
`DYNADOT_SANDBOX`; each must be configured before its corresponding integration
is enabled.

Staff Worker secrets, set separately with `--config
wrangler.staff.production.jsonc`, are `MAILNICE_API_KEY` (or
`RESEND_API_KEY`), `STRIPE_SECRET_KEY`, and `CF_ANALYTICS_TOKEN`. Staff
non-secret configuration includes `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`,
`STAFF_ALLOWED_EMAILS`, `EMAIL_FROM`, `ROOT_DOMAIN`, both Stripe price IDs,
`AFFILIATE_PAYOUT_DUAL_CONTROL_THRESHOLD_MINOR`,
`AFFILIATE_STRIPE_CONNECT_COUNTRIES`, `AFFILIATE_OFFER_EXPERIMENT`, and
`CF_ACCOUNT_ID`. Cloudflare Access configuration is not a substitute for the
Worker's role checks. Provider features fail closed when required values are
absent.

## Affiliate operations

Publish the affiliate terms and keep
`AFFILIATE_TERMS_VERSION`, `AFFILIATE_TERMS_DOCUMENT_DIGEST`,
`AFFILIATE_TERMS_URL`, and `AFFILIATE_POLICY_VERSION` consistent. Verify the
configured Stripe coupon implements the promised discount and duration. Limit
Connect onboarding with `AFFILIATE_STRIPE_CONNECT_COUNTRIES` and configure the
same corridor on public and staff Workers.

Keep `AFFILIATE_OFFER_EXPERIMENT=off` until its decision parameters and start
record are frozen. Validate referral capture, attribution, checkout metadata,
webhook settlement, refund/dispute handling, maturity, payout preparation,
dual control, and staff reporting before enabling payouts or experiments.

## Verification and rollback

Before deployment:

```sh
npm test
npm run typecheck
npm run deploy:production:check
npm run deploy:staff:production:check
```

After deployment, verify the public and staff Worker versions, routes, D1/R2/AE
bindings, queue producers and consumers, cron, and Access policy. For a code
regression, redeploy the last known-good commit with the same production
configs. D1 migrations are forward-only: restore the pre-migration backup or
apply a separately reviewed corrective migration rather than attempting an
ad-hoc reversal. Pause affiliate experiments and financial dispatch before a
rollback when their state could diverge.

Use [`incident-response.md`](incident-response.md) during production incidents
and execute [`restore-drill.md`](restore-drill.md) at least quarterly. The test
suite checks README links/npm commands, migration-ledger coverage, and production
queue documentation so common forms of documentation drift fail CI.
