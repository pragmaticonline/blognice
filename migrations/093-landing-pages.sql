-- Landing pages (POSTS database). Tenant content: design, structured
-- content JSON, published flag. Must be applied to EVERY posts shard
-- when more shards exist (see src/db.ts sharding seam).
-- Target: blognice-posts.
CREATE TABLE IF NOT EXISTS landing_pages (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  design TEXT NOT NULL DEFAULT 'hero',
  content_json TEXT NOT NULL DEFAULT '{}',
  meta_description TEXT,
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER,
  UNIQUE (tenant_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_landing_pages_tenant ON landing_pages (tenant_id, published);
