-- Make the AI acronym distinct in MeloTTS narration (index DB: blognice).
UPDATE pronunciation_overrides
SET spoken = 'A eye', enabled = 1, updated_at = strftime('%s', 'now')
WHERE term = 'AI';

INSERT OR IGNORE INTO pronunciation_overrides (term, spoken, enabled, created_at, updated_at)
VALUES ('AI', 'A eye', 1, strftime('%s', 'now'), strftime('%s', 'now'));
