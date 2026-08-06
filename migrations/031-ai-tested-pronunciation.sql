-- Use the pronunciation confirmed in the staff TTS test tool.
UPDATE pronunciation_overrides
SET spoken = 'eAy eye', enabled = 1, updated_at = strftime('%s', 'now')
WHERE term = 'AI';
