-- Per-blog custom CSS for paid plans (INDEX database). Owner-supplied CSS is
-- appended after the built-in theme styles on public blog pages.
-- Target: blognice.
ALTER TABLE tenants ADD COLUMN custom_css TEXT NOT NULL DEFAULT '';
