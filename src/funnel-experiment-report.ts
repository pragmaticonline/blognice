export type FunnelVariantTotals = {
  exposures: number; ctaClicks: number; signups: number; checkoutStarts: number;
  conversions: number; annualConversions: number; monthlyConversions: number; revenueMinor: number;
};

export type FunnelExperimentReport = {
  exact: true;
  experiment: {
    experimentKey: string; status: string; startedAt: number | null; stoppedAt: number | null;
    requiredSamplePerVariant: number | null; baselineRate: number | null; minimumDetectableRelativeUplift: number | null;
  };
  variants: Record<"control" | "focused", FunnelVariantTotals>;
  diagnostics: Record<"control" | "focused", {
    paymentFailures: number; refundedConversions: number; refundedRevenueMinor: number;
    distinctAffiliates: number; largestAffiliateExposures: number;
  }>;
  interval: { difference: number; lower: number; upper: number } | null;
  exclusions: number;
  decision: { ready: boolean; reason: string };
};

function totals(): FunnelVariantTotals {
  return { exposures: 0, ctaClicks: 0, signups: 0, checkoutStarts: 0, conversions: 0, annualConversions: 0, monthlyConversions: 0, revenueMinor: 0 };
}

export async function getFunnelExperimentReportInDb(db: D1Database, experimentKey: string, now: number): Promise<FunnelExperimentReport> {
  const experiment = await db.prepare(
    `SELECT experiment_key, status, started_at, stopped_at, required_sample_per_variant,
            baseline_rate, minimum_detectable_relative_uplift
       FROM funnel_experiments WHERE experiment_key = ? AND route = 'affiliate_offer'`,
  ).bind(experimentKey).first<{
    experiment_key: string; status: string; started_at: number | null; stopped_at: number | null;
    required_sample_per_variant: number | null; baseline_rate: number | null; minimum_detectable_relative_uplift: number | null;
  }>();
  if (!experiment) throw new Error("Experiment not found.");
  const assignmentRows = await db.prepare(
    `SELECT variant, COUNT(*) AS exposures,
            SUM(cta_clicked_at IS NOT NULL) AS cta_clicks,
            SUM(signup_at IS NOT NULL) AS signups,
            SUM(checkout_started_at IS NOT NULL) AS checkout_starts
       FROM funnel_experiment_assignments
      WHERE experiment_key = ? AND exposed_at IS NOT NULL AND excluded_at IS NULL GROUP BY variant`,
  ).bind(experimentKey).all<{ variant: "control" | "focused"; exposures: number; cta_clicks: number; signups: number; checkout_starts: number }>();
  const conversionRows = await db.prepare(
    `SELECT variant, COUNT(*) AS conversions,
            SUM(cadence = 'annual') AS annual_conversions,
            SUM(cadence = 'monthly') AS monthly_conversions,
            SUM(eligible_revenue_minor) AS revenue_minor
       FROM funnel_experiment_conversions WHERE experiment_key = ? GROUP BY variant`,
  ).bind(experimentKey).all<{ variant: "control" | "focused"; conversions: number; annual_conversions: number; monthly_conversions: number; revenue_minor: number }>();
  const variants = { control: totals(), focused: totals() };
  for (const row of assignmentRows.results) if (row.variant in variants) Object.assign(variants[row.variant], {
    exposures: Number(row.exposures), ctaClicks: Number(row.cta_clicks), signups: Number(row.signups), checkoutStarts: Number(row.checkout_starts),
  });
  for (const row of conversionRows.results) if (row.variant in variants) Object.assign(variants[row.variant], {
    conversions: Number(row.conversions), annualConversions: Number(row.annual_conversions), monthlyConversions: Number(row.monthly_conversions), revenueMinor: Number(row.revenue_minor),
  });
  const excluded = await db.prepare("SELECT COUNT(*) AS count FROM funnel_experiment_assignments WHERE experiment_key = ? AND excluded_at IS NOT NULL").bind(experimentKey).first<{ count: number }>();
  const failureRows = await db.prepare(
    `SELECT experiment_variant AS variant, COUNT(*) AS payment_failures FROM (
       SELECT experiment_variant FROM affiliate_stripe_checkouts
        WHERE experiment_key = ? AND status = 'failed'
       UNION ALL
       SELECT experiment_variant FROM affiliate_nowpayments_checkouts
        WHERE experiment_key = ? AND status = 'failed'
     ) GROUP BY experiment_variant`,
  ).bind(experimentKey, experimentKey).all<{ variant: "control" | "focused"; payment_failures: number }>();
  const refundRows = await db.prepare(
    `SELECT conversion.variant, COUNT(DISTINCT adjustment.occurrence_id) AS refunded_conversions,
            COALESCE(SUM(adjustment.refunded_eligible_revenue_minor), 0) AS refunded_revenue_minor
       FROM funnel_experiment_conversions AS conversion
       JOIN affiliate_revenue_adjustments AS adjustment ON adjustment.occurrence_id = conversion.occurrence_id
      WHERE conversion.experiment_key = ? GROUP BY conversion.variant`,
  ).bind(experimentKey).all<{ variant: "control" | "focused"; refunded_conversions: number; refunded_revenue_minor: number }>();
  const affiliateRows = await db.prepare(
    `SELECT variant, COUNT(*) AS distinct_affiliates, MAX(exposures) AS largest_affiliate_exposures FROM (
       SELECT variant, affiliate_id, COUNT(*) AS exposures
         FROM funnel_experiment_assignments
        WHERE experiment_key = ? AND exposed_at IS NOT NULL AND excluded_at IS NULL
        GROUP BY variant, affiliate_id
     ) GROUP BY variant`,
  ).bind(experimentKey).all<{ variant: "control" | "focused"; distinct_affiliates: number; largest_affiliate_exposures: number }>();
  const diagnostics = {
    control: { paymentFailures: 0, refundedConversions: 0, refundedRevenueMinor: 0, distinctAffiliates: 0, largestAffiliateExposures: 0 },
    focused: { paymentFailures: 0, refundedConversions: 0, refundedRevenueMinor: 0, distinctAffiliates: 0, largestAffiliateExposures: 0 },
  };
  for (const row of failureRows.results) if (row.variant in diagnostics) diagnostics[row.variant].paymentFailures = Number(row.payment_failures);
  for (const row of refundRows.results) if (row.variant in diagnostics) Object.assign(diagnostics[row.variant], {
    refundedConversions: Number(row.refunded_conversions), refundedRevenueMinor: Number(row.refunded_revenue_minor),
  });
  for (const row of affiliateRows.results) if (row.variant in diagnostics) Object.assign(diagnostics[row.variant], {
    distinctAffiliates: Number(row.distinct_affiliates), largestAffiliateExposures: Number(row.largest_affiliate_exposures),
  });
  const c = variants.control, f = variants.focused;
  let interval: FunnelExperimentReport["interval"] = null;
  if (c.exposures && f.exposures) {
    const pc = c.conversions / c.exposures, pf = f.conversions / f.exposures;
    const margin = 1.96 * Math.sqrt(pc * (1 - pc) / c.exposures + pf * (1 - pf) / f.exposures);
    interval = { difference: pf - pc, lower: pf - pc - margin, upper: pf - pc + margin };
  }
  const target = experiment.required_sample_per_variant;
  const elapsedDays = experiment.started_at == null ? 0 : Math.floor((now - experiment.started_at) / 86400);
  let reason = "Ready for the pre-registered decision review.";
  if (target == null || experiment.baseline_rate == null || experiment.minimum_detectable_relative_uplift == null) reason = "Baseline, minimum detectable uplift, and sample target are not frozen.";
  else if (c.exposures < target || f.exposures < target) reason = `Waiting for ${target} exposures per variant.`;
  else if (elapsedDays < 14) reason = "Waiting for 14 complete UTC days and two weekly cycles.";
  else if (!interval || interval.lower <= 0 && interval.upper >= 0) reason = "The two-sided 95% confidence interval still includes zero.";
  return {
    exact: true,
    experiment: { experimentKey: experiment.experiment_key, status: experiment.status, startedAt: experiment.started_at, stoppedAt: experiment.stopped_at, requiredSamplePerVariant: target, baselineRate: experiment.baseline_rate, minimumDetectableRelativeUplift: experiment.minimum_detectable_relative_uplift },
    variants, diagnostics, interval, exclusions: Number(excluded?.count || 0),
    decision: { ready: reason.startsWith("Ready"), reason },
  };
}
