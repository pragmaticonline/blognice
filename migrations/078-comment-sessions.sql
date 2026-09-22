-- Reader sessions for multi-device sign-in (POSTS database). The identity
-- used to hold a single cookie hash, so verifying a second device signed
-- out the first. Sessions are one row per verified cookie, keyed by the
-- reader's email hash; the lookup joins back to the identity. Existing
-- signed-in cookies are preserved. Target: blognice-posts. Forward-only.
CREATE TABLE IF NOT EXISTS comment_sessions (
  tenant_id   INTEGER NOT NULL,
  email_hash  TEXT    NOT NULL,
  cookie_hash TEXT    NOT NULL,                   -- sha-256 of one bn_comment browser cookie
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, cookie_hash)
);
CREATE INDEX IF NOT EXISTS idx_comment_sessions_identity ON comment_sessions (tenant_id, email_hash);
INSERT OR IGNORE INTO comment_sessions (tenant_id, email_hash, cookie_hash, created_at)
  SELECT tenant_id, email_hash, cookie_hash, verified_at
  FROM comment_identities WHERE cookie_hash IS NOT NULL;
