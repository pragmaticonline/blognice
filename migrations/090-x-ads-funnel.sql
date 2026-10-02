-- X Ads funnel: click id on the attribution row plus the X-side
-- once-per-account conversion ledger. Target: blognice.
ALTER TABLE ads_attributions ADD COLUMN twclid TEXT;
CREATE TABLE IF NOT EXISTS x_ads_conversions (
  account_id     INTEGER PRIMARY KEY,
  transaction_id TEXT    NOT NULL,
  value_minor    INTEGER NOT NULL DEFAULT 0,
  currency       TEXT    NOT NULL DEFAULT 'USD',
  reported_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_x_ads_conversions_reported ON x_ads_conversions (reported_at);
