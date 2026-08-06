-- Monthly AI credit allowance for paid accounts (index DB: blognice).
CREATE TABLE IF NOT EXISTS ai_credit_usage (
  account_id INTEGER NOT NULL,
  period TEXT NOT NULL,
  credits_used INTEGER NOT NULL DEFAULT 0,
  allowance INTEGER NOT NULL DEFAULT 1000,
  PRIMARY KEY (account_id, period),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ai_credit_usage_period ON ai_credit_usage(period);
