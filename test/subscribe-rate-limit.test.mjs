import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { Miniflare } from "miniflare";
import {
  checkSubscribeRateLimit,
  SUBSCRIBE_IP_MAX,
  SUBSCRIBE_TENANT_MAX,
} from "../src/subscribe-rate-limit.ts";

async function testDb() {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "subscribe-rate-limit" },
  });
  const db = await mf.getD1Database("DB");
  await db.exec(
    "CREATE TABLE signup_rate_limits (ip TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);",
  );
  return { mf, db };
}

test("subscribe limiter allows a burst then blocks the same IP with retryAfter", async () => {
  const { mf, db } = await testDb();
  try {
    const c = { env: { DB: db } };
    for (let i = 0; i < SUBSCRIBE_IP_MAX; i++) {
      assert.deepEqual(await checkSubscribeRateLimit(c, "203.0.113.10", 1), { allowed: true });
    }
    const blocked = await checkSubscribeRateLimit(c, "203.0.113.10", 1);
    assert.equal(blocked.allowed, false);
    assert.ok(Number.isInteger(blocked.retryAfter) && blocked.retryAfter > 0);
    // A different IP is unaffected by the first IP's bucket.
    assert.deepEqual(await checkSubscribeRateLimit(c, "203.0.113.11", 1), { allowed: true });
  } finally {
    await mf.dispose();
  }
});

test("subscribe limiter buckets tenants separately and never keys on email", async () => {
  const { mf, db } = await testDb();
  try {
    const c = { env: { DB: db } };
    // Same IP across many tenants only spends the shared IP bucket.
    for (let i = 0; i < SUBSCRIBE_IP_MAX; i++) {
      assert.deepEqual(await checkSubscribeRateLimit(c, "203.0.113.20", 100 + i), { allowed: true });
    }
    assert.equal((await checkSubscribeRateLimit(c, "203.0.113.20", 999)).allowed, false);

    // Tenant bucket: many distinct IPs against one tenant trip the tenant cap.
    const tenant = 7;
    for (let i = 0; i < SUBSCRIBE_TENANT_MAX; i++) {
      await checkSubscribeRateLimit(c, `198.51.100.${i % 250}.${i}`, tenant);
    }
    const over = await checkSubscribeRateLimit(c, "192.0.2.99", tenant);
    assert.equal(over.allowed, false);

    const rows = await db.prepare("SELECT ip FROM signup_rate_limits").all();
    assert.ok(rows.results.length > 0);
    for (const row of rows.results) {
      assert.match(row.ip, /^sub:(ip|tenant):/);
      assert.doesNotMatch(row.ip, /@/);
    }
  } finally {
    await mf.dispose();
  }
});

test("POST /subscribe enforces the limiter before mail and prunes via cron", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const block = source.slice(source.indexOf('app.post("/subscribe"'), source.indexOf('app.post("/subscribe"') + 2500);
  assert.match(block, /checkSubscribeRateLimit\(c, getClientIp\(c\), tenant\.id\)/);
  assert.match(block, /429/);
  assert.match(block, /Retry-After/);
  // No per-email bucket: the address is attacker-controlled cardinality.
  assert.doesNotMatch(block, /sub:email/);
  // Stale buckets are pruned by the per-minute scheduled cleanup, not in the hot path.
  assert.match(source, /DELETE FROM signup_rate_limits WHERE window_start < \?/);
});
