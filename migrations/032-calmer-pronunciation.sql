-- Use the pronunciation confirmed in the staff TTS tester.
INSERT INTO pronunciation_overrides (term, spoken, enabled, created_at, updated_at)
VALUES ('calmer', 'carlmar', 1, strftime('%s', 'now'), strftime('%s', 'now'))
ON CONFLICT(term) DO UPDATE SET spoken = excluded.spoken, enabled = 1, updated_at = excluded.updated_at;
