-- Evergreen pages live separately from posts so they do not enter feeds,
-- subscriber notifications, or popularity calculations.
CREATE TABLE IF NOT EXISTS pages (
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

CREATE INDEX IF NOT EXISTS idx_pages_tenant_pub
  ON pages (tenant_id, published, navigation_order, title);
