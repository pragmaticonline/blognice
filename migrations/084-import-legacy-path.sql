-- Legacy import URLs (POSTS database). Records the original public path of an
-- imported item (for Blogger: /YYYY/MM/slug.html for posts, /p/slug.html for
-- pages) so old links 301 to the new address instead of breaking.
-- Target: blognice-posts.
ALTER TABLE import_records ADD COLUMN legacy_path TEXT;
CREATE INDEX IF NOT EXISTS idx_import_records_legacy ON import_records (tenant_id, legacy_path);
