import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { classifyPushDelivery, canAdmitPushSubscription, deliveryClaimable } from "../src/push-state.ts";

const index = fs.readFileSync("src/index.ts", "utf8");
const push = fs.readFileSync("src/push.ts", "utf8");
const render = fs.readFileSync("src/render.ts", "utf8");
const migration = fs.readFileSync("migrations/047-browser-push.sql", "utf8");
const postMigration = fs.readFileSync("migrations/048-post-browser-push.sql", "utf8");
const ownerMigration = fs.readFileSync("migrations/049-browser-push-owner-opt-in.sql", "utf8");
const productionConfig = fs.readFileSync("wrangler.production.jsonc", "utf8");

test("browser push is opt-in and has a reusable service worker", () => {
  assert.match(index, /app\.get\("\/sw\.js"/);
  assert.match(render, /Notification\.requestPermission/);
  assert.match(render, /data-push-enable/);
  assert.match(render, /pushManager\.subscribe/);
});

test("push subscriptions are tenant-scoped and bounded", () => {
  assert.match(index, /readBoundedJson/);
  assert.match(index, /tenant_id = \? AND endpoint_hash = \?/);
  assert.match(push, /PUSH_SERVICE_HOSTS/);
  assert.match(migration, /UNIQUE \(tenant_id, endpoint_hash, topic\)/);
});

test("new-post delivery is queued and future topics can reuse the path", () => {
  assert.match(index, /kind: "push-fanout"/);
  assert.match(index, /queueBrowserPushNotificationOnce/);
  assert.match(index, /processPushFanout/);
  assert.match(postMigration, /push_notification_sent/);
  assert.match(ownerMigration, /browser_push_enabled/);
  assert.match(index, /push_deliveries/);
  assert.match(index, /push_campaigns/);
  assert.match(index, /push-campaigns\/:campaignId\/replay/);
  assert.match(index, /PUSH_QUEUE/);
  assert.doesNotMatch(index, /EMAIL_QUEUE\.send\(\{ kind: "push-fanout"/);
  assert.match(fs.readFileSync("docs/comments-and-realtime-discussion-design.md", "utf8"), /comment-reply/);
});

test("delivery failures distinguish retryable providers from dead subscriptions", () => {
  assert.match(index, /classifyPushDelivery\(status\)/);
  assert.match(index, /status = 'pending', claimed_at = NULL/);
  assert.match(index, /status = 'dead'/);
  assert.match(index, /campaignFailure = true/);
  assert.match(index, /campaign\.status === "failed"/);
  assert.match(productionConfig, /dead_letter_queue/);
  assert.match(index, /UPDATE push_deliveries SET status = 'pending', claimed_at = NULL WHERE campaign_id/);
});

test("replay is origin-protected and quota admission is atomic", () => {
  assert.match(index, /push-campaigns\/:campaignId\/replay[\s\S]{0,1200}new URL\(origin\)/);
  assert.match(index, /INSERT INTO push_subscriptions[\s\S]{0,500}SELECT \?, \?, \?, 'new-post'/);
  assert.match(index, /WHERE EXISTS \(SELECT 1 FROM push_subscriptions/);
  assert.match(index, /PUSH_QUEUE\.send/);
  assert.match(productionConfig, /blognice-push-dlq/);
  assert.match(index, /status IN \('failed', 'retry-exhausted'\)/);
  assert.match(index, /status = 'retry-exhausted'/);
  assert.match(index, /status = 'failed', completed_at = NULL WHERE campaign_id/);
});

test("push delivery policy is behavioral and terminal states are explicit", () => {
  assert.equal(classifyPushDelivery(201), "sent");
  assert.equal(classifyPushDelivery(404), "expired");
  assert.equal(classifyPushDelivery(410), "expired");
  for (const status of [0, 408, 425, 429, 500, 503]) assert.equal(classifyPushDelivery(status), "retry");
  for (const status of [400, 401, 403, 413, 422, 499]) assert.equal(classifyPushDelivery(status), "campaign-failed");
  assert.equal(classifyPushDelivery(301), "dead");
  assert.equal(canAdmitPushSubscription(false, 999), true);
  assert.equal(canAdmitPushSubscription(false, 1000), false);
  assert.equal(canAdmitPushSubscription(true, 1000), true);
  assert.equal(deliveryClaimable("pending", null, 1000), true);
  assert.equal(deliveryClaimable("claimed", 699, 1000), true);
  assert.equal(deliveryClaimable("claimed", 700, 1000), false);
  assert.equal(deliveryClaimable("sent", null, 1000), false);
});

test("push secrets are configuration-only", () => {
  assert.match(index, /VAPID_PRIVATE_KEY\?: string/);
  assert.match(index, /PUSH_IP_HMAC_SECRET\?: string/);
  assert.doesNotMatch(index, /VAPID_PRIVATE_KEY\s*=\s*["'`]/);
  assert.doesNotMatch(push, /BEGIN .*PRIVATE KEY/);
  assert.match(index, /Too many subscription attempts/);
});
test("new blog creation enables browser push by default", () => {
  const tenantCreates = [...index.matchAll(/INSERT INTO tenants \(public_id, slug, title, description, shard, browser_push_enabled, created_at\) VALUES \(\?, \?, \?, '', 'primary', 1, \?\)/g)];
  assert.equal(tenantCreates.length, 2);
});
