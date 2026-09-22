-- Reader website addresses for comments (POSTS database). The comments
-- value is copied from the identity at insert; the identity value is the
-- source of truth for future comments and is backfilled onto past rows when
-- the reader saves settings. NULL means no link: the profile renders as
-- plain text and clicks keep their current behaviour. Values are normalized
-- to http(s) URLs server-side; never trust client-supplied schemes.
-- Target: blognice-posts. Forward-only.
ALTER TABLE comments ADD COLUMN website TEXT;
ALTER TABLE comment_identities ADD COLUMN website TEXT;
