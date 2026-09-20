-- Reader abuse reports on comments (POSTS database, alongside comments).
-- Target: blognice-posts.
CREATE TABLE IF NOT EXISTS comment_reports (
  id            INTEGER PRIMARY KEY,
  tenant_id     INTEGER NOT NULL,
  post_id       INTEGER NOT NULL,
  comment_id    INTEGER NOT NULL,
  reason        TEXT    NOT NULL,              -- spam | harassment | other
  reporter_hash TEXT    NOT NULL,              -- comment-cookie hash, or 'anonymous'
  status        TEXT    NOT NULL DEFAULT 'open', -- open | dismissed | actioned
  created_at    INTEGER NOT NULL,
  decided_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_comment_reports_queue ON comment_reports (status, created_at);
CREATE INDEX IF NOT EXISTS idx_comment_reports_comment ON comment_reports (tenant_id, comment_id);
