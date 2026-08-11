-- Browser push subscriptions live in the shared index database.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL,
  endpoint_hash TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT 'new-post',
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_success_at INTEGER,
  last_push_campaign_id TEXT,
  UNIQUE (tenant_id, endpoint_hash, topic),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_tenant_id
  ON push_subscriptions(tenant_id, topic, id);

CREATE TABLE IF NOT EXISTS push_deliveries (
  campaign_id TEXT NOT NULL,
  subscription_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,
  sent_at INTEGER,
  PRIMARY KEY (campaign_id, subscription_id),
  FOREIGN KEY (subscription_id) REFERENCES push_subscriptions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS push_campaigns (
  campaign_id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  topic TEXT NOT NULL,
  post_slug TEXT NOT NULL,
  post_title TEXT NOT NULL,
  post_excerpt TEXT NOT NULL DEFAULT '',
  max_subscription_id INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_push_campaigns_tenant_status
  ON push_campaigns(tenant_id, status, created_at);

CREATE TABLE IF NOT EXISTS push_subscription_limits (
  tenant_id INTEGER NOT NULL,
  ip_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, ip_hash, window_start),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
