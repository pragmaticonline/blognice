-- Preserve authorship for collaborator permissions and attribution.
ALTER TABLE posts ADD COLUMN author_account_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(tenant_id, author_account_id);
