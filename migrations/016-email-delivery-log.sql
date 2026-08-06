-- Best-effort idempotency state for queued transactional email deliveries.
CREATE TABLE IF NOT EXISTS email_delivery_log (
  idempotency_key TEXT PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'pending',
  recipient       TEXT NOT NULL,
  kind            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_email_delivery_log_status
  ON email_delivery_log (status, created_at);
