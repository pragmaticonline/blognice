-- Blog Nice — POSTS database schema (binding: POSTS)
-- Holds only post bodies. This is a different database from the index, so it
-- has no foreign key to `tenants` (SQLite can't enforce cross-database FKs).
-- Integrity is maintained in code: every query is scoped by tenant_id, and
-- deleting a tenant also deletes their posts here (see src/db.ts / README).
-- Run with:  npm run db:init:posts        (remote)
--            npm run db:init:posts:local  (local dev)

DROP TABLE IF EXISTS posts;
DROP TABLE IF EXISTS pages;

CREATE TABLE posts (
  id         INTEGER PRIMARY KEY,
  tenant_id  INTEGER NOT NULL,                     -- references tenants.id in the INDEX database
  slug       TEXT    NOT NULL,                     -- url slug: /<slug>
  title      TEXT    NOT NULL,
  featured_image_key TEXT,                              -- optional R2 key used as the post's lead/list image
  audio_key  TEXT,                                      -- optional generated MP3 narration in R2
  audio_generation_id TEXT,                             -- active narration job; invalidated on removal
  body_md    TEXT    NOT NULL,                     -- the post, written in Markdown
  tags_json  TEXT    NOT NULL DEFAULT '[]',       -- normalized post tags
  published  INTEGER NOT NULL DEFAULT 1,           -- 1 = live, 0 = draft
  subscriber_notification_sent INTEGER NOT NULL DEFAULT 0, -- one subscriber campaign per post
  push_notification_sent INTEGER NOT NULL DEFAULT 0, -- one browser-push campaign per post; existing live posts are backfilled by migration
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  author_account_id INTEGER,
  author_name TEXT,
  author_visible INTEGER NOT NULL DEFAULT 1,
  meta_description TEXT,
  preview_token_hash TEXT,                       -- sha-256 of a draft preview token (see 073)
  preview_token_expires_at INTEGER,              -- unix seconds; NULL means no link minted
  UNIQUE (tenant_id, slug)
);

-- Fast lookups for a tenant's published posts, newest first.
CREATE INDEX idx_posts_tenant_pub ON posts (tenant_id, published, created_at DESC);
CREATE INDEX idx_posts_author ON posts (tenant_id, author_account_id);

CREATE TABLE pages (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  body_md TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 0,
  show_in_navigation INTEGER NOT NULL DEFAULT 0,
  navigation_label TEXT,
  navigation_order INTEGER NOT NULL DEFAULT 0,
  meta_description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER,
  UNIQUE (tenant_id, slug)
);

CREATE INDEX idx_pages_tenant_pub ON pages (tenant_id, published, navigation_order, title);

-- Blog comments (see migrations/069-comments.sql). Unbounded tenant content
-- lives in this database, never in the index database.
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
  avatar_hue  INTEGER,                          -- reader-chosen colour, NULL = name-derived (see 072)
  avatar_key  TEXT,                             -- R2 profile photo key, NULL = no photo (see 074)
  website     TEXT,                             -- reader site, NULL = no profile link (see 075)
  likes       INTEGER NOT NULL DEFAULT 0,       -- like count, adjusted with comment_votes (see 076)
  dislikes    INTEGER NOT NULL DEFAULT 0,       -- dislike count, adjusted with comment_votes (see 076)
  UNIQUE (tenant_id, post_id, id)
);
CREATE TABLE IF NOT EXISTS comment_votes (
  tenant_id   INTEGER NOT NULL,
  comment_id  INTEGER NOT NULL,
  email_hash  TEXT    NOT NULL,
  vote        INTEGER NOT NULL,                  -- 1 like, -1 dislike
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, comment_id, email_hash)
);
CREATE INDEX IF NOT EXISTS idx_comment_votes_comment ON comment_votes (tenant_id, comment_id);
CREATE INDEX IF NOT EXISTS idx_comments_listing ON comments (tenant_id, post_id, status, id);
CREATE INDEX IF NOT EXISTS idx_comments_moderation ON comments (tenant_id, status, created_at);
CREATE TABLE IF NOT EXISTS comment_identities (
  tenant_id   INTEGER NOT NULL,
  email_hash  TEXT    NOT NULL,
  author_name TEXT    NOT NULL,
  token_hash  TEXT,                          -- pending verification/recovery token (sha-256 hex), NULL when none
  token_expires_at INTEGER,                  -- unix seconds; verification links live 24 hours
  cookie_hash TEXT,                          -- legacy single-device cookie, superseded by comment_sessions (see 078)
  pending_subscribe_email TEXT,              -- updates address awaiting verification-click confirm (see 081)
  verified_at INTEGER,
  avatar_key  TEXT,                            -- R2 MEDIA key under avatars/, NULL means the initial circle (see 074)
  website     TEXT,                            -- normalized http(s) URL, NULL = no profile link (see 075)
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, email_hash)
);
CREATE TABLE IF NOT EXISTS comment_sessions (
  tenant_id   INTEGER NOT NULL,
  email_hash  TEXT    NOT NULL,
  cookie_hash TEXT    NOT NULL,                   -- sha-256 of one bn_comment browser cookie
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, cookie_hash)
);
CREATE INDEX IF NOT EXISTS idx_comment_sessions_identity ON comment_sessions (tenant_id, email_hash);
CREATE TABLE IF NOT EXISTS comment_attempts (
  tenant_id   INTEGER NOT NULL,
  email_hash  TEXT    NOT NULL,
  kind        TEXT    NOT NULL,              -- 'start' (verification requested) or 'submit' (comment posted)
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comment_attempts ON comment_attempts (tenant_id, email_hash, created_at);
CREATE TABLE IF NOT EXISTS comment_reports (
  id            INTEGER PRIMARY KEY,
  tenant_id     INTEGER NOT NULL,
  post_id       INTEGER NOT NULL,
  comment_id    INTEGER NOT NULL,
  reason        TEXT    NOT NULL,
  reporter_hash TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'open',
  created_at    INTEGER NOT NULL,
  decided_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_comment_reports_queue ON comment_reports (status, created_at);
CREATE INDEX IF NOT EXISTS idx_comment_reports_comment ON comment_reports (tenant_id, comment_id);
