CREATE TABLE IF NOT EXISTS post_popularity_daily (
  tenant_id       INTEGER NOT NULL,
  path            TEXT NOT NULL,
  day             TEXT NOT NULL,
  reader_days     INTEGER NOT NULL DEFAULT 0,
  engaged_readers INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, path, day),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_post_popularity_daily_window
  ON post_popularity_daily(day, tenant_id);

CREATE TABLE IF NOT EXISTS post_popularity (
  tenant_id            INTEGER NOT NULL,
  path                 TEXT NOT NULL,
  score                REAL NOT NULL,
  reader_days_30       INTEGER NOT NULL DEFAULT 0,
  reader_days_90       INTEGER NOT NULL DEFAULT 0,
  engaged_readers_30   INTEGER NOT NULL DEFAULT 0,
  calculated_at        INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, path),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_post_popularity_rank
  ON post_popularity(tenant_id, score DESC, reader_days_30 DESC);

CREATE TABLE IF NOT EXISTS popularity_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
