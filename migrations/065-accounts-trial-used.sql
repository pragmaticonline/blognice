-- One free trial per account: stamped when a trialing subscription starts,
-- consulted at checkout so cancel-then-resubscribe never grants a second trial.
ALTER TABLE accounts ADD COLUMN trial_used_at INTEGER;
