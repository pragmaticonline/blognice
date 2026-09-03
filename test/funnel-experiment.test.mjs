import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { Miniflare } from "miniflare";
import { assignAndExposeFunnelExperimentInDb, associateFunnelExperimentSignupInDb, recordFunnelExperimentCheckoutInDb, recordFunnelExperimentCtaInDb, renderAffiliateOfferPage } from "../src/funnel-experiment.ts";
import { handleReferralLink, prepareReferralExperiment } from "../src/affiliate-referral.ts";

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
  await db.prepare("INSERT INTO accounts (id, email, status, email_verified, billing_status) VALUES (17, 'affiliate@example.com', 'active', 1, 'inactive')").run();
  await db.prepare("INSERT INTO affiliate_terms_acceptances (id, account_id, terms_version, terms_document_digest, policy_version, accepted_at) VALUES ('terms-17', 17, 'affiliate-1', 'sha256:test', 'affiliate-1', 1800000000)").run();
  await db.prepare("INSERT INTO affiliate_profiles (account_id, referral_code, stripe_promotion_code_id, status, terms_acceptance_id, enabled_at) VALUES (17, 'writer-17', 'promo_17', 'active', 'terms-17', 1800000000)").run();
  await db.prepare("INSERT INTO funnel_experiments (experiment_key, route, status, control_variant, treatment_variant, treatment_allocation_basis_points, control_presentation_version, treatment_presentation_version, created_at, started_at) VALUES ('affiliate-offer-v1', 'affiliate_offer', 'running', 'control', 'focused', 5000, 'control-v1', 'focused-v1', 1800000000, 1800000000)").run();
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
