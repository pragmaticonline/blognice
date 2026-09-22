-- Resync past comment names and sites to current identity values (POSTS
-- database). Name/site changes via re-verification never restamped comment
-- rows, so history could disagree with the identity (and with newer rows).
-- Copy the current identity values onto exactly the rows that disagree;
-- rows already in sync are untouched. Target: blognice-posts. Forward-only.
UPDATE comments SET author_name = (
  SELECT i.author_name FROM comment_identities i
  WHERE i.tenant_id = comments.tenant_id AND i.email_hash = comments.email_hash
), website = (
  SELECT i.website FROM comment_identities i
  WHERE i.tenant_id = comments.tenant_id AND i.email_hash = comments.email_hash
)
WHERE EXISTS (
  SELECT 1 FROM comment_identities i
  WHERE i.tenant_id = comments.tenant_id
    AND i.email_hash = comments.email_hash
    AND (i.author_name IS NOT comments.author_name OR i.website IS NOT comments.website)
);
