-- Blog Nice — POSTS database schema (binding: POSTS)
-- Holds only post bodies. This is a different database from the index, so it
-- has no foreign key to `tenants` (SQLite can't enforce cross-database FKs).
-- Integrity is maintained in code: every query is scoped by tenant_id, and
-- deleting a tenant also deletes their posts here (see src/db.ts / README).
-- Run with:  npm run db:init:posts        (remote)
--            npm run db:init:posts:local  (local dev)

DROP TABLE IF EXISTS posts;

CREATE TABLE posts (
  id         INTEGER PRIMARY KEY,
  tenant_id  INTEGER NOT NULL,                     -- references tenants.id in the INDEX database
  slug       TEXT    NOT NULL,                     -- url slug: /<slug>
  title      TEXT    NOT NULL,
  featured_image_key TEXT,                              -- optional R2 key used as the post's lead/list image
  audio_key  TEXT,                                      -- optional generated MP3 narration in R2
  body_md    TEXT    NOT NULL,                     -- the post, written in Markdown
  tags_json  TEXT    NOT NULL DEFAULT '[]',       -- normalized post tags
  published  INTEGER NOT NULL DEFAULT 1,           -- 1 = live, 0 = draft
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  author_account_id INTEGER,
  author_name TEXT,
  author_visible INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, slug)
);

-- Fast lookups for a tenant's published posts, newest first.
CREATE INDEX idx_posts_tenant_pub ON posts (tenant_id, published, created_at DESC);
CREATE INDEX idx_posts_author ON posts (tenant_id, author_account_id);
