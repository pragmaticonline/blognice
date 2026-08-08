import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { accountHasPaidPlan } from "../src/auth.ts";
import { canonicalizeIpn, isTerminalPaidStatus, replayCryptoEntitlements, verifyNowPaymentsIpn, NOWPAYMENTS_ANNUAL_SECONDS } from "../src/nowpayments.ts";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/041-nowpayments-crypto.sql", import.meta.url), "utf8");

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

test("crypto billing is separate from Stripe and cannot grant access from the return URL", () => {
  assert.match(source, /\/admin\/billing\/crypto\/checkout/);
  assert.match(source, /\/nowpayments\/webhook/);
  assert.match(source, /verifyNowPaymentsIpn/);
  assert.match(source, /isTerminalPaidStatus/);
  assert.match(source, /credited_at IS NULL/);
  assert.match(source, /credit_nonce/);
  assert.match(source, /revoked_at/);
  assert.match(source, /crypto_paid_through \+ \?/);
  assert.match(source, /const reversible = paymentStatus === "refunded"/);
  assert.match(source, /later finished callback/);
  assert.match(source, /each payment's own one-year contribution independent/);
  assert.match(source, /WITH RECURSIVE ordered AS/);
  assert.match(source, /CASE WHEN t\.expiry > o\.credited_at/);
  assert.match(source, /NOWPAYMENTS_ANNUAL_SECONDS/);
  assert.match(migration, /crypto_paid_through/);
  assert.match(migration, /crypto_payments/);
  assert.match(source, /Crypto payments are annual-only, prepaid/);
});
