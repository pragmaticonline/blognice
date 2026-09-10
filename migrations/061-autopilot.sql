-- Autopilot: per-blog automated publishing configs and runs
CREATE TABLE autopilot_configs (
  tenant_id INTEGER PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  staff_enabled INTEGER NOT NULL DEFAULT 0 CHECK (staff_enabled IN (0,1)),
  interval_days INTEGER NOT NULL DEFAULT 1 CHECK (interval_days BETWEEN 1 AND 7),
  run_hour_utc INTEGER NOT NULL DEFAULT 9 CHECK (run_hour_utc BETWEEN 0 AND 23),
  criteria_json TEXT NOT NULL DEFAULT '{}',
  image_style TEXT NOT NULL DEFAULT 'editorial-photo',
  voice TEXT,
  auto_publish INTEGER NOT NULL DEFAULT 1 CHECK (auto_publish IN (0,1)),
  max_length INTEGER NOT NULL DEFAULT 900 CHECK (max_length BETWEEN 400 AND 2000),
  next_run_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE TABLE autopilot_runs (
  id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending','success','skipped','failed')),
  source_url TEXT,
  source_title TEXT,
  post_id INTEGER,
  error TEXT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX idx_autopilot_runs_tenant ON autopilot_runs(tenant_id, started_at DESC);
CREATE INDEX idx_autopilot_configs_next ON autopilot_configs(enabled, staff_enabled, next_run_at);
