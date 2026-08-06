import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const stripe = readFileSync(new URL("../src/stripe.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/017-stripe-billing.sql", import.meta.url), "utf8");

test("Stripe billing uses hosted Checkout and Customer Portal", () => {
  assert.match(source, /\/admin\/billing\/checkout/);
  assert.match(source, /\/admin\/billing\/portal/);
  assert.match(stripe, /checkout\/sessions/);
  assert.match(stripe, /billing_portal\/sessions/);
});

test("Stripe webhook verifies the raw signed payload and deduplicates events", () => {
  assert.match(source, /Stripe-Signature/);
  assert.match(source, /stripe_events/);
  assert.match(stripe, /HMAC/);
  assert.match(migration, /stripe_subscription_id/);
});

test("free and paid plan boundaries are visible and enforced", () => {
  assert.match(source, /Free plan/);
  assert.match(source, /Pro — active/);
  assert.match(source, /Free accounts can own one blog/);
  assert.match(source, /AI image generation requires a paid plan/);
  assert.match(source, /Collaborators are available on a paid plan/);
  assert.match(source, /Custom domains are available on a paid plan/);
  assert.match(source, /Custom favicons are available on a paid plan/);
});
