ALTER TABLE accounts ADD COLUMN crypto_paid_through INTEGER;

CREATE TABLE IF NOT EXISTS crypto_payments (
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

CREATE INDEX IF NOT EXISTS idx_crypto_payments_account ON crypto_payments(account_id, created_at DESC);
