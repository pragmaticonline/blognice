-- Reader profile photos for comments (POSTS database). The comments key is
-- copied from the identity at insert; the identity key is the source of
-- truth for future comments. Keys point at R2 MEDIA under avatars/ and are
-- server-minted on upload, never client-supplied. NULL means the
-- name-derived initial circle. Target: blognice-posts. Forward-only.
ALTER TABLE comments ADD COLUMN avatar_key TEXT;
ALTER TABLE comment_identities ADD COLUMN avatar_key TEXT;
