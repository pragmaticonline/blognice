-- Blog comments tables (POSTS database). Comments are unbounded tenant
-- content, so they live with posts, never in the index database.
-- Target: blognice-posts.
CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY,
  tenant_id   INTEGER NOT NULL,
  post_id     INTEGER NOT NULL,
  parent_id   INTEGER,
  author_name TEXT    NOT NULL,
  email_hash  TEXT    NOT NULL,
  body        TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'approved',
  created_at  INTEGER NOT NULL,
  decided_at  INTEGER,
  UNIQUE (tenant_id, post_id, id)
);
CREATE INDEX IF NOT EXISTS idx_comments_listing ON comments (tenant_id, post_id, status, id);
CREATE INDEX IF NOT EXISTS idx_comments_moderation ON comments (tenant_id, status, created_at);
CREATE TABLE IF NOT EXISTS comment_identities (
  tenant_id   INTEGER NOT NULL,
  email_hash  TEXT    NOT NULL,
  author_name TEXT    NOT NULL,
  token_hash  TEXT,                          -- pending verification/recovery token (sha-256 hex), NULL when none
  token_expires_at INTEGER,                  -- unix seconds; verification links live 24 hours
  cookie_hash TEXT,                          -- sha-256 of the bn_comment browser cookie, set on verify
  verified_at INTEGER,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, email_hash)
);
CREATE TABLE IF NOT EXISTS comment_attempts (
  tenant_id   INTEGER NOT NULL,
  email_hash  TEXT    NOT NULL,
  kind        TEXT    NOT NULL,              -- 'start' (verification requested) or 'submit' (comment posted)
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comment_attempts ON comment_attempts (tenant_id, email_hash, created_at);
