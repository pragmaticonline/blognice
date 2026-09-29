-- Per-blog theme (INDEX database). 'modern' (default, current look) or
-- 'classic' (old-Blogspot-inspired look) for the public blog pages.
-- Target: blognice.
ALTER TABLE tenants ADD COLUMN theme TEXT NOT NULL DEFAULT 'modern';
