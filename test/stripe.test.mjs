import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { accountHasPaidPlan } from "../src/auth.ts";
import { checkoutSubscriptionDecision, createAffiliateConnectedAccount, createAffiliateConnectOnboardingLink, createAffiliatePromotionCode, createAffiliateTransfer, createCheckoutSession, subscriptionEventMatchesCurrent, verifyStripeSignature } from "../src/stripe.ts";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const stripe = readFileSync(new URL("../src/stripe.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/017-stripe-billing.sql", import.meta.url), "utf8");
const reliabilityMigration = readFileSync(new URL("../migrations/035-billing-event-ordering.sql", import.meta.url), "utf8");
const checkoutOrderingMigration = readFileSync(new URL("../migrations/038-checkout-subscription-ordering.sql", import.meta.url), "utf8");

test("Stripe billing uses hosted Checkout and Customer Portal", () => {
  assert.match(source, /\/admin\/billing\/checkout/);
  assert.match(source, /\/admin\/billing\/portal/);
  assert.match(stripe, /checkout\/sessions/);
  assert.match(stripe, /billing_portal\/sessions/);
});

test("billing clearly distinguishes founding and planned standard pricing", () => {
  assert.match(source, /Founding member pricing/);
  assert.match(source, /\$36\/year or \$5\/month/);
  assert.match(source, /Planned standard pricing:<\/strong> \$119\/year or \$9\.99\/month/);
  assert.match(source, /billing-ribbon">Founding price/);
  assert.doesNotMatch(source, /Founding rates available now/);
});

test("attributed Stripe checkout carries its snapshot and promotion code", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(new URLSearchParams(init.body));
    return new Response(JSON.stringify({ id: "cs_123", url: "https://checkout.stripe.test/cs_123" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    for (const priceId of ["price_yearly", "price_monthly"]) {
      await createCheckoutSession({ STRIPE_SECRET_KEY: "sk_test" }, {
        accountId: 42, email: "reader@example.com", priceId,
        affiliateCheckoutId: "affiliate-checkout-123",
        promotionCodeId: "promo_affiliate_17",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      });
    }
    for (const params of requests) {
      assert.equal(params.get("discounts[0][promotion_code]"), "promo_affiliate_17");
      assert.equal(params.get("metadata[affiliate_checkout_id]"), "affiliate-checkout-123");
      assert.equal(params.get("subscription_data[metadata][affiliate_checkout_id]"), "affiliate-checkout-123");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("affiliate promotion provisioning verifies the 10%-for-12-month coupon", async () => {
  const originalFetch = globalThis.fetch;
  let promotionParams;
  let promotionHeaders;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/coupons/affiliate_10_percent_12_months")) {
      return new Response(JSON.stringify({
        id: "affiliate_10_percent_12_months",
        percent_off: 10,
        duration: "repeating",
        duration_in_months: 12,
        valid: true,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    promotionParams = new URLSearchParams(init.body);
    promotionHeaders = new Headers(init.headers);
    return new Response(JSON.stringify({ id: "promo_writer17", code: "WRITER17" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const promotion = await createAffiliatePromotionCode({ STRIPE_SECRET_KEY: "sk_test" }, {
      couponId: "affiliate_10_percent_12_months",
      referralCode: "writer17",
      affiliateAccountId: 17,
    });
    assert.deepEqual(promotion, { promotionCodeId: "promo_writer17", customerCode: "WRITER17" });
    assert.equal(promotionParams.get("promotion[coupon]"), "affiliate_10_percent_12_months");
    assert.equal(promotionParams.get("code"), "WRITER17");
    assert.equal(promotionParams.get("metadata[affiliate_account_id]"), "17");
    assert.equal(promotionHeaders.get("Idempotency-Key"), "affiliate-promotion:17");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Affiliate payout onboarding uses a Stripe-hosted Express connected account", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), params: new URLSearchParams(init.body), headers: new Headers(init.headers) });
    if (String(url).endsWith("/accounts")) {
      return new Response(JSON.stringify({ id: "acct_1Affiliate17" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ url: "https://connect.stripe.test/onboard/17", expires_at: 1_800_001_800 }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    const connected = await createAffiliateConnectedAccount({ STRIPE_SECRET_KEY: "sk_test" }, {
      affiliateAccountId: 17,
      email: "alex@example.com",
      country: "GB",
      allowedCountries: new Set(["GB"]),
    });
    const onboarding = await createAffiliateConnectOnboardingLink({ STRIPE_SECRET_KEY: "sk_test" }, {
      connectedAccountId: connected.connectedAccountId,
      refreshUrl: "https://www.blognice.com/admin/affiliate/connect/refresh",
      returnUrl: "https://www.blognice.com/admin/affiliate?connect=returned",
    });

    assert.deepEqual(connected, { connectedAccountId: "acct_1Affiliate17" });
    assert.deepEqual(onboarding, { url: "https://connect.stripe.test/onboard/17", expiresAt: 1_800_001_800 });
    assert.equal(requests[0].url, "https://api.stripe.com/v1/accounts");
    assert.equal(requests[0].params.get("type"), "express");
    assert.equal(requests[0].params.get("country"), "GB");
    assert.equal(requests[0].params.get("email"), "alex@example.com");
    assert.equal(requests[0].params.get("capabilities[transfers][requested]"), "true");
    assert.equal(requests[0].params.get("metadata[blognice_affiliate_account_id]"), "17");
    assert.equal(requests[0].headers.get("idempotency-key"), "blognice-affiliate-connect-17");
    assert.equal(requests[1].url, "https://api.stripe.com/v1/account_links");
    assert.equal(requests[1].params.get("account"), "acct_1Affiliate17");
    assert.equal(requests[1].params.get("type"), "account_onboarding");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Affiliate Connect onboarding fails closed outside the operator-approved corridor", async () => {
  await assert.rejects(
    createAffiliateConnectedAccount({ STRIPE_SECRET_KEY: "sk_test" }, {
      affiliateAccountId: 17, email: "alex@example.com", country: "US",
      allowedCountries: new Set(["TH", "GB"]),
    }),
    /unavailable in that country/,
  );
  await assert.rejects(
    createAffiliateConnectedAccount({ STRIPE_SECRET_KEY: "sk_test" }, {
      affiliateAccountId: 17, email: "alex@example.com", country: "TH",
      allowedCountries: new Set(),
    }),
    /unavailable in that country/,
  );
});

test("a prepared Affiliate payout becomes one idempotent Stripe transfer", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init = {}) => {
    request = { url: String(url), params: new URLSearchParams(init.body), headers: new Headers(init.headers) };
    return new Response(JSON.stringify({ id: "tr_1AffiliatePayout" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    const transfer = await createAffiliateTransfer({ STRIPE_SECRET_KEY: "sk_test" }, {
      payoutId: "payout-123",
      connectedAccountId: "acct_1Affiliate17",
      amountMinor: 10_000,
      currency: "usd",
    });

    assert.deepEqual(transfer, { transferId: "tr_1AffiliatePayout" });
    assert.equal(request.url, "https://api.stripe.com/v1/transfers");
    assert.equal(request.params.get("amount"), "10000");
    assert.equal(request.params.get("currency"), "usd");
    assert.equal(request.params.get("destination"), "acct_1Affiliate17");
    assert.equal(request.params.get("transfer_group"), "affiliate_payout:payout-123");
    assert.equal(request.params.get("metadata[affiliate_payout_id]"), "payout-123");
    assert.equal(request.headers.get("idempotency-key"), "affiliate-payout:payout-123");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("billing presents monthly AI credits and Stripe-owned plan management", () => {
  assert.match(source, /AI usage/);
  assert.match(source, /credits remaining this month/);
  assert.match(source, /Resets \$\{esc\(resetDate\)\}/);
  assert.match(source, /Images use 3 credits\. Audio narration uses credits based on word count/);
  assert.match(source, /Payment details, receipts, invoices, cancellations, and plan changes are managed securely in Stripe/);
  assert.doesNotMatch(source, /Buy more credits/);
  assert.match(source, /STRIPE_MONTHLY_PRICE_ID/);
  assert.match(source, /STRIPE_YEARLY_PRICE_ID/);
  assert.match(source, /Fix payment in Stripe/);
  assert.match(source, /View billing history in Stripe/);
  assert.match(source, /billing-main-action/);
  assert.match(source, /billing-main-action\{margin-bottom:1\.25rem\}/);
  assert.match(source, /const stripeActive = \["active", "trialing", "past_due"\]/);
  assert.match(source, /const billingAction = stripeActive \? portal : ""/);
  assert.match(source, /Or pay for blognice pro yearly with crypto/);
  assert.equal((source.match(/action="\/admin\/billing\/crypto\/checkout"/g) || []).length, 1);
  assert.match(source, /role="img" aria-label="Bitcoin"/);
  assert.match(source, /billing-btn:focus-visible\{outline:3px solid var\(--green\)/);
  assert.doesNotMatch(source, /Use the Stripe button below/);
  assert.match(source, /Crypto payment is available after your current Stripe subscription ends/);
  assert.doesNotMatch(source, /active \? \(term === "monthly" \? `.*Manage billing in Stripe/);
});

test("Stripe webhook verifies the raw signed payload and deduplicates events", () => {
  assert.match(source, /Stripe-Signature/);
  assert.match(source, /stripe_events/);
  assert.match(stripe, /HMAC/);
  assert.match(stripe, /constantTimeHexEqual/);
  assert.match(stripe, /constantTimeHexEqual\(digest, candidate\)/);
  assert.match(migration, /stripe_subscription_id/);
});

test("Stripe signature verification accepts valid and repeated signatures only within the time window", async () => {
  const body = JSON.stringify({ id: "evt_test" });
  const secret = "whsec_test_secret";
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  const digest = [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  assert.equal(await verifyStripeSignature(body, `t=${timestamp},v1=${digest}`, secret), true);
  assert.equal(await verifyStripeSignature(body, `t=${timestamp},v1=${"0".repeat(64)},v1=${digest}`, secret), true);
  const altered = `${digest[0] === "0" ? "1" : "0"}${digest.slice(1)}`;
  assert.equal(await verifyStripeSignature(body, `t=${timestamp},v1=${altered}`, secret), false);
  assert.equal(await verifyStripeSignature(body, `t=${timestamp},v1=not-a-signature`, secret), false);
  assert.equal(await verifyStripeSignature(body, `t=${timestamp - 301},v1=${digest}`, secret), false);
});

test("Stripe route supports a distinct Connect webhook signing secret", () => {
  assert.match(source, /STRIPE_CONNECT_WEBHOOK_SECRET/);
  assert.match(source, /!platformSignature && !connectSignature/);
});

test("Stripe webhook processing is retryable and rejects stale events", () => {
  assert.match(source, /status = 'failed'/);
  assert.match(source, /status = 'processed'/);
  assert.match(source, /billing_event_created_at/);
  assert.match(source, /billing_event_id/);
  assert.match(source, /could not be mapped to a Blog Nice account yet/);
  assert.match(source, /retrieveSubscription/);
  assert.match(source, /parent\?\.subscription_details\?\.subscription/);
  assert.match(source, /invoiceSubscriptionId !== accountBilling\.stripe_subscription_id/);
  assert.match(source, /items\?\.data\?\.\[0\]\?\.current_period_end/);
  assert.match(source, /A delayed event from an older Stripe subscription/);
  assert.match(source, /incomplete_expired/);
  assert.match(source, /const reconciledStatus =/);
  assert.match(source, /stripe_subscription_id FROM accounts WHERE id = \?/);
  assert.match(reliabilityMigration, /billing_subscription_event_created_at/);
  assert.match(reliabilityMigration, /ai_credit_refunds/);
  assert.match(checkoutOrderingMigration, /billing_subscription_created_at/);
});

test("Stripe dispute webhooks reserve and reverse affiliate commission by payment intent", () => {
  assert.match(source, /event\.type === "charge\.dispute\.created"/);
  assert.match(source, /recordPendingStripeFinancialEventInDb\(c\.env\.DB/);
  assert.match(source, /kind: "dispute_open"/);
  assert.match(source, /paymentId/);
  assert.match(source, /event\.type === "charge\.dispute\.closed"/);
  assert.match(source, /kind: "dispute_close"/);
  assert.match(source, /object\.status === "won"/);
  assert.match(source, /object\.status === "warning_closed"/);
});

test("Stripe credit-note webhooks append line-specific affiliate adjustments", () => {
  assert.match(source, /credit_note\.created/);
  assert.match(source, /credit_note\.updated/);
  assert.match(source, /line\.invoice_line_item/);
  assert.match(source, /kind: "credit_note"/);
  assert.match(source, /!object\.refund/);
});

test("a delayed Checkout event cannot replace a newer subscription", () => {
  assert.equal(checkoutSubscriptionDecision({
    currentId: "sub_new",
    currentCreated: 200,
    incomingId: "sub_old",
    incomingCreated: 100,
  }), "ignore");
});

test("subscription-created before Checkout is safely completed by Checkout reconciliation", () => {
  // During resubscription the subscription event arrives while the canceled
  // subscription is still current, so it cannot replace that ID by itself.
  assert.equal(subscriptionEventMatchesCurrent("sub_old", "sub_new"), false);
  // The completed Checkout then proves the replacement is newer using Stripe's
  // immutable subscription creation time and may adopt it authoritatively.
  assert.equal(checkoutSubscriptionDecision({
    currentId: "sub_old",
    currentCreated: 100,
    incomingId: "sub_new",
    incomingCreated: 200,
  }), "adopt");
});

test("a canceled subscription can transition to a newer paid subscription", () => {
  const canceled = { id: "sub_canceled", created: 100, status: "canceled" };
  const replacement = { id: "sub_active", created: 300, status: "active" };
  const decision = checkoutSubscriptionDecision({
    currentId: canceled.id,
    currentCreated: canceled.created,
    incomingId: replacement.id,
    incomingCreated: replacement.created,
  });
  assert.equal(decision, "adopt");
  assert.equal(accountHasPaidPlan({ billing_status: canceled.status }), false);
  assert.equal(accountHasPaidPlan({ billing_status: replacement.status }), true);
});

test("free and paid plan boundaries are visible and enforced", () => {
  assert.match(source, /Free plan/);
  assert.match(source, /blognice pro monthly/);
  assert.match(source, /blognice pro yearly/);
  assert.match(source, /replaceAll\("Blog Nice admin", "blognice admin"\)/);
  assert.match(source, /Free accounts can own one blog/);
  assert.match(source, /AI image generation requires a paid plan/);
  assert.match(source, /Collaborators are available on a paid plan/);
  assert.match(source, /Custom domains are available on a paid plan/);
  assert.match(source, /Custom favicons are available on a paid plan/);
});

test("checkoutSubscriptionDecision treats equal creation timestamps as ignore (needs event.id tie-breaker)", () => {
  // Same created → checkout should not blindly adopt; ordering is decided by event.id elsewhere
  assert.equal(checkoutSubscriptionDecision({
    currentId: "sub_a",
    currentCreated: 200,
    incomingId: "sub_b",
    incomingCreated: 200,
  }), "ignore");
  assert.equal(checkoutSubscriptionDecision({
    currentId: "sub_a",
    currentCreated: 100,
    incomingId: "sub_b",
    incomingCreated: null,
  }), "ignore");
  assert.equal(checkoutSubscriptionDecision({
    currentId: "sub_a",
    currentCreated: null,
    incomingId: "sub_b",
    incomingCreated: 200,
  }), "ignore");
});

test("billing event ordering uses created-at + event-id lex tie-breaker", () => {
  // The UPDATE guards: (COALESCE(created,0) < ? OR (= AND billing_event_id < ?))
  assert.match(source, /COALESCE\(billing_event_created_at, 0\) < \? OR \(COALESCE\(billing_event_created_at, 0\) = \? AND COALESCE\(billing_event_id, ''\) < \?\)/);
  // both customer.subscription.* and invoice reproducers use same guard
  const hits = (source.match(/COALESCE\(billing_event_created_at, 0\) < \? OR/g) || []).length;
  assert.ok(hits >= 2, `expected at least 2 billing ordering guards, got ${hits}`);
});

test("domain purchase webhook is pending/duplicate safe", () => {
  assert.match(source, /domain_pending/);
  assert.match(source, /duplicate_domain/);
  assert.match(source, /Domain purchase metadata missing domain\/tenant\/account/);
  assert.match(source, /ON CONFLICT\(hostname\) DO UPDATE SET tenant_id=excluded\.tenant_id/);
  assert.match(source, /sanitizeDynadotErrorMessage/);
});

test("email delivery log stale-pending reclaim uses 300s window", () => {
  assert.match(source, /email_delivery_log/);
  assert.match(source, /INSERT OR IGNORE INTO email_delivery_log/);
  // stale pending reclaim after 300s, and delete on failure
  assert.match(source, /pending.*300|300.*pending/);
  assert.match(source, /DELETE FROM email_delivery_log WHERE idempotency_key = \? AND status = 'pending'/);
});
