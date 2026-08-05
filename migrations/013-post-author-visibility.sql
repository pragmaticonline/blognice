-- Allow a post to retain its internal author for permissions while displaying
-- only the blog identity publicly.
ALTER TABLE posts ADD COLUMN author_visible INTEGER NOT NULL DEFAULT 1;
