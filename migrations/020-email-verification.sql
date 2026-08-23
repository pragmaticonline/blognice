-- Email verification + signup rate limiting (public launch)
-- Apply with: wrangler d1 execute blognice --remote --file=./migrations/020-email-verification.sql
ALTER TABLE accounts ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN email_verified_at INTEGER;
-- Backfill existing accounts as verified so current users aren't locked out
UPDATE accounts SET email_verified = 1, email_verified_at = COALESCE(created_at, strftime('%s','now')) WHERE email_verified = 0;
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
