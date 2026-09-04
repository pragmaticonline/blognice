-- VIP gifted membership equivalent to Pro. Staff-granted, not a Stripe purchase.
-- Also: per-account blog limit override for backend-granted extra blogs.
ALTER TABLE accounts ADD COLUMN vip_granted_at INTEGER;
ALTER TABLE accounts ADD COLUMN vip_expires_at INTEGER;
ALTER TABLE accounts ADD COLUMN vip_granted_by INTEGER REFERENCES accounts(id);
ALTER TABLE accounts ADD COLUMN vip_reason TEXT;
ALTER TABLE accounts ADD COLUMN max_blogs_override INTEGER;
CREATE INDEX IF NOT EXISTS idx_accounts_vip_expires_at ON accounts(vip_expires_at);
