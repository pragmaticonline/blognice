-- Reader-chosen avatar colour for comments (POSTS database).
-- Target: blognice-posts. Forward-only like the other column migrations:
-- NULL (or absent) means the name-derived hue, set by renderCommentSection.
ALTER TABLE comments ADD COLUMN avatar_hue INTEGER;
