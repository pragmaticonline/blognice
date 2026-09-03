CREATE TABLE funnel_experiments (
  experiment_key                    TEXT PRIMARY KEY,
  route                             TEXT NOT NULL CHECK (route = 'affiliate_offer'),
  status                            TEXT NOT NULL CHECK (status IN ('draft', 'running', 'paused', 'completed')),
  control_variant                   TEXT NOT NULL,
  treatment_variant                 TEXT NOT NULL,
  treatment_allocation_basis_points INTEGER NOT NULL CHECK (treatment_allocation_basis_points BETWEEN 0 AND 10000),
  control_presentation_version      TEXT NOT NULL,
  treatment_presentation_version    TEXT NOT NULL,
  required_sample_per_variant       INTEGER CHECK (required_sample_per_variant IS NULL OR required_sample_per_variant > 0),
  baseline_rate                     REAL CHECK (baseline_rate IS NULL OR (baseline_rate > 0 AND baseline_rate < 1)),
  minimum_detectable_relative_uplift REAL CHECK (minimum_detectable_relative_uplift IS NULL OR minimum_detectable_relative_uplift > 0),
  winner_variant                    TEXT,
  created_at                        INTEGER NOT NULL,
  started_at                        INTEGER,
  stopped_at                        INTEGER,
  CHECK (control_variant != treatment_variant),
  CHECK (winner_variant IS NULL OR winner_variant IN (control_variant, treatment_variant)),
  CHECK (status != 'running' OR started_at IS NOT NULL)
);

CREATE UNIQUE INDEX idx_one_running_affiliate_offer_experiment
  ON funnel_experiments(route) WHERE status = 'running';

CREATE TABLE funnel_experiment_assignments (
  journey_id       TEXT PRIMARY KEY CHECK (length(journey_id) BETWEEN 20 AND 96),
  experiment_key   TEXT NOT NULL,
  variant          TEXT NOT NULL,
  affiliate_id     INTEGER NOT NULL,
  policy_version   TEXT NOT NULL,
  assigned_at      INTEGER NOT NULL,
  exposed_at       INTEGER,
  cta_clicked_at   INTEGER,
  account_id       INTEGER,
  signup_at        INTEGER,
  checkout_started_at INTEGER,
  excluded_at      INTEGER,
  exclusion_reason TEXT,
  CHECK ((excluded_at IS NULL AND exclusion_reason IS NULL) OR (excluded_at IS NOT NULL AND length(trim(exclusion_reason)) > 0)),
  CHECK (signup_at IS NULL OR account_id IS NOT NULL),
  FOREIGN KEY (experiment_key) REFERENCES funnel_experiments(experiment_key) ON DELETE RESTRICT,
  FOREIGN KEY (affiliate_id) REFERENCES affiliate_profiles(account_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_funnel_experiment_account
  ON funnel_experiment_assignments(experiment_key, account_id) WHERE account_id IS NOT NULL;

CREATE INDEX idx_funnel_experiment_results
  ON funnel_experiment_assignments(experiment_key, variant, exposed_at);

CREATE TABLE funnel_experiment_conversions (
  experiment_key        TEXT NOT NULL,
  account_id            INTEGER NOT NULL,
  journey_id            TEXT NOT NULL,
  variant               TEXT NOT NULL,
  occurrence_id         TEXT NOT NULL UNIQUE,
  provider              TEXT NOT NULL CHECK (provider IN ('stripe', 'nowpayments')),
  source_key            TEXT NOT NULL,
  cadence               TEXT NOT NULL CHECK (cadence IN ('monthly', 'annual')),
  eligible_revenue_minor INTEGER NOT NULL CHECK (eligible_revenue_minor >= 0),
  currency              TEXT NOT NULL,
  converted_at          INTEGER NOT NULL,
  PRIMARY KEY (experiment_key, account_id),
  UNIQUE (provider, source_key),
  FOREIGN KEY (experiment_key) REFERENCES funnel_experiments(experiment_key) ON DELETE RESTRICT,
  FOREIGN KEY (journey_id) REFERENCES funnel_experiment_assignments(journey_id) ON DELETE RESTRICT,
  FOREIGN KEY (occurrence_id) REFERENCES affiliate_revenue_occurrences(id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT
);

CREATE INDEX idx_funnel_experiment_conversions_results
  ON funnel_experiment_conversions(experiment_key, variant, converted_at);

INSERT INTO funnel_experiments
  (experiment_key, route, status, control_variant, treatment_variant,
   treatment_allocation_basis_points, control_presentation_version,
   treatment_presentation_version, created_at)
VALUES
  ('affiliate-offer-v1', 'affiliate_offer', 'draft', 'control', 'focused',
   5000, 'control-v1', 'focused-v1', 1788451200);
