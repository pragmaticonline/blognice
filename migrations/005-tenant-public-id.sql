-- Give each blog an opaque public identifier while retaining the integer id
-- internally for joins and foreign keys.
ALTER TABLE tenants ADD COLUMN public_id TEXT;
UPDATE tenants SET public_id = lower(hex(randomblob(8))) WHERE public_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_public_id ON tenants(public_id);
