-- Keep comparable Stripe event streams ordered independently.
ALTER TABLE accounts ADD COLUMN billing_subscription_event_created_at INTEGER;
ALTER TABLE accounts ADD COLUMN billing_invoice_event_created_at INTEGER;

CREATE TABLE IF NOT EXISTS ai_credit_refunds (
  job_key TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  period TEXT NOT NULL,
  credits INTEGER NOT NULL,
  refunded_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS marketing_audio_state (
  asset_key TEXT PRIMARY KEY,
  generating_at INTEGER NOT NULL
);

UPDATE pronunciation_overrides SET spoken = 'aiye eye', updated_at = strftime('%s', 'now') WHERE term = 'AI';
INSERT OR IGNORE INTO pronunciation_overrides (term, spoken, enabled, created_at, updated_at)
VALUES
  ('calmer', 'carlmar', 1, strftime('%s', 'now'), strftime('%s', 'now')),
  ('formatting', 'format-ting', 1, strftime('%s', 'now'), strftime('%s', 'now')),
  ('login', 'log in', 1, strftime('%s', 'now'), strftime('%s', 'now'));
