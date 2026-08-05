-- Migration: single-blog `users` -> multi-blog `accounts` + `memberships`.
-- Safe to run once on an existing INDEX database. Preserves every login and
-- links it to the blog it currently owns. Existing sessions are cleared, so
-- everyone signs in again after this runs.
--
-- Apply with:
--   wrangler d1 execute blognice --remote --file=./migrations/001-accounts-multiblog.sql

-- 1. Accounts, carried over from users (same ids, emails, password hashes).
CREATE TABLE accounts (
  id         INTEGER PRIMARY KEY,
  email      TEXT    NOT NULL UNIQUE,
  pw_hash    TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT INTO accounts (id, email, pw_hash, created_at)
  SELECT id, email, pw_hash, created_at FROM users;

-- 2. Memberships: each old user owns their old tenant.
CREATE TABLE memberships (
  account_id INTEGER NOT NULL,
  tenant_id  INTEGER NOT NULL,
  role       TEXT    NOT NULL DEFAULT 'owner',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, tenant_id),
  FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id)  REFERENCES tenants (id)  ON DELETE CASCADE
);
INSERT INTO memberships (account_id, tenant_id, role, created_at)
  SELECT id, tenant_id, 'owner', created_at FROM users;

CREATE INDEX idx_memberships_account ON memberships (account_id);
CREATE INDEX idx_memberships_tenant  ON memberships (tenant_id);

-- 3. Sessions now reference accounts. Recreate (drops existing sessions).
DROP TABLE sessions;
CREATE TABLE sessions (
  token      TEXT    PRIMARY KEY,
  account_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
);
CREATE INDEX idx_sessions_expiry ON sessions (expires_at);

-- 4. Done with users.
DROP TABLE users;
