-- Resync past comment photos to current profile photos (POSTS database).
-- Photo uploads and removals before the restamp fix left comment rows
-- behind: NULL photos where the identity has one, and keys whose R2 objects
-- were deleted on replace. Copy the current identity key onto exactly the
-- rows that disagree; rows already in sync are untouched.
-- Target: blognice-posts. Forward-only.
UPDATE comments SET avatar_key = (
  SELECT i.avatar_key FROM comment_identities i
  WHERE i.tenant_id = comments.tenant_id AND i.email_hash = comments.email_hash
)
WHERE EXISTS (
  SELECT 1 FROM comment_identities i
  WHERE i.tenant_id = comments.tenant_id
    AND i.email_hash = comments.email_hash
    AND i.avatar_key IS NOT comments.avatar_key
);
