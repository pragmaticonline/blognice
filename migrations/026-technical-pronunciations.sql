-- Technical terms that MeloTTS commonly misreads.
INSERT OR IGNORE INTO pronunciation_overrides (term, spoken, enabled, created_at, updated_at)
VALUES
  ('PBKDF2-HMAC-SHA256', 'P B K D F two H M A C S H A two five six', 1, strftime('%s', 'now'), strftime('%s', 'now')),
  ('SHA256', 'S H A two five six', 1, strftime('%s', 'now'), strftime('%s', 'now')),
  ('OWASP', 'O Wasp', 1, strftime('%s', 'now'), strftime('%s', 'now')),
  ('CPU', 'C P U', 1, strftime('%s', 'now'), strftime('%s', 'now'));
