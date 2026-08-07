-- A published post may notify subscribers at most once.
-- Existing published posts are considered already notified so applying this
-- migration cannot send a historical email blast.
ALTER TABLE posts ADD COLUMN subscriber_notification_sent INTEGER NOT NULL DEFAULT 0;
UPDATE posts SET subscriber_notification_sent = 1 WHERE published = 1;
