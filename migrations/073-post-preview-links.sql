-- Shareable draft preview links (POSTS database). Lets owners open drafts on
-- any host (including custom domains, which never carry the owner session).
-- Target: blognice-posts. Forward-only like the other column migrations.
-- A NULL hash means no link is minted; the stored value is the sha-256 of
-- the token in the URL, never the token itself.
ALTER TABLE posts ADD COLUMN preview_token_hash TEXT;
ALTER TABLE posts ADD COLUMN preview_token_expires_at INTEGER;
