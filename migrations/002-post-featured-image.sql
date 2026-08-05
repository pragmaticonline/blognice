-- Add one optional featured image to each post. Safe to run once on an
-- existing POSTS database.
--
-- Apply with:
--   wrangler d1 execute blognice-posts --remote --file=./migrations/002-post-featured-image.sql

ALTER TABLE posts ADD COLUMN featured_image_key TEXT;
