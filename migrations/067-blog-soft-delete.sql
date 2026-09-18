-- Soft delete for blogs. Setting deleted_at removes the blog from the web
-- (public pages, listings, sitemaps, API) while keeping every row for later
-- expunge tooling. NULL = live.
ALTER TABLE tenants ADD COLUMN deleted_at INTEGER;
