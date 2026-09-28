-- Paid-ads funnel ledger (INDEX database). Stores Google click attribution
-- captured at signup and the once-per-account ads conversion record, so the
-- Google Ads conversion event fires exactly once per paying account and
-- refreshes, failures, and repeat subscriptions never re-fire it.
-- Target: blognice.
CREATE TABLE IF NOT EXISTS ads_attributions (
  account_id  INTEGER PRIMARY KEY,
  gclid       TEXT,
  gbraid      TEXT,
  wbraid      TEXT,
  landing_path TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ads_conversions (
  account_id     INTEGER PRIMARY KEY,
  transaction_id TEXT    NOT NULL,
  value_minor    INTEGER NOT NULL DEFAULT 0,
  currency       TEXT    NOT NULL DEFAULT 'USD',
  reported_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ads_conversions_reported ON ads_conversions (reported_at);
