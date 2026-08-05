CREATE TABLE IF NOT EXISTS tenant_slug_aliases (
  old_slug TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tenant_slug_aliases_tenant ON tenant_slug_aliases(tenant_id);
