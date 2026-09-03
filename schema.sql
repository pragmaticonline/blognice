-- Blog Nice — INDEX database schema (binding: DB)
-- Holds accounts, memberships, tenants, sessions, domains. Post bodies live in
-- the separate POSTS database (see schema-posts.sql).
-- Run with:  npm run db:init        (remote)
--            npm run db:init:local  (local dev)

-- Drop everything first so re-applying is idempotent. Includes tables that may
-- linger from other versions (subscribers, and the reader-era account tables),
-- so a re-apply cleanly resets to this schema regardless of prior state.
DROP TABLE IF EXISTS bookmarks;
DROP TABLE IF EXISTS bookmark_lists;
DROP TABLE IF EXISTS reactions;
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS subscriber_confirmations;
DROP TABLE IF EXISTS subscribers;
DROP TABLE IF EXISTS staff_audit_events;
DROP TABLE IF EXISTS staff_users;
DROP TABLE IF EXISTS pronunciation_overrides;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS password_resets;
DROP TABLE IF EXISTS password_reset_tokens;
DROP TABLE IF EXISTS stripe_events;
DROP TABLE IF EXISTS email_delivery_log;
DROP TABLE IF EXISTS subscription_manage_tokens;
DROP TABLE IF EXISTS ai_credit_usage;
DROP TABLE IF EXISTS ai_credit_refunds;
DROP TABLE IF EXISTS affiliate_payout_reconciliations;
DROP TABLE IF EXISTS affiliate_payout_attempts;
DROP TABLE IF EXISTS affiliate_payout_entries;
DROP TABLE IF EXISTS affiliate_payout_approvals;
DROP TABLE IF EXISTS affiliate_payouts;
DROP TABLE IF EXISTS affiliate_ledger_entries;
DROP TABLE IF EXISTS affiliate_manual_adjustments;
DROP TABLE IF EXISTS affiliate_relationship_reversals;
DROP TABLE IF EXISTS affiliate_dispute_losses;
DROP TABLE IF EXISTS affiliate_reserves;
DROP TABLE IF EXISTS affiliate_revenue_adjustments;
DROP TABLE IF EXISTS affiliate_revenue_occurrences;
DROP TABLE IF EXISTS affiliate_stripe_checkouts;
DROP TABLE IF EXISTS affiliate_nowpayments_checkouts;
DROP TABLE IF EXISTS affiliate_installments;
DROP TABLE IF EXISTS affiliate_account_relationships;
DROP TABLE IF EXISTS affiliate_profiles;
DROP TABLE IF EXISTS affiliate_terms_acceptances;
DROP TABLE IF EXISTS affiliate_attributions;
DROP TABLE IF EXISTS crypto_payments;
DROP TABLE IF EXISTS post_popularity;
DROP TABLE IF EXISTS post_popularity_daily;
DROP TABLE IF EXISTS popularity_state;
DROP TABLE IF EXISTS marketing_audio_state;
DROP TABLE IF EXISTS memberships;
DROP TABLE IF EXISTS blog_invitations;
DROP TABLE IF EXISTS accounts;
DROP TABLE IF EXISTS domains;
DROP TABLE IF EXISTS tenant_slug_aliases;
DROP TABLE IF EXISTS tenants;

-- One row per blog.
CREATE TABLE tenants (
  id            INTEGER PRIMARY KEY,
  public_id     TEXT    NOT NULL UNIQUE,          -- opaque identifier used in public URLs/API paths
  slug          TEXT    NOT NULL UNIQUE,          -- the subdomain: <slug>.blognice.com
  custom_domain TEXT             UNIQUE,          -- optional: blog.theircompany.com (nullable)
  title         TEXT    NOT NULL,                 -- blog title, shown in header + <title>
  description   TEXT    NOT NULL DEFAULT '',      -- tagline, shown under the title + meta description
  footer_name   TEXT    NOT NULL DEFAULT '',      -- optional public publisher/company name
  avatar_key    TEXT,                             -- R2 key of the blog's profile image (nullable)
  favicon_key   TEXT,                             -- R2 key of the blog's browser icon (nullable)
  accent_color  TEXT    NOT NULL DEFAULT '#1a8917', -- six-digit hex branding accent
  topics_json   TEXT    NOT NULL DEFAULT '[]',     -- normalized blog topics
  social_links_json TEXT NOT NULL DEFAULT '{}',    -- normalized social profile URLs
  navigation_links_json TEXT NOT NULL DEFAULT '[]', -- external/custom navigation links {label, href, order}
  browser_push_enabled INTEGER NOT NULL DEFAULT 0, -- owner opt-in for reader notifications
  header_link_url TEXT NOT NULL DEFAULT '/',       -- where the header logo/name links ("/" = blog home, or https://parent.site)
  shard         TEXT    NOT NULL DEFAULT 'primary', -- which POSTS database holds this tenant's posts (see src/db.ts)
  created_at    INTEGER NOT NULL                  -- unix seconds
);

-- Materialized anonymous readership rankings. Raw visitor identifiers stay in
-- Analytics Engine; D1 receives only daily aggregate counts and scores.
CREATE TABLE post_popularity_daily (
  tenant_id       INTEGER NOT NULL,
  path            TEXT NOT NULL,
  day             TEXT NOT NULL,
  reader_days     INTEGER NOT NULL DEFAULT 0,
  engaged_readers INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, path, day),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX idx_post_popularity_daily_window ON post_popularity_daily(day, tenant_id);

CREATE TABLE post_popularity (
  tenant_id           INTEGER NOT NULL,
  path                TEXT NOT NULL,
  score               REAL NOT NULL,
  reader_days_30      INTEGER NOT NULL DEFAULT 0,
  reader_days_90      INTEGER NOT NULL DEFAULT 0,
  engaged_readers_30  INTEGER NOT NULL DEFAULT 0,
  calculated_at       INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, path),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX idx_post_popularity_rank ON post_popularity(tenant_id, score DESC, reader_days_30 DESC);

CREATE TABLE popularity_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- A login. An account can own several blogs (via memberships).
CREATE TABLE accounts (
  id         INTEGER PRIMARY KEY,
  email      TEXT    NOT NULL UNIQUE,
  pw_hash    TEXT    NOT NULL,                    -- pbkdf2$iterations$salt$hash
  api_key_hash       TEXT,                        -- sha-256 hex of the account's API key (nullable)
  api_key_created_at INTEGER,                     -- when the current key was generated
  status     TEXT    NOT NULL DEFAULT 'active',  -- active | suspended
  status_reason TEXT,
  status_changed_at INTEGER,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  billing_status TEXT NOT NULL DEFAULT 'inactive',
  billing_price_id TEXT,
  billing_period_end INTEGER,
  billing_cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  billing_updated_at INTEGER,
  billing_event_created_at INTEGER,
  billing_event_id TEXT,
  billing_subscription_created_at INTEGER,
  billing_subscription_event_created_at INTEGER,
  billing_invoice_event_created_at INTEGER,
  crypto_paid_through INTEGER,
  affiliate_eligibility_closed_at INTEGER,
  email_verified INTEGER NOT NULL DEFAULT 0,
  email_verified_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_accounts_api_key ON accounts (api_key_hash);
CREATE INDEX idx_accounts_status ON accounts (status, created_at DESC);
CREATE UNIQUE INDEX idx_accounts_stripe_customer ON accounts (stripe_customer_id);
CREATE UNIQUE INDEX idx_accounts_stripe_subscription ON accounts (stripe_subscription_id);

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

CREATE TABLE IF NOT EXISTS account_email_verifications (
  account_id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_verifications_expiry ON account_email_verifications(expires_at);
CREATE TABLE IF NOT EXISTS signup_rate_limits (
  ip TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

CREATE TABLE crypto_payments (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  order_id TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'yearly',
  price_usd_cents INTEGER NOT NULL,
  pay_currency TEXT,
  pay_amount TEXT,
  actually_paid TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  paid_at INTEGER,
  credited_at INTEGER,
  credit_nonce TEXT,
  entitlement_through INTEGER,
  revoked_at INTEGER,
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX idx_crypto_payments_account ON crypto_payments(account_id, created_at DESC);

CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  processed_at INTEGER NOT NULL DEFAULT 0,
  account_id INTEGER,
  status TEXT NOT NULL DEFAULT 'processed',
  last_error TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE SET NULL
);
CREATE INDEX idx_stripe_events_account ON stripe_events (account_id, processed_at DESC);
CREATE INDEX idx_stripe_events_status ON stripe_events (status, created_at);

CREATE TABLE staff_users (
  subject TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'read_only',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE staff_audit_events (
  id TEXT PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  subject TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT,
  result TEXT NOT NULL,
  request_id TEXT,
  before_json TEXT,
  after_json TEXT
);

CREATE INDEX idx_staff_audit_occurred ON staff_audit_events(occurred_at DESC);
CREATE INDEX idx_staff_audit_target ON staff_audit_events(target_type, target_id, occurred_at DESC);

-- Which accounts can manage which blogs. One row = one account's access to one
-- blog. `role` is 'owner' today; the column exists so collaborator roles can be
-- added later without a migration.
CREATE TABLE memberships (
  account_id INTEGER NOT NULL,
  tenant_id  INTEGER NOT NULL,
  role       TEXT    NOT NULL DEFAULT 'owner',
  display_name TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, tenant_id),
  FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id)  REFERENCES tenants (id)  ON DELETE CASCADE
);

CREATE INDEX idx_memberships_account ON memberships (account_id);
CREATE INDEX idx_memberships_tenant  ON memberships (tenant_id);

CREATE TABLE blog_invitations (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  invited_by INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (invited_by) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE tenant_slug_aliases (
  old_slug TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX idx_tenant_slug_aliases_tenant ON tenant_slug_aliases(tenant_id);
CREATE INDEX idx_blog_invites_tenant ON blog_invitations(tenant_id, created_at DESC);
CREATE INDEX idx_blog_invites_email ON blog_invitations(email, expires_at);

-- Customer-owned domains connected via Cloudflare for SaaS. A tenant may have
-- several. A domain only routes once status = 'active' (verified + certificate).
CREATE TABLE domains (
  hostname       TEXT    PRIMARY KEY,              -- blog.theircompany.com
  tenant_id      INTEGER NOT NULL,
  cf_hostname_id TEXT,                             -- Cloudflare custom_hostname id
  status         TEXT    NOT NULL DEFAULT 'pending', -- pending | active
  created_at     INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE INDEX idx_domains_active ON domains (hostname, status);

-- Login sessions. The cookie holds the opaque token; everything else is here.
CREATE TABLE sessions (
  token      TEXT    PRIMARY KEY,
  account_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
);

CREATE INDEX idx_sessions_expiry ON sessions (expires_at);

-- Newsletter subscribers, per blog. `token` powers one-click unsubscribe links.
CREATE TABLE subscribers (
  id         INTEGER PRIMARY KEY,
  tenant_id  INTEGER NOT NULL,
  email      TEXT    NOT NULL,
  token      TEXT    NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  UNIQUE (tenant_id, email),
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE INDEX idx_subscribers_tenant ON subscribers (tenant_id, created_at DESC);

-- Pending double-opt-in requests. Tokens are stored hashed and one pending
-- row per tenant/email prevents repeated requests from spamming confirmations.
CREATE TABLE subscriber_confirmations (
  tenant_id  INTEGER NOT NULL,
  email      TEXT    NOT NULL,
  token_hash TEXT    NOT NULL PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  sent_at    INTEGER NOT NULL,
  UNIQUE (tenant_id, email),
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);
CREATE INDEX idx_subscriber_confirmations_expiry ON subscriber_confirmations (expires_at);

CREATE TABLE subscription_manage_tokens (
  email TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_subscription_manage_tokens_token ON subscription_manage_tokens(token);

CREATE TABLE email_delivery_log (
  idempotency_key TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  recipient TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX idx_email_delivery_log_status ON email_delivery_log(status, created_at);

CREATE TABLE password_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX idx_password_reset_account ON password_reset_tokens(account_id, expires_at);

CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX idx_password_resets_account ON password_resets(account_id, expires_at);

CREATE TABLE ai_credit_usage (
  account_id INTEGER NOT NULL,
  period TEXT NOT NULL,
  credits_used INTEGER NOT NULL DEFAULT 0,
  allowance INTEGER NOT NULL DEFAULT 1000,
  PRIMARY KEY (account_id, period),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX idx_ai_credit_usage_period ON ai_credit_usage(period);

CREATE TABLE ai_credit_refunds (
  job_key TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  period TEXT NOT NULL,
  credits INTEGER NOT NULL,
  refunded_at INTEGER NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE marketing_audio_state (
  asset_key TEXT PRIMARY KEY,
  generating_at INTEGER NOT NULL
);

CREATE TABLE pronunciation_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT NOT NULL UNIQUE COLLATE NOCASE,
  spoken TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_pronunciation_overrides_enabled ON pronunciation_overrides(enabled, term);

INSERT OR IGNORE INTO pronunciation_overrides (term, spoken, enabled, created_at, updated_at)
VALUES
  ('AI', 'aiye eye', 1, strftime('%s', 'now'), strftime('%s', 'now')),
  ('UI', 'U I', 1, strftime('%s', 'now'), strftime('%s', 'now')),
  ('API', 'A P I', 1, strftime('%s', 'now'), strftime('%s', 'now')),
  ('PNG', 'P N G', 1, strftime('%s', 'now'), strftime('%s', 'now')),
  ('URL', 'U R L', 1, strftime('%s', 'now'), strftime('%s', 'now')),
  ('US', 'U S', 1, strftime('%s', 'now'), strftime('%s', 'now')),
  ('calmer', 'carlmar', 1, strftime('%s', 'now'), strftime('%s', 'now')),
  ('formatting', 'format-ting', 1, strftime('%s', 'now'), strftime('%s', 'now')),
  ('login', 'log in', 1, strftime('%s', 'now'), strftime('%s', 'now'));
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL,
  endpoint_hash TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT 'new-post',
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_success_at INTEGER,
  last_push_campaign_id TEXT,
  UNIQUE (tenant_id, endpoint_hash, topic),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_tenant_id ON push_subscriptions(tenant_id, topic, id);

CREATE TABLE IF NOT EXISTS push_deliveries (
  campaign_id TEXT NOT NULL,
  subscription_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,
  sent_at INTEGER,
  PRIMARY KEY (campaign_id, subscription_id),
  FOREIGN KEY (subscription_id) REFERENCES push_subscriptions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS push_campaigns (
  campaign_id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  topic TEXT NOT NULL,
  post_slug TEXT NOT NULL,
  post_title TEXT NOT NULL,
  post_excerpt TEXT NOT NULL DEFAULT '',
  max_subscription_id INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_push_campaigns_tenant_status ON push_campaigns(tenant_id, status, created_at);

CREATE TABLE IF NOT EXISTS push_subscription_limits (
  tenant_id INTEGER NOT NULL,
  ip_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, ip_hash, window_start),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- Staff expansion v2 (052)
ALTER TABLE accounts ADD COLUMN signup_ip TEXT;
ALTER TABLE accounts ADD COLUMN signup_ua TEXT;
ALTER TABLE accounts ADD COLUMN signup_referer TEXT;
ALTER TABLE accounts ADD COLUMN signup_country TEXT;
ALTER TABLE accounts ADD COLUMN locked_until INTEGER;
ALTER TABLE accounts ADD COLUMN deleted_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_accounts_deleted ON accounts(deleted_at);
ALTER TABLE sessions ADD COLUMN ip TEXT;
ALTER TABLE sessions ADD COLUMN user_agent TEXT;
ALTER TABLE sessions ADD COLUMN created_via TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_ip ON sessions(ip, created_at DESC);
CREATE TABLE IF NOT EXISTS account_activity (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_account_activity_account ON account_activity(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_activity_kind ON account_activity(kind, created_at DESC);
CREATE TABLE IF NOT EXISTS account_notes (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  author_subject TEXT NOT NULL,
  author_email TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_account_notes_account ON account_notes(account_id, created_at DESC);
CREATE TABLE IF NOT EXISTS staff_impersonation_tokens (
  token TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  issued_by_subject TEXT NOT NULL,
  issued_by_email TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_impersonation_account ON staff_impersonation_tokens(account_id, expires_at);
CREATE TABLE IF NOT EXISTS staff_rate_limit_overrides (
  account_id INTEGER PRIMARY KEY,
  max_logins_per_hour INTEGER,
  max_signups_per_hour INTEGER,
  max_api_per_minute INTEGER,
  note TEXT,
  updated_by_subject TEXT,
  updated_by_email TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- Affiliate offer funnel experiments (054)
CREATE TABLE funnel_experiments (
  experiment_key TEXT PRIMARY KEY,
  route TEXT NOT NULL CHECK (route = 'affiliate_offer'),
  status TEXT NOT NULL CHECK (status IN ('draft', 'running', 'paused', 'completed')),
  control_variant TEXT NOT NULL,
  treatment_variant TEXT NOT NULL,
  treatment_allocation_basis_points INTEGER NOT NULL CHECK (treatment_allocation_basis_points BETWEEN 0 AND 10000),
  control_presentation_version TEXT NOT NULL,
  treatment_presentation_version TEXT NOT NULL,
  required_sample_per_variant INTEGER CHECK (required_sample_per_variant IS NULL OR required_sample_per_variant > 0),
  baseline_rate REAL CHECK (baseline_rate IS NULL OR (baseline_rate > 0 AND baseline_rate < 1)),
  minimum_detectable_relative_uplift REAL CHECK (minimum_detectable_relative_uplift IS NULL OR minimum_detectable_relative_uplift > 0),
  winner_variant TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  stopped_at INTEGER,
  CHECK (control_variant != treatment_variant),
  CHECK (winner_variant IS NULL OR winner_variant IN (control_variant, treatment_variant)),
  CHECK (status != 'running' OR started_at IS NOT NULL)
);
CREATE UNIQUE INDEX idx_one_running_affiliate_offer_experiment
  ON funnel_experiments(route) WHERE status = 'running';
CREATE TABLE funnel_experiment_assignments (
  journey_id TEXT PRIMARY KEY CHECK (length(journey_id) BETWEEN 20 AND 96),
  experiment_key TEXT NOT NULL,
  variant TEXT NOT NULL,
  affiliate_id INTEGER NOT NULL,
  policy_version TEXT NOT NULL,
  assigned_at INTEGER NOT NULL,
  exposed_at INTEGER,
  cta_clicked_at INTEGER,
  account_id INTEGER,
  signup_at INTEGER,
  checkout_started_at INTEGER,
  excluded_at INTEGER,
  exclusion_reason TEXT,
  CHECK ((excluded_at IS NULL AND exclusion_reason IS NULL) OR (excluded_at IS NOT NULL AND length(trim(exclusion_reason)) > 0)),
  CHECK (signup_at IS NULL OR account_id IS NOT NULL),
  FOREIGN KEY (experiment_key) REFERENCES funnel_experiments(experiment_key) ON DELETE RESTRICT,
  FOREIGN KEY (affiliate_id) REFERENCES affiliate_profiles(account_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX idx_funnel_experiment_account
  ON funnel_experiment_assignments(experiment_key, account_id) WHERE account_id IS NOT NULL;
CREATE INDEX idx_funnel_experiment_results
  ON funnel_experiment_assignments(experiment_key, variant, exposed_at);

CREATE TABLE funnel_experiment_conversions (
  experiment_key        TEXT NOT NULL,
  account_id            INTEGER NOT NULL,
  journey_id            TEXT NOT NULL,
  variant               TEXT NOT NULL,
  occurrence_id         TEXT NOT NULL UNIQUE,
  provider              TEXT NOT NULL CHECK (provider IN ('stripe', 'nowpayments')),
  source_key            TEXT NOT NULL,
  cadence               TEXT NOT NULL CHECK (cadence IN ('monthly', 'annual')),
  eligible_revenue_minor INTEGER NOT NULL CHECK (eligible_revenue_minor >= 0),
  currency              TEXT NOT NULL,
  converted_at          INTEGER NOT NULL,
  PRIMARY KEY (experiment_key, account_id),
  UNIQUE (provider, source_key),
  FOREIGN KEY (experiment_key) REFERENCES funnel_experiments(experiment_key) ON DELETE RESTRICT,
  FOREIGN KEY (journey_id) REFERENCES funnel_experiment_assignments(journey_id) ON DELETE RESTRICT,
  FOREIGN KEY (occurrence_id) REFERENCES affiliate_revenue_occurrences(id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT
);

CREATE INDEX idx_funnel_experiment_conversions_results
  ON funnel_experiment_conversions(experiment_key, variant, converted_at);
