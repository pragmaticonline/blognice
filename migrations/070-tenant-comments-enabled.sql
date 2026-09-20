-- Per-blog comments switch, defaulting off. Mirrors browser_push_enabled.
-- Target: blognice (index database).
ALTER TABLE tenants ADD COLUMN comments_enabled INTEGER NOT NULL DEFAULT 0;
