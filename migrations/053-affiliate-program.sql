ALTER TABLE accounts ADD COLUMN affiliate_eligibility_closed_at INTEGER;

-- Existing paid accounts must not gain retroactive referral eligibility when
-- this program is introduced. A non-trial Stripe lifecycle or any durable
-- crypto entitlement is evidence that the first-payment boundary passed.
UPDATE accounts
   SET affiliate_eligibility_closed_at = unixepoch()
 WHERE billing_status NOT IN ('inactive', 'trialing')
    OR crypto_paid_through IS NOT NULL;

CREATE TABLE affiliate_attributions (
  id                  INTEGER PRIMARY KEY,
  referred_account_id INTEGER NOT NULL UNIQUE,
  affiliate_id        INTEGER NOT NULL,
  source              TEXT NOT NULL CHECK (source IN ('link', 'code')),
  interacted_at       INTEGER NOT NULL,
  captured_at         INTEGER NOT NULL,
  policy_version      TEXT NOT NULL DEFAULT 'affiliate-1',
  CHECK (affiliate_id != referred_account_id),
  FOREIGN KEY (referred_account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (affiliate_id) REFERENCES accounts(id) ON DELETE RESTRICT
);

CREATE INDEX idx_affiliate_attributions_affiliate
  ON affiliate_attributions(affiliate_id, captured_at DESC);

CREATE TABLE affiliate_terms_acceptances (
  id                    TEXT PRIMARY KEY,
  account_id            INTEGER NOT NULL,
  terms_version         TEXT NOT NULL,
  terms_document_digest TEXT NOT NULL,
  policy_version        TEXT NOT NULL,
  accepted_at           INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_affiliate_terms_account
  ON affiliate_terms_acceptances(account_id, accepted_at DESC);

CREATE TABLE affiliate_profiles (
  account_id          INTEGER PRIMARY KEY,
  referral_code       TEXT NOT NULL COLLATE NOCASE UNIQUE,
  stripe_promotion_code_id TEXT UNIQUE,
  stripe_connected_account_id TEXT UNIQUE,
  stripe_connect_country TEXT,
  stripe_connect_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (stripe_connect_status IN ('not_started', 'onboarding', 'ready', 'restricted')),
  stripe_connect_details_submitted INTEGER NOT NULL DEFAULT 0 CHECK (stripe_connect_details_submitted IN (0, 1)),
  stripe_connect_payouts_enabled INTEGER NOT NULL DEFAULT 0 CHECK (stripe_connect_payouts_enabled IN (0, 1)),
  stripe_connect_updated_at INTEGER,
  stripe_connect_event_id TEXT,
  status              TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'closed', 'terms_required')),
  terms_acceptance_id TEXT NOT NULL,
  enabled_at          INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (terms_acceptance_id) REFERENCES affiliate_terms_acceptances(id) ON DELETE RESTRICT
);

CREATE TABLE affiliate_account_relationships (
  affiliate_id       INTEGER NOT NULL,
  related_account_id INTEGER NOT NULL,
  relationship_kind  TEXT NOT NULL CHECK (relationship_kind IN ('same_person', 'same_organization', 'controlled_account')),
  actor_subject      TEXT NOT NULL,
  actor_role         TEXT NOT NULL CHECK (actor_role = 'admin'),
  reason             TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  recorded_at        INTEGER NOT NULL,
  PRIMARY KEY (affiliate_id, related_account_id),
  CHECK (affiliate_id != related_account_id),
  FOREIGN KEY (affiliate_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  FOREIGN KEY (related_account_id) REFERENCES accounts(id) ON DELETE RESTRICT
);

CREATE TABLE affiliate_installments (
  id                 INTEGER PRIMARY KEY,
  attribution_id     INTEGER NOT NULL,
  cadence            TEXT NOT NULL CHECK (cadence IN ('monthly', 'annual')),
  installment_number INTEGER NOT NULL CHECK (installment_number > 0),
  provider           TEXT NOT NULL CHECK (provider IN ('stripe', 'nowpayments')),
  source_key         TEXT NOT NULL,
  claimed_at         INTEGER NOT NULL,
  UNIQUE (attribution_id, cadence, installment_number),
  UNIQUE (provider, source_key),
  FOREIGN KEY (attribution_id) REFERENCES affiliate_attributions(id) ON DELETE RESTRICT
);

CREATE TABLE affiliate_nowpayments_checkouts (
  order_id                         TEXT PRIMARY KEY,
  account_id                       INTEGER NOT NULL,
  attribution_id                   INTEGER,
  expected_discounted_amount_minor INTEGER NOT NULL CHECK (expected_discounted_amount_minor > 0),
  currency                         TEXT NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  policy_version                   TEXT NOT NULL,
  discount_rate_numerator          INTEGER NOT NULL CHECK (discount_rate_numerator >= 0),
  discount_rate_denominator        INTEGER NOT NULL CHECK (discount_rate_denominator > 0),
  commission_rate_numerator        INTEGER NOT NULL CHECK (commission_rate_numerator >= 0),
  commission_rate_denominator      INTEGER NOT NULL CHECK (commission_rate_denominator > 0),
  status                           TEXT NOT NULL CHECK (status IN ('pending', 'invoiced', 'paid', 'refunded', 'expired', 'failed')),
  provider_invoice_id              TEXT,
  provider_payment_id              TEXT UNIQUE,
  payment_claim_nonce              TEXT UNIQUE,
  paid_at                          INTEGER,
  refund_claim_nonce               TEXT UNIQUE,
  refunded_at                      INTEGER,
  created_at                       INTEGER NOT NULL,
  expires_at                       INTEGER NOT NULL,
  CHECK (expires_at > created_at),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  FOREIGN KEY (attribution_id) REFERENCES affiliate_attributions(id) ON DELETE RESTRICT
);

CREATE TABLE affiliate_stripe_checkouts (
  id                           TEXT PRIMARY KEY,
  account_id                   INTEGER NOT NULL,
  attribution_id               INTEGER NOT NULL,
  cadence                      TEXT NOT NULL CHECK (cadence IN ('monthly', 'annual')),
  price_id                     TEXT NOT NULL,
  promotion_code_id            TEXT NOT NULL,
  policy_version               TEXT NOT NULL,
  discount_rate_numerator      INTEGER NOT NULL CHECK (discount_rate_numerator > 0),
  discount_rate_denominator    INTEGER NOT NULL CHECK (discount_rate_denominator > 0),
  commission_rate_numerator    INTEGER NOT NULL CHECK (commission_rate_numerator > 0),
  commission_rate_denominator  INTEGER NOT NULL CHECK (commission_rate_denominator > 0),
  status                       TEXT NOT NULL CHECK (status IN ('pending', 'created', 'completed', 'expired', 'failed')),
  stripe_session_id            TEXT UNIQUE,
  stripe_subscription_id       TEXT,
  completed_at                 INTEGER,
  created_at                   INTEGER NOT NULL,
  expires_at                   INTEGER NOT NULL,
  CHECK (expires_at > created_at),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  FOREIGN KEY (attribution_id) REFERENCES affiliate_attributions(id) ON DELETE RESTRICT
);

CREATE TABLE affiliate_revenue_occurrences (
  id                          TEXT PRIMARY KEY,
  provider                    TEXT NOT NULL CHECK (provider IN ('stripe', 'nowpayments')),
  source_key                  TEXT NOT NULL,
  provider_payment_id         TEXT,
  provider_invoice_id         TEXT,
  provider_line_id            TEXT,
  provider_subscription_id    TEXT,
  provider_price_id           TEXT,
  affiliate_id                INTEGER NOT NULL,
  referred_account_id         INTEGER NOT NULL,
  attribution_id              INTEGER NOT NULL,
  installment_id              INTEGER NOT NULL UNIQUE,
  currency                    TEXT NOT NULL,
  eligible_revenue_minor      INTEGER NOT NULL CHECK (eligible_revenue_minor >= 0),
  processing_fee_minor        INTEGER NOT NULL CHECK (processing_fee_minor >= 0),
  policy_version              TEXT NOT NULL,
  commission_rate_numerator   INTEGER NOT NULL CHECK (commission_rate_numerator > 0),
  commission_rate_denominator INTEGER NOT NULL CHECK (commission_rate_denominator > 0),
  service_start_at            INTEGER NOT NULL,
  service_end_at              INTEGER NOT NULL,
  paid_at                     INTEGER NOT NULL,
  CHECK (service_end_at > service_start_at),
  UNIQUE (provider, source_key),
  FOREIGN KEY (affiliate_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  FOREIGN KEY (referred_account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  FOREIGN KEY (attribution_id) REFERENCES affiliate_attributions(id) ON DELETE RESTRICT,
  FOREIGN KEY (installment_id) REFERENCES affiliate_installments(id) ON DELETE RESTRICT
);

CREATE TABLE affiliate_revenue_adjustments (
  id                                TEXT PRIMARY KEY,
  occurrence_id                     TEXT NOT NULL,
  provider                          TEXT NOT NULL CHECK (provider IN ('stripe', 'nowpayments')),
  source_key                        TEXT NOT NULL,
  refunded_eligible_revenue_minor   INTEGER NOT NULL CHECK (refunded_eligible_revenue_minor > 0),
  commission_reversal_minor         INTEGER NOT NULL CHECK (commission_reversal_minor < 0),
  recorded_at                       INTEGER NOT NULL,
  UNIQUE (provider, source_key),
  FOREIGN KEY (occurrence_id) REFERENCES affiliate_revenue_occurrences(id) ON DELETE RESTRICT
);

CREATE TABLE affiliate_relationship_reversals (
  id                      TEXT PRIMARY KEY,
  occurrence_id           TEXT NOT NULL UNIQUE,
  relationship_affiliate_id INTEGER NOT NULL,
  related_account_id      INTEGER NOT NULL,
  commission_reversal_minor INTEGER NOT NULL CHECK (commission_reversal_minor < 0),
  recorded_at             INTEGER NOT NULL,
  FOREIGN KEY (occurrence_id) REFERENCES affiliate_revenue_occurrences(id) ON DELETE RESTRICT,
  FOREIGN KEY (relationship_affiliate_id, related_account_id)
    REFERENCES affiliate_account_relationships(affiliate_id, related_account_id) ON DELETE RESTRICT
);

CREATE TABLE affiliate_manual_adjustments (
  id             TEXT PRIMARY KEY,
  source_key     TEXT NOT NULL UNIQUE,
  occurrence_id  TEXT NOT NULL,
  affiliate_id   INTEGER NOT NULL,
  currency       TEXT NOT NULL CHECK (currency = 'usd'),
  amount_minor   INTEGER NOT NULL CHECK (amount_minor != 0),
  actor_subject  TEXT NOT NULL,
  actor_role     TEXT NOT NULL CHECK (actor_role = 'admin'),
  reason         TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  recorded_at    INTEGER NOT NULL,
  FOREIGN KEY (occurrence_id) REFERENCES affiliate_revenue_occurrences(id) ON DELETE RESTRICT,
  FOREIGN KEY (affiliate_id) REFERENCES accounts(id) ON DELETE RESTRICT
);

CREATE TABLE affiliate_ledger_entries (
  id                    TEXT PRIMARY KEY,
  occurrence_id         TEXT NOT NULL,
  adjustment_id         TEXT UNIQUE,
  dispute_loss_id       TEXT UNIQUE,
  relationship_reversal_id TEXT UNIQUE,
  manual_adjustment_id  TEXT UNIQUE,
  entry_kind            TEXT NOT NULL CHECK (entry_kind IN ('earning', 'refund', 'dispute_loss', 'relationship_reversal', 'manual_adjustment')),
  affiliate_id          INTEGER NOT NULL,
  currency              TEXT NOT NULL,
  amount_minor          INTEGER NOT NULL,
  available_at          INTEGER NOT NULL,
  created_at            INTEGER NOT NULL,
  FOREIGN KEY (occurrence_id) REFERENCES affiliate_revenue_occurrences(id) ON DELETE RESTRICT,
  FOREIGN KEY (adjustment_id) REFERENCES affiliate_revenue_adjustments(id) ON DELETE RESTRICT,
  FOREIGN KEY (dispute_loss_id) REFERENCES affiliate_dispute_losses(id) ON DELETE RESTRICT,
  FOREIGN KEY (relationship_reversal_id) REFERENCES affiliate_relationship_reversals(id) ON DELETE RESTRICT,
  FOREIGN KEY (manual_adjustment_id) REFERENCES affiliate_manual_adjustments(id) ON DELETE RESTRICT,
  FOREIGN KEY (affiliate_id) REFERENCES accounts(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_affiliate_ledger_one_earning
  ON affiliate_ledger_entries(occurrence_id) WHERE entry_kind = 'earning';

CREATE INDEX idx_affiliate_ledger_availability
  ON affiliate_ledger_entries(affiliate_id, currency, available_at);

CREATE TABLE affiliate_reserves (
  id            TEXT PRIMARY KEY,
  occurrence_id TEXT NOT NULL,
  affiliate_id  INTEGER NOT NULL,
  provider      TEXT NOT NULL CHECK (provider IN ('stripe', 'nowpayments')),
  dispute_id    TEXT NOT NULL,
  source_key    TEXT NOT NULL,
  currency      TEXT NOT NULL,
  amount_minor  INTEGER NOT NULL CHECK (amount_minor > 0),
  status        TEXT NOT NULL CHECK (status IN ('open', 'released', 'lost')),
  opened_at     INTEGER NOT NULL,
  resolution_source_key TEXT UNIQUE,
  resolved_at   INTEGER,
  UNIQUE (provider, dispute_id),
  UNIQUE (provider, source_key),
  FOREIGN KEY (occurrence_id) REFERENCES affiliate_revenue_occurrences(id) ON DELETE RESTRICT,
  FOREIGN KEY (affiliate_id) REFERENCES accounts(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_affiliate_one_open_reserve
  ON affiliate_reserves(occurrence_id) WHERE status = 'open';

CREATE TABLE affiliate_dispute_losses (
  id                   TEXT PRIMARY KEY,
  reserve_id           TEXT NOT NULL UNIQUE,
  provider             TEXT NOT NULL CHECK (provider IN ('stripe', 'nowpayments')),
  source_key           TEXT NOT NULL,
  commission_reversal_minor INTEGER NOT NULL CHECK (commission_reversal_minor < 0),
  recorded_at          INTEGER NOT NULL,
  UNIQUE (provider, source_key),
  FOREIGN KEY (reserve_id) REFERENCES affiliate_reserves(id) ON DELETE RESTRICT
);

CREATE TABLE affiliate_payouts (
  id           TEXT PRIMARY KEY,
  affiliate_id INTEGER NOT NULL,
  currency     TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('prepared', 'reconciliation', 'paid', 'cancelled')),
  reconciliation_token TEXT UNIQUE,
  cutoff_at    INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (affiliate_id) REFERENCES accounts(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_affiliate_one_prepared_payout
  ON affiliate_payouts(affiliate_id, currency) WHERE status = 'prepared';

CREATE TABLE affiliate_payout_approvals (
  payout_id     TEXT NOT NULL,
  actor_subject TEXT NOT NULL,
  actor_role    TEXT NOT NULL CHECK (actor_role = 'admin'),
  reason        TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  approved_at   INTEGER NOT NULL,
  PRIMARY KEY (payout_id, actor_subject),
  FOREIGN KEY (payout_id) REFERENCES affiliate_payouts(id) ON DELETE RESTRICT
);

CREATE TABLE affiliate_payout_entries (
  payout_id       TEXT NOT NULL,
  ledger_entry_id TEXT NOT NULL,
  released_at     INTEGER,
  PRIMARY KEY (payout_id, ledger_entry_id),
  FOREIGN KEY (payout_id) REFERENCES affiliate_payouts(id) ON DELETE RESTRICT,
  FOREIGN KEY (ledger_entry_id) REFERENCES affiliate_ledger_entries(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_affiliate_active_payout_allocation
  ON affiliate_payout_entries(ledger_entry_id) WHERE released_at IS NULL;

CREATE TABLE affiliate_payout_attempts (
  id                 TEXT PRIMARY KEY,
  payout_id          TEXT NOT NULL,
  provider           TEXT NOT NULL CHECK (provider IN ('stripe', 'nowpayments')),
  idempotency_key    TEXT NOT NULL,
  outcome            TEXT NOT NULL CHECK (outcome IN ('paid', 'ambiguous')),
  external_reference TEXT,
  actor_subject      TEXT NOT NULL,
  actor_role         TEXT NOT NULL CHECK (actor_role = 'admin'),
  reason             TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  recorded_at        INTEGER NOT NULL,
  UNIQUE (provider, idempotency_key),
  CHECK (outcome != 'paid' OR external_reference IS NOT NULL),
  FOREIGN KEY (payout_id) REFERENCES affiliate_payouts(id) ON DELETE RESTRICT
);

CREATE TABLE affiliate_payout_reconciliations (
  id                 TEXT PRIMARY KEY,
  payout_id          TEXT NOT NULL UNIQUE,
  decision           TEXT NOT NULL CHECK (decision IN ('confirm_paid', 'cancel')),
  actor_subject      TEXT NOT NULL,
  actor_role         TEXT NOT NULL CHECK (actor_role = 'admin'),
  evidence           TEXT NOT NULL CHECK (length(trim(evidence)) > 0),
  external_reference TEXT,
  reconciled_at      INTEGER NOT NULL,
  FOREIGN KEY (payout_id) REFERENCES affiliate_payouts(id) ON DELETE RESTRICT
);

CREATE TABLE affiliate_email_outbox (
  idempotency_key TEXT PRIMARY KEY,
  affiliate_id    INTEGER NOT NULL,
  payout_id       TEXT UNIQUE,
  kind            TEXT NOT NULL CHECK (kind IN ('affiliate-enrolled', 'affiliate-terms-required', 'affiliate-connect-ready', 'affiliate-connect-restricted', 'affiliate-payout-sent', 'affiliate-payout-cancelled')),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'queued')),
  created_at      INTEGER NOT NULL,
  queued_at       INTEGER,
  FOREIGN KEY (affiliate_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  FOREIGN KEY (payout_id) REFERENCES affiliate_payouts(id) ON DELETE RESTRICT
);

CREATE INDEX idx_affiliate_email_outbox_pending
  ON affiliate_email_outbox(status, created_at);

CREATE TABLE affiliate_stripe_financial_events (
  source_key            TEXT PRIMARY KEY,
  kind                  TEXT NOT NULL CHECK (kind IN ('refund', 'credit_note', 'dispute_open', 'dispute_close')),
  payment_id            TEXT,
  invoice_id            TEXT,
  invoice_line_id       TEXT,
  dispute_id            TEXT,
  outcome               TEXT CHECK (outcome IS NULL OR outcome IN ('won', 'lost')),
  amount_minor          INTEGER,
  original_amount_minor INTEGER,
  occurred_at           INTEGER NOT NULL,
  applied_at            INTEGER
);

CREATE INDEX idx_affiliate_stripe_financial_events_pending
  ON affiliate_stripe_financial_events(applied_at, occurred_at);
