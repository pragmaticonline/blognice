-- Require readers to confirm ownership of an email address before receiving
-- subscriber notifications. Existing subscribers remain active.
ALTER TABLE subscribers ADD COLUMN confirmed_at INTEGER;
UPDATE subscribers SET confirmed_at = created_at WHERE confirmed_at IS NULL;

CREATE TABLE IF NOT EXISTS subscriber_confirmations (
  tenant_id  INTEGER NOT NULL,
  email      TEXT    NOT NULL,
  token_hash TEXT    NOT NULL PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  sent_at    INTEGER NOT NULL,
  UNIQUE (tenant_id, email),
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_subscriber_confirmations_expiry
  ON subscriber_confirmations (expires_at);
