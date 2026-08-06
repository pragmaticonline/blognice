-- Separate the AI initials with a short punctuation pause for MeloTTS.
UPDATE pronunciation_overrides
SET spoken = 'A, I', enabled = 1, updated_at = strftime('%s', 'now')
WHERE term = 'AI';
