-- Reliability state for Stripe webhook retries and ordering.
ALTER TABLE stripe_events ADD COLUMN status TEXT NOT NULL DEFAULT 'processed';
ALTER TABLE stripe_events ADD COLUMN last_error TEXT;
ALTER TABLE accounts ADD COLUMN billing_event_created_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_stripe_events_status ON stripe_events(status, created_at);
