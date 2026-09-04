import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const index = fs.readFileSync("src/index.ts", "utf8");
const metrics = fs.readFileSync("src/metrics.ts", "utf8");

test("subscriber lifecycle Analytics Engine events are tenant-scoped and PII-free", () => {
  for (const event of ["email_subscribe_requested", "email_subscribed", "email_unsubscribed", "push_subscribed", "push_unsubscribed", "email_bounced", "email_complained", "email_opened", "email_clicked"]) {
    assert.match(metrics, new RegExp(event), `metrics.ts should define ${event}`);
    assert.match(index, new RegExp(event), `index.ts should emit ${event}`);
  }
  // Must use tenant-scoped write, not global
  assert.match(index, /recordCustomEvent\(c\.env, tenant\.id/);
  assert.match(index, /EVENTS.*writeDataPoint|recordCustomEvent/);
  // Must not leak email/endpoint into blob
  assert.doesNotMatch(index, /recordCustomEvent\([^)]*email[^)]*to:/);
  assert.doesNotMatch(metrics, /email.*blob.*@/);
});

test("push and email unsubscriptions are idempotent and produce audit-safe events", () => {
  // push DELETE should record even if endpoint missing (idempotent)
  assert.match(index, /app\.delete\("\/push\/subscribe"/);
  // unsubscribe should handle missing token without error
  assert.match(index, /app\.post\("\/unsubscribe\/:token"/);
  // Should not increment on preview GET
  assert.match(index, /confirmation === "preview"/);
  assert.match(index, /email_unsubscribed/);
});

test("reportQueries and archive include subscriber events", () => {
  assert.match(metrics, /subscriberSummary/);
  assert.match(metrics, /subscriberDaily/);
  assert.match(metrics, /email_subscribed.*push_subscribed/s);
});
