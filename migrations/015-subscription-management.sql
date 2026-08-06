-- Bearer tokens for a private, email-specific subscription preferences page.
CREATE TABLE IF NOT EXISTS subscription_manage_tokens (
  email      TEXT PRIMARY KEY,
  token      TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscription_manage_tokens_token
  ON subscription_manage_tokens (token);
