-- Subscriber attribution: source path and UTM campaign for subscribe conversions.
ALTER TABLE subscribers ADD COLUMN source_path TEXT;
ALTER TABLE subscribers ADD COLUMN utm_source TEXT;
ALTER TABLE subscribers ADD COLUMN utm_medium TEXT;
ALTER TABLE subscribers ADD COLUMN utm_campaign TEXT;
CREATE INDEX IF NOT EXISTS idx_subscribers_source ON subscribers (tenant_id, source_path);
