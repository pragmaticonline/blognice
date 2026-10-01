-- Suspension appeals (INDEX database). Suspended users submit one pending
-- appeal at a time from /admin/appeal; staff approve/deny from the staff
-- console. A deny starts a cooldown (APPEAL_COOLDOWN_DAYS in code) before
-- the next appeal. Target: blognice.
CREATE TABLE suspension_appeals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  appeal_text TEXT NOT NULL,
  staff_note TEXT NOT NULL DEFAULT '',
  decided_by INTEGER NULL REFERENCES accounts(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  decided_at INTEGER NULL
);
CREATE INDEX idx_suspension_appeals_account ON suspension_appeals(account_id, created_at);
CREATE UNIQUE INDEX idx_suspension_appeals_pending ON suspension_appeals(account_id) WHERE status = 'pending';
