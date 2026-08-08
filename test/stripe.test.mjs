import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { accountHasPaidPlan } from "../src/auth.ts";
import { checkoutSubscriptionDecision, subscriptionEventMatchesCurrent, verifyStripeSignature } from "../src/stripe.ts";

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
  assert.match(source, /Pro · Monthly/);
  assert.match(source, /Free accounts can own one blog/);
  assert.match(source, /AI image generation requires a paid plan/);
  assert.match(source, /Collaborators are available on a paid plan/);
  assert.match(source, /Custom domains are available on a paid plan/);
  assert.match(source, /Custom favicons are available on a paid plan/);
});
