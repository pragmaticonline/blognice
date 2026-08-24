-- Staff expansion: search, activity, impersonation, notes, related-account signals, rate limits
-- Apply to INDEX database (blognice) before deploying staff Worker v2

-- Creation signals (for staff "source/referral" view). Back-filled as NULL for existing rows.
ALTER TABLE accounts ADD COLUMN signup_ip TEXT;
ALTER TABLE accounts ADD COLUMN signup_ua TEXT;
ALTER TABLE accounts ADD COLUMN signup_referer TEXT;
ALTER TABLE accounts ADD COLUMN signup_country TEXT;

-- Soft lock + soft delete markers (hard delete remains available via staff API)
ALTER TABLE accounts ADD COLUMN locked_until INTEGER;
ALTER TABLE accounts ADD COLUMN deleted_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_accounts_deleted ON accounts(deleted_at);

-- Session attribution (IP / device). Existing rows remain NULL.
ALTER TABLE sessions ADD COLUMN ip TEXT;
ALTER TABLE sessions ADD COLUMN user_agent TEXT;
ALTER TABLE sessions ADD COLUMN created_via TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_ip ON sessions(ip, created_at DESC);

-- Lightweight activity ledger (staff-visible). Complements existing tables (posts live in POSTS DB, domains/stripe in INDEX).
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

-- Internal staff-only notes on an account
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

-- One-time impersonation grants issued by staff; consumed by the main Worker at /admin/impersonate
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

-- Optional per-account rate-limit overrides managed by staff (NULL = global default)
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
