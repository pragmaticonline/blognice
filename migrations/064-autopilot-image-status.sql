-- Autopilot image outcome per run: queued/skipped at publish time, then
-- ready/failed once the async image queue job settles.
ALTER TABLE autopilot_runs ADD COLUMN image_status TEXT;
ALTER TABLE autopilot_runs ADD COLUMN image_error TEXT;
