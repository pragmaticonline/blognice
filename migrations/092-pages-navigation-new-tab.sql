-- Pages in the blog header can choose to open in a new tab instead of the
-- same tab. 0 = same tab (previous behaviour for pages).
-- Target: blognice-posts.
ALTER TABLE pages ADD COLUMN navigation_new_tab INTEGER NOT NULL DEFAULT 0;
