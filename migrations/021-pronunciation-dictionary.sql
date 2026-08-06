-- Staff-managed global pronunciation overrides (index DB: blognice).
CREATE TABLE IF NOT EXISTS pronunciation_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT NOT NULL UNIQUE COLLATE NOCASE,
  spoken TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pronunciation_overrides_enabled
  ON pronunciation_overrides(enabled, term);

-- Seed the acronym rules that are useful to edit from the staff UI.
INSERT OR IGNORE INTO pronunciation_overrides (term, spoken, enabled, created_at, updated_at)
VALUES
  ('AI', 'A I', 1, strftime('%s', 'now'), strftime('%s', 'now')),
  ('UI', 'U I', 1, strftime('%s', 'now'), strftime('%s', 'now')),
  ('API', 'A P I', 1, strftime('%s', 'now'), strftime('%s', 'now')),
  ('HTML', 'H T M L', 1, strftime('%s', 'now'), strftime('%s', 'now')),
  ('HTTP', 'H T T P', 1, strftime('%s', 'now'), strftime('%s', 'now')),
  ('HTTPS', 'H T T P S', 1, strftime('%s', 'now'), strftime('%s', 'now')),
  ('PNG', 'P N G', 1, strftime('%s', 'now'), strftime('%s', 'now')),
  ('URL', 'U R L', 1, strftime('%s', 'now'), strftime('%s', 'now')),
  ('UK', 'U K', 1, strftime('%s', 'now'), strftime('%s', 'now')),
  ('US', 'U S', 1, strftime('%s', 'now'), strftime('%s', 'now'));
