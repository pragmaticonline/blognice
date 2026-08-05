-- Staff administration phase 1.
-- Run against the index database (blognice) before deploying the staff Worker.

ALTER TABLE accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE accounts ADD COLUMN status_reason TEXT;
ALTER TABLE accounts ADD COLUMN status_changed_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status, created_at DESC);

CREATE TABLE IF NOT EXISTS staff_users (
  subject TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'read_only',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS staff_audit_events (
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

CREATE INDEX IF NOT EXISTS idx_staff_audit_occurred ON staff_audit_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_audit_target ON staff_audit_events(target_type, target_id, occurred_at DESC);
