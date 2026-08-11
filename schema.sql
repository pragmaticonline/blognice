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
  browser_push_enabled INTEGER NOT NULL DEFAULT 0, -- owner opt-in for reader notifications
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
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_accounts_api_key ON accounts (api_key_hash);
CREATE INDEX idx_accounts_status ON accounts (status, created_at DESC);
CREATE UNIQUE INDEX idx_accounts_stripe_customer ON accounts (stripe_customer_id);
CREATE UNIQUE INDEX idx_accounts_stripe_subscription ON accounts (stripe_subscription_id);

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
