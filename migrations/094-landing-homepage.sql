-- Landing page homepage pointer + per-account access override (INDEX
-- database). home_landing_page_id is a soft pointer into the posts DB
-- (no cross-database FK): the render path treats a dangling value as
-- "blog is homepage".
-- Target: blognice.
ALTER TABLE tenants ADD COLUMN home_landing_page_id INTEGER;
ALTER TABLE accounts ADD COLUMN landing_access_override INTEGER NOT NULL DEFAULT 0;
