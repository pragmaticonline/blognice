ALTER TABLE affiliate_stripe_checkouts ADD COLUMN experiment_key TEXT;
ALTER TABLE affiliate_stripe_checkouts ADD COLUMN experiment_variant TEXT;
ALTER TABLE affiliate_nowpayments_checkouts ADD COLUMN experiment_key TEXT;
ALTER TABLE affiliate_nowpayments_checkouts ADD COLUMN experiment_variant TEXT;

CREATE TRIGGER trg_funnel_experiment_presentation_immutable
BEFORE UPDATE OF control_variant, treatment_variant, treatment_allocation_basis_points,
  control_presentation_version, treatment_presentation_version ON funnel_experiments
WHEN EXISTS (
  SELECT 1 FROM funnel_experiment_assignments
   WHERE experiment_key = OLD.experiment_key AND exposed_at IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'exposed experiment presentation is immutable'); END;

CREATE TRIGGER trg_affiliate_stripe_experiment_snapshot
BEFORE INSERT ON affiliate_stripe_checkouts
WHEN NEW.experiment_key IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM funnel_experiment_assignments
   WHERE account_id = NEW.account_id AND experiment_key = NEW.experiment_key
     AND variant = NEW.experiment_variant AND excluded_at IS NULL
)
BEGIN SELECT RAISE(ABORT, 'invalid Stripe experiment snapshot'); END;

CREATE TRIGGER trg_affiliate_nowpayments_experiment_snapshot
BEFORE INSERT ON affiliate_nowpayments_checkouts
WHEN NEW.experiment_key IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM funnel_experiment_assignments
   WHERE account_id = NEW.account_id AND experiment_key = NEW.experiment_key
     AND variant = NEW.experiment_variant AND excluded_at IS NULL
)
BEGIN SELECT RAISE(ABORT, 'invalid NOWPayments experiment snapshot'); END;
