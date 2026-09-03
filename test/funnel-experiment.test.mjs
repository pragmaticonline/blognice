import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { Miniflare } from "miniflare";
import { assignAndExposeFunnelExperimentInDb, associateFunnelExperimentSignupInDb, isAutomatedExperimentRequest, loadAffiliateOfferExperimentInDb, loadFunnelExperimentAssignmentInDb, recordFunnelExperimentCheckoutInDb, recordFunnelExperimentConversionInDb, recordFunnelExperimentCtaInDb, renderAffiliateOfferPage } from "../src/funnel-experiment.ts";
import { handleReferralLink, prepareReferralExperiment, selectFunnelExperimentVariant } from "../src/affiliate-referral.ts";

async function applySql(db, path) {
  const sql = fs.readFileSync(path, "utf8");
  for (const statement of sql.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
    await db.prepare(statement).run();
  }
}

async function experimentDb(name) {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: name },
  });
  const db = await mf.getD1Database("DB");
  await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT NOT NULL, status TEXT NOT NULL, email_verified INTEGER NOT NULL, billing_status TEXT NOT NULL, crypto_paid_through INTEGER);");
  await applySql(db, "migrations/053-affiliate-program.sql");
  await applySql(db, "migrations/054-affiliate-offer-experiments.sql");
  await applySql(db, "migrations/055-affiliate-experiment-hardening.sql");
  await db.prepare("INSERT INTO accounts (id, email, status, email_verified, billing_status) VALUES (17, 'affiliate@example.com', 'active', 1, 'inactive')").run();
  await db.prepare("INSERT INTO affiliate_terms_acceptances (id, account_id, terms_version, terms_document_digest, policy_version, accepted_at) VALUES ('terms-17', 17, 'affiliate-1', 'sha256:test', 'affiliate-1', 1800000000)").run();
  await db.prepare("INSERT INTO affiliate_profiles (account_id, referral_code, stripe_promotion_code_id, status, terms_acceptance_id, enabled_at) VALUES (17, 'writer-17', 'promo_17', 'active', 'terms-17', 1800000000)").run();
  await db.prepare("INSERT OR REPLACE INTO funnel_experiments (experiment_key, route, status, control_variant, treatment_variant, treatment_allocation_basis_points, control_presentation_version, treatment_presentation_version, created_at, started_at) VALUES ('affiliate-offer-v1', 'affiliate_offer', 'running', 'control', 'focused', 5000, 'control-v1', 'focused-v1', 1800000000, 1800000000)").run();
  return { mf, db };
}

test("one referral journey receives one immutable assignment and exposure", async () => {
  const { mf, db } = await experimentDb("funnel-assignment");
  try {
    const input = {
      journeyId: "journey_0123456789abcdef",
      experimentKey: "affiliate-offer-v1",
      variant: "focused",
      affiliateId: 17,
      policyVersion: "affiliate-1",
      assignedAt: 1_800_000_010,
      exposedAt: 1_800_000_011,
    };
    const [first, concurrent] = await Promise.all([
      assignAndExposeFunnelExperimentInDb(db, input),
      assignAndExposeFunnelExperimentInDb(db, { ...input, variant: "control", exposedAt: 1_800_000_012 }),
    ]);

    assert.equal(first.assignment.variant, concurrent.assignment.variant);
    assert.equal(first.assignment.exposedAt, 1_800_000_011);
    assert.deepEqual(
      await db.prepare("SELECT journey_id, experiment_key, variant, affiliate_id, assigned_at, exposed_at FROM funnel_experiment_assignments").all().then((rows) => rows.results),
      [{ journey_id: input.journeyId, experiment_key: input.experimentKey, variant: first.assignment.variant, affiliate_id: 17, assigned_at: 1_800_000_010, exposed_at: 1_800_000_011 }],
    );
  } finally {
    await mf.dispose();
  }
});

test("paused and completed lifecycle keeps old assignments while exposing the permanent winner", async () => {
  const { mf, db } = await experimentDb("funnel-lifecycle");
  try {
    const journeyId = "journey_lifecycle_123456";
    await assignAndExposeFunnelExperimentInDb(db, { journeyId, experimentKey: "affiliate-offer-v1", variant: "focused", affiliateId: 17, policyVersion: "affiliate-1", assignedAt: 1_800_000_010, exposedAt: 1_800_000_011 });
    await assert.rejects(db.prepare("UPDATE funnel_experiments SET treatment_presentation_version = 'mutated' WHERE experiment_key = 'affiliate-offer-v1'").run(), /exposed experiment presentation is immutable/);
    await db.prepare("UPDATE funnel_experiments SET status = 'paused', stopped_at = 1800000020 WHERE experiment_key = 'affiliate-offer-v1'").run();
    assert.deepEqual(await loadAffiliateOfferExperimentInDb(db, "affiliate-offer-v1"), { experimentKey: "affiliate-offer-v1", treatmentAllocationBasisPoints: 5000, status: "paused", winnerVariant: null });
    assert.equal((await loadFunnelExperimentAssignmentInDb(db, "affiliate-offer-v1", journeyId))?.variant, "focused");
    await db.prepare("UPDATE funnel_experiments SET status = 'completed', winner_variant = 'control' WHERE experiment_key = 'affiliate-offer-v1'").run();
    assert.equal((await loadAffiliateOfferExperimentInDb(db, "affiliate-offer-v1"))?.winnerVariant, "control");
    assert.equal((await loadFunnelExperimentAssignmentInDb(db, "affiliate-offer-v1", journeyId))?.variant, "focused");
  } finally { await mf.dispose(); }
});

test("A/A instrumentation fixture assigns the frozen 50/50 allocation without presentation skew", () => {
  const counts = { control: 0, focused: 0 };
  for (let bucket = 0; bucket < 10_000; bucket++) {
    const entropy = new Uint8Array(4);
    new DataView(entropy.buffer).setUint32(0, bucket);
    counts[selectFunnelExperimentVariant(entropy, 5000)] += 1;
  }
  assert.deepEqual(counts, { control: 5000, focused: 5000 });
});

test("verified and definitively low-score bots are excluded from assignment", () => {
  assert.equal(isAutomatedExperimentRequest({ cf: { botManagement: { verifiedBot: true, score: 99 } } }), true);
  assert.equal(isAutomatedExperimentRequest({ cf: { botManagement: { verifiedBot: false, score: 1 } } }), true);
  assert.equal(isAutomatedExperimentRequest({ cf: { botManagement: { verifiedBot: false, score: 2 } } }), false);
  assert.equal(isAutomatedExperimentRequest(new Request("https://www.blognice.test/")), false);
});

test("a legacy signed referral journey upgrades once to a stable 50/50 experiment assignment", async () => {
  const { mf, db } = await experimentDb("funnel-referral-cookie");
  try {
    const secret = "experiment-signing-secret-at-least-32-bytes";
    const referral = await handleReferralLink(
      new Request("https://www.blognice.com/?ref=writer-17"), db, [secret], 1_800_000_100,
    );
    const legacyCookie = referral.headers.get("set-cookie").split(";", 1)[0];
    const config = { experimentKey: "affiliate-offer-v1", treatmentAllocationBasisPoints: 5000 };
    const upgraded = await prepareReferralExperiment(
      new Request("https://www.blognice.com/affiliate-offer", { headers: { cookie: legacyCookie } }),
      [secret], 1_800_000_101, config, new Uint8Array(20).fill(0),
    );
    assert.equal(upgraded.assignment.variant, "focused");
    assert.match(upgraded.assignment.journeyId, /^[A-Za-z0-9_-]{20,96}$/);
    assert.match(upgraded.setCookie, /^bn_ref=[^;]+; Path=\/; Max-Age=5183999; HttpOnly; Secure; SameSite=Lax$/);

    const stable = await prepareReferralExperiment(
      new Request("https://www.blognice.com/affiliate-offer", { headers: { cookie: upgraded.setCookie.split(";", 1)[0] } }),
      [secret], 1_800_000_102, config, new Uint8Array(20).fill(255),
    );
    assert.deepEqual(stable.assignment, upgraded.assignment);
    assert.equal(stable.setCookie, null);
  } finally {
    await mf.dispose();
  }
});

test("the focused offer keeps commercial terms but removes the editorial product tour", () => {
  const homepage = fs.readFileSync("homepage.html", "utf8");
  const control = renderAffiliateOfferPage(homepage, "blognice.test", "control");
  const focused = renderAffiliateOfferPage(homepage, "blognice.test", "focused");

  assert.match(control, /Save 10% for your first 12 paid months/);
  assert.match(control, /id="writing"/);
  assert.match(focused, /<h1>Save 10% and lock in \$36\/year\.<\/h1>/);
  assert.match(focused, /href="\/experiment\/affiliate-offer\/cta"[^>]*>Claim 10% and lock in \$36\/year/);
  assert.doesNotMatch(focused, /id="writing"|id="features"|id="compare"|id="examples"/);
  assert.match(focused, /id="pricing"/);
  assert.match(focused, /Founding member price/);
  assert.match(focused, /Planned standard price: <s>\$119\/year<\/s>/);
  assert.match(focused, /\$12\.99\/month/);
  assert.match(focused, /id="faq"/);
  assert.match(focused, /<meta name="robots" content="noindex,follow">/);
  assert.match(focused, /<link rel="canonical" href="https:\/\/www\.blognice\.test\/affiliate-offer">/);
});

test("CTA, signup, and checkout milestones are first-write and stay on the attributed account", async () => {
  const { mf, db } = await experimentDb("funnel-milestones");
  try {
    await db.prepare("INSERT INTO accounts (id, email, status, email_verified, billing_status) VALUES (42, 'reader@example.com', 'active', 1, 'inactive'), (43, 'other@example.com', 'active', 1, 'inactive')").run();
    await db.prepare("INSERT INTO affiliate_attributions (referred_account_id, affiliate_id, source, interacted_at, captured_at, policy_version) VALUES (42, 17, 'link', 1800000001, 1800000020, 'affiliate-1')").run();
    const assignment = {
      journeyId: "journey_abcdef0123456789",
      experimentKey: "affiliate-offer-v1",
      variant: "focused",
      affiliateId: 17,
      policyVersion: "affiliate-1",
      assignedAt: 1_800_000_010,
      exposedAt: 1_800_000_011,
    };
    await assignAndExposeFunnelExperimentInDb(db, assignment);
    await recordFunnelExperimentCtaInDb(db, assignment.journeyId, 1_800_000_015);
    await recordFunnelExperimentCtaInDb(db, assignment.journeyId, 1_800_000_014);
    assert.deepEqual(await associateFunnelExperimentSignupInDb(db, assignment.journeyId, 42, 1_800_000_020), { associated: true });
    assert.deepEqual(await associateFunnelExperimentSignupInDb(db, assignment.journeyId, 43, 1_800_000_021), { associated: false });
    await recordFunnelExperimentCheckoutInDb(db, 42, 1_800_000_030);
    await recordFunnelExperimentCheckoutInDb(db, 42, 1_800_000_029);

    assert.deepEqual(await db.prepare("SELECT cta_clicked_at, account_id, signup_at, checkout_started_at FROM funnel_experiment_assignments WHERE journey_id = ?").bind(assignment.journeyId).first(), {
      cta_clicked_at: 1_800_000_014,
      account_id: 42,
      signup_at: 1_800_000_020,
      checkout_started_at: 1_800_000_029,
    });
  } finally {
    await mf.dispose();
  }
});

test("only an authoritative first paid occurrence creates one Experiment Conversion", async () => {
  const { mf, db } = await experimentDb("funnel-conversion");
  try {
    await db.prepare("INSERT INTO accounts (id, email, status, email_verified, billing_status) VALUES (42, 'buyer@example.com', 'active', 1, 'inactive')").run();
    const attribution = await db.prepare("INSERT INTO affiliate_attributions (referred_account_id, affiliate_id, source, interacted_at, captured_at, policy_version) VALUES (42, 17, 'link', 1800000001, 1800000020, 'affiliate-1')").run();
    const journeyId = "journey_paid_0123456789";
    await assignAndExposeFunnelExperimentInDb(db, { journeyId, experimentKey: "affiliate-offer-v1", variant: "focused", affiliateId: 17, policyVersion: "affiliate-1", assignedAt: 1_800_000_010, exposedAt: 1_800_000_011 });
    await associateFunnelExperimentSignupInDb(db, journeyId, 42, 1_800_000_020);
    await db.prepare("INSERT INTO affiliate_installments (id, attribution_id, cadence, installment_number, provider, source_key, claimed_at) VALUES (71, ?, 'annual', 1, 'stripe', 'invoice:in_1:line:il_1', 1800000040)").bind(attribution.meta.last_row_id).run();
    await db.prepare("INSERT INTO affiliate_revenue_occurrences (id, provider, source_key, provider_payment_id, provider_invoice_id, provider_line_id, provider_subscription_id, provider_price_id, affiliate_id, referred_account_id, attribution_id, installment_id, currency, eligible_revenue_minor, processing_fee_minor, policy_version, commission_rate_numerator, commission_rate_denominator, service_start_at, service_end_at, paid_at) VALUES ('occ_1', 'stripe', 'invoice:in_1:line:il_1', 'pi_1', 'in_1', 'il_1', 'sub_1', 'price_yearly', 17, 42, ?, 71, 'usd', 3240, 0, 'affiliate-1', 1, 2, 1800000040, 1831536040, 1800000040)").bind(attribution.meta.last_row_id).run();

    assert.deepEqual(await recordFunnelExperimentConversionInDb(db, { accountId: 42, provider: "stripe", sourceKey: "invoice:in_1:line:il_1" }), { created: false });
    await recordFunnelExperimentCheckoutInDb(db, 42, 1_800_000_030);
    assert.deepEqual(await recordFunnelExperimentConversionInDb(db, { accountId: 42, provider: "stripe", sourceKey: "invoice:in_1:line:il_1" }), { created: true });
    assert.deepEqual(await recordFunnelExperimentConversionInDb(db, { accountId: 42, provider: "stripe", sourceKey: "invoice:in_1:line:il_1" }), { created: false });
    assert.deepEqual(await db.prepare("SELECT experiment_key, account_id, journey_id, variant, occurrence_id, provider, cadence, eligible_revenue_minor, currency, converted_at FROM funnel_experiment_conversions").first(), {
      experiment_key: "affiliate-offer-v1", account_id: 42, journey_id: journeyId, variant: "focused", occurrence_id: "occ_1", provider: "stripe", cadence: "annual", eligible_revenue_minor: 3240, currency: "usd", converted_at: 1_800_000_040,
    });
  } finally {
    await mf.dispose();
  }
});

test("a delayed NOWPayments occurrence is recoverable and still converts only once", async () => {
  const { mf, db } = await experimentDb("funnel-nowpayments-conversion");
  try {
    await db.prepare("INSERT INTO accounts (id,email,status,email_verified,billing_status) VALUES (52,'crypto@example.com','active',1,'inactive')").run();
    const attribution = await db.prepare("INSERT INTO affiliate_attributions (referred_account_id,affiliate_id,source,interacted_at,captured_at,policy_version) VALUES (52,17,'link',1800000001,1800000020,'affiliate-1')").run();
    const journeyId = "journey_crypto_012345678";
    await assignAndExposeFunnelExperimentInDb(db, { journeyId, experimentKey: "affiliate-offer-v1", variant: "control", affiliateId: 17, policyVersion: "affiliate-1", assignedAt: 1_800_000_010, exposedAt: 1_800_000_011 });
    await associateFunnelExperimentSignupInDb(db, journeyId, 52, 1_800_000_020);
    await recordFunnelExperimentCheckoutInDb(db, 52, 1_800_000_030);
    const input = { accountId: 52, provider: "nowpayments", sourceKey: "order:o_1:payment:p_1" };
    assert.deepEqual(await recordFunnelExperimentConversionInDb(db, input), { created: false });
    await db.prepare("INSERT INTO affiliate_installments (id,attribution_id,cadence,installment_number,provider,source_key,claimed_at) VALUES (81,?,'annual',1,'nowpayments','order:o_1:payment:p_1',1800000040)").bind(attribution.meta.last_row_id).run();
    await db.prepare("INSERT INTO affiliate_revenue_occurrences (id,provider,source_key,provider_payment_id,affiliate_id,referred_account_id,attribution_id,installment_id,currency,eligible_revenue_minor,processing_fee_minor,policy_version,commission_rate_numerator,commission_rate_denominator,service_start_at,service_end_at,paid_at) VALUES ('occ_np','nowpayments','order:o_1:payment:p_1','p_1',17,52,?,81,'usd',3240,0,'affiliate-1',1,2,1800000040,1831536040,1800000040)").bind(attribution.meta.last_row_id).run();
    assert.deepEqual(await recordFunnelExperimentConversionInDb(db, input), { created: true });
    assert.deepEqual(await recordFunnelExperimentConversionInDb(db, input), { created: false });
  } finally { await mf.dispose(); }
});
