-- Comments on by default (INDEX database). New blogs get comments_enabled=1
-- from the schema default and the creation inserts; this flips every
-- existing blog that lacks them. Owners can still switch comments off per
-- blog afterwards. Target: blognice. Forward-only.
UPDATE tenants SET comments_enabled = 1 WHERE comments_enabled = 0;
