-- Order subscription replacements by the Stripe subscription's own creation
-- time, rather than webhook delivery time. This prevents a delayed Checkout
-- event for an older subscription from replacing the current subscription.
ALTER TABLE accounts ADD COLUMN billing_subscription_created_at INTEGER;
