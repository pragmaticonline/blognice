import assert from "node:assert/strict";
import test from "node:test";
import { Miniflare } from "miniflare";
import fs from "node:fs";
import { checkLoginRateLimit, clearFailedLoginForEmail, recordFailedLogin } from "../src/login-rate-limit.ts";

test("unsafe admin requests require the canonical same origin", async () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /new Set\(\["GET", "HEAD", "OPTIONS"\]\)/);
  assert.match(source, /if \(!origin \|\| origin !== expectedOrigin\)/);
  assert.match(source, /same-origin request required/);
});

test("failed login limits are separate by IP and hashed email and clear after success", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "login-hardening" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec(`
      CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT NOT NULL);
      CREATE TABLE signup_rate_limits (ip TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
      CREATE TABLE staff_rate_limit_overrides (account_id INTEGER PRIMARY KEY, max_logins_per_hour INTEGER);
      INSERT INTO accounts (id, email) VALUES (1, 'owner@example.com');
      INSERT INTO staff_rate_limit_overrides (account_id, max_logins_per_hour) VALUES (1, 2);
    `);
    const c = { env: { DB: db } };
    assert.deepEqual(await checkLoginRateLimit(c, "203.0.113.10", "owner@example.com"), { allowed: true });
    await recordFailedLogin(c, "203.0.113.10", "owner@example.com");
    await recordFailedLogin(c, "203.0.113.10", "owner@example.com");
    assert.equal((await checkLoginRateLimit(c, "203.0.113.10", "owner@example.com")).allowed, false);
    const rows = await db.prepare("SELECT ip FROM signup_rate_limits ORDER BY ip").all();
    assert.equal(rows.results.length, 2);
    assert.equal(rows.results.some((row) => row.ip.includes("owner@example.com")), false);
    await clearFailedLoginForEmail(c, "owner@example.com");
    assert.equal((await checkLoginRateLimit(c, "203.0.113.11", "owner@example.com")).allowed, true);
  } finally {
    await mf.dispose();
  }
});
