-- Add optional generated narration to existing post databases.
-- Apply once to every production posts database before deploying this version.

ALTER TABLE posts ADD COLUMN audio_key TEXT;
