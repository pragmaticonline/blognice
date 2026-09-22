-- Comment likes/dislikes (POSTS database). One vote row per reader per
-- comment; the likes/dislikes counters on comments keep listings free of
-- COUNT(*) queries. Counters are adjusted in the same batch as the vote
-- row so the two never drift. Clients send absolute desired state
-- (1 = like, -1 = dislike, 0 = clear), so retries converge.
-- Target: blognice-posts. Forward-only.
ALTER TABLE comments ADD COLUMN likes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comments ADD COLUMN dislikes INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS comment_votes (
  tenant_id   INTEGER NOT NULL,
  comment_id  INTEGER NOT NULL,
  email_hash  TEXT    NOT NULL,
  vote        INTEGER NOT NULL,                  -- 1 like, -1 dislike
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, comment_id, email_hash)
);
CREATE INDEX IF NOT EXISTS idx_comment_votes_comment ON comment_votes (tenant_id, comment_id);
