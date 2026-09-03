import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { Miniflare } from "miniflare";
import { getFunnelExperimentReportInDb } from "../src/funnel-experiment-report.ts";

async function fixture() {
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: { DB: "experiment-report" } });
  const db = await mf.getD1Database("DB");
  for (const statement of fs.readFileSync("schema.sql", "utf8").replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((v) => v.trim()).filter(Boolean)) await db.prepare(statement).run();
  const now = 1_800_000_000;
  await db.prepare("INSERT INTO accounts (id,email,pw_hash,email_verified,created_at) VALUES (17,'a@x.test','x',1,?), (42,'b@x.test','x',1,?)").bind(now, now).run();
  await db.prepare("INSERT INTO affiliate_terms_acceptances (id,account_id,terms_version,terms_document_digest,policy_version,accepted_at) VALUES ('t',17,'v','d','p',?)").bind(now).run();
  await db.prepare("INSERT INTO affiliate_profiles (account_id,referral_code,status,terms_acceptance_id,enabled_at) VALUES (17,'affiliate','active','t',?)").bind(now).run();
  await db.prepare("INSERT INTO funnel_experiments (experiment_key,route,status,control_variant,treatment_variant,treatment_allocation_basis_points,control_presentation_version,treatment_presentation_version,required_sample_per_variant,baseline_rate,minimum_detectable_relative_uplift,created_at,started_at) VALUES ('affiliate-offer-v1','affiliate_offer','running','control','focused',5000,'c1','f1',100,0.1,0.2,?,?)").bind(now, now).run();
  await db.prepare("INSERT INTO funnel_experiment_assignments (journey_id,experiment_key,variant,affiliate_id,policy_version,assigned_at,exposed_at,cta_clicked_at,account_id,signup_at,checkout_started_at) VALUES ('journey_control_1234567','affiliate-offer-v1','control',17,'p',?,?,?,42,?,?), ('journey_focused_1234567','affiliate-offer-v1','focused',17,'p',?,?,NULL,NULL,NULL,NULL)").bind(now,now,now,now,now,now,now).run();
  await db.prepare("INSERT INTO affiliate_attributions (id,referred_account_id,affiliate_id,source,interacted_at,captured_at,policy_version) VALUES (9,42,17,'link',?,?, 'p')").bind(now,now).run();
  await db.prepare("INSERT INTO affiliate_installments (id,attribution_id,cadence,installment_number,provider,source_key,claimed_at) VALUES (8,9,'annual',1,'stripe','invoice:i:line:l',?)").bind(now).run();
  await db.prepare("INSERT INTO affiliate_revenue_occurrences (id,provider,source_key,affiliate_id,referred_account_id,attribution_id,installment_id,currency,eligible_revenue_minor,processing_fee_minor,policy_version,commission_rate_numerator,commission_rate_denominator,service_start_at,service_end_at,paid_at) VALUES ('occ','stripe','invoice:i:line:l',17,42,9,8,'usd',3240,0,'p',1,2,?,?,?)").bind(now,now+86400,now).run();
  await db.prepare("INSERT INTO funnel_experiment_conversions (experiment_key,account_id,journey_id,variant,occurrence_id,provider,source_key,cadence,eligible_revenue_minor,currency,converted_at) VALUES ('affiliate-offer-v1',42,'journey_control_1234567','control','occ','stripe','invoice:i:line:l','annual',3240,'usd',?)").bind(now).run();
  await db.prepare("INSERT INTO affiliate_revenue_adjustments (id,occurrence_id,provider,source_key,refunded_eligible_revenue_minor,commission_reversal_minor,recorded_at) VALUES ('adj','occ','stripe','refund:r',1000,-500,?)").bind(now).run();
  await db.prepare("INSERT INTO affiliate_stripe_checkouts (id,account_id,attribution_id,cadence,price_id,promotion_code_id,policy_version,discount_rate_numerator,discount_rate_denominator,commission_rate_numerator,commission_rate_denominator,status,created_at,expires_at,experiment_key,experiment_variant) VALUES ('co',42,9,'annual','price','promo','p',1,10,1,2,'failed',?,?, 'affiliate-offer-v1','control')").bind(now, now + 3600).run();
  return { mf, db };
}

test("staff report returns exact denominators, money, cadence, and an explicit readiness decision", async () => {
  const { mf, db } = await fixture();
  try {
    const report = await getFunnelExperimentReportInDb(db, "affiliate-offer-v1", 1_800_000_000 + 15 * 86400);
    assert.equal(report.experiment.status, "running");
    assert.deepEqual(report.variants.control, { exposures: 1, ctaClicks: 1, signups: 1, checkoutStarts: 1, conversions: 1, annualConversions: 1, monthlyConversions: 0, revenueMinor: 3240 });
    assert.equal(report.variants.focused.exposures, 1);
    assert.equal(report.decision.ready, false);
    assert.match(report.decision.reason, /100 exposures per variant/);
    assert.deepEqual(report.diagnostics.control, {
      paymentFailures: 1, refundedConversions: 1, refundedRevenueMinor: 1000,
      distinctAffiliates: 1, largestAffiliateExposures: 1,
    });
    assert.deepEqual(report.diagnostics.focused, {
      paymentFailures: 0, refundedConversions: 0, refundedRevenueMinor: 0,
      distinctAffiliates: 1, largestAffiliateExposures: 1,
    });
    assert.equal(report.exact, true);
  } finally { await mf.dispose(); }
});
