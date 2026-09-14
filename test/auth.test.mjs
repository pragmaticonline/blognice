import assert from "node:assert/strict";
import { test } from "node:test";
import { accountHasPaidPlan, accountIsVip, hashPassword, maxBlogsForAccount, verifyPassword } from "../src/auth.ts";

test("password hashing uses the supported scrypt profile and verifies successfully", async () => {
  const password = "a-long-test-password-123!";
  const hash = await hashPassword(password);

  assert.match(hash, /^scrypt\$32768\$8\$3\$/);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword("wrong-password", hash), false);
});

test("paid gates grant active/trialing/past_due, VIP, or funded crypto time", () => {
  const now = Math.floor(Date.now() / 1000);
  const base = { billing_status: "inactive", crypto_paid_through: null, vip_granted_at: null, vip_expires_at: null };
  for (const status of ["active", "trialing", "past_due"]) {
    assert.equal(accountHasPaidPlan({ ...base, billing_status: status }), true, status);
  }
  for (const status of ["inactive", "canceled", "unpaid", "", null, undefined]) {
    assert.equal(accountHasPaidPlan({ ...base, billing_status: status }), false, String(status));
  }
  assert.equal(accountHasPaidPlan({ ...base, vip_granted_at: now - 10, vip_expires_at: null }), true);
  assert.equal(accountHasPaidPlan({ ...base, vip_granted_at: now - 100, vip_expires_at: now + 100 }), true);
  assert.equal(accountHasPaidPlan({ ...base, vip_granted_at: now - 100, vip_expires_at: now - 10 }), false);
  assert.equal(accountHasPaidPlan({ ...base, crypto_paid_through: now + 60 }), true);
  assert.equal(accountHasPaidPlan({ ...base, crypto_paid_through: now - 60 }), false);
});

test("VIP requires a grant and respects expiry", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(accountIsVip({ vip_granted_at: null, vip_expires_at: null }), false);
  assert.equal(accountIsVip({ vip_granted_at: 0, vip_expires_at: null }), false);
  assert.equal(accountIsVip({ vip_granted_at: now - 10, vip_expires_at: null }), true);
  assert.equal(accountIsVip({ vip_granted_at: now - 10, vip_expires_at: now + 10 }), true);
  assert.equal(accountIsVip({ vip_granted_at: now - 10, vip_expires_at: now - 10 }), false);
});

test("blog limit honors valid overrides, paid default 5, free default 1", () => {
  const paid = { billing_status: "active", crypto_paid_through: null, vip_granted_at: null, vip_expires_at: null, max_blogs_override: null };
  const free = { ...paid, billing_status: "inactive" };
  assert.equal(maxBlogsForAccount(paid), 5);
  assert.equal(maxBlogsForAccount(free), 1);
  assert.equal(maxBlogsForAccount({ ...free, max_blogs_override: 7 }), 7);
  assert.equal(maxBlogsForAccount({ ...paid, max_blogs_override: 1 }), 1);
  assert.equal(maxBlogsForAccount({ ...paid, max_blogs_override: 50 }), 50);
  for (const bad of [0, 51, -3, 2.5, NaN, "7"]) {
    assert.equal(maxBlogsForAccount({ ...paid, max_blogs_override: bad }), 5, String(bad));
  }
});
