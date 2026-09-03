# Affiliate program technical design

Status: accepted for pre-implementation planning; BIG review corrections incorporated.

## Objective

Allow any verified, active Blognice account to enable an account-level Affiliate Profile, give referred customers 10% off their first 12 paid service months, and earn 50% of the resulting Eligible Revenue. Paid Blognice membership is not required.

The design keeps referral policy and financial accounting independent of Stripe, NOWPayments, and any future payout provider. D1 is the authority for attribution and money. Cloudflare Analytics Engine provides approximate aggregate traffic reporting only.

## Program rules

- An Affiliate accepts a versioned set of Affiliate Terms before activation.
- A referral interaction opens a 60-day Attribution Opportunity for an unpaid, unattributed account.
- A link or explicitly entered Referral Code may create Attribution during that opportunity.
- An explicitly entered valid code takes precedence only while no Attribution exists.
- Once created, Attribution is immutable.
- The first eligible payment permanently closes the Attribution Opportunity, including when no Affiliate was attributed. The account records `eligibility_closed_at` to prevent retroactive claims.
- Existing paid accounts, self-referrals, and related-account referrals are ineligible.
- The customer receives 10% off qualifying subscription service during the first 12 paid service months.
- Commission is 50% of Eligible Revenue, calculated after discounts, taxes, refunds, and credits but before provider-processing fees.
- Annual billing qualifies on the first non-zero annual subscription line only.
- Monthly billing qualifies on the first 12 non-zero initial or renewal monthly subscription lines.
- A retry of the same provider invoice is the same installment. Trials and zero-value invoices neither earn commission nor consume an installment.
- Proration and upgrade lines do not earn commission or consume an installment in the first release.
- Cancellation and resubscription continue the same installment counter; eligibility never restarts.
- Stripe and NOWPayments purchases follow the same policy.
- Earned commission matures 60 days after provider-confirmed payment.
- Payouts are prepared monthly when the Affiliate's net matured USD balance is at least $100.
- Payouts use Stripe Connect only. Each Affiliate completes Stripe-hosted Express onboarding; Blognice stores the connected-account ID and status but never bank-account details.
- Enrollment and payout availability are limited to countries and cross-border corridors enabled by Stripe for Blognice's Thailand platform account.
- Late refunds, lost disputes, and corrections create signed adjustment entries; historical entries are never rewritten.

## Terms and policy snapshots

Terms acceptance is immutable evidence rather than fields overwritten on the Affiliate Profile. Each acceptance records the account, exact terms version and document digest, program-policy version, acceptance time, and any security metadata Saul determines is necessary and proportionate.

Each Attribution references its program-policy version. Each Revenue Occurrence snapshots its applied discount and commission policy. Historical amounts are never recomputed using current profile settings.

Material terms changes may place a profile in `terms_required`. Legitimate attribution may continue during a configured grace period, but payouts remain paused until reacceptance. Saul must approve the legal wording and the treatment of referral storage, offsets, recovery, suspension, tax responsibility, and program termination before launch.

## Referral capture

An affiliate URL such as `https://www.blognice.com/?ref=alex` validates the active Referral Code and sets a signed, first-party referral cookie containing only the minimum affiliate/policy reference and expiry. The cookie is `HttpOnly`, `Secure`, `SameSite=Lax`, scoped deliberately, and expires after 60 days. Signing keys must support rotation and contain at least 32 bytes; weak configuration fails closed and leaves explicit Referral Code entry available.

At signup or before the first eligible checkout, Blognice attempts to capture Attribution transactionally. Concurrent attempts can produce at most one row. An existing Attribution cannot be replaced. Checkout closes the opportunity before payment-provider handoff so a later code cannot claim the payment.

Referral storage is separate from the existing optional analytics visitor identifier. Saul must determine the applicable consent and disclosure behavior. When referral storage is unavailable, explicit code entry remains the fallback.

## Revenue recognition

Provider adapters convert verified provider payloads into a normalized Revenue Occurrence. The affiliate module never consumes raw provider payloads.

Each occurrence contains:

- provider and currency;
- provider payment, invoice, qualifying line, subscription, and price identifiers where applicable;
- referred account and Attribution identifiers;
- service interval;
- discounted qualifying line amount excluding tax;
- credits or refunds affecting collected eligible value;
- policy version, rate numerator and denominator;
- provider payment time and immutable source key.

All amounts use integer minor units. The first release recognizes USD only. A non-USD occurrence is retained for reconciliation but cannot create commission until an explicit FX policy exists.

Commission rounds half-up per Revenue Occurrence. The uniqueness key is the provider plus provider payment/invoice plus qualifying line—not a webhook event ID. Different events describing the same occurrence cannot credit it twice. Every refund, credit note, dispute result, and manual adjustment has its own immutable source key.

### Example occurrences

- Discounted annual Stripe line: $32.40 Eligible Revenue produces $16.20 commission.
- Discounted monthly Stripe line: $4.50 Eligible Revenue produces $2.25 commission and consumes one of 12 installments.
- Discounted annual NOWPayments order: $32.40 Eligible Revenue produces $16.20 commission.

## Refunds and disputes

- A refund appends a proportional negative Commission Entry.
- An opened dispute reserves related unallocated commission but does not immediately reverse it.
- A won dispute releases the reserve.
- A lost dispute appends the negative Commission Entry.
- A single amount cannot be reversed by both a refund and a dispute. Adjustments track the remaining reversible amount for their Revenue Occurrence.
- Negative matured amounts reduce the net balance before the $100 threshold is evaluated.
- Suspended, closed, reserved, or `terms_required` profiles cannot receive payouts.
- Terms and staff procedures must permit lawful withholding, offset, suspension, and recovery when an Affiliate stops participating with a negative balance.

## NOWPayments checkout correction

Before calling NOWPayments, Blognice persists a pending checkout with a random order ID, account, Attribution and policy snapshots, expected discounted USD cents, and creation/expiry times. Invoice creation uses that amount rather than the global $36 constant.

The IPN accepts credit only for a matching durable order and idempotent provider-payment claim. The current account-ID-from-order-string fallback is removed. A database transaction claims the payment, grants entitlement, records the Revenue Occurrence, and appends commission consistently. Underpayments and partial payments do not qualify; overpayments earn commission only on the expected subscription price. Refunds require an immutable provider or staff adjustment.

## Stripe adapter changes

Checkout snapshots Attribution and applies the appropriate promotion configuration. A shared 10%-off policy may have Affiliate-specific promotion codes. Stripe's repeating coupon duration is isolated inside the adapter because Stripe has marked that mechanism deprecated in some API versions; migration to subscription schedules must not change affiliate policy.

The webhook adapter recognizes successful invoices, refunds, credit notes, and dispute lifecycle events in addition to current entitlement events. It allow-lists Blognice monthly and yearly subscription prices and qualifying subscription lines. Provider event delivery order and event IDs are never treated as financial identity.

## Persistence model

The implementation will introduce these conceptual tables; exact SQL is finalized in the TDD slices:

- `affiliate_profiles`: account-owned activation and lifecycle state.
- `affiliate_terms_acceptances`: immutable terms and policy acceptance evidence.
- `affiliate_attributions`: one immutable row per referred account.
- `affiliate_revenue_occurrences`: immutable normalized provider facts and occurrence uniqueness.
- `affiliate_ledger_entries`: immutable signed commission amounts with `available_at`; availability is derived rather than represented by mutable pending/payable status.
- `affiliate_reserves`: temporary holds associated with disputes or fraud review.
- `affiliate_payouts`: mutable reviewed external-payment workflow.
- `affiliate_payout_entries`: immutable allocation rows with a uniqueness constraint preventing one ledger entry from entering two payouts.

Payout preparation atomically claims eligible entries. Two staff requests or retries cannot allocate the same entry twice. Prepared payouts transfer to an Affiliate's ready Stripe connected account; Stripe then pays the external bank account collected through hosted onboarding. An ambiguous external-provider timeout leaves the payout requiring reconciliation; it is never blindly re-sent. External references and staff actions are audited. Payouts at or above `AFFILIATE_PAYOUT_DUAL_CONTROL_THRESHOLD_MINOR` require durable approval by an admin other than the dispatching admin; the production threshold is an explicit operational configuration reviewed by Tackleberry, and missing or invalid configuration disables dispatch. Commissions arising from NOWPayments sales must not be funded through Stripe until Stripe confirms that use case for Blognice's account.

## Analytics and privacy

The existing Cloudflare analytics infrastructure records approximate, consent-aware affiliate funnel events in a dedicated affiliate schema or dataset indexed by Affiliate Profile—not tenant. Events include `affiliate_click`, `affiliate_signup`, and `affiliate_conversion` without customer/account identity.

Analytics Engine click totals are labeled approximate because collection may be denied, blocked, sampled, or expire. Exact Attribution, signup, payment, balance, and payout counts come from D1. Affiliate aggregate archives extend the established R2 daily archive approach with documented retention and deletion behavior; the current popularity materialization is not reused as an affiliate archive.

Affiliate funnel archives contain daily counts grouped only by Affiliate Profile,
event, source, provider, and policy version. They never contain referred-account or
customer identity. Cron stores them under `affiliate/daily/YYYY/MM/YYYY-MM-DD.json`
and deletes the corresponding partition once it is older than 730 days. Account
deletion does not require row-level archive rewriting because these files contain
only Affiliate-level aggregate counts, not referred-customer records.

## Abuse controls

Staff-visible signals support investigation rather than automatic guilt. Signals may include related Blognice accounts, normalized payment customer, lawfully available card fingerprint, billing or payout identity, organization, session/device patterns, cookie stuffing, code injection, spam, misleading claims, and trademark bidding.

Raw IP addresses are not stored in click analytics. If IP-derived signals are used for security, their hashing, access, and retention are specified separately. Suspension, reserve, adjustment, and payout decisions require reasons in the existing staff audit path.

## Module interfaces and TDD seams

The affiliate program is a deep module with four public behavioral seams:

1. `captureReferral(candidate, accountState, policy, now)` decides whether Attribution can be created; D1 integration proves immutable and concurrent capture.
2. `recognizeRevenue(normalizedOccurrence)` deterministically creates an occurrence and Commission Entry; D1 integration proves uniqueness and adjustment invariants.
3. `preparePayout(affiliate, currency, cutoff)` derives and atomically allocates available commission.
4. Provider adapters normalize Stripe and NOWPayments fixtures into equivalent Revenue Occurrences.

End-to-end HTTP tests cross the external seam from referral link/code through signup, discounted checkout snapshot, verified payment, maturation, payout allocation, and post-payout adjustment. Tests observe behavior through module and HTTP interfaces rather than private helpers or source-text assertions.

Required cases include concurrent attribution, attempted replacement, close-without-attribution, annual and monthly examples, rounding, zero invoices, prorations, retries, duplicate and out-of-order events, partial refunds, dispute/refund overlap, the exact 60-day and $100 boundaries, negative carry-forward, suspended Affiliates, payout retry ambiguity, and provider webhook replay.

## Review gates

- BIG corrections in this document must remain satisfied during implementation.
- Tackleberry reviews cookie signing, webhook replay, financial authorization, fraud signals, payout concurrency, and privacy before release.
- Saul approves Affiliate Terms and referral-storage disclosures before activation.
- Enrollment is fail-closed until production supplies the four Saul-approved settings
  and verified Stripe coupon configuration:
  `AFFILIATE_TERMS_VERSION`, `AFFILIATE_TERMS_DOCUMENT_DIGEST`,
  `AFFILIATE_POLICY_VERSION`, an HTTPS `AFFILIATE_TERMS_URL`, and
  `STRIPE_AFFILIATE_COUPON_ID`. Stripe Connect onboarding additionally requires
  a non-empty `AFFILIATE_STRIPE_CONNECT_COUNTRIES` ISO country allowlist verified
  for the Thailand platform account; the application never infers this changing,
  account-specific corridor from Stripe's general country list. The same explicit
  allowlist is required by the staff Worker and is re-checked at payout dispatch, so
  removing a corridor disables future transfers to accounts in that country. They are
  deliberately absent from checked-in production configuration; placeholder values
  must not be used merely to expose enrollment.
- Deterministic tests remain the final local authority; reviewer approval does not replace them.
