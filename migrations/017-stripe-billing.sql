ALTER TABLE accounts ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE accounts ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE accounts ADD COLUMN billing_status TEXT NOT NULL DEFAULT 'inactive';
ALTER TABLE accounts ADD COLUMN billing_price_id TEXT;
ALTER TABLE accounts ADD COLUMN billing_period_end INTEGER;
ALTER TABLE accounts ADD COLUMN billing_cancel_at_period_end INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN billing_updated_at INTEGER;

CREATE UNIQUE INDEX idx_accounts_stripe_customer ON accounts (stripe_customer_id);
CREATE UNIQUE INDEX idx_accounts_stripe_subscription ON accounts (stripe_subscription_id);

CREATE TABLE IF NOT EXISTS stripe_events (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  processed_at INTEGER NOT NULL,
  account_id   INTEGER,
  FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE SET NULL
);

CREATE INDEX idx_stripe_events_account ON stripe_events (account_id, processed_at DESC);
