-- Post scheduling: future publish time on drafts, claimed by the per-minute
-- tick. NULL means unscheduled; published posts always have NULL.
-- Target: blognice-posts.
ALTER TABLE posts ADD COLUMN scheduled_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_posts_scheduled ON posts (published, scheduled_at);
