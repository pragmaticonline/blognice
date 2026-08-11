-- Apply this migration to blognice-posts. It makes post notification fan-out idempotent.
ALTER TABLE posts ADD COLUMN push_notification_sent INTEGER NOT NULL DEFAULT 0;
UPDATE posts SET push_notification_sent = 1 WHERE published = 1;
