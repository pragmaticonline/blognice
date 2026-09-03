import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { Miniflare } from "miniflare";
import { approveAffiliatePayoutInDb, attachStripeConnectedAccountInDb, attachStripePromotionCodeInDb, beginCheckoutAttributionInDb, captureReferral, captureReferralInDb, closeAttributionOpportunityInDb, createNowPaymentsCheckoutInDb, createStripeCheckoutInDb, decideInstallmentEligibility, enableAffiliateProfileInDb, hasIndependentPayoutApprovalInDb, loadStripePayoutDispatchInDb, normalizeNowPaymentsAffiliatePayment, normalizeStripeAffiliatePayment, openDisputeReserveInDb, openStripeDisputeInDb, parseAffiliateStripeConnectCountries, parsePayoutDualControlThreshold, prepareAffiliatePayoutBatchInDb, preparePayoutInDb, reacceptAffiliateTermsInDb, reconcilePayoutInDb, recordAffiliateAccountRelationshipInDb, recordManualAffiliateAdjustmentInDb, recordPendingStripeFinancialEventInDb, recordPayoutDispatchResultInDb, recordRefundInDb, recordStripeCreditNoteInDb, recordStripeRefundInDb, refundNowPaymentsCheckoutInDb, replayPendingStripeFinancialEventsInDb, requireCurrentAffiliateTermsInDb, requireOutdatedAffiliateTermsInDb, recognizeRevenue, recognizeRevenueInDb, resolveDisputeInDb, resolveStripeDisputeInDb, settleNowPaymentsCheckoutInDb, settleStripeInvoiceInDb, updateStripeConnectedAccountStatusInDb } from "../src/affiliate.ts";
import { getAffiliatePayoutQueueInDb } from "../src/affiliate-support.ts";
import { captureSignupReferral, handleReferralCodeSubmission, handleReferralLink } from "../src/affiliate-referral.ts";
import { getAffiliateSupportActivityInDb, getAffiliateSupportSummaryInDb } from "../src/affiliate-support.ts";
import { getAffiliateDashboardInDb } from "../src/affiliate-dashboard.ts";
import { enqueueAffiliateEnrollmentEmailInDb, relayAffiliateEmailOutboxInDb } from "../src/affiliate-notifications.ts";

test("payout dual-control configuration fails closed unless explicitly valid", () => {
  assert.deepEqual(parsePayoutDualControlThreshold("100000"), { configured: true, thresholdMinor: 100_000 });
  for (const value of [undefined, "", "0", "-1", "100.5", "USD 1000", "9007199254740992"]) {
    assert.deepEqual(parsePayoutDualControlThreshold(value), { configured: false });
  }
});

test("Stripe Connect country configuration fails closed on missing or malformed values", () => {
  const parsed = parseAffiliateStripeConnectCountries("gb, US");
  assert.equal(parsed.configured, true);
  assert.deepEqual([...parsed.countries].sort(), ["GB", "US"]);
  for (const value of [undefined, "", "GB,", "GB,USA", "GB,not-a-country"]) {
    assert.deepEqual(parseAffiliateStripeConnectCountries(value), { configured: false });
  }
});

test("high-value payouts require approval from a different admin", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-payout-approval" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT NOT NULL, status TEXT NOT NULL, email_verified INTEGER NOT NULL, billing_status TEXT NOT NULL, crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id, email, status, email_verified, billing_status) VALUES (17, 'affiliate@example.com', 'active', 1, 'inactive')").run();
    await db.prepare("INSERT INTO affiliate_terms_acceptances (id, account_id, terms_version, terms_document_digest, policy_version, accepted_at) VALUES ('terms-17', 17, 'affiliate-1', 'sha256:test', 'policy-1', 1800000000)").run();
    await db.prepare("INSERT INTO affiliate_profiles (account_id, referral_code, status, terms_acceptance_id, enabled_at, stripe_connect_status, stripe_connect_payouts_enabled) VALUES (17, 'Alex', 'active', 'terms-17', 1800000000, 'ready', 1)").run();
    await db.prepare("INSERT INTO affiliate_payouts (id, affiliate_id, currency, amount_minor, status, cutoff_at, created_at) VALUES ('pay_high', 17, 'usd', 500000, 'prepared', 1800000000, 1800000000)").run();

    assert.equal(await hasIndependentPayoutApprovalInDb(db, "pay_high", "admin-a"), false);
    assert.deepEqual(await approveAffiliatePayoutInDb(db, {
      payoutId: "pay_high", actorSubject: "admin-a", actorRole: "admin",
      reason: "Reviewed ledger and connected account", approvedAt: 1800000010,
    }), { approved: true });
    assert.equal(await hasIndependentPayoutApprovalInDb(db, "pay_high", "admin-a"), false);
    assert.equal(await hasIndependentPayoutApprovalInDb(db, "pay_high", "admin-b"), true);
    const queue = await getAffiliatePayoutQueueInDb(db, "prepared");
    assert.equal(queue[0].approvalCount, 1);
    assert.equal(queue[0].latestApproverSubject, "admin-a");
    assert.equal(queue[0].latestApprovalReason, "Reviewed ledger and connected account");
    assert.equal(queue[0].latestApprovedAt, 1800000010);
    assert.deepEqual(await approveAffiliatePayoutInDb(db, {
      payoutId: "pay_high", actorSubject: "admin-a", actorRole: "admin",
      reason: "Duplicate approval", approvedAt: 1800000011,
    }), { approved: false });
  } finally {
    await mf.dispose();
  }
});

test("outdated Affiliate Terms queue one reacceptance email per version", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-terms-email" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT NOT NULL, status TEXT NOT NULL, email_verified INTEGER NOT NULL, billing_status TEXT NOT NULL, crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id, email, status, email_verified, billing_status) VALUES (17, 'alex@example.com', 'active', 1, 'inactive')").run();
    await enableAffiliateProfileInDb(db, {
      accountId: 17, referralCode: "Alex", termsVersion: "affiliate-1",
      termsDocumentDigest: "sha256:terms-1", policyVersion: "policy-1", acceptedAt: 1_800_000_000,
    });

    assert.deepEqual(await requireCurrentAffiliateTermsInDb(db, {
      accountId: 17, termsVersion: "affiliate-2", policyVersion: "policy-2", requiredAt: 1_800_000_100,
    }), { required: true });
    await requireCurrentAffiliateTermsInDb(db, {
      accountId: 17, termsVersion: "affiliate-2", policyVersion: "policy-2", requiredAt: 1_800_000_101,
    });

    const emails = [];
    assert.deepEqual(await relayAffiliateEmailOutboxInDb(db, { send: async (body) => { emails.push(body); } }), { queued: 1 });
    assert.equal(emails[0].idempotencyKey, "affiliate-terms-required:17:affiliate-2:policy-2");
    assert.equal(emails[0].emailKind, "affiliate-terms-required");
    assert.equal(emails[0].subject, "Updated Blognice Affiliate Terms require your acceptance");
    assert.match(emails[0].plainText, /attribution and payouts are paused/i);
    assert.match(emails[0].html, /admin\/affiliate/);
  } finally {
    await mf.dispose();
  }
});

test("Affiliate email outbox retries failures and concurrent relays claim once", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-email-retry" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT NOT NULL, status TEXT NOT NULL, email_verified INTEGER NOT NULL, billing_status TEXT NOT NULL, crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) await db.prepare(statement).run();
    await db.prepare("INSERT INTO accounts (id, email, status, email_verified, billing_status) VALUES (17, 'alex@example.com', 'active', 1, 'inactive')").run();
    await enableAffiliateProfileInDb(db, {
      accountId: 17, referralCode: "Alex", termsVersion: "affiliate-1",
      termsDocumentDigest: "sha256:terms", policyVersion: "policy-1", acceptedAt: 1_800_000_000,
    });
    await enqueueAffiliateEnrollmentEmailInDb(db, 17, 1_800_000_001);

    await assert.rejects(relayAffiliateEmailOutboxInDb(db, { send: async () => { throw new Error("queue unavailable"); } }), /queue unavailable/);
    assert.deepEqual(await db.prepare("SELECT status, queued_at FROM affiliate_email_outbox").first(), { status: "pending", queued_at: null });

    const deliveries = [];
    const queue = { send: async (body) => { deliveries.push(body.idempotencyKey); await Promise.resolve(); } };
    const results = await Promise.all([relayAffiliateEmailOutboxInDb(db, queue), relayAffiliateEmailOutboxInDb(db, queue)]);
    assert.equal(results.reduce((sum, result) => sum + result.queued, 0), 1);
    assert.deepEqual(deliveries, ["affiliate-enrolled:17"]);
    assert.equal(await db.prepare("SELECT status FROM affiliate_email_outbox").first().then((row) => row.status), "queued");
  } finally {
    await mf.dispose();
  }
});

test("scheduled terms enforcement pauses every outdated active Affiliate exactly once", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-terms-bulk" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT NOT NULL, status TEXT NOT NULL, email_verified INTEGER NOT NULL, billing_status TEXT NOT NULL, crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare(
      `INSERT INTO accounts (id, email, status, email_verified, billing_status) VALUES
       (1, 'old@example.com', 'active', 1, 'inactive'),
       (2, 'current@example.com', 'active', 1, 'inactive'),
       (3, 'suspended@example.com', 'active', 1, 'inactive')`,
    ).run();
    for (const [accountId, version] of [[1, "terms-v1"], [2, "terms-v2"], [3, "terms-v1"]]) {
      await enableAffiliateProfileInDb(db, {
        accountId, referralCode: `writer-${accountId}`, termsVersion: version,
        termsDocumentDigest: `sha256:${version}`, policyVersion: version === "terms-v2" ? "policy-v2" : "policy-v1",
        acceptedAt: 1_800_000_000,
      });
      await attachStripePromotionCodeInDb(db, { accountId, promotionCodeId: `promo_${accountId}` });
    }
    await db.prepare("UPDATE affiliate_profiles SET status = 'suspended' WHERE account_id = 3").run();

    const input = { termsVersion: "terms-v2", policyVersion: "policy-v2", requiredAt: 1_800_000_100 };
    assert.deepEqual(await requireOutdatedAffiliateTermsInDb(db, input), { requiredCount: 1 });
    assert.deepEqual(await requireOutdatedAffiliateTermsInDb(db, { ...input, requiredAt: input.requiredAt + 1 }), { requiredCount: 0 });
    const profiles = await db.prepare("SELECT account_id, status FROM affiliate_profiles ORDER BY account_id").all();
    assert.deepEqual(profiles.results, [
      { account_id: 1, status: "terms_required" },
      { account_id: 2, status: "active" },
      { account_id: 3, status: "suspended" },
    ]);
    const notices = await db.prepare(
      "SELECT affiliate_id, kind, status FROM affiliate_email_outbox ORDER BY affiliate_id",
    ).all();
    assert.deepEqual(notices.results, [
      { affiliate_id: 1, kind: "affiliate-terms-required", status: "pending" },
    ]);
  } finally {
    await mf.dispose();
  }
});

test("an Affiliate dashboard exposes exact aggregate money without referred-customer identity", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-dashboard" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT, status TEXT NOT NULL, email_verified INTEGER NOT NULL, billing_status TEXT NOT NULL, crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id, status, email_verified, billing_status) VALUES (17, 'active', 1, 'inactive')").run();
    await enableAffiliateProfileInDb(db, {
      accountId: 17, referralCode: "Alex", termsVersion: "affiliate-1",
      termsDocumentDigest: "sha256:terms", policyVersion: "affiliate-1", acceptedAt: 1_800_000_000,
    });
    await attachStripePromotionCodeInDb(db, { accountId: 17, promotionCodeId: "promo_alex" });

    const dashboard = await getAffiliateDashboardInDb(db, 17, 1_800_000_100);

    assert.deepEqual(dashboard, {
      accountId: 17,
      referralCode: "Alex",
      status: "active",
      stripePromotionCodeReady: true,
      stripeConnectStatus: "not_started",
      stripeConnectCountry: null,
      stripeConnectDetailsSubmitted: false,
      stripeConnectPayoutsEnabled: false,
      attributionCount: 0,
      conversionCount: 0,
      netCommissionMinor: 0,
      pendingCommissionMinor: 0,
      availableCommissionMinor: 0,
      openReserveMinor: 0,
      paidPayoutMinor: 0,
      currency: "usd",
      payouts: [],
    });
    assert.doesNotMatch(JSON.stringify(dashboard), /email|referredAccount|paymentId/i);
  } finally {
    await mf.dispose();
  }
});

test("customer support can inspect an Affiliate's exact account-level summary", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-support-summary" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT NOT NULL, status TEXT NOT NULL, email_verified INTEGER NOT NULL, billing_status TEXT NOT NULL, crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id, email, status, email_verified, billing_status) VALUES (17, 'alex@example.com', 'active', 1, 'inactive'), (42, 'reader@example.com', 'active', 1, 'inactive')").run();
    await enableAffiliateProfileInDb(db, {
      accountId: 17, referralCode: "Alex", termsVersion: "affiliate-1",
      termsDocumentDigest: "sha256:terms", policyVersion: "affiliate-1", acceptedAt: 1_800_000_000,
    });
    await attachStripePromotionCodeInDb(db, { accountId: 17, promotionCodeId: "promo_alex" });
    await db.prepare(
      "INSERT INTO affiliate_attributions (referred_account_id, affiliate_id, source, interacted_at, captured_at, policy_version) VALUES (42, 17, 'code', 1800000010, 1800000020, 'affiliate-1')",
    ).run();
    await recognizeRevenueInDb(db, {
      provider: "stripe", sourceKey: "invoice:support-eur:line:1",
      providerPaymentId: "pi_support_eur", providerInvoiceId: "in_support_eur",
      providerLineId: "il_support_eur", affiliateId: 17, referredAccountId: 42,
      attributionId: 1, cadence: "annual", currency: "eur",
      eligibleRevenueMinor: 3_240, processingFeeMinor: 126,
      policyVersion: "affiliate-1", commissionRateNumerator: 1,
      commissionRateDenominator: 2, paidAt: 1_800_000_025,
      maturationSeconds: 60 * 24 * 60 * 60,
    });

    const summary = await getAffiliateSupportSummaryInDb(db, 17, 1_800_000_100);
    const activity = await getAffiliateSupportActivityInDb(db, 17);

    assert.deepEqual(summary, {
      accountId: 17,
      email: "alex@example.com",
      referralCode: "Alex",
      status: "active",
      enabledAt: 1_800_000_000,
      stripeConnectedAccountId: null,
      stripeConnectCountry: null,
      stripeConnectStatus: "not_started",
      stripeConnectPayoutsEnabled: false,
      termsVersion: "affiliate-1",
      policyVersion: "affiliate-1",
      termsAcceptedAt: 1_800_000_000,
      attributionCount: 1,
      ledgerBalanceMinor: 0,
      maturedBalanceMinor: 0,
      openReserveMinor: 0,
      paidPayoutMinor: 0,
      currency: "usd",
    });
    assert.deepEqual(activity, {
      uncommissionedOccurrences: [{
        id: activity.uncommissionedOccurrences[0].id,
        provider: "stripe",
        providerPaymentId: "pi_support_eur",
        providerInvoiceId: "in_support_eur",
        referredAccountId: 42,
        currency: "eur",
        eligibleRevenueMinor: 3_240,
        refundedEligibleRevenueMinor: 0,
        reason: "non_usd",
        policyVersion: "affiliate-1",
        paidAt: 1_800_000_025,
      }],
      attributions: [{
        id: 1,
        referredAccountId: 42,
        referredEmail: "reader@example.com",
        source: "code",
        interactedAt: 1_800_000_010,
        capturedAt: 1_800_000_020,
        policyVersion: "affiliate-1",
      }],
      ledgerEntries: [],
      reserves: [],
      payouts: [],
    });
    assert.deepEqual(await enqueueAffiliateEnrollmentEmailInDb(db, 17, 1_800_000_030), { enqueued: true });
    const enrollmentEmails = [];
    assert.deepEqual(await relayAffiliateEmailOutboxInDb(db, { send: async (body) => { enrollmentEmails.push(body); } }), { queued: 1 });
    assert.equal(enrollmentEmails[0].idempotencyKey, "affiliate-enrolled:17");
    assert.match(enrollmentEmails[0].plainText, /Alex/);
  } finally {
    await mf.dispose();
  }
});

test("migration permanently closes Attribution for accounts with prior payment evidence", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-existing-paid-backfill" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, billing_status TEXT NOT NULL DEFAULT 'inactive', crypto_paid_through INTEGER);");
    await db.prepare("INSERT INTO accounts (id, billing_status, crypto_paid_through) VALUES (1, 'inactive', NULL), (2, 'trialing', NULL), (3, 'active', NULL), (4, 'canceled', NULL), (5, 'inactive', 1700000000)").run();
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \\t]*--.*(?:\\r?\\n|$)/gm, "").split(/;\\s*(?=\\r?\\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }

    const accounts = await db.prepare("SELECT id, affiliate_eligibility_closed_at AS closed_at FROM accounts ORDER BY id").all();
    assert.equal(accounts.results[0].closed_at, null);
    assert.equal(accounts.results[1].closed_at, null);
    for (const account of accounts.results.slice(2)) assert.equal(Number.isInteger(account.closed_at), true);
  } finally {
    await mf.dispose();
  }
});

test("starting checkout without Attribution permanently closes the opportunity", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-checkout-close" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, billing_status TEXT NOT NULL DEFAULT 'inactive', crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id) VALUES (17), (42)").run();

    const checkout = await beginCheckoutAttributionInDb(db, 42, 1_800_000_100);
    const lateCapture = await captureReferralInDb(
      db,
      { affiliateId: 17, source: "code", interactedAt: 1_800_000_101 },
      { accountId: 42, attributionId: null, eligibilityClosedAt: null },
      { attributionWindowSeconds: 60 * 24 * 60 * 60 },
      1_800_000_101,
    );

    assert.deepEqual(checkout, { attribution: null, closedAt: 1_800_000_100 });
    assert.deepEqual(lateCapture, { accepted: false, reason: "eligibility_closed" });
  } finally {
    await mf.dispose();
  }
});

test("an unpaid account can explicitly apply an active Referral Code", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-explicit-code" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, status TEXT NOT NULL, email_verified INTEGER NOT NULL, billing_status TEXT NOT NULL, crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id, status, email_verified, billing_status, crypto_paid_through) VALUES (17, 'active', 1, 'inactive', NULL), (42, 'active', 1, 'inactive', NULL), (43, 'active', 1, 'trialing', NULL), (44, 'active', 1, 'inactive', 1700000000), (45, 'active', 1, 'canceled', NULL)").run();
    await enableAffiliateProfileInDb(db, {
      accountId: 17, referralCode: "Alex", termsVersion: "affiliate-1",
      termsDocumentDigest: "sha256:terms", policyVersion: "affiliate-1", acceptedAt: 1_800_000_000,
    });

    const pendingForm = new FormData();
    pendingForm.set("referral_code", "alex");
    const pendingResponse = await handleReferralCodeSubmission(
      new Request("https://www.blognice.com/admin/billing/referral", { method: "POST", body: pendingForm }),
      db, 42, 1_800_000_090,
    );
    assert.equal(pendingResponse.headers.get("location"), "/admin/billing?message=That%20referral%20code%20is%20not%20valid.");

    await attachStripePromotionCodeInDb(db, { accountId: 17, promotionCodeId: "promo_explicit_alex" });
    const form = new FormData();
    form.set("referral_code", " alex ");
    const response = await handleReferralCodeSubmission(
      new Request("https://www.blognice.com/admin/billing/referral", { method: "POST", body: form }),
      db,
      42,
      1_800_000_100,
    );

    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/admin/billing?message=Referral%20code%20applied.");
    const attribution = await db.prepare("SELECT affiliate_id, source, policy_version FROM affiliate_attributions WHERE referred_account_id = 42").first();
    assert.deepEqual(attribution, { affiliate_id: 17, source: "code", policy_version: "affiliate-1" });

    const submitFor = (accountId) => {
      const referralForm = new FormData();
      referralForm.set("referral_code", "alex");
      return handleReferralCodeSubmission(
        new Request("https://www.blognice.com/admin/billing/referral", { method: "POST", body: referralForm }),
        db, accountId, 1_800_000_100,
      );
    };
    assert.equal((await submitFor(43)).headers.get("location"), "/admin/billing?message=Referral%20code%20applied.");
    for (const paidAccountId of [44, 45]) {
      assert.equal((await submitFor(paidAccountId)).headers.get("location"), "/admin/billing?message=Referral%20codes%20can%20only%20be%20applied%20before%20your%20first%20payment.");
    }
  } finally {
    await mf.dispose();
  }
});

test("referral cookies survive key rotation but reject tampering and exact expiry", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-referral-http" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT, status TEXT NOT NULL, email_verified INTEGER NOT NULL, billing_status TEXT NOT NULL, crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id, status, email_verified, billing_status) VALUES (17, 'active', 1, 'inactive'), (42, 'active', 0, 'inactive'), (43, 'active', 0, 'inactive'), (44, 'active', 0, 'inactive')").run();
    await enableAffiliateProfileInDb(db, {
      accountId: 17, referralCode: "Alex", termsVersion: "affiliate-1",
      termsDocumentDigest: "sha256:terms", policyVersion: "affiliate-1", acceptedAt: 1_800_000_000,
    });

    await attachStripePromotionCodeInDb(db, { accountId: 17, promotionCodeId: "promo_link_alex" });
    assert.equal(await handleReferralLink(
      new Request("https://www.blognice.com/?ref=alex"), db, ["weak-secret"], 1_800_000_099,
    ), null);
    const currentSigningSecret = "current-signing-secret-at-least-32-bytes";
    const previousSigningSecret = "previous-signing-secret-at-least-32-bytes";
    const funnelEvents = [];
    const response = await handleReferralLink(
      new Request("https://www.blognice.com/?ref=alex"),
      db,
      [currentSigningSecret, previousSigningSecret],
      1_800_000_100,
      (event) => funnelEvents.push(event),
    );
    assert.equal(response?.status, 302);
    assert.equal(response?.headers.get("location"), "/affiliate-offer");
    const setCookie = response?.headers.get("set-cookie") || "";
    assert.match(setCookie, /^bn_ref=[^;]+;.*Max-Age=5184000/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.deepEqual(funnelEvents, [{
      affiliateId: 17,
      name: "affiliate_click",
      source: "link",
      policyVersion: "affiliate-1",
    }]);

    const cookie = setCookie.split(";", 1)[0];
    const captured = await captureSignupReferral(
      new Request("https://www.blognice.com/signup", { headers: { cookie } }),
      db,
      42,
      [currentSigningSecret, previousSigningSecret],
      1_800_000_200,
    );
    assert.equal(captured.accepted, true);
    const attribution = await db.prepare("SELECT affiliate_id, source, interacted_at FROM affiliate_attributions WHERE referred_account_id = 42").first();
    assert.deepEqual(attribution, { affiliate_id: 17, source: "link", interacted_at: 1_800_000_100 });

    const previousKeyResponse = await handleReferralLink(
      new Request("https://www.blognice.com/?ref=alex"), db,
      [previousSigningSecret], 1_800_000_300,
    );
    const previousKeyCookie = (previousKeyResponse?.headers.get("set-cookie") || "").split(";", 1)[0];
    assert.equal((await captureSignupReferral(
      new Request("https://www.blognice.com/signup", { headers: { cookie: previousKeyCookie } }),
      db, 43, [currentSigningSecret, previousSigningSecret], 1_800_000_301,
    )).accepted, true);

    const [cookieName, cookieValue] = previousKeyCookie.split("=");
    const [payload, signature] = cookieValue.split(".");
    const tamperedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    assert.deepEqual(await captureSignupReferral(
      new Request("https://www.blognice.com/signup", { headers: { cookie: `${cookieName}=${payload}.${tamperedSignature}` } }),
      db, 44, [currentSigningSecret, previousSigningSecret], 1_800_000_302,
    ), { accepted: false, reason: "missing_or_invalid_referral" });

    assert.deepEqual(await captureSignupReferral(
      new Request("https://www.blognice.com/signup", { headers: { cookie: previousKeyCookie } }),
      db, 44, [currentSigningSecret, previousSigningSecret], 1_800_000_300 + 60 * 24 * 60 * 60,
    ), { accepted: false, reason: "missing_or_invalid_referral" });
  } finally {
    await mf.dispose();
  }
});

test("an unpaid account accepts a referral interaction within the policy window", () => {
  const now = 1_800_000_000;

  assert.deepEqual(
    captureReferral(
      { affiliateId: 17, source: "link", interactedAt: now - 59 * 24 * 60 * 60 },
      { accountId: 42, attributionId: null, eligibilityClosedAt: null },
      { attributionWindowSeconds: 60 * 24 * 60 * 60 },
      now,
    ),
    {
      accepted: true,
      attribution: {
        affiliateId: 17,
        referredAccountId: 42,
        source: "link",
        interactedAt: now - 59 * 24 * 60 * 60,
        capturedAt: now,
      },
    },
  );
});

test("a referral interaction at the policy-window expiry is rejected", () => {
  const now = 1_800_000_000;

  assert.deepEqual(
    captureReferral(
      { affiliateId: 17, source: "link", interactedAt: now - 60 * 24 * 60 * 60 },
      { accountId: 42, attributionId: null, eligibilityClosedAt: null },
      { attributionWindowSeconds: 60 * 24 * 60 * 60 },
      now,
    ),
    { accepted: false, reason: "interaction_expired" },
  );
});

test("an existing attribution cannot be replaced", () => {
  const now = 1_800_000_000;

  assert.deepEqual(
    captureReferral(
      { affiliateId: 23, source: "code", interactedAt: now },
      { accountId: 42, attributionId: 9, eligibilityClosedAt: null },
      { attributionWindowSeconds: 60 * 24 * 60 * 60 },
      now,
    ),
    { accepted: false, reason: "already_attributed" },
  );
});

test("a staff-confirmed related account cannot create Attribution", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-related-account" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, billing_status TEXT NOT NULL DEFAULT 'inactive', crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id) VALUES (17), (42)").run();
    assert.deepEqual(await recordAffiliateAccountRelationshipInDb(db, {
      affiliateId: 17, relatedAccountId: 42, relationshipKind: "same_person",
      actorSubject: "staff|saul", actorRole: "admin",
      reason: "Identity review confirmed common control", recordedAt: 1_800_000_000,
    }), { recorded: true });

    assert.deepEqual(await captureReferralInDb(
      db,
      { affiliateId: 17, source: "code", interactedAt: 1_800_000_010, policyVersion: "policy-v1" },
      { accountId: 42, attributionId: null, eligibilityClosedAt: null },
      { attributionWindowSeconds: 60 * 24 * 60 * 60 },
      1_800_000_020,
    ), { accepted: false, reason: "related_account" });
    assert.deepEqual(await db.prepare("SELECT * FROM affiliate_attributions").all().then((result) => result.results), []);
  } finally {
    await mf.dispose();
  }
});

test("the Attribution seam and schema reject self-referral", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-self-referral" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, billing_status TEXT NOT NULL DEFAULT 'inactive', crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id) VALUES (17)").run();

    assert.deepEqual(await captureReferralInDb(
      db,
      { affiliateId: 17, source: "code", interactedAt: 1_800_000_000, policyVersion: "policy-v1" },
      { accountId: 17, attributionId: null, eligibilityClosedAt: null },
      { attributionWindowSeconds: 60 * 24 * 60 * 60 },
      1_800_000_001,
    ), { accepted: false, reason: "self_referral" });
    await assert.rejects(
      db.prepare(`INSERT INTO affiliate_attributions
        (referred_account_id, affiliate_id, source, interacted_at, captured_at, policy_version)
        VALUES (17, 17, 'code', 1800000000, 1800000001, 'policy-v1')`).run(),
      /CHECK constraint failed/,
    );
  } finally {
    await mf.dispose();
  }
});

test("a confirmed account relationship blocks Attribution in either direction", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-related-account-reverse" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, billing_status TEXT NOT NULL DEFAULT 'inactive', crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \\t]*--.*(?:\\r?\\n|$)/gm, "").split(/;\\s*(?=\\r?\\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id) VALUES (17), (42)").run();
    assert.deepEqual(await recordAffiliateAccountRelationshipInDb(db, {
      affiliateId: 42, relatedAccountId: 17, relationshipKind: "controlled_account",
      actorSubject: "staff|saul", actorRole: "admin",
      reason: "Control review linked both accounts", recordedAt: 1_800_000_000,
    }), { recorded: true });
    assert.deepEqual(await recordAffiliateAccountRelationshipInDb(db, {
      affiliateId: 17, relatedAccountId: 42, relationshipKind: "controlled_account",
      actorSubject: "staff|saul", actorRole: "admin",
      reason: "Duplicate reverse-direction report", recordedAt: 1_800_000_001,
    }), { recorded: false });
    assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM affiliate_account_relationships").first().then((row) => row.count), 1);

    assert.deepEqual(await captureReferralInDb(
      db,
      { affiliateId: 17, source: "code", interactedAt: 1_800_000_010, policyVersion: "policy-v1" },
      { accountId: 42, attributionId: null, eligibilityClosedAt: null },
      { attributionWindowSeconds: 60 * 24 * 60 * 60 },
      1_800_000_020,
    ), { accepted: false, reason: "related_account" });
    assert.deepEqual(await db.prepare("SELECT * FROM affiliate_attributions").all().then((result) => result.results), []);
  } finally {
    await mf.dispose();
  }
});

test("a first eligible payment permanently closes attribution", () => {
  const now = 1_800_000_000;

  assert.deepEqual(
    captureReferral(
      { affiliateId: 17, source: "code", interactedAt: now },
      { accountId: 42, attributionId: null, eligibilityClosedAt: now - 1 },
      { attributionWindowSeconds: 60 * 24 * 60 * 60 },
      now,
    ),
    { accepted: false, reason: "eligibility_closed" },
  );
});

test("concurrent referral capture stores exactly one immutable attribution", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-capture" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, billing_status TEXT NOT NULL DEFAULT 'inactive', crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id) VALUES (17), (23), (42)").run();
    const now = 1_800_000_000;
    const account = { accountId: 42, attributionId: null, eligibilityClosedAt: null };
    const policy = { attributionWindowSeconds: 60 * 24 * 60 * 60 };

    const results = await Promise.all([
      captureReferralInDb(db, { affiliateId: 17, source: "link", interactedAt: now }, account, policy, now),
      captureReferralInDb(db, { affiliateId: 23, source: "code", interactedAt: now }, account, policy, now),
    ]);

    assert.deepEqual(results.map((result) => result.accepted).sort(), [false, true]);
    const rows = await db.prepare("SELECT affiliate_id FROM affiliate_attributions WHERE referred_account_id = 42").all();
    assert.equal(rows.results.length, 1);
    assert.ok([17, 23].includes(Number(rows.results[0].affiliate_id)));
  } finally {
    await mf.dispose();
  }
});

test("first-payment closure races safely with referral capture", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-payment-close" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, billing_status TEXT NOT NULL DEFAULT 'inactive', crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id) VALUES (17), (42)").run();
    const now = 1_800_000_000;

    const [closed, capture] = await Promise.all([
      closeAttributionOpportunityInDb(db, 42, now),
      captureReferralInDb(
        db,
        { affiliateId: 17, source: "link", interactedAt: now },
        { accountId: 42, attributionId: null, eligibilityClosedAt: null },
        { attributionWindowSeconds: 60 * 24 * 60 * 60 },
        now,
      ),
    ]);

    assert.equal(closed.closedAt, now);
    const account = await db.prepare("SELECT affiliate_eligibility_closed_at FROM accounts WHERE id = 42").first();
    assert.equal(account.affiliate_eligibility_closed_at, now);
    const rows = await db.prepare("SELECT affiliate_id FROM affiliate_attributions WHERE referred_account_id = 42").all();
    assert.equal(rows.results.length, capture.accepted ? 1 : 0);
    if (!capture.accepted) assert.equal(capture.reason, "eligibility_closed");
  } finally {
    await mf.dispose();
  }
});

test("an Affiliate Profile keeps one immutable Stripe connected-account identity", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-stripe-connect-identity" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT NOT NULL, status TEXT NOT NULL, email_verified INTEGER NOT NULL, billing_status TEXT NOT NULL, crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id, email, status, email_verified, billing_status) VALUES (17, 'connect@example.com', 'active', 1, 'inactive')").run();
    await enableAffiliateProfileInDb(db, {
      accountId: 17, referralCode: "CONNECT17", termsVersion: "terms-v1",
      termsDocumentDigest: "sha256:terms-v1", policyVersion: "policy-v1", acceptedAt: 1_800_000_000,
    });

    assert.deepEqual(await attachStripeConnectedAccountInDb(db, {
      affiliateAccountId: 17, connectedAccountId: "acct_1Affiliate17",
      country: "GB", attachedAt: 1_800_000_100,
    }), { attached: true, connectedAccountId: "acct_1Affiliate17" });
    assert.deepEqual(await attachStripeConnectedAccountInDb(db, {
      affiliateAccountId: 17, connectedAccountId: "acct_1WrongRecipient",
      country: "US", attachedAt: 1_800_000_200,
    }), { attached: false, connectedAccountId: "acct_1Affiliate17" });
    assert.deepEqual(await updateStripeConnectedAccountStatusInDb(db, {
      connectedAccountId: "acct_1Affiliate17", detailsSubmitted: true,
      payoutsEnabled: true, transfersStatus: "active",
      eventCreated: 1_800_000_300, eventId: "evt_ready",
    }), { updated: true, status: "ready" });
    const readyEmails = [];
    assert.deepEqual(await relayAffiliateEmailOutboxInDb(db, { send: async (body) => { readyEmails.push(body); } }), { queued: 1 });
    assert.equal(readyEmails[0].emailKind, "affiliate-connect-ready");
    assert.equal(readyEmails[0].idempotencyKey, "affiliate-connect-ready:17:evt_ready");
    assert.match(readyEmails[0].plainText, /payout account is ready/i);
    assert.deepEqual(await updateStripeConnectedAccountStatusInDb(db, {
      connectedAccountId: "acct_1Affiliate17", detailsSubmitted: true,
      payoutsEnabled: false, transfersStatus: "active",
      eventCreated: 1_800_000_299, eventId: "evt_stale",
    }), { updated: false, status: "ready" });
    assert.deepEqual(await updateStripeConnectedAccountStatusInDb(db, {
      connectedAccountId: "acct_1Affiliate17", detailsSubmitted: true,
      payoutsEnabled: false, transfersStatus: "restricted",
      eventCreated: 1_800_000_400, eventId: "evt_restricted",
    }), { updated: true, status: "restricted" });
    const restrictedEmails = [];
    assert.deepEqual(await relayAffiliateEmailOutboxInDb(db, { send: async (body) => { restrictedEmails.push(body); } }), { queued: 1 });
    assert.equal(restrictedEmails[0].emailKind, "affiliate-connect-restricted");
    assert.equal(restrictedEmails[0].idempotencyKey, "affiliate-connect-restricted:17:evt_restricted");
    assert.match(restrictedEmails[0].plainText, /needs more information/i);
  } finally {
    await mf.dispose();
  }
});

test("a verified active free account enables an Affiliate Profile with immutable terms evidence", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-enable" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT, status TEXT NOT NULL, email_verified INTEGER NOT NULL, billing_status TEXT NOT NULL, crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id, status, email_verified, billing_status) VALUES (42, 'active', 1, 'inactive')").run();
    const now = 1_800_000_000;

    assert.deepEqual(await enableAffiliateProfileInDb(db, {
      accountId: 42,
      referralCode: "WRITER42",
      termsVersion: "affiliate-terms-v1",
      termsDocumentDigest: "sha256:terms-v1",
      policyVersion: "affiliate-policy-v1",
      acceptedAt: now,
    }), { enabled: true, status: "active", referralCode: "WRITER42" });

    const profile = await db.prepare("SELECT status, referral_code, terms_acceptance_id FROM affiliate_profiles WHERE account_id = 42").first();
    assert.equal(profile.status, "active");
    assert.equal(profile.referral_code, "WRITER42");
    const acceptance = await db.prepare("SELECT account_id, terms_version, terms_document_digest, policy_version, accepted_at FROM affiliate_terms_acceptances WHERE id = ?").bind(profile.terms_acceptance_id).first();
    assert.deepEqual(acceptance, {
      account_id: 42,
      terms_version: "affiliate-terms-v1",
      terms_document_digest: "sha256:terms-v1",
      policy_version: "affiliate-policy-v1",
      accepted_at: now,
    });
    assert.deepEqual(await attachStripePromotionCodeInDb(db, {
      accountId: 42,
      promotionCodeId: "promo_writer42",
    }), { attached: true });
    assert.deepEqual(await attachStripePromotionCodeInDb(db, {
      accountId: 42,
      promotionCodeId: "promo_replacement",
    }), { attached: false });
    const provisioned = await db.prepare("SELECT stripe_promotion_code_id FROM affiliate_profiles WHERE account_id = 42").first();
    assert.deepEqual(provisioned, { stripe_promotion_code_id: "promo_writer42" });

    assert.deepEqual(await requireCurrentAffiliateTermsInDb(db, {
      accountId: 42, termsVersion: "affiliate-terms-v2", policyVersion: "affiliate-policy-v2",
      requiredAt: now + 50,
    }), { required: true });
    assert.deepEqual(await reacceptAffiliateTermsInDb(db, {
      accountId: 42, termsVersion: "affiliate-terms-v2",
      termsDocumentDigest: "sha256:terms-v2", policyVersion: "affiliate-policy-v2",
      acceptedAt: now + 100,
    }), { accepted: true, status: "active" });
    const acceptances = await db.prepare("SELECT terms_version, terms_document_digest, policy_version, accepted_at FROM affiliate_terms_acceptances WHERE account_id = 42 ORDER BY accepted_at").all();
    assert.deepEqual(acceptances.results, [
      { terms_version: "affiliate-terms-v1", terms_document_digest: "sha256:terms-v1", policy_version: "affiliate-policy-v1", accepted_at: now },
      { terms_version: "affiliate-terms-v2", terms_document_digest: "sha256:terms-v2", policy_version: "affiliate-policy-v2", accepted_at: now + 100 },
    ]);
  } finally {
    await mf.dispose();
  }
});

test("commission is 50% of discounted revenue excluding tax and before processing fees", () => {
  const paidAt = 1_800_000_000;

  assert.deepEqual(recognizeRevenue({
    provider: "stripe",
    currency: "usd",
    eligibleRevenueMinor: 3_240,
    processingFeeMinor: 126,
    commissionRateNumerator: 1,
    commissionRateDenominator: 2,
    paidAt,
    maturationSeconds: 60 * 24 * 60 * 60,
  }), {
    eligibleRevenueMinor: 3_240,
    commissionMinor: 1_620,
    availableAt: paidAt + 60 * 24 * 60 * 60,
    commissionRateNumerator: 1,
    commissionRateDenominator: 2,
  });
  assert.equal(recognizeRevenue({
    provider: "stripe",
    currency: "usd",
    eligibleRevenueMinor: 1,
    processingFeeMinor: 0,
    commissionRateNumerator: 1,
    commissionRateDenominator: 2,
    paidAt,
    maturationSeconds: 60 * 24 * 60 * 60,
  }).commissionMinor, 1, "an exact half-cent rounds up");
});

test("duplicate provider notifications create one Revenue Occurrence and one Commission Entry", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-revenue-idempotency" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, billing_status TEXT NOT NULL DEFAULT 'inactive', crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id) VALUES (17), (42)").run();
    const attribution = await db.prepare(
      "INSERT INTO affiliate_attributions (referred_account_id, affiliate_id, source, interacted_at, captured_at) VALUES (42, 17, 'link', 1790000000, 1790000000) RETURNING id",
    ).first();
    const occurrence = {
      provider: "stripe",
      sourceKey: "invoice:in_123:line:il_456",
      providerPaymentId: "pi_123",
      providerInvoiceId: "in_123",
      providerLineId: "il_456",
      affiliateId: 17,
      referredAccountId: 42,
      attributionId: Number(attribution.id),
      cadence: "annual",
      currency: "usd",
      eligibleRevenueMinor: 3_241,
      processingFeeMinor: 126,
      policyVersion: "affiliate-policy-v1",
      commissionRateNumerator: 1,
      commissionRateDenominator: 2,
      paidAt: 1_800_000_000,
      maturationSeconds: 60 * 24 * 60 * 60,
    };

    const results = await Promise.all([
      recognizeRevenueInDb(db, occurrence),
      recognizeRevenueInDb(db, occurrence),
    ]);

    assert.deepEqual(results.map(({ created }) => created).sort(), [false, true]);
    const occurrences = await db.prepare("SELECT eligible_revenue_minor, processing_fee_minor FROM affiliate_revenue_occurrences").all();
    assert.deepEqual(occurrences.results, [{ eligible_revenue_minor: 3241, processing_fee_minor: 126 }]);
    const entries = await db.prepare("SELECT affiliate_id, amount_minor, available_at FROM affiliate_ledger_entries").all();
    assert.deepEqual(entries.results, [{
      affiliate_id: 17,
      amount_minor: 1621,
      available_at: occurrence.paidAt + occurrence.maturationSeconds,
    }]);

    const credits = await Promise.all([
      recordStripeCreditNoteInDb(db, {
        invoiceId: "in_123", invoiceLineId: "il_456", creditNoteId: "cn_123",
        creditedEligibleRevenueMinor: 1_000, recordedAt: 1_800_000_100,
      }),
      recordStripeCreditNoteInDb(db, {
        invoiceId: "in_123", invoiceLineId: "il_456", creditNoteId: "cn_123",
        creditedEligibleRevenueMinor: 1_000, recordedAt: 1_800_000_100,
      }),
    ]);
    assert.deepEqual(credits.map(({ recorded }) => recorded).sort(), [false, true]);
    assert.deepEqual(await db.prepare(
      "SELECT entry_kind, amount_minor FROM affiliate_ledger_entries ORDER BY created_at",
    ).all().then((query) => query.results), [
      { entry_kind: "earning", amount_minor: 1_621 },
      { entry_kind: "refund", amount_minor: -500 },
    ]);

    const corrections = await Promise.all([
      recordManualAffiliateAdjustmentInDb(db, {
        occurrenceId: results.find(({ created }) => created).occurrenceId,
        sourceKey: "support-case:AFF-123", amountMinor: -25,
        actorSubject: "staff-admin-1", actorRole: "admin",
        reason: "Correct a documented rounding exception", recordedAt: 1_800_000_200,
      }),
      recordManualAffiliateAdjustmentInDb(db, {
        occurrenceId: results.find(({ created }) => created).occurrenceId,
        sourceKey: "support-case:AFF-123", amountMinor: -25,
        actorSubject: "staff-admin-1", actorRole: "admin",
        reason: "Correct a documented rounding exception", recordedAt: 1_800_000_200,
      }),
    ]);
    assert.deepEqual(corrections.map(({ recorded }) => recorded).sort(), [false, true]);
    assert.deepEqual(await db.prepare(
      `SELECT manual.source_key, manual.actor_subject, manual.actor_role, manual.reason,
              ledger.entry_kind, ledger.amount_minor
         FROM affiliate_manual_adjustments AS manual
         JOIN affiliate_ledger_entries AS ledger ON ledger.manual_adjustment_id = manual.id`,
    ).first(), {
      source_key: "support-case:AFF-123", actor_subject: "staff-admin-1", actor_role: "admin",
      reason: "Correct a documented rounding exception", entry_kind: "manual_adjustment", amount_minor: -25,
    });
  } finally {
    await mf.dispose();
  }
});

test("D1 rejects Revenue Occurrence identity that disagrees with Attribution", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-revenue-identity" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, billing_status TEXT NOT NULL DEFAULT 'inactive', crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \\t]*--.*(?:\\r?\\n|$)/gm, "").split(/;\\s*(?=\\r?\\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id) VALUES (17), (23), (42)").run();
    const attribution = await db.prepare(
      "INSERT INTO affiliate_attributions (referred_account_id, affiliate_id, source, interacted_at, captured_at) VALUES (42, 17, 'link', 1790000000, 1790000000) RETURNING id",
    ).first();

    assert.deepEqual(await recognizeRevenueInDb(db, {
      provider: "stripe", sourceKey: "invoice:wrong-payee:line:1",
      providerPaymentId: "pi_wrong_payee", providerInvoiceId: "in_wrong_payee",
      providerLineId: "il_wrong_payee", affiliateId: 23, referredAccountId: 42,
      attributionId: Number(attribution.id), cadence: "annual", currency: "usd",
      eligibleRevenueMinor: 3_240, processingFeeMinor: 126,
      policyVersion: "affiliate-policy-v1", commissionRateNumerator: 1,
      commissionRateDenominator: 2, paidAt: 1_800_000_000,
      maturationSeconds: 60 * 24 * 60 * 60,
    }), { created: false, occurrenceId: null });

    assert.deepEqual(await db.prepare("SELECT * FROM affiliate_installments").all().then((result) => result.results), []);
    assert.deepEqual(await db.prepare("SELECT * FROM affiliate_revenue_occurrences").all().then((result) => result.results), []);
    assert.deepEqual(await db.prepare("SELECT * FROM affiliate_ledger_entries").all().then((result) => result.results), []);
  } finally {
    await mf.dispose();
  }
});

test("a relationship confirmed after Attribution retains revenue without creating commission", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-related-revenue" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT NOT NULL, status TEXT NOT NULL, email_verified INTEGER NOT NULL, billing_status TEXT NOT NULL, crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \\t]*--.*(?:\\r?\\n|$)/gm, "").split(/;\\s*(?=\\r?\\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id, email, status, email_verified, billing_status) VALUES (17, 'affiliate@example.com', 'active', 1, 'inactive'), (42, 'related@example.com', 'active', 1, 'inactive')").run();
    await enableAffiliateProfileInDb(db, {
      accountId: 17, referralCode: "RELATED17", termsVersion: "terms-v1",
      termsDocumentDigest: "sha256:terms-v1", policyVersion: "policy-v1",
      acceptedAt: 1_790_000_000,
    });
    const attribution = await db.prepare(
      "INSERT INTO affiliate_attributions (referred_account_id, affiliate_id, source, interacted_at, captured_at) VALUES (42, 17, 'link', 1790000000, 1790000000) RETURNING id",
    ).first();
    assert.deepEqual(await requireCurrentAffiliateTermsInDb(db, {
      accountId: 17, termsVersion: "terms-v2", policyVersion: "policy-v2",
      requiredAt: 1_798_000_000,
    }), { required: true });
    await recordAffiliateAccountRelationshipInDb(db, {
      affiliateId: 42, relatedAccountId: 17, relationshipKind: "same_organization",
      actorSubject: "staff|saul", actorRole: "admin",
      reason: "Organization review confirmed shared control", recordedAt: 1_799_000_000,
    });
    assert.deepEqual(await db.prepare("SELECT status FROM affiliate_profiles WHERE account_id = 17").first(), { status: "suspended" });
    assert.deepEqual(await reacceptAffiliateTermsInDb(db, {
      accountId: 17, termsVersion: "terms-v2", termsDocumentDigest: "sha256:terms-v2",
      policyVersion: "policy-v2", acceptedAt: 1_799_000_001,
    }), { accepted: false, status: "suspended" });

    const result = await recognizeRevenueInDb(db, {
      provider: "stripe", sourceKey: "invoice:related:line:1",
      providerPaymentId: "pi_related", providerInvoiceId: "in_related",
      providerLineId: "il_related", affiliateId: 17, referredAccountId: 42,
      attributionId: Number(attribution.id), cadence: "annual", currency: "usd",
      eligibleRevenueMinor: 3_240, processingFeeMinor: 126,
      policyVersion: "affiliate-policy-v1", commissionRateNumerator: 1,
      commissionRateDenominator: 2, paidAt: 1_800_000_000,
      maturationSeconds: 60 * 24 * 60 * 60,
    });

    assert.equal(result.created, true);
    assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM affiliate_revenue_occurrences").first().then((row) => row.count), 1);
    assert.deepEqual(await db.prepare("SELECT * FROM affiliate_ledger_entries").all().then((query) => query.results), []);
    const activity = await getAffiliateSupportActivityInDb(db, 17);
    assert.equal(activity.uncommissionedOccurrences.length, 1);
    assert.equal(activity.uncommissionedOccurrences[0].reason, "related_account");
  } finally {
    await mf.dispose();
  }
});

test("related-account earnings stay ineligible after Affiliate reactivation", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-related-existing-earnings" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT NOT NULL, status TEXT NOT NULL, email_verified INTEGER NOT NULL, billing_status TEXT NOT NULL, crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \\t]*--.*(?:\\r?\\n|$)/gm, "").split(/;\\s*(?=\\r?\\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id, email, status, email_verified, billing_status) VALUES (17, 'affiliate@example.com', 'active', 1, 'inactive'), (42, 'related@example.com', 'active', 1, 'active'), (51, 'legitimate@example.com', 'active', 1, 'active')").run();
    await enableAffiliateProfileInDb(db, {
      accountId: 17, referralCode: "EXISTING17", termsVersion: "terms-v1",
      termsDocumentDigest: "sha256:terms-v1", policyVersion: "policy-v1",
      acceptedAt: 1_780_000_000,
    });
    await db.prepare("UPDATE affiliate_profiles SET stripe_connected_account_id = 'acct_related', stripe_connect_country = 'GB', stripe_connect_status = 'ready', stripe_connect_payouts_enabled = 1 WHERE account_id = 17").run();
    const attribution = await db.prepare(
      "INSERT INTO affiliate_attributions (referred_account_id, affiliate_id, source, interacted_at, captured_at) VALUES (42, 17, 'link', 1780000000, 1780000000) RETURNING id",
    ).first();
    const revenue = (sourceKey, lineId) => recognizeRevenueInDb(db, {
      provider: "stripe", sourceKey, providerPaymentId: `pi_${lineId}`,
      providerInvoiceId: `in_${lineId}`, providerLineId: lineId,
      affiliateId: 17, referredAccountId: 42, attributionId: Number(attribution.id),
      cadence: "monthly", currency: "usd", eligibleRevenueMinor: 20_000,
      processingFeeMinor: 600, policyVersion: "policy-v1",
      commissionRateNumerator: 1, commissionRateDenominator: 2,
      paidAt: 1_780_000_000, maturationSeconds: 60 * 24 * 60 * 60,
    });
    await revenue("invoice:related-existing:line:1", "line_1");
    const prepared = await preparePayoutInDb(db, {
      affiliateId: 17, currency: "usd", cutoff: 1_800_000_000, minimumMinor: 10_000,
    });
    assert.equal(prepared.prepared, true);
    const secondRevenue = await revenue("invoice:related-existing:line:2", "line_2");
    assert.deepEqual(await openDisputeReserveInDb(db, {
      occurrenceId: secondRevenue.occurrenceId, provider: "stripe",
      disputeId: "dp_related_existing", sourceKey: "dispute:related-existing:opened",
      openedAt: 1_800_000_005,
    }), { reserved: true });

    await recordAffiliateAccountRelationshipInDb(db, {
      affiliateId: 17, relatedAccountId: 42, relationshipKind: "controlled_account",
      actorSubject: "staff|saul", actorRole: "admin",
      reason: "Control review invalidated commission", recordedAt: 1_800_000_010,
    });
    assert.deepEqual(await recordRefundInDb(db, {
      occurrenceId: secondRevenue.occurrenceId, provider: "stripe",
      sourceKey: "refund:related-existing:line:2",
      refundedEligibleRevenueMinor: 10_000, recordedAt: 1_800_000_011,
    }), { recorded: true });
    assert.deepEqual(await resolveDisputeInDb(db, {
      provider: "stripe", disputeId: "dp_related_existing", outcome: "lost",
      sourceKey: "dispute:related-existing:lost", resolvedAt: 1_800_000_012,
    }), { resolved: true });
    const correctedLedger = await db.prepare(
      "SELECT entry_kind, amount_minor FROM affiliate_ledger_entries ORDER BY created_at, entry_kind",
    ).all();
    assert.deepEqual(correctedLedger.results, [
      { entry_kind: "earning", amount_minor: 10_000 },
      { entry_kind: "earning", amount_minor: 10_000 },
      { entry_kind: "relationship_reversal", amount_minor: -10_000 },
      { entry_kind: "relationship_reversal", amount_minor: -10_000 },
    ]);
    assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM affiliate_revenue_adjustments").first().then((row) => row.count), 1);
    assert.deepEqual(await db.prepare("SELECT status, resolution_source_key FROM affiliate_reserves WHERE dispute_id = 'dp_related_existing'").first(), {
      status: "lost", resolution_source_key: "dispute:related-existing:lost",
    });
    await db.prepare("UPDATE affiliate_payouts SET status = 'cancelled' WHERE id = ?").bind(prepared.payoutId).run();
    await db.prepare("UPDATE affiliate_payout_entries SET released_at = 1800000013 WHERE payout_id = ?").bind(prepared.payoutId).run();
    const legitimateAttribution = await db.prepare(
      "INSERT INTO affiliate_attributions (referred_account_id, affiliate_id, source, interacted_at, captured_at) VALUES (51, 17, 'link', 1800000013, 1800000013) RETURNING id",
    ).first();
    await recognizeRevenueInDb(db, {
      provider: "stripe", sourceKey: "invoice:related-existing:legitimate",
      providerPaymentId: "pi_related_existing_legitimate",
      providerInvoiceId: "in_related_existing_legitimate",
      providerLineId: "line_related_existing_legitimate", affiliateId: 17,
      referredAccountId: 51, attributionId: Number(legitimateAttribution.id),
      cadence: "annual", currency: "usd", eligibleRevenueMinor: 40_000,
      processingFeeMinor: 1_200, policyVersion: "policy-v1",
      commissionRateNumerator: 1, commissionRateDenominator: 2,
      paidAt: 1_780_000_000, maturationSeconds: 60 * 24 * 60 * 60,
    });
    await db.prepare("UPDATE affiliate_profiles SET status = 'active' WHERE account_id = 17").run();

    const legitimatePayout = await preparePayoutInDb(db, {
      affiliateId: 17, currency: "usd", cutoff: 1_800_000_020, minimumMinor: 1,
    });
    assert.equal(legitimatePayout.prepared, true);
    assert.equal(legitimatePayout.amountMinor, 20_000);
    assert.equal((await loadStripePayoutDispatchInDb(db, legitimatePayout.payoutId, new Set(["GB"]))).dispatchable, true);
    assert.deepEqual(await loadStripePayoutDispatchInDb(db, legitimatePayout.payoutId, new Set(["US"])), { dispatchable: false });
    assert.deepEqual(await loadStripePayoutDispatchInDb(db, prepared.payoutId, new Set(["GB"])), { dispatchable: false });
  } finally {
    await mf.dispose();
  }
});

test("a paid related-account reversal carries forward against legitimate commission", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-related-negative-carry" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT NOT NULL, status TEXT NOT NULL, email_verified INTEGER NOT NULL, billing_status TEXT NOT NULL, crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \\t]*--.*(?:\\r?\\n|$)/gm, "").split(/;\\s*(?=\\r?\\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id, email, status, email_verified, billing_status) VALUES (17, 'affiliate@example.com', 'active', 1, 'inactive'), (42, 'related@example.com', 'active', 1, 'active'), (51, 'legitimate@example.com', 'active', 1, 'active')").run();
    await enableAffiliateProfileInDb(db, {
      accountId: 17, referralCode: "RECOVERY17", termsVersion: "terms-v1",
      termsDocumentDigest: "sha256:terms-v1", policyVersion: "policy-v1",
      acceptedAt: 1_780_000_000,
    });
    await db.prepare("UPDATE affiliate_profiles SET stripe_connected_account_id = 'acct_recovery', stripe_connect_country = 'GB', stripe_connect_status = 'ready', stripe_connect_payouts_enabled = 1 WHERE account_id = 17").run();
    const relatedAttribution = await db.prepare(
      "INSERT INTO affiliate_attributions (referred_account_id, affiliate_id, source, interacted_at, captured_at) VALUES (42, 17, 'link', 1780000000, 1780000000) RETURNING id",
    ).first();
    await recognizeRevenueInDb(db, {
      provider: "stripe", sourceKey: "invoice:recovery:related", providerPaymentId: "pi_recovery_related",
      providerInvoiceId: "in_recovery_related", providerLineId: "line_recovery_related",
      affiliateId: 17, referredAccountId: 42, attributionId: Number(relatedAttribution.id),
      cadence: "annual", currency: "usd", eligibleRevenueMinor: 20_000,
      processingFeeMinor: 600, policyVersion: "policy-v1", commissionRateNumerator: 1,
      commissionRateDenominator: 2, paidAt: 1_780_000_000, maturationSeconds: 60 * 24 * 60 * 60,
    });
    const oldPayout = await preparePayoutInDb(db, {
      affiliateId: 17, currency: "usd", cutoff: 1_800_000_000, minimumMinor: 10_000,
    });
    assert.equal(oldPayout.prepared, true);
    await db.prepare("UPDATE affiliate_payouts SET status = 'paid' WHERE id = ?").bind(oldPayout.payoutId).run();
    await recordAffiliateAccountRelationshipInDb(db, {
      affiliateId: 17, relatedAccountId: 42, relationshipKind: "same_person",
      actorSubject: "staff|saul", actorRole: "admin", reason: "Confirmed common identity",
      recordedAt: 1_800_000_010,
    });

    const legitimateAttribution = await db.prepare(
      "INSERT INTO affiliate_attributions (referred_account_id, affiliate_id, source, interacted_at, captured_at) VALUES (51, 17, 'link', 1800000011, 1800000011) RETURNING id",
    ).first();
    await recognizeRevenueInDb(db, {
      provider: "stripe", sourceKey: "invoice:recovery:legitimate", providerPaymentId: "pi_recovery_legitimate",
      providerInvoiceId: "in_recovery_legitimate", providerLineId: "line_recovery_legitimate",
      affiliateId: 17, referredAccountId: 51, attributionId: Number(legitimateAttribution.id),
      cadence: "annual", currency: "usd", eligibleRevenueMinor: 40_000,
      processingFeeMinor: 1_200, policyVersion: "policy-v1", commissionRateNumerator: 1,
      commissionRateDenominator: 2, paidAt: 1_780_000_000, maturationSeconds: 60 * 24 * 60 * 60,
    });
    await db.prepare("UPDATE affiliate_profiles SET status = 'active' WHERE account_id = 17").run();

    const recoveryPayout = await preparePayoutInDb(db, {
      affiliateId: 17, currency: "usd", cutoff: 1_800_000_020, minimumMinor: 10_000,
    });
    assert.equal(recoveryPayout.prepared, true);
    assert.equal(recoveryPayout.amountMinor, 10_000);
    assert.equal((await loadStripePayoutDispatchInDb(db, recoveryPayout.payoutId, new Set(["GB"]))).dispatchable, true);
  } finally {
    await mf.dispose();
  }
});

test("negative NOWPayments commission can offset a Stripe-funded payout", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-nowpayments-negative-stripe-payout" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT NOT NULL, status TEXT NOT NULL, email_verified INTEGER NOT NULL, billing_status TEXT NOT NULL, crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \\t]*--.*(?:\\r?\\n|$)/gm, "").split(/;\\s*(?=\\r?\\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id, email, status, email_verified, billing_status) VALUES (17, 'affiliate@example.com', 'active', 1, 'inactive'), (42, 'crypto@example.com', 'active', 1, 'active'), (51, 'stripe@example.com', 'active', 1, 'active')").run();
    await enableAffiliateProfileInDb(db, {
      accountId: 17, referralCode: "MIXED17", termsVersion: "terms-v1",
      termsDocumentDigest: "sha256:terms-v1", policyVersion: "policy-v1",
      acceptedAt: 1_780_000_000,
    });
    await db.prepare("UPDATE affiliate_profiles SET stripe_connected_account_id = 'acct_mixed', stripe_connect_country = 'GB', stripe_connect_status = 'ready', stripe_connect_payouts_enabled = 1 WHERE account_id = 17").run();
    const cryptoAttribution = await db.prepare(
      "INSERT INTO affiliate_attributions (referred_account_id, affiliate_id, source, interacted_at, captured_at) VALUES (42, 17, 'link', 1780000000, 1780000000) RETURNING id",
    ).first();
    const cryptoSale = await recognizeRevenueInDb(db, {
      provider: "nowpayments", sourceKey: "order:mixed:crypto", providerPaymentId: "np_mixed",
      providerInvoiceId: "order_mixed", providerLineId: null, affiliateId: 17,
      referredAccountId: 42, attributionId: Number(cryptoAttribution.id), cadence: "annual",
      currency: "usd", eligibleRevenueMinor: 20_000, processingFeeMinor: 0,
      policyVersion: "policy-v1", commissionRateNumerator: 1,
      commissionRateDenominator: 2, paidAt: 1_780_000_000,
      maturationSeconds: 60 * 24 * 60 * 60,
    });
    const cryptoPayout = await preparePayoutInDb(db, {
      affiliateId: 17, currency: "usd", cutoff: 1_800_000_000, minimumMinor: 10_000,
    });
    assert.equal(cryptoPayout.prepared, true);
    assert.deepEqual(await loadStripePayoutDispatchInDb(db, cryptoPayout.payoutId, new Set(["GB"])), { dispatchable: false });
    await db.prepare("UPDATE affiliate_payouts SET status = 'paid' WHERE id = ?").bind(cryptoPayout.payoutId).run();
    assert.deepEqual(await recordRefundInDb(db, {
      occurrenceId: cryptoSale.occurrenceId, provider: "nowpayments",
      sourceKey: "refund:mixed:crypto", refundedEligibleRevenueMinor: 20_000,
      recordedAt: 1_800_000_001,
    }), { recorded: true });

    const stripeAttribution = await db.prepare(
      "INSERT INTO affiliate_attributions (referred_account_id, affiliate_id, source, interacted_at, captured_at) VALUES (51, 17, 'link', 1800000002, 1800000002) RETURNING id",
    ).first();
    await recognizeRevenueInDb(db, {
      provider: "stripe", sourceKey: "invoice:mixed:stripe", providerPaymentId: "pi_mixed",
      providerInvoiceId: "in_mixed", providerLineId: "line_mixed", affiliateId: 17,
      referredAccountId: 51, attributionId: Number(stripeAttribution.id), cadence: "annual",
      currency: "usd", eligibleRevenueMinor: 40_000, processingFeeMinor: 1_200,
      policyVersion: "policy-v1", commissionRateNumerator: 1,
      commissionRateDenominator: 2, paidAt: 1_780_000_000,
      maturationSeconds: 60 * 24 * 60 * 60,
    });
    const mixedPayout = await preparePayoutInDb(db, {
      affiliateId: 17, currency: "usd", cutoff: 1_800_000_010, minimumMinor: 10_000,
    });
    assert.equal(mixedPayout.prepared, true);
    assert.equal(mixedPayout.amountMinor, 10_000);
    assert.equal((await loadStripePayoutDispatchInDb(db, mixedPayout.payoutId, new Set(["GB"]))).dispatchable, true);
  } finally {
    await mf.dispose();
  }
});

test("non-USD revenue is retained without creating commission", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-non-usd-revenue" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, billing_status TEXT NOT NULL DEFAULT 'inactive', crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id) VALUES (17), (42)").run();
    const attribution = await db.prepare(
      "INSERT INTO affiliate_attributions (referred_account_id, affiliate_id, source, interacted_at, captured_at) VALUES (42, 17, 'link', 1800000000, 1800000000) RETURNING id",
    ).first();

    const retained = await recognizeRevenueInDb(db, {
      provider: "stripe", sourceKey: "invoice:eur:line:1",
      providerPaymentId: "pi_eur", providerInvoiceId: "in_eur", providerLineId: "il_eur",
      affiliateId: 17, referredAccountId: 42, attributionId: Number(attribution.id),
      cadence: "annual", currency: "eur", eligibleRevenueMinor: 3_240,
      processingFeeMinor: 126, policyVersion: "policy-v1",
      commissionRateNumerator: 1, commissionRateDenominator: 2,
      paidAt: 1_800_000_000, maturationSeconds: 60 * 24 * 60 * 60,
    });
    assert.equal(retained.created, true);
    assert.deepEqual(await db.prepare(
      "SELECT currency, eligible_revenue_minor FROM affiliate_revenue_occurrences",
    ).all().then((result) => result.results), [{ currency: "eur", eligible_revenue_minor: 3_240 }]);
    assert.deepEqual(await recordRefundInDb(db, {
      occurrenceId: retained.occurrenceId, provider: "stripe", sourceKey: "refund:eur:partial",
      refundedEligibleRevenueMinor: 1_000, recordedAt: 1_800_000_100,
    }), { recorded: true });
    assert.deepEqual(await db.prepare(
      "SELECT provider, refunded_eligible_revenue_minor FROM affiliate_revenue_adjustments",
    ).all().then((result) => result.results), [{ provider: "stripe", refunded_eligible_revenue_minor: 1_000 }]);
    assert.deepEqual(await db.prepare("SELECT * FROM affiliate_ledger_entries").all().then((result) => result.results), []);
  } finally {
    await mf.dispose();
  }
});

test("only the first non-zero annual subscription line qualifies", () => {
  assert.deepEqual(decideInstallmentEligibility({
    cadence: "annual",
    qualifyingInstallmentsConsumed: 0,
    lineKind: "subscription",
    eligibleRevenueMinor: 0,
  }), { qualifies: false, reason: "zero_value" });

  assert.deepEqual(decideInstallmentEligibility({
    cadence: "annual",
    qualifyingInstallmentsConsumed: 0,
    lineKind: "subscription",
    eligibleRevenueMinor: 3_240,
  }), { qualifies: true, installmentNumber: 1 });

  assert.deepEqual(decideInstallmentEligibility({
    cadence: "annual",
    qualifyingInstallmentsConsumed: 1,
    lineKind: "subscription",
    eligibleRevenueMinor: 3_240,
  }), { qualifies: false, reason: "installment_limit_reached" });
});

test("monthly eligibility covers 12 paid subscription lines without consuming zero or proration lines", () => {
  assert.deepEqual(decideInstallmentEligibility({
    cadence: "monthly",
    qualifyingInstallmentsConsumed: 11,
    lineKind: "subscription",
    eligibleRevenueMinor: 450,
  }), { qualifies: true, installmentNumber: 12 });

  assert.deepEqual(decideInstallmentEligibility({
    cadence: "monthly",
    qualifyingInstallmentsConsumed: 12,
    lineKind: "subscription",
    eligibleRevenueMinor: 450,
  }), { qualifies: false, reason: "installment_limit_reached" });

  assert.deepEqual(decideInstallmentEligibility({
    cadence: "monthly",
    qualifyingInstallmentsConsumed: 7,
    lineKind: "subscription",
    eligibleRevenueMinor: 0,
  }), { qualifies: false, reason: "zero_value" });

  assert.deepEqual(decideInstallmentEligibility({
    cadence: "monthly",
    qualifyingInstallmentsConsumed: 7,
    lineKind: "proration",
    eligibleRevenueMinor: 125,
  }), { qualifies: false, reason: "non_subscription_line" });
});

test("concurrent monthly payments cannot claim more than 12 installments", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-installment-limit" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, billing_status TEXT NOT NULL DEFAULT 'inactive', crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id) VALUES (17), (42)").run();
    const attribution = await db.prepare(
      "INSERT INTO affiliate_attributions (referred_account_id, affiliate_id, source, interacted_at, captured_at) VALUES (42, 17, 'link', 1790000000, 1790000000) RETURNING id",
    ).first();
    for (let installment = 1; installment <= 11; installment += 1) {
      await db.prepare(
        "INSERT INTO affiliate_installments (attribution_id, cadence, installment_number, provider, source_key, claimed_at) VALUES (?, 'monthly', ?, 'stripe', ?, 1800000000)",
      ).bind(attribution.id, installment, `invoice:seed-${installment}:line:1`).run();
    }

    const payment = (suffix) => ({
      provider: "stripe",
      sourceKey: `invoice:race-${suffix}:line:1`,
      providerPaymentId: `pi_race_${suffix}`,
      providerInvoiceId: `in_race_${suffix}`,
      providerLineId: `il_race_${suffix}`,
      affiliateId: 17,
      referredAccountId: 42,
      attributionId: Number(attribution.id),
      cadence: "monthly",
      currency: "usd",
      eligibleRevenueMinor: 450,
      processingFeeMinor: 30,
      policyVersion: "affiliate-policy-v1",
      commissionRateNumerator: 1,
      commissionRateDenominator: 2,
      paidAt: 1_800_000_001,
      maturationSeconds: 60 * 24 * 60 * 60,
    });
    const results = await Promise.all([
      recognizeRevenueInDb(db, payment("a")),
      recognizeRevenueInDb(db, payment("b")),
    ]);

    assert.deepEqual(results.map(({ created }) => created).sort(), [false, true]);
    const stored = await db.prepare("SELECT COUNT(*) AS count, MAX(installment_number) AS highest FROM affiliate_installments WHERE attribution_id = ?").bind(attribution.id).first();
    assert.deepEqual(stored, { count: 12, highest: 12 });
    const occurrences = await db.prepare("SELECT COUNT(*) AS count FROM affiliate_revenue_occurrences").first();
    assert.deepEqual(occurrences, { count: 1 });
    const entries = await db.prepare("SELECT COUNT(*) AS count, SUM(amount_minor) AS amount FROM affiliate_ledger_entries").first();
    assert.deepEqual(entries, { count: 1, amount: 225 });
  } finally {
    await mf.dispose();
  }
});

test("concurrent refunds cannot reverse more than the original commission", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-refund-limit" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, billing_status TEXT NOT NULL DEFAULT 'inactive', crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id) VALUES (17), (42)").run();
    const attribution = await db.prepare(
      "INSERT INTO affiliate_attributions (referred_account_id, affiliate_id, source, interacted_at, captured_at) VALUES (42, 17, 'link', 1790000000, 1790000000) RETURNING id",
    ).first();
    const sale = await recognizeRevenueInDb(db, {
      provider: "stripe", sourceKey: "invoice:refund-target:line:1",
      providerPaymentId: "pi_refund_target", providerInvoiceId: "in_refund_target",
      providerLineId: "il_refund_target", affiliateId: 17, referredAccountId: 42,
      attributionId: Number(attribution.id), cadence: "annual", currency: "usd",
      eligibleRevenueMinor: 3_240, processingFeeMinor: 126,
      policyVersion: "affiliate-policy-v1", commissionRateNumerator: 1,
      commissionRateDenominator: 2, paidAt: 1_800_000_000,
      maturationSeconds: 60 * 24 * 60 * 60,
    });
    assert.equal(sale.created, true);

    const results = await Promise.all([
      recordRefundInDb(db, {
        occurrenceId: sale.occurrenceId, provider: "stripe", sourceKey: "refund:re_a",
        refundedEligibleRevenueMinor: 3_240, recordedAt: 1_800_000_100,
      }),
      recordRefundInDb(db, {
        occurrenceId: sale.occurrenceId, provider: "stripe", sourceKey: "refund:re_b",
        refundedEligibleRevenueMinor: 3_240, recordedAt: 1_800_000_100,
      }),
    ]);

    assert.deepEqual(results.map(({ recorded }) => recorded).sort(), [false, true]);
    const adjustments = await db.prepare("SELECT COUNT(*) AS count, SUM(refunded_eligible_revenue_minor) AS refunded FROM affiliate_revenue_adjustments").first();
    assert.deepEqual(adjustments, { count: 1, refunded: 3240 });
    const ledger = await db.prepare("SELECT amount_minor FROM affiliate_ledger_entries ORDER BY created_at, amount_minor DESC").all();
    assert.deepEqual(ledger.results, [{ amount_minor: 1620 }, { amount_minor: -1620 }]);
  } finally {
    await mf.dispose();
  }
});

test("concurrent dispute notifications create one reserve for unreversed commission", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-dispute-reserve" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, billing_status TEXT NOT NULL DEFAULT 'inactive', crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id) VALUES (17), (42)").run();
    const attribution = await db.prepare(
      "INSERT INTO affiliate_attributions (referred_account_id, affiliate_id, source, interacted_at, captured_at) VALUES (42, 17, 'link', 1790000000, 1790000000) RETURNING id",
    ).first();
    const sale = await recognizeRevenueInDb(db, {
      provider: "stripe", sourceKey: "invoice:dispute-target:line:1",
      providerPaymentId: "pi_dispute_target", providerInvoiceId: "in_dispute_target",
      providerLineId: "il_dispute_target", affiliateId: 17, referredAccountId: 42,
      attributionId: Number(attribution.id), cadence: "annual", currency: "usd",
      eligibleRevenueMinor: 3_240, processingFeeMinor: 126,
      policyVersion: "affiliate-policy-v1", commissionRateNumerator: 1,
      commissionRateDenominator: 2, paidAt: 1_800_000_000,
      maturationSeconds: 60 * 24 * 60 * 60,
    });
    assert.equal(sale.created, true);

    const results = await Promise.all([
      openDisputeReserveInDb(db, {
        occurrenceId: sale.occurrenceId, provider: "stripe",
        disputeId: "dp_123", sourceKey: "dispute:dp_123:opened:event-a",
        openedAt: 1_800_000_100,
      }),
      openDisputeReserveInDb(db, {
        occurrenceId: sale.occurrenceId, provider: "stripe",
        disputeId: "dp_123", sourceKey: "dispute:dp_123:opened:event-b",
        openedAt: 1_800_000_100,
      }),
    ]);

    assert.deepEqual(results.map(({ reserved }) => reserved).sort(), [false, true]);
    const reserves = await db.prepare("SELECT occurrence_id, affiliate_id, currency, amount_minor, status FROM affiliate_reserves").all();
    assert.deepEqual(reserves.results, [{
      occurrence_id: sale.occurrenceId,
      affiliate_id: 17,
      currency: "usd",
      amount_minor: 1620,
      status: "open",
    }]);

    const resolutions = await Promise.all([
      resolveDisputeInDb(db, {
        provider: "stripe", disputeId: "dp_123", outcome: "won",
        sourceKey: "dispute:dp_123:won:event-a", resolvedAt: 1_800_000_200,
      }),
      resolveDisputeInDb(db, {
        provider: "stripe", disputeId: "dp_123", outcome: "won",
        sourceKey: "dispute:dp_123:won:event-b", resolvedAt: 1_800_000_200,
      }),
    ]);
    assert.deepEqual(resolutions.map(({ resolved }) => resolved).sort(), [false, true]);
    const released = await db.prepare("SELECT status, resolved_at FROM affiliate_reserves WHERE dispute_id = 'dp_123'").first();
    assert.deepEqual(released, { status: "released", resolved_at: 1800000200 });
    const ledger = await db.prepare("SELECT amount_minor FROM affiliate_ledger_entries").all();
    assert.deepEqual(ledger.results, [{ amount_minor: 1620 }]);

  } finally {
    await mf.dispose();
  }
});

test("a lost dispute reverses only commission not already reversed by refunds", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-dispute-loss" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, billing_status TEXT NOT NULL DEFAULT 'inactive', crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id) VALUES (17), (42)").run();
    const attribution = await db.prepare(
      "INSERT INTO affiliate_attributions (referred_account_id, affiliate_id, source, interacted_at, captured_at) VALUES (42, 17, 'link', 1790000000, 1790000000) RETURNING id",
    ).first();
    const sale = await recognizeRevenueInDb(db, {
      provider: "stripe", sourceKey: "invoice:lost-target:line:1",
      providerPaymentId: "pi_lost_target", providerInvoiceId: "in_lost_target",
      providerLineId: "il_lost_target", affiliateId: 17, referredAccountId: 42,
      attributionId: Number(attribution.id), cadence: "annual", currency: "usd",
      eligibleRevenueMinor: 3_240, processingFeeMinor: 126,
      policyVersion: "affiliate-policy-v1", commissionRateNumerator: 1,
      commissionRateDenominator: 2, paidAt: 1_800_000_000,
      maturationSeconds: 60 * 24 * 60 * 60,
    });
    assert.equal(sale.created, true);
    assert.deepEqual(await recordRefundInDb(db, {
      occurrenceId: sale.occurrenceId, provider: "stripe", sourceKey: "refund:partial",
      refundedEligibleRevenueMinor: 1_240, recordedAt: 1_800_000_100,
    }), { recorded: true });
    assert.deepEqual(await openDisputeReserveInDb(db, {
      occurrenceId: sale.occurrenceId, provider: "stripe", disputeId: "dp_lost",
      sourceKey: "dispute:dp_lost:opened", openedAt: 1_800_000_200,
    }), { reserved: true });

    const resolutions = await Promise.all([
      resolveDisputeInDb(db, {
        provider: "stripe", disputeId: "dp_lost", outcome: "lost",
        sourceKey: "dispute:dp_lost:lost:a", resolvedAt: 1_800_000_300,
      }),
      resolveDisputeInDb(db, {
        provider: "stripe", disputeId: "dp_lost", outcome: "lost",
        sourceKey: "dispute:dp_lost:lost:b", resolvedAt: 1_800_000_300,
      }),
    ]);

    assert.deepEqual(resolutions.map(({ resolved }) => resolved).sort(), [false, true]);
    const reserve = await db.prepare("SELECT status FROM affiliate_reserves WHERE dispute_id = 'dp_lost'").first();
    assert.deepEqual(reserve, { status: "lost" });
    const ledger = await db.prepare("SELECT entry_kind, amount_minor FROM affiliate_ledger_entries ORDER BY created_at").all();
    assert.deepEqual(ledger.results, [
      { entry_kind: "earning", amount_minor: 1620 },
      { entry_kind: "refund", amount_minor: -620 },
      { entry_kind: "dispute_loss", amount_minor: -1000 },
    ]);
  } finally {
    await mf.dispose();
  }
});

test("monthly payout preparation finds every newly eligible Affiliate exactly once", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-monthly-payouts" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, status TEXT NOT NULL, email_verified INTEGER NOT NULL, billing_status TEXT NOT NULL, crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id, status, email_verified, billing_status) VALUES (17, 'active', 1, 'inactive'), (42, 'active', 1, 'active')").run();
    await enableAffiliateProfileInDb(db, {
      accountId: 17, referralCode: "MONTHLY17", termsVersion: "terms-v1",
      termsDocumentDigest: "sha256:terms-v1", policyVersion: "policy-v1", acceptedAt: 1_790_000_000,
    });
    const attribution = await db.prepare(
      "INSERT INTO affiliate_attributions (referred_account_id, affiliate_id, source, interacted_at, captured_at) VALUES (42, 17, 'link', 1790000000, 1790000000) RETURNING id",
    ).first();
    await recognizeRevenueInDb(db, {
      provider: "stripe", sourceKey: "invoice:monthly-batch:line:1",
      providerPaymentId: "pi_monthly_batch", providerInvoiceId: "in_monthly_batch",
      providerLineId: "il_monthly_batch", affiliateId: 17, referredAccountId: 42,
      attributionId: Number(attribution.id), cadence: "annual", currency: "usd",
      eligibleRevenueMinor: 20_000, processingFeeMinor: 600,
      policyVersion: "policy-v1", commissionRateNumerator: 1,
      commissionRateDenominator: 2, paidAt: 1_790_000_000,
      maturationSeconds: 60 * 24 * 60 * 60,
    });

    const first = await prepareAffiliatePayoutBatchInDb(db, {
      currency: "usd", cutoff: 1_800_000_000, minimumMinor: 10_000,
    });
    const retry = await prepareAffiliatePayoutBatchInDb(db, {
      currency: "usd", cutoff: 1_800_000_000, minimumMinor: 10_000,
    });

    assert.deepEqual(first.map(({ affiliateId, amountMinor }) => ({ affiliateId, amountMinor })), [
      { affiliateId: 17, amountMinor: 10_000 },
    ]);
    assert.deepEqual(retry, []);
  } finally {
    await mf.dispose();
  }
});

test("negative carry-forward and non-payable Affiliate states block preparation", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-negative-carry" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, status TEXT NOT NULL, email_verified INTEGER NOT NULL, billing_status TEXT NOT NULL, crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id, status, email_verified, billing_status) VALUES (17, 'active', 1, 'inactive'), (42, 'active', 1, 'active')").run();
    await enableAffiliateProfileInDb(db, {
      accountId: 17, referralCode: "CARRY17", termsVersion: "terms-v1",
      termsDocumentDigest: "sha256:terms-v1", policyVersion: "policy-v1",
      acceptedAt: 1_790_000_000,
    });
    const attribution = await db.prepare(
      "INSERT INTO affiliate_attributions (referred_account_id, affiliate_id, source, interacted_at, captured_at) VALUES (42, 17, 'link', 1790000000, 1790000000) RETURNING id",
    ).first();
    const sale = await recognizeRevenueInDb(db, {
      provider: "stripe", sourceKey: "invoice:carry:line:1",
      providerPaymentId: "pi_carry", providerInvoiceId: "in_carry",
      providerLineId: "il_carry", affiliateId: 17, referredAccountId: 42,
      attributionId: Number(attribution.id), cadence: "annual", currency: "usd",
      eligibleRevenueMinor: 22_000, processingFeeMinor: 600,
      policyVersion: "policy-v1", commissionRateNumerator: 1,
      commissionRateDenominator: 2, paidAt: 1_794_816_000,
      maturationSeconds: 60 * 24 * 60 * 60,
    });
    await recordRefundInDb(db, {
      occurrenceId: sale.occurrenceId, provider: "stripe", sourceKey: "refund:carry:partial",
      refundedEligibleRevenueMinor: 2_000, recordedAt: 1_799_000_000,
    });

    await db.prepare("UPDATE affiliate_profiles SET status = 'suspended' WHERE account_id = 17").run();
    assert.deepEqual(await preparePayoutInDb(db, {
      affiliateId: 17, currency: "usd", cutoff: 1_800_000_000, minimumMinor: 10_000,
    }), { prepared: false, payoutId: null, amountMinor: 0 });

    for (const status of ["terms_required", "closed"]) {
      await db.prepare("UPDATE affiliate_profiles SET status = ? WHERE account_id = 17").bind(status).run();
      assert.deepEqual(await preparePayoutInDb(db, {
        affiliateId: 17, currency: "usd", cutoff: 1_800_000_000, minimumMinor: 10_000,
      }), { prepared: false, payoutId: null, amountMinor: 0 });
    }

    await db.prepare("UPDATE affiliate_profiles SET status = 'active' WHERE account_id = 17").run();
    assert.deepEqual(await openDisputeReserveInDb(db, {
      occurrenceId: sale.occurrenceId, provider: "stripe", disputeId: "dp_carry",
      sourceKey: "dispute:dp_carry:opened", openedAt: 1_799_000_100,
    }), { reserved: true });
    assert.deepEqual(await preparePayoutInDb(db, {
      affiliateId: 17, currency: "usd", cutoff: 1_800_000_000, minimumMinor: 10_000,
    }), { prepared: false, payoutId: null, amountMinor: 0 });
    assert.deepEqual(await resolveDisputeInDb(db, {
      provider: "stripe", disputeId: "dp_carry", outcome: "won",
      sourceKey: "dispute:dp_carry:won", resolvedAt: 1_799_000_200,
    }), { resolved: true });

    const payout = await preparePayoutInDb(db, {
      affiliateId: 17, currency: "usd", cutoff: 1_800_000_000, minimumMinor: 10_000,
    });
    assert.equal(payout.prepared, true);
    assert.equal(payout.amountMinor, 10_000);
    const allocated = await db.prepare(
      "SELECT entry_kind, amount_minor FROM affiliate_payout_entries JOIN affiliate_ledger_entries AS entry ON entry.id = ledger_entry_id WHERE payout_id = ? ORDER BY amount_minor",
    ).bind(payout.payoutId).all();
    assert.deepEqual(allocated.results, [
      { entry_kind: "refund", amount_minor: -1_000 },
      { entry_kind: "earning", amount_minor: 11_000 },
    ]);
  } finally {
    await mf.dispose();
  }
});

test("$100 matures at exactly 60 days and concurrent payout preparation allocates it once", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-payout-allocation" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT, status TEXT NOT NULL, email_verified INTEGER NOT NULL, billing_status TEXT NOT NULL, crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id, email, status, email_verified, billing_status) VALUES (17, 'affiliate@example.com', 'active', 1, 'inactive'), (42, 'customer@example.com', 'active', 1, 'active')").run();
    await enableAffiliateProfileInDb(db, {
      accountId: 17, referralCode: "PAYOUT17", termsVersion: "terms-v1",
      termsDocumentDigest: "sha256:terms-v1", policyVersion: "policy-v1",
      acceptedAt: 1_790_000_000,
    });
    await attachStripeConnectedAccountInDb(db, {
      affiliateAccountId: 17, connectedAccountId: "acct_1Payout17",
      country: "GB", attachedAt: 1_790_000_001,
    });
    await updateStripeConnectedAccountStatusInDb(db, {
      connectedAccountId: "acct_1Payout17", detailsSubmitted: true,
      payoutsEnabled: true, transfersStatus: "active",
      eventCreated: 1_790_000_002, eventId: "evt_payout_ready",
    });
    const attribution = await db.prepare(
      "INSERT INTO affiliate_attributions (referred_account_id, affiliate_id, source, interacted_at, captured_at) VALUES (42, 17, 'link', 1790000000, 1790000000) RETURNING id",
    ).first();
    await recognizeRevenueInDb(db, {
      provider: "stripe", sourceKey: "invoice:payout-target:line:1",
      providerPaymentId: "pi_payout_target", providerInvoiceId: "in_payout_target",
      providerLineId: "il_payout_target", affiliateId: 17, referredAccountId: 42,
      attributionId: Number(attribution.id), cadence: "annual", currency: "usd",
      eligibleRevenueMinor: 20_000, processingFeeMinor: 600,
      policyVersion: "affiliate-policy-v1", commissionRateNumerator: 1,
      commissionRateDenominator: 2, paidAt: 1_794_816_000,
      maturationSeconds: 60 * 24 * 60 * 60,
    });
    const cutoff = 1_800_000_000;

    assert.deepEqual(await preparePayoutInDb(db, {
      affiliateId: 17, currency: "usd", cutoff: 1_799_999_999, minimumMinor: 10_000,
    }), { prepared: false, payoutId: null, amountMinor: 0 });

    const results = await Promise.all([
      preparePayoutInDb(db, { affiliateId: 17, currency: "usd", cutoff, minimumMinor: 10_000 }),
      preparePayoutInDb(db, { affiliateId: 17, currency: "usd", cutoff, minimumMinor: 10_000 }),
    ]);

    assert.deepEqual(results.map(({ prepared }) => prepared).sort(), [false, true]);
    const payouts = await db.prepare("SELECT affiliate_id, currency, amount_minor, status FROM affiliate_payouts").all();
    assert.deepEqual(payouts.results, [{ affiliate_id: 17, currency: "usd", amount_minor: 10000, status: "prepared" }]);
    const allocations = await db.prepare("SELECT COUNT(*) AS count FROM affiliate_payout_entries").first();
    assert.deepEqual(allocations, { count: 1 });

    const prepared = results.find(({ prepared }) => prepared);
    assert.deepEqual(await loadStripePayoutDispatchInDb(db, prepared.payoutId, new Set()), { dispatchable: false });
    assert.deepEqual(await loadStripePayoutDispatchInDb(db, prepared.payoutId, new Set(["US"])), { dispatchable: false });
    assert.deepEqual(await loadStripePayoutDispatchInDb(db, prepared.payoutId, new Set(["GB"])), {
      dispatchable: true,
      payoutId: prepared.payoutId,
      affiliateId: 17,
      connectedAccountId: "acct_1Payout17",
      amountMinor: 10_000,
      currency: "usd",
    });
    assert.deepEqual(await recordPayoutDispatchResultInDb(db, {
      payoutId: prepared.payoutId,
      provider: "stripe",
      idempotencyKey: `affiliate-payout:${prepared.payoutId}`,
      outcome: "ambiguous",
      externalReference: null,
      actorSubject: "staff|dispatcher", actorRole: "admin", reason: "Monthly payout run",
      recordedAt: cutoff + 1,
    }), { recorded: true, payoutStatus: "reconciliation" });
    assert.deepEqual(await recordPayoutDispatchResultInDb(db, {
      payoutId: prepared.payoutId,
      provider: "stripe",
      idempotencyKey: `affiliate-payout:${prepared.payoutId}:retry`,
      outcome: "paid",
      externalReference: "po_should_not_be_recorded",
      actorSubject: "staff|dispatcher", actorRole: "admin", reason: "Retry after timeout",
      recordedAt: cutoff + 2,
    }), { recorded: false, payoutStatus: "reconciliation" });
    const attempts = await db.prepare("SELECT outcome, external_reference, actor_subject, actor_role, reason FROM affiliate_payout_attempts").all();
    assert.deepEqual(attempts.results, [{
      outcome: "ambiguous", external_reference: null, actor_subject: "staff|dispatcher",
      actor_role: "admin", reason: "Monthly payout run",
    }]);
    assert.deepEqual(await getAffiliatePayoutQueueInDb(db, "reconciliation"), [{
      payoutId: prepared.payoutId,
      affiliateId: 17,
      affiliateEmail: "affiliate@example.com",
      referralCode: "PAYOUT17",
      amountMinor: 10_000,
      currency: "usd",
      status: "reconciliation",
      createdAt: cutoff,
      connectedAccountId: "acct_1Payout17",
      latestAttemptOutcome: "ambiguous",
      latestExternalReference: null,
      latestAttemptAt: cutoff + 1,
      latestDispatchActorSubject: "staff|dispatcher",
      latestDispatchReason: "Monthly payout run",
      approvalCount: 0,
      latestApproverSubject: null,
      latestApprovalReason: null,
      latestApprovedAt: null,
    }]);

    const reconciliations = await Promise.all([
      reconcilePayoutInDb(db, {
        payoutId: prepared.payoutId, decision: "confirm_paid",
        actorSubject: "staff|saul", actorRole: "admin",
        evidence: "Stripe dashboard confirms payout succeeded.",
        externalReference: "po_confirmed_123", reconciledAt: cutoff + 3,
      }),
      reconcilePayoutInDb(db, {
        payoutId: prepared.payoutId, decision: "confirm_paid",
        actorSubject: "staff|saul", actorRole: "admin",
        evidence: "Stripe dashboard confirms payout succeeded.",
        externalReference: "po_confirmed_123", reconciledAt: cutoff + 3,
      }),
    ]);
    assert.deepEqual(reconciliations.map(({ reconciled }) => reconciled).sort(), [false, true]);
    const reconciledPayout = await db.prepare("SELECT status FROM affiliate_payouts WHERE id = ?").bind(prepared.payoutId).first();
    assert.deepEqual(reconciledPayout, { status: "paid" });
    const audit = await db.prepare("SELECT decision, actor_subject, actor_role, evidence, external_reference FROM affiliate_payout_reconciliations").all();
    assert.deepEqual(audit.results, [{
      decision: "confirm_paid", actor_subject: "staff|saul", actor_role: "admin",
      evidence: "Stripe dashboard confirms payout succeeded.", external_reference: "po_confirmed_123",
    }]);
    const queuedEmails = [];
    assert.deepEqual(await relayAffiliateEmailOutboxInDb(db, { send: async (body) => { queuedEmails.push(body); } }), { queued: 2 });
    const payoutEmail = queuedEmails.find((email) => email.emailKind === "affiliate-payout-sent");
    assert.equal(payoutEmail.idempotencyKey, `affiliate-payout-sent:${prepared.payoutId}`);
    assert.equal(payoutEmail.to, "affiliate@example.com");
    assert.match(payoutEmail.subject, /\$100\.00/);
    assert.deepEqual(await relayAffiliateEmailOutboxInDb(db, { send: async (body) => { queuedEmails.push(body); } }), { queued: 0 });

    await recognizeRevenueInDb(db, {
      provider: "stripe", sourceKey: "invoice:payout-cancel:line:1",
      providerPaymentId: "pi_payout_cancel", providerInvoiceId: "in_payout_cancel",
      providerLineId: "il_payout_cancel", affiliateId: 17, referredAccountId: 42,
      attributionId: Number(attribution.id), cadence: "monthly", currency: "usd",
      eligibleRevenueMinor: 20_000, processingFeeMinor: 600,
      policyVersion: "affiliate-policy-v1", commissionRateNumerator: 1,
      commissionRateDenominator: 2, paidAt: 1_790_000_100,
      maturationSeconds: 60 * 24 * 60 * 60,
    });
    const cancellable = await preparePayoutInDb(db, {
      affiliateId: 17, currency: "usd", cutoff, minimumMinor: 10_000,
    });
    assert.equal(cancellable.prepared, true);
    await recordPayoutDispatchResultInDb(db, {
      payoutId: cancellable.payoutId, provider: "stripe",
      idempotencyKey: `affiliate-payout:${cancellable.payoutId}`,
      outcome: "ambiguous", externalReference: null,
      actorSubject: "staff|dispatcher", actorRole: "admin", reason: "Monthly payout run",
      recordedAt: cutoff + 4,
    });
    assert.deepEqual(await reconcilePayoutInDb(db, {
      payoutId: cancellable.payoutId, decision: "cancel",
      actorSubject: "staff|saul", actorRole: "admin",
      evidence: "Provider confirms no payout was created.",
      externalReference: null, reconciledAt: cutoff + 5,
    }), { reconciled: true });
    const cancelled = await db.prepare("SELECT status FROM affiliate_payouts WHERE id = ?").bind(cancellable.payoutId).first();
    assert.deepEqual(cancelled, { status: "cancelled" });
    const released = await db.prepare("SELECT COUNT(*) AS count, SUM(CASE WHEN released_at IS NULL THEN 1 ELSE 0 END) AS active FROM affiliate_payout_entries WHERE payout_id = ?").bind(cancellable.payoutId).first();
    assert.deepEqual(released, { count: 1, active: 0 });
    const cancellationEmails = [];
    assert.deepEqual(await relayAffiliateEmailOutboxInDb(db, { send: async (body) => { cancellationEmails.push(body); } }), { queued: 1 });
    assert.equal(cancellationEmails[0].emailKind, "affiliate-payout-cancelled");
    assert.equal(cancellationEmails[0].idempotencyKey, `affiliate-payout-cancelled:${cancellable.payoutId}`);
    assert.match(cancellationEmails[0].plainText, /\$100\.00/);
    assert.match(cancellationEmails[0].plainText, /available balance/i);
    const preparedAgain = await preparePayoutInDb(db, {
      affiliateId: 17, currency: "usd", cutoff, minimumMinor: 10_000,
    });
    assert.equal(preparedAgain.prepared, true);
    assert.equal(preparedAgain.amountMinor, 10_000);
  } finally {
    await mf.dispose();
  }
});

test("Stripe and NOWPayments annual payments normalize to equivalent affiliate economics", () => {
  const context = {
    affiliateId: 17,
    referredAccountId: 42,
    attributionId: 9,
    policyVersion: "affiliate-policy-v1",
    commissionRateNumerator: 1,
    commissionRateDenominator: 2,
    maturationSeconds: 60 * 24 * 60 * 60,
  };
  const stripe = normalizeStripeAffiliatePayment({
    invoiceId: "in_annual_123",
    paymentId: "pi_annual_123",
    currency: "usd",
    paidAt: 1_800_000_000,
    processingFeeMinor: 126,
    line: {
      id: "il_annual_123",
      priceId: "price_yearly",
      cadence: "annual",
      discountedAmountExcludingTaxMinor: 3_240,
      serviceStartAt: 1_800_000_000,
      serviceEndAt: 1_831_536_000,
    },
  }, context);
  const nowPayments = normalizeNowPaymentsAffiliatePayment({
    paymentId: "np_annual_123",
    orderId: "affiliate-order-123",
    currency: "usd",
    paidAt: 1_800_000_000,
    processingFeeMinor: 126,
    expectedDiscountedAmountMinor: 3_240,
    cadence: "annual",
    serviceStartAt: 1_800_000_000,
    serviceEndAt: 1_831_536_000,
  }, context);

  const economics = ({ provider: _provider, sourceKey: _sourceKey,
    providerPaymentId: _payment, providerInvoiceId: _invoice,
    providerLineId: _line, ...value }) => value;
  assert.deepEqual(economics(stripe), economics(nowPayments));
  assert.equal(recognizeRevenue(stripe).commissionMinor, 1_620);
  assert.equal(recognizeRevenue(nowPayments).commissionMinor, 1_620);
  assert.equal(stripe.sourceKey, "invoice:in_annual_123:line:il_annual_123");
  assert.equal(nowPayments.sourceKey, "order:affiliate-order-123:payment:np_annual_123");
});

test("Stripe checkout snapshots attribution and promotion policy", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-stripe-checkout" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, billing_status TEXT NOT NULL DEFAULT 'inactive', crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id) VALUES (17), (42)").run();
    const attribution = await db.prepare(
      "INSERT INTO affiliate_attributions (referred_account_id, affiliate_id, source, interacted_at, captured_at) VALUES (42, 17, 'code', 1790000000, 1790000000) RETURNING id",
    ).first();

    const checkout = await createStripeCheckoutInDb(db, {
      accountId: 42, attributionId: Number(attribution.id), cadence: "monthly",
      priceId: "price_monthly", promotionCodeId: "promo_affiliate_17",
      policyVersion: "affiliate-policy-v1", discountRateNumerator: 1,
      discountRateDenominator: 10, commissionRateNumerator: 1,
      commissionRateDenominator: 2, createdAt: 1_800_000_000,
      expiresAt: 1_800_001_800,
    });

    const stored = await db.prepare("SELECT account_id, attribution_id, cadence, price_id, promotion_code_id, policy_version, status FROM affiliate_stripe_checkouts WHERE id = ?").bind(checkout.checkoutId).first();
    assert.deepEqual(stored, {
      account_id: 42, attribution_id: Number(attribution.id), cadence: "monthly",
      price_id: "price_monthly", promotion_code_id: "promo_affiliate_17",
      policy_version: "affiliate-policy-v1", status: "pending",
    });

    const invoice = {
      checkoutId: checkout.checkoutId,
      invoiceId: "in_monthly_123",
      paymentId: "pi_monthly_123",
      subscriptionId: "sub_monthly_123",
      lineId: "il_monthly_123",
      priceId: "price_monthly",
      currency: "usd",
      discountedAmountExcludingTaxMinor: 450,
      processingFeeMinor: 30,
      serviceStartAt: 1_800_000_000,
      serviceEndAt: 1_802_592_000,
      paidAt: 1_800_000_100,
      maturationSeconds: 60 * 24 * 60 * 60,
    };
    const settlements = await Promise.all([
      settleStripeInvoiceInDb(db, invoice),
      settleStripeInvoiceInDb(db, invoice),
    ]);
    assert.deepEqual(settlements.map(({ created }) => created).sort(), [false, true]);
    const installments = await db.prepare("SELECT installment_number FROM affiliate_installments").all();
    assert.deepEqual(installments.results, [{ installment_number: 1 }]);
    const occurrence = await db.prepare("SELECT provider_invoice_id, eligible_revenue_minor, service_start_at, service_end_at FROM affiliate_revenue_occurrences").all();
    assert.deepEqual(occurrence.results, [{
      provider_invoice_id: "in_monthly_123", eligible_revenue_minor: 450,
      service_start_at: 1_800_000_000, service_end_at: 1_802_592_000,
    }]);
    const ledger = await db.prepare("SELECT amount_minor FROM affiliate_ledger_entries").all();
    assert.deepEqual(ledger.results, [{ amount_minor: 225 }]);

    const refunds = await Promise.all([
      recordStripeRefundInDb(db, {
        paymentId: "pi_monthly_123", refundId: "re_monthly_123",
        refundedChargeMinor: 100, originalChargeMinor: 500,
        recordedAt: 1_800_000_200,
      }),
      recordStripeRefundInDb(db, {
        paymentId: "pi_monthly_123", refundId: "re_monthly_123",
        refundedChargeMinor: 100, originalChargeMinor: 500,
        recordedAt: 1_800_000_200,
      }),
    ]);
    assert.deepEqual(refunds.map(({ recorded }) => recorded).sort(), [false, true]);
    const adjustedLedger = await db.prepare("SELECT entry_kind, amount_minor FROM affiliate_ledger_entries ORDER BY created_at").all();
    assert.deepEqual(adjustedLedger.results, [
      { entry_kind: "earning", amount_minor: 225 },
      { entry_kind: "refund", amount_minor: -45 },
    ]);

    const reserves = await Promise.all([
      openStripeDisputeInDb(db, {
        paymentId: "pi_monthly_123", disputeId: "dp_monthly_123",
        sourceKey: "dispute:dp_monthly_123:opened:a", openedAt: 1_800_000_300,
      }),
      openStripeDisputeInDb(db, {
        paymentId: "pi_monthly_123", disputeId: "dp_monthly_123",
        sourceKey: "dispute:dp_monthly_123:opened:b", openedAt: 1_800_000_300,
      }),
    ]);
    assert.deepEqual(reserves.map(({ reserved }) => reserved).sort(), [false, true]);
    const reserve = await db.prepare("SELECT amount_minor, status FROM affiliate_reserves WHERE dispute_id = 'dp_monthly_123'").first();
    assert.deepEqual(reserve, { amount_minor: 180, status: "open" });

    const losses = await Promise.all([
      resolveStripeDisputeInDb(db, {
        disputeId: "dp_monthly_123", outcome: "lost",
        sourceKey: "dispute:dp_monthly_123:lost:a", resolvedAt: 1_800_000_400,
      }),
      resolveStripeDisputeInDb(db, {
        disputeId: "dp_monthly_123", outcome: "lost",
        sourceKey: "dispute:dp_monthly_123:lost:b", resolvedAt: 1_800_000_400,
      }),
    ]);
    assert.deepEqual(losses.map(({ resolved }) => resolved).sort(), [false, true]);
    const disputedLedger = await db.prepare("SELECT entry_kind, amount_minor FROM affiliate_ledger_entries ORDER BY created_at").all();
    assert.deepEqual(disputedLedger.results, [
      { entry_kind: "earning", amount_minor: 225 },
      { entry_kind: "refund", amount_minor: -45 },
      { entry_kind: "dispute_loss", amount_minor: -180 },
    ]);
  } finally {
    await mf.dispose();
  }
});

test("out-of-order Stripe financial facts apply exactly once after revenue arrives", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-stripe-pending-financial-events" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, billing_status TEXT NOT NULL DEFAULT 'inactive', crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id) VALUES (17), (42)").run();
    const attribution = await db.prepare(
      "INSERT INTO affiliate_attributions (referred_account_id, affiliate_id, source, interacted_at, captured_at) VALUES (42, 17, 'code', 1790000000, 1790000000) RETURNING id",
    ).first();
    const checkout = await createStripeCheckoutInDb(db, {
      accountId: 42, attributionId: Number(attribution.id), cadence: "annual",
      priceId: "price_yearly", promotionCodeId: "promo_affiliate_17",
      policyVersion: "affiliate-policy-v1", discountRateNumerator: 1,
      discountRateDenominator: 10, commissionRateNumerator: 1,
      commissionRateDenominator: 2, createdAt: 1_800_000_000,
      expiresAt: 1_800_001_800,
    });

    const pending = [
      { kind: "dispute_close", sourceKey: "dispute:dp_early:lost", disputeId: "dp_early", outcome: "lost", occurredAt: 1_800_000_040 },
      { kind: "dispute_open", sourceKey: "dispute:dp_early:opened", paymentId: "pi_early", disputeId: "dp_early", occurredAt: 1_800_000_030 },
      { kind: "refund", sourceKey: "refund:re_early", paymentId: "pi_early", amountMinor: 200, originalAmountMinor: 1_000, occurredAt: 1_800_000_020 },
      { kind: "credit_note", sourceKey: "credit_note:cn_early:line:il_early", invoiceId: "in_early", invoiceLineId: "il_early", amountMinor: 100, occurredAt: 1_800_000_010 },
    ];
    for (const fact of pending) {
      assert.deepEqual(await recordPendingStripeFinancialEventInDb(db, fact), { recorded: true, applied: false });
      assert.deepEqual(await recordPendingStripeFinancialEventInDb(db, fact), { recorded: false, applied: false });
    }

    assert.deepEqual(await settleStripeInvoiceInDb(db, {
      checkoutId: checkout.checkoutId, invoiceId: "in_early", paymentId: "pi_early",
      subscriptionId: "sub_early", lineId: "il_early", priceId: "price_yearly",
      currency: "usd", discountedAmountExcludingTaxMinor: 1_000, processingFeeMinor: 30,
      serviceStartAt: 1_800_000_000, serviceEndAt: 1_831_536_000,
      paidAt: 1_800_000_100, maturationSeconds: 60 * 24 * 60 * 60,
    }), { created: true });

    assert.deepEqual(await db.prepare(
      "SELECT entry_kind, amount_minor FROM affiliate_ledger_entries ORDER BY created_at, entry_kind",
    ).all().then((result) => result.results), [
      { entry_kind: "refund", amount_minor: -50 },
      { entry_kind: "refund", amount_minor: -100 },
      { entry_kind: "dispute_loss", amount_minor: -350 },
      { entry_kind: "earning", amount_minor: 500 },
    ]);
    assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM affiliate_stripe_financial_events WHERE applied_at IS NOT NULL").first().then((row) => row.count), 4);
  } finally {
    await mf.dispose();
  }
});

test("one settlement drains more than 400 actionable Stripe facts and caps overlap", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-stripe-pending-drain" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, billing_status TEXT NOT NULL DEFAULT 'inactive', crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id) VALUES (17), (42)").run();
    const attribution = await db.prepare(
      "INSERT INTO affiliate_attributions (referred_account_id, affiliate_id, source, interacted_at, captured_at) VALUES (42, 17, 'code', 1790000000, 1790000000) RETURNING id",
    ).first();
    const checkout = await createStripeCheckoutInDb(db, {
      accountId: 42, attributionId: Number(attribution.id), cadence: "annual",
      priceId: "price_yearly", promotionCodeId: "promo_affiliate_17",
      policyVersion: "affiliate-policy-v1", discountRateNumerator: 1,
      discountRateDenominator: 10, commissionRateNumerator: 1,
      commissionRateDenominator: 2, createdAt: 1_800_000_000,
      expiresAt: 1_800_001_800,
    });
    await db.batch(Array.from({ length: 401 }, (_, index) => db.prepare(
      `INSERT INTO affiliate_stripe_financial_events
        (source_key, kind, invoice_id, invoice_line_id, amount_minor, occurred_at)
       VALUES (?, 'credit_note', 'in_bulk', 'il_bulk', 1, ?)`,
    ).bind(`credit_note:cn_bulk_${index}:line:il_bulk`, 1_800_000_001 + index)));

    assert.deepEqual(await settleStripeInvoiceInDb(db, {
      checkoutId: checkout.checkoutId, invoiceId: "in_bulk", paymentId: "pi_bulk",
      subscriptionId: "sub_bulk", lineId: "il_bulk", priceId: "price_yearly",
      currency: "usd", discountedAmountExcludingTaxMinor: 1_000, processingFeeMinor: 30,
      serviceStartAt: 1_800_000_000, serviceEndAt: 1_831_536_000,
      paidAt: 1_800_001_000, maturationSeconds: 60 * 24 * 60 * 60,
    }), { created: true });
    assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM affiliate_stripe_financial_events WHERE applied_at IS NOT NULL").first().then((row) => row.count), 401);
    assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM affiliate_revenue_adjustments").first().then((row) => row.count), 401);

    assert.deepEqual(await recordPendingStripeFinancialEventInDb(db, {
      kind: "credit_note", sourceKey: "credit_note:cn_overlap:line:il_bulk",
      invoiceId: "in_bulk", invoiceLineId: "il_bulk", amountMinor: 1_000,
      occurredAt: 1_800_002_000,
    }), { recorded: true, applied: true });
    assert.deepEqual(await db.prepare(
      "SELECT refunded_eligible_revenue_minor FROM affiliate_revenue_adjustments WHERE source_key = 'credit_note:cn_overlap:line:il_bulk'",
    ).first(), { refunded_eligible_revenue_minor: 599 });
    assert.deepEqual(await Promise.all([
      replayPendingStripeFinancialEventsInDb(db), replayPendingStripeFinancialEventsInDb(db),
    ]), [0, 0]);
  } finally {
    await mf.dispose();
  }
});

test("NOWPayments checkout persists a random order and affiliate policy snapshot before invoicing", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-nowpayments-checkout" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, billing_status TEXT NOT NULL DEFAULT 'inactive', crypto_paid_through INTEGER);");
    const migration = fs.readFileSync("migrations/053-affiliate-program.sql", "utf8");
    for (const statement of migration.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO accounts (id) VALUES (17), (42)").run();
    const attribution = await db.prepare(
      "INSERT INTO affiliate_attributions (referred_account_id, affiliate_id, source, interacted_at, captured_at) VALUES (42, 17, 'code', 1790000000, 1790000000) RETURNING id",
    ).first();

    const checkout = await createNowPaymentsCheckoutInDb(db, {
      accountId: 42,
      attributionId: Number(attribution.id),
      expectedDiscountedAmountMinor: 3_240,
      policyVersion: "affiliate-policy-v1",
      discountRateNumerator: 1,
      discountRateDenominator: 10,
      commissionRateNumerator: 1,
      commissionRateDenominator: 2,
      createdAt: 1_800_000_000,
      expiresAt: 1_800_000_900,
    });

    assert.equal(checkout.expectedDiscountedAmountMinor, 3_240);
    assert.match(checkout.orderId, /^affiliate_[0-9a-f-]{36}$/);
    assert.doesNotMatch(checkout.orderId, /^blognice-42-/);
    const stored = await db.prepare("SELECT account_id, attribution_id, expected_discounted_amount_minor, policy_version, discount_rate_numerator, discount_rate_denominator, commission_rate_numerator, commission_rate_denominator, status, created_at, expires_at FROM affiliate_nowpayments_checkouts WHERE order_id = ?").bind(checkout.orderId).first();
    assert.deepEqual(stored, {
      account_id: 42, attribution_id: Number(attribution.id),
      expected_discounted_amount_minor: 3240, policy_version: "affiliate-policy-v1",
      discount_rate_numerator: 1, discount_rate_denominator: 10,
      commission_rate_numerator: 1, commission_rate_denominator: 2,
      status: "pending", created_at: 1800000000, expires_at: 1800000900,
    });
  } finally {
    await mf.dispose();
  }
});

test("duplicate finished NOWPayments IPNs settle entitlement and affiliate money once", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-nowpayments-settlement" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, billing_status TEXT NOT NULL DEFAULT 'inactive');");
    for (const migrationFile of ["migrations/041-nowpayments-crypto.sql", "migrations/053-affiliate-program.sql"]) {
      const migration = fs.readFileSync(migrationFile, "utf8");
      for (const statement of migration.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
        await db.prepare(statement).run();
      }
    }
    await db.prepare("INSERT INTO accounts (id) VALUES (17), (42)").run();
    const attribution = await db.prepare(
      "INSERT INTO affiliate_attributions (referred_account_id, affiliate_id, source, interacted_at, captured_at) VALUES (42, 17, 'code', 1790000000, 1790000000) RETURNING id",
    ).first();
    const checkout = await createNowPaymentsCheckoutInDb(db, {
      accountId: 42, attributionId: Number(attribution.id),
      expectedDiscountedAmountMinor: 3_240, policyVersion: "affiliate-policy-v1",
      discountRateNumerator: 1, discountRateDenominator: 10,
      commissionRateNumerator: 1, commissionRateDenominator: 2,
      createdAt: 1_800_000_000, expiresAt: 1_800_000_900,
    });
    await db.prepare(
      "INSERT INTO crypto_payments (id, account_id, order_id, plan, price_usd_cents, status, created_at, updated_at) VALUES ('np_123', 42, ?, 'yearly', 3240, 'finished', 1800000100, 1800000100)",
    ).bind(checkout.orderId).run();

    const settlement = {
      orderId: checkout.orderId, paymentId: "np_123", paidAt: 1_800_000_100,
      entitlementSeconds: 365 * 24 * 60 * 60,
      maturationSeconds: 60 * 24 * 60 * 60,
    };
    const results = await Promise.all([
      settleNowPaymentsCheckoutInDb(db, settlement),
      settleNowPaymentsCheckoutInDb(db, settlement),
    ]);

    assert.deepEqual(results.map(({ settled }) => settled).sort(), [false, true]);
    const account = await db.prepare("SELECT crypto_paid_through, affiliate_eligibility_closed_at FROM accounts WHERE id = 42").first();
    assert.deepEqual(account, {
      crypto_paid_through: settlement.paidAt + settlement.entitlementSeconds,
      affiliate_eligibility_closed_at: settlement.paidAt,
    });
    const paidCheckout = await db.prepare("SELECT status, provider_payment_id, paid_at FROM affiliate_nowpayments_checkouts WHERE order_id = ?").bind(checkout.orderId).first();
    assert.deepEqual(paidCheckout, { status: "paid", provider_payment_id: "np_123", paid_at: settlement.paidAt });
    const occurrence = await db.prepare("SELECT eligible_revenue_minor, service_start_at, service_end_at FROM affiliate_revenue_occurrences").all();
    assert.deepEqual(occurrence.results, [{
      eligible_revenue_minor: 3240, service_start_at: settlement.paidAt,
      service_end_at: settlement.paidAt + settlement.entitlementSeconds,
    }]);
    const ledger = await db.prepare("SELECT amount_minor FROM affiliate_ledger_entries").all();
    assert.deepEqual(ledger.results, [{ amount_minor: 1620 }]);

    await db.prepare("UPDATE crypto_payments SET status = 'refunded' WHERE order_id = ?").bind(checkout.orderId).run();
    const refunds = await Promise.all([
      refundNowPaymentsCheckoutInDb(db, {
        orderId: checkout.orderId, paymentId: "np_123",
        sourceKey: "refund:np_123", refundedAt: 1_800_000_200,
        entitlementSeconds: settlement.entitlementSeconds,
      }),
      refundNowPaymentsCheckoutInDb(db, {
        orderId: checkout.orderId, paymentId: "np_123",
        sourceKey: "refund:np_123", refundedAt: 1_800_000_200,
        entitlementSeconds: settlement.entitlementSeconds,
      }),
    ]);
    assert.deepEqual(refunds.map(({ refunded }) => refunded).sort(), [false, true]);
    const refundedAccount = await db.prepare("SELECT crypto_paid_through FROM accounts WHERE id = 42").first();
    assert.deepEqual(refundedAccount, { crypto_paid_through: null });
    const refundedCheckout = await db.prepare("SELECT status, refunded_at FROM affiliate_nowpayments_checkouts WHERE order_id = ?").bind(checkout.orderId).first();
    assert.deepEqual(refundedCheckout, { status: "refunded", refunded_at: 1800000200 });
    const reversedLedger = await db.prepare("SELECT entry_kind, amount_minor FROM affiliate_ledger_entries ORDER BY created_at").all();
    assert.deepEqual(reversedLedger.results, [
      { entry_kind: "earning", amount_minor: 1620 },
      { entry_kind: "refund", amount_minor: -1620 },
    ]);
  } finally {
    await mf.dispose();
  }
});
