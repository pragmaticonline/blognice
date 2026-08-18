import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Miniflare } from "miniflare";
import { build } from "esbuild";

const base64url = (bytes) => Buffer.from(bytes).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const publicKey = base64url(Buffer.from("046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5", "hex"));
const auth = base64url(Buffer.alloc(16, 7));
const subscription = (endpoint) => ({ endpoint, keys: { p256dh: publicKey, auth } });

let mf;
let db;

test.before(async () => {
  const bundle = await build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    format: "esm",
    write: false,
    platform: "neutral",
    mainFields: ["module", "main"],
    external: ["node:*", "assert", "buffer", "crypto", "http", "https", "net", "stream", "tls", "tty", "url", "util"],
    loader: { ".html": "text", ".svg": "text" },
    plugins: [{
      name: "web-push-test-stub",
      setup(plugin) {
        plugin.onResolve({ filter: /^web-push$/ }, () => ({ path: "web-push-test-stub", namespace: "push-test" }));
        plugin.onLoad({ filter: /.*/, namespace: "push-test" }, () => ({ contents: "const calls = new Map(); export default { sendNotification: async (subscription) => { if (subscription.endpoint.includes('concurrent-claim')) await new Promise((resolve) => setTimeout(resolve, 100)); const prior = calls.get(subscription.endpoint) || 0; calls.set(subscription.endpoint, prior + 1); const match = subscription.endpoint.match(/status-(\\d+)/); const statusCode = subscription.endpoint.includes('recover-after-dlq') && prior >= 6 ? 201 : (match ? Number(match[1]) : 201); if (statusCode !== 201) throw Object.assign(new Error('provider response'), { statusCode }); return { statusCode }; } };", loader: "js" }));
      },
    }],
  });
  mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "browser-push-integration", POSTS: "browser-push-posts-integration" },
    queueProducers: { PUSH_QUEUE: { queueName: "blognice-push" } },
  queueConsumers: { "blognice-push": { maxBatchSize: 1, maxRetries: 5, deadLetterQueue: "blognice-push-dlq" } },
    bindings: {
      ROOT_DOMAIN: "blognice.com",
      VAPID_SUBJECT: "mailto:qa@blognice.com",
      VAPID_PUBLIC_KEY: "test-public-key",
      VAPID_PRIVATE_KEY: "test-private-key",
      PUSH_IP_HMAC_SECRET: "test-rate-limit-secret",
    },
  });
  db = await mf.getD1Database("DB");
  const postsDb = await mf.getD1Database("POSTS");
  await db.exec(`
    CREATE TABLE tenants (id INTEGER PRIMARY KEY, public_id TEXT UNIQUE, slug TEXT UNIQUE, custom_domain TEXT, title TEXT NOT NULL DEFAULT 'Test blog', description TEXT, footer_name TEXT, accent_color TEXT, topics_json TEXT, social_links_json TEXT, avatar_key TEXT, shard TEXT NOT NULL DEFAULT 'primary');
    CREATE TABLE domains (id INTEGER PRIMARY KEY, tenant_id INTEGER, hostname TEXT, status TEXT);
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT, billing_status TEXT DEFAULT 'inactive', billing_cancel_at_period_end INTEGER DEFAULT 0, crypto_paid_through INTEGER, status TEXT DEFAULT 'active', status_reason TEXT, status_changed_at INTEGER);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, account_id INTEGER, expires_at INTEGER);
    CREATE TABLE memberships (account_id INTEGER, tenant_id INTEGER, role TEXT, display_name TEXT, PRIMARY KEY (account_id, tenant_id));
  `);
  await postsDb.exec("CREATE TABLE posts (id INTEGER PRIMARY KEY, published INTEGER NOT NULL DEFAULT 0);");
  for (const migration of ["migrations/047-browser-push.sql", "migrations/049-browser-push-owner-opt-in.sql"]) {
    const sql = fs.readFileSync(migration, "utf8").replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "");
    for (const statement of sql.split(/;\s*(?=\r?\n|$)/).map((item) => item.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
  for (const statement of fs.readFileSync("migrations/048-post-browser-push.sql", "utf8").replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((item) => item.trim()).filter(Boolean)) {
    await postsDb.prepare(statement).run();
  }
  await db.prepare("INSERT INTO tenants (id, public_id, slug, browser_push_enabled) VALUES (1, 'alpha-id', 'alpha', 1), (2, 'beta-id', 'beta', 1)").run();
  await db.prepare("INSERT INTO accounts (id, email, billing_status) VALUES (1, 'owner@example.com', 'inactive')").run();
  await db.prepare("INSERT INTO sessions (token, account_id, expires_at) VALUES ('integration-session', 1, 4102444800)").run();
  await db.prepare("INSERT INTO memberships (account_id, tenant_id, role) VALUES (1, 1, 'owner')").run();
});

test.after(async () => {
  await mf?.dispose();
});

async function request(host, method, value, origin = `https://${host}`, ip = "198.51.100.10") {
  return mf.dispatchFetch(`https://${host}/push/subscribe`, {
    method,
    headers: { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify(value),
  });
}

async function replayRequest(host, blogId, campaignId, origin = `https://${host}`) {
  return mf.dispatchFetch(`https://${host}/admin/b/${blogId}/push-campaigns/${campaignId}/replay`, {
    method: "POST",
    redirect: "manual",
    headers: { Origin: origin, Cookie: "bn_session=integration-session" },
  });
}

test("push routes enforce same-origin requests and support revoke", async () => {
  const value = subscription("https://fcm.googleapis.com/send/integration-origin");
  const accepted = await request("alpha.blognice.com", "POST", value);
  assert.equal(accepted.status, 200);
  const crossOrigin = await request("alpha.blognice.com", "POST", subscription("https://fcm.googleapis.com/send/cross-origin"), "https://evil.example");
  assert.equal(crossOrigin.status, 403);
  const missingOrigin = await mf.dispatchFetch("https://alpha.blognice.com/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(subscription("https://fcm.googleapis.com/send/missing-origin")) });
  assert.equal(missingOrigin.status, 403);
  const revoked = await request("alpha.blognice.com", "DELETE", value);
  assert.equal(revoked.status, 200);
  const count = await db.prepare("SELECT COUNT(*) AS count FROM push_subscriptions WHERE tenant_id = 1").first();
  assert.equal(count.count, 0);
});

test("subscriptions remain isolated between tenant origins", async () => {
  const endpoint = "https://fcm.googleapis.com/send/shared-endpoint";
  assert.equal((await request("alpha.blognice.com", "POST", subscription(endpoint), undefined, "198.51.100.11")).status, 200);
  assert.equal((await request("beta.blognice.com", "POST", subscription(endpoint), undefined, "198.51.100.12")).status, 200);
  const rows = await db.prepare("SELECT tenant_id, COUNT(*) AS count FROM push_subscriptions GROUP BY tenant_id ORDER BY tenant_id").all();
  assert.deepEqual(rows.results, [{ tenant_id: 1, count: 1 }, { tenant_id: 2, count: 1 }]);
});

test("quota rejects new subscriptions but refreshes an existing endpoint at capacity", async () => {
  await db.prepare("DELETE FROM push_subscriptions").run();
  const existing = subscription("https://fcm.googleapis.com/send/at-capacity");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(existing.endpoint));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  for (let offset = 0; offset < 1000; offset += 100) {
    const values = Array.from({ length: 100 }, (_, localIndex) => {
      const index = offset + localIndex;
      const endpoint = index === 0 ? existing.endpoint : `https://fcm.googleapis.com/send/${index}`;
      const endpointHash = index === 0 ? hash : `seed-${index}`;
      return `(${index + 1}, 1, '${endpoint}', '${endpointHash}', 'new-post', '${publicKey}', '${auth}', 1, 1)`;
    });
    await db.exec(`INSERT INTO push_subscriptions (id, tenant_id, endpoint, endpoint_hash, topic, p256dh, auth, created_at, updated_at) VALUES ${values.join(",")};`);
  }
  const refreshed = await request("alpha.blognice.com", "POST", existing, undefined, "198.51.100.13");
  assert.equal(refreshed.status, 200, await refreshed.text());
  assert.equal((await request("alpha.blognice.com", "POST", subscription("https://fcm.googleapis.com/send/new-at-capacity"), undefined, "198.51.100.14")).status, 429);
});

test("quota remains bounded when two new subscriptions race for the final slot", async () => {
  await db.prepare("DELETE FROM push_subscriptions").run();
  const values = Array.from({ length: 999 }, (_, index) => `(${index + 1}, 1, 'https://fcm.googleapis.com/send/race-${index}', 'race-${index}', 'new-post', '${publicKey}', '${auth}', 1, 1)`);
  for (let offset = 0; offset < values.length; offset += 100) await db.exec(`INSERT INTO push_subscriptions (id, tenant_id, endpoint, endpoint_hash, topic, p256dh, auth, created_at, updated_at) VALUES ${values.slice(offset, offset + 100).join(",")};`);
  const responses = await Promise.all([
    request("alpha.blognice.com", "POST", subscription("https://fcm.googleapis.com/send/race-a"), undefined, "198.51.100.30"),
    request("alpha.blognice.com", "POST", subscription("https://fcm.googleapis.com/send/race-b"), undefined, "198.51.100.31"),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 429]);
  const count = await db.prepare("SELECT COUNT(*) AS count FROM push_subscriptions WHERE tenant_id = 1").first();
  assert.equal(count.count, 1000);
});

test("dedicated push queue completes a tenant-scoped delivery ledger", async () => {
  await db.prepare("DELETE FROM push_deliveries").run();
  await db.prepare("DELETE FROM push_campaigns").run();
  await db.prepare("DELETE FROM push_subscriptions").run();
  await db.prepare("INSERT INTO push_subscriptions (id, tenant_id, endpoint, endpoint_hash, topic, p256dh, auth, created_at, updated_at) VALUES (1, 1, 'https://fcm.googleapis.com/send/queue-test', 'queue-test-hash', 'new-post', ?, ?, 1, 1)").bind(publicKey, auth).run();
  await db.prepare("INSERT INTO push_subscriptions (id, tenant_id, endpoint, endpoint_hash, topic, p256dh, auth, created_at, updated_at) VALUES (2, 1, 'https://fcm.googleapis.com/send/later-subscriber', 'later-subscriber-hash', 'new-post', ?, ?, 1, 1)").bind(publicKey, auth).run();
  await db.prepare("INSERT INTO push_campaigns (campaign_id, tenant_id, topic, post_slug, post_title, post_excerpt, max_subscription_id, status, created_at) VALUES ('campaign-queue-test', 1, 'new-post', 'hello', 'Hello', '', 1, 'pending', 1)").run();
  const bindings = await mf.getBindings();
  await bindings.PUSH_QUEUE.send({ kind: "push-fanout", campaignId: "campaign-queue-test", tenantId: 1, postSlug: "hello", postTitle: "Hello", postExcerpt: "", afterId: 0 });
  for (let attempt = 0; attempt < 30; attempt++) {
    const row = await db.prepare("SELECT status FROM push_campaigns WHERE campaign_id = 'campaign-queue-test'").first();
    if (row.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const campaign = await db.prepare("SELECT status FROM push_campaigns WHERE campaign_id = 'campaign-queue-test'").first();
  const delivery = await db.prepare("SELECT status, attempts FROM push_deliveries WHERE campaign_id = 'campaign-queue-test' AND subscription_id = 1").first();
  assert.equal(campaign.status, "completed");
  assert.equal(delivery.status, "sent");
  assert.equal(delivery.attempts, 1);
  const laterDelivery = await db.prepare("SELECT COUNT(*) AS count FROM push_deliveries WHERE campaign_id = 'campaign-queue-test' AND subscription_id = 2").first();
  assert.equal(laterDelivery.count, 0);
});

test("subscription ingress rejects malformed providers and owner disablement blocks new subscriptions but permits revoke", async () => {
  await db.prepare("DELETE FROM push_subscriptions").run();
  const malformed = subscription("https://not-a-push-provider.example/send/bad");
  assert.equal((await request("alpha.blognice.com", "POST", malformed, undefined, "198.51.100.20")).status, 400);
  const badKey = { endpoint: "https://fcm.googleapis.com/send/bad-key", keys: { p256dh: auth, auth } };
  assert.equal((await request("alpha.blognice.com", "POST", badKey, undefined, "198.51.100.21")).status, 400);
  const valid = subscription("https://fcm.googleapis.com/send/disablement");
  assert.equal((await request("alpha.blognice.com", "POST", valid, undefined, "198.51.100.22")).status, 200);
  await db.prepare("UPDATE tenants SET browser_push_enabled = 0 WHERE id = 1").run();
  assert.equal((await mf.dispatchFetch("https://alpha.blognice.com/push/public-key")).status, 404);
  assert.equal((await request("alpha.blognice.com", "POST", subscription("https://fcm.googleapis.com/send/blocked"), undefined, "198.51.100.23")).status, 404);
  assert.equal((await request("alpha.blognice.com", "DELETE", valid, undefined, "198.51.100.22")).status, 200);
  await db.prepare("UPDATE tenants SET browser_push_enabled = 1 WHERE id = 1").run();
});

test("provider terminal failures update the campaign state and expired endpoints are removed", async () => {
  await db.prepare("DELETE FROM push_deliveries").run();
  await db.prepare("DELETE FROM push_campaigns").run();
  await db.prepare("DELETE FROM push_subscriptions").run();
  await db.prepare("INSERT INTO push_subscriptions (id, tenant_id, endpoint, endpoint_hash, topic, p256dh, auth, created_at, updated_at) VALUES (1, 1, 'https://fcm.googleapis.com/status-404', 'expired-hash', 'new-post', ?, ?, 1, 1), (2, 1, 'https://fcm.googleapis.com/status-400', 'failed-hash', 'new-post', ?, ?, 1, 1)").bind(publicKey, auth, publicKey, auth).run();
  await db.prepare("INSERT INTO push_campaigns (campaign_id, tenant_id, topic, post_slug, post_title, post_excerpt, max_subscription_id, status, created_at) VALUES ('campaign-failure-test', 1, 'new-post', 'failure', 'Failure', '', 2, 'pending', 1)").run();
  const bindings = await mf.getBindings();
  await bindings.PUSH_QUEUE.send({ kind: "push-fanout", campaignId: "campaign-failure-test", tenantId: 1, postSlug: "failure", postTitle: "Failure", postExcerpt: "", afterId: 0 });
  for (let attempt = 0; attempt < 30; attempt++) {
    const row = await db.prepare("SELECT status FROM push_campaigns WHERE campaign_id = 'campaign-failure-test'").first();
    if (row.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const campaign = await db.prepare("SELECT status FROM push_campaigns WHERE campaign_id = 'campaign-failure-test'").first();
  const expired = await db.prepare("SELECT COUNT(*) AS count FROM push_subscriptions WHERE id = 1").first();
  assert.equal(campaign.status, "failed");
  assert.equal(expired.count, 0);
});

test("transient provider failures are retried and become recoverable after exhaustion", async () => {
  await db.prepare("DELETE FROM push_deliveries").run();
  await db.prepare("DELETE FROM push_campaigns").run();
  await db.prepare("DELETE FROM push_subscriptions").run();
  await db.prepare("INSERT INTO push_subscriptions (id, tenant_id, endpoint, endpoint_hash, topic, p256dh, auth, created_at, updated_at) VALUES (1, 1, 'https://fcm.googleapis.com/status-503', 'retry-hash', 'new-post', ?, ?, 1, 1)").bind(publicKey, auth).run();
  await db.prepare("INSERT INTO push_campaigns (campaign_id, tenant_id, topic, post_slug, post_title, post_excerpt, max_subscription_id, status, created_at) VALUES ('campaign-retry-test', 1, 'new-post', 'retry', 'Retry', '', 1, 'pending', 1)").run();
  const bindings = await mf.getBindings();
  await bindings.PUSH_QUEUE.send({ kind: "push-fanout", campaignId: "campaign-retry-test", tenantId: 1, postSlug: "retry", postTitle: "Retry", postExcerpt: "", afterId: 0 });
  for (let attempt = 0; attempt < 100; attempt++) {
    const row = await db.prepare("SELECT attempts FROM push_deliveries WHERE campaign_id = 'campaign-retry-test' AND subscription_id = 1").first();
    if (row?.attempts >= 6) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const delivery = await db.prepare("SELECT status, attempts FROM push_deliveries WHERE campaign_id = 'campaign-retry-test' AND subscription_id = 1").first();
  const campaign = await db.prepare("SELECT status FROM push_campaigns WHERE campaign_id = 'campaign-retry-test'").first();
  assert.equal(delivery.status, "pending");
  assert.ok(delivery.attempts >= 6);
  assert.equal(campaign.status, "retry-exhausted");
});

test("concurrent queue jobs claim a delivery only once", async () => {
  await db.prepare("DELETE FROM push_deliveries").run();
  await db.prepare("DELETE FROM push_campaigns").run();
  await db.prepare("DELETE FROM push_subscriptions").run();
  await db.prepare("INSERT INTO push_subscriptions (id, tenant_id, endpoint, endpoint_hash, topic, p256dh, auth, created_at, updated_at) VALUES (1, 1, 'https://fcm.googleapis.com/send/concurrent-claim', 'claim-hash', 'new-post', ?, ?, 1, 1)").bind(publicKey, auth).run();
  await db.prepare("INSERT INTO push_campaigns (campaign_id, tenant_id, topic, post_slug, post_title, post_excerpt, max_subscription_id, status, created_at) VALUES ('campaign-claim-test', 1, 'new-post', 'claim', 'Claim', '', 1, 'pending', 1)").run();
  const bindings = await mf.getBindings();
  const job = { kind: "push-fanout", campaignId: "campaign-claim-test", tenantId: 1, postSlug: "claim", postTitle: "Claim", postExcerpt: "", afterId: 0 };
  await Promise.all([bindings.PUSH_QUEUE.send(job), bindings.PUSH_QUEUE.send(job)]);
  for (let attempt = 0; attempt < 40; attempt++) {
    const row = await db.prepare("SELECT status FROM push_campaigns WHERE campaign_id = 'campaign-claim-test'").first();
    if (row.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const delivery = await db.prepare("SELECT status, attempts FROM push_deliveries WHERE campaign_id = 'campaign-claim-test' AND subscription_id = 1").first();
  assert.equal(delivery.status, "sent");
  assert.equal(delivery.attempts, 1);
});

test("replay is same-origin, tenant-scoped, and idempotent", async () => {
  await db.prepare("DELETE FROM push_deliveries").run();
  await db.prepare("DELETE FROM push_campaigns").run();
  await db.prepare("DELETE FROM push_subscriptions").run();
  await db.prepare("INSERT INTO push_subscriptions (id, tenant_id, endpoint, endpoint_hash, topic, p256dh, auth, created_at, updated_at) VALUES (1, 1, 'https://fcm.googleapis.com/send/replay-test', 'replay-hash', 'new-post', ?, ?, 1, 1)").bind(publicKey, auth).run();
  await db.prepare("INSERT INTO push_campaigns (campaign_id, tenant_id, topic, post_slug, post_title, post_excerpt, max_subscription_id, status, created_at) VALUES ('campaign-replay-test', 1, 'new-post', 'replay', 'Replay', '', 1, 'failed', 1)").run();
  await db.prepare("INSERT INTO push_deliveries (campaign_id, subscription_id, status, attempts) VALUES ('campaign-replay-test', 1, 'dead', 1)").run();

  assert.equal((await replayRequest("www.blognice.com", "alpha-id", "campaign-replay-test", "https://beta.blognice.com")).status, 403);
  const wrongTenant = await replayRequest("www.blognice.com", "beta-id", "campaign-replay-test");
  assert.notEqual(wrongTenant.status, 200);
  const first = await replayRequest("www.blognice.com", "alpha-id", "campaign-replay-test");
  const second = await replayRequest("www.blognice.com", "alpha-id", "campaign-replay-test");
  assert.equal(first.status, 200, await first.text());
  assert.equal(second.status, 200, await second.text());
  for (let attempt = 0; attempt < 40; attempt++) {
    const row = await db.prepare("SELECT status FROM push_campaigns WHERE campaign_id = 'campaign-replay-test'").first();
    if (row.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const campaign = await db.prepare("SELECT status FROM push_campaigns WHERE campaign_id = 'campaign-replay-test'").first();
  const delivery = await db.prepare("SELECT status, attempts FROM push_deliveries WHERE campaign_id = 'campaign-replay-test' AND subscription_id = 1").first();
  assert.equal(campaign.status, "completed");
  assert.equal(delivery.status, "sent");
  assert.equal(delivery.attempts, 2);
});

test("retry exhaustion becomes recoverable through replay", async () => {
  await db.prepare("DELETE FROM push_deliveries").run();
  await db.prepare("DELETE FROM push_campaigns").run();
  await db.prepare("DELETE FROM push_subscriptions").run();
  await db.prepare("INSERT INTO push_subscriptions (id, tenant_id, endpoint, endpoint_hash, topic, p256dh, auth, created_at, updated_at) VALUES (1, 1, 'https://fcm.googleapis.com/status-503-recover-after-dlq', 'dlq-recovery-hash', 'new-post', ?, ?, 1, 1)").bind(publicKey, auth).run();
  await db.prepare("INSERT INTO push_campaigns (campaign_id, tenant_id, topic, post_slug, post_title, post_excerpt, max_subscription_id, status, created_at) VALUES ('campaign-dlq-recovery', 1, 'new-post', 'dlq-recovery', 'DLQ recovery', '', 1, 'pending', 1)").run();
  const bindings = await mf.getBindings();
  await bindings.PUSH_QUEUE.send({ kind: "push-fanout", campaignId: "campaign-dlq-recovery", tenantId: 1, postSlug: "dlq-recovery", postTitle: "DLQ recovery", postExcerpt: "", afterId: 0 });
  for (let attempt = 0; attempt < 100; attempt++) {
    const row = await db.prepare("SELECT status FROM push_campaigns WHERE campaign_id = 'campaign-dlq-recovery'").first();
    if (row.status === "retry-exhausted") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await db.prepare("SELECT status FROM push_campaigns WHERE campaign_id = 'campaign-dlq-recovery'").first()).status, "retry-exhausted");
  await bindings.PUSH_QUEUE.send({ kind: "push-fanout", campaignId: "campaign-dlq-recovery", tenantId: 1, postSlug: "dlq-recovery", postTitle: "DLQ recovery", postExcerpt: "", afterId: 0 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await db.prepare("SELECT status FROM push_campaigns WHERE campaign_id = 'campaign-dlq-recovery'").first()).status, "retry-exhausted");
  assert.equal((await db.prepare("SELECT attempts FROM push_deliveries WHERE campaign_id = 'campaign-dlq-recovery' AND subscription_id = 1").first()).attempts, 6);
  const replay = await replayRequest("www.blognice.com", "alpha-id", "campaign-dlq-recovery");
  assert.equal(replay.status, 200, await replay.text());
  for (let attempt = 0; attempt < 40; attempt++) {
    const row = await db.prepare("SELECT status FROM push_campaigns WHERE campaign_id = 'campaign-dlq-recovery'").first();
    if (row.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const campaign = await db.prepare("SELECT status FROM push_campaigns WHERE campaign_id = 'campaign-dlq-recovery'").first();
  const delivery = await db.prepare("SELECT status, attempts FROM push_deliveries WHERE campaign_id = 'campaign-dlq-recovery' AND subscription_id = 1").first();
  assert.equal(campaign.status, "completed");
  assert.equal(delivery.status, "sent");
  assert.equal(delivery.attempts, 7);
});
