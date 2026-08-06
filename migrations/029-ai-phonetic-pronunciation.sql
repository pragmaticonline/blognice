-- Use an explicit phonetic form for AI in MeloTTS narration (index DB: blognice).
UPDATE pronunciation_overrides
SET spoken = 'Aye-eye', enabled = 1, updated_at = strftime('%s', 'now')
WHERE term = 'AI';
