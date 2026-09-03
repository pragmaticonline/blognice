import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { accountHasPaidPlan } from "../src/auth.ts";
import { affiliateAnnualPriceMinor } from "../src/affiliate.ts";
import { canonicalizeIpn, createAnnualInvoice, isNowPaymentsAmountFullyPaid, isTerminalPaidStatus, replayCryptoEntitlements, verifyNowPaymentsIpn, NOWPAYMENTS_ANNUAL_SECONDS } from "../src/nowpayments.ts";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const affiliateSource = readFileSync(new URL("../src/affiliate.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/041-nowpayments-crypto.sql", import.meta.url), "utf8");

test("crypto billing displays the same attributed annual price used at checkout", () => {
  assert.equal(affiliateAnnualPriceMinor(false, 3_600), 3_600);
  assert.equal(affiliateAnnualPriceMinor(true, 3_600), 3_240);
  assert.match(source, /const cryptoPriceMinor = affiliateAnnualPriceMinor\(attributed/);
  assert.match(source, /Pay \$\$\{\(cryptoPriceMinor \/ 100\)\.toFixed\(2\)\} with crypto/);
  assert.match(source, /affiliateAnnualPriceMinor\(Boolean\(attribution\)/);
});

test("NOWPayments IPN uses HMAC-SHA512 and rejects altered signatures", async () => {
  const body = JSON.stringify({ payment_status: "finished", payment_id: "123" });
  const secret = "ipn-test-secret";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonicalizeIpn(JSON.parse(body))));
  const digest = [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  assert.equal(await verifyNowPaymentsIpn(body, digest, secret), true);
  assert.equal(await verifyNowPaymentsIpn(body, `${digest.slice(0, -1)}0`, secret), false);
  assert.equal(await verifyNowPaymentsIpn(body, "short", secret), false);
  assert.equal(await verifyNowPaymentsIpn(JSON.stringify({ payment_id: "123", payment_status: "finished" }), digest, secret), true);
});

test("NOWPayments invoice uses the durable checkout amount", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: "invoice-123", invoice_url: "https://pay.example/invoice-123" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await createAnnualInvoice({ NOWPAYMENTS_API_KEY: "test-key" }, {
      orderId: "affiliate_123",
      priceUsdMinor: 3_240,
      callbackUrl: "https://example.com/nowpayments/webhook",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      experimentKey: "affiliate-offer-v1",
      experimentVariant: "focused",
    });
    assert.equal(requestBody.price_amount, 32.4);
    assert.equal(requestBody.order_id, "affiliate_123");
    assert.equal(requestBody.order_description, "blognice pro yearly (affiliate-offer-v1/focused)");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("crypto access is time-limited and only finished is terminally paid", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(accountHasPaidPlan({ billing_status: "inactive", crypto_paid_through: now + 60 }), true);
  assert.equal(accountHasPaidPlan({ billing_status: "inactive", crypto_paid_through: now - 60 }), false);
  assert.equal(isTerminalPaidStatus("finished"), true);
  assert.equal(isTerminalPaidStatus("confirmed"), false);
  const base = 1_000_000;
  const grants = [{ creditedAt: base }, { creditedAt: base }, { creditedAt: base }];
  assert.equal(replayCryptoEntitlements(grants.slice(1), base), base + 2 * NOWPAYMENTS_ANNUAL_SECONDS);
  assert.equal(replayCryptoEntitlements(grants.slice(0, 2), base), base + 2 * NOWPAYMENTS_ANNUAL_SECONDS);
  assert.equal(replayCryptoEntitlements(grants.slice(0, 1), base), base + NOWPAYMENTS_ANNUAL_SECONDS);
});

test("NOWPayments requires the full provider-denominated amount", () => {
  assert.equal(isNowPaymentsAmountFullyPaid({ pay_amount: "0.00100000", actually_paid: "0.001" }), true);
  assert.equal(isNowPaymentsAmountFullyPaid({ pay_amount: "0.001", actually_paid: "0.0012" }), true);
  assert.equal(isNowPaymentsAmountFullyPaid({ pay_amount: "0.001", actually_paid: "0.00099999" }), false);
  for (const payment of [
    { pay_amount: "0.001" },
    { pay_amount: "0", actually_paid: "1" },
    { pay_amount: "NaN", actually_paid: "1" },
    { pay_amount: "1", actually_paid: "1e0" },
  ]) assert.equal(isNowPaymentsAmountFullyPaid(payment), false);
});

test("crypto billing is separate from Stripe and cannot grant access from the return URL", () => {
  assert.match(source, /\/admin\/billing\/crypto\/checkout/);
  assert.match(source, /\/nowpayments\/webhook/);
  assert.match(source, /verifyNowPaymentsIpn/);
  assert.match(source, /isTerminalPaidStatus/);
  assert.match(source, /isNowPaymentsAmountFullyPaid/);
  assert.match(source, /settleNowPaymentsCheckoutInDb/);
  assert.match(affiliateSource, /credited_at IS NULL/);
  assert.match(affiliateSource, /credit_nonce/);
  assert.match(source, /revoked_at/);
  assert.match(affiliateSource, /crypto_paid_through \+ \?/);
  assert.match(source, /const reversible = paymentStatus === "refunded"/);
  assert.match(source, /later finished callback/);
  assert.match(affiliateSource, /entitlement_through/);
  assert.match(affiliateSource, /WITH RECURSIVE ordered AS/);
  assert.match(affiliateSource, /CASE WHEN timeline\.expiry > ordered\.credited_at/);
  assert.match(source, /NOWPAYMENTS_ANNUAL_SECONDS/);
  assert.match(migration, /crypto_paid_through/);
  assert.match(migration, /crypto_payments/);
  assert.match(source, /Crypto payments are annual-only, prepaid/);
});
