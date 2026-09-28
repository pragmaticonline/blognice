-- Native import ledger (POSTS database). Records which external items have
-- already been imported into a tenant so repeat imports skip instead of
-- duplicating posts and pages. Shared by every importer; `source` names the
-- origin (the first is 'blogger') and `external_id` is the origin's stable
-- item id (for Blogger, the Atom entry <id>).
-- Target: blognice-posts.
CREATE TABLE IF NOT EXISTS import_records (
  tenant_id   INTEGER NOT NULL,
  source      TEXT    NOT NULL,
  external_id TEXT    NOT NULL,
  item_type   TEXT    NOT NULL, -- 'post' or 'page'
  slug        TEXT    NOT NULL, -- slug the item received on import
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_import_records_tenant ON import_records (tenant_id, source);
