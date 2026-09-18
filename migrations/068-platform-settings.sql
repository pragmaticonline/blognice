-- Platform-wide switches managed from the staff area (no deploy to flip).
-- Known keys: tts.engine = melotts (default) or aura-1.
CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
