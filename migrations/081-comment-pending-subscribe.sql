-- Pending updates subscription on comment verification (POSTS database).
-- A ticked box stores the address here at verification-request time so the
-- verification click can confirm the subscription directly: one email
-- proves ownership and intent instead of two. Consumed (nulled) on verify.
-- Target: blognice-posts. Forward-only.
ALTER TABLE comment_identities ADD COLUMN pending_subscribe_email TEXT;
