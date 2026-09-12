-- Autopilot run source diagnostics: how many Brave results came back (raw)
-- and how many survived domain filtering (kept) before path/dedup checks.
ALTER TABLE autopilot_runs ADD COLUMN search_raw_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE autopilot_runs ADD COLUMN search_kept_count INTEGER NOT NULL DEFAULT 0;
