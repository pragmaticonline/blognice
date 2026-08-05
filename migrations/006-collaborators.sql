-- Collaborator memberships and invitation records.
CREATE TABLE IF NOT EXISTS blog_invitations (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  invited_by INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (invited_by) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_blog_invites_tenant ON blog_invitations(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_blog_invites_email ON blog_invitations(email, expires_at);
