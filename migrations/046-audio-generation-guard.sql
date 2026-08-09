ALTER TABLE posts ADD COLUMN audio_generation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_posts_audio_generation
  ON posts (tenant_id, audio_generation_id);
