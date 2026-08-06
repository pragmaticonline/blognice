-- Use the pronunciation confirmed in the staff TTS tester.
UPDATE pronunciation_overrides
SET spoken = 'aiye eye', enabled = 1, updated_at = strftime('%s', 'now')
WHERE term = 'AI';
