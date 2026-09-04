-- Postal/MailNice bounce and complaint suppression per tenant.
CREATE TABLE IF NOT EXISTS email_suppressions (
  email TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('email_bounced','email_complained')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (email, tenant_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_email_suppressions_tenant ON email_suppressions(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_suppressions_email ON email_suppressions(email);
