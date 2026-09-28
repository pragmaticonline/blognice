import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

const require = createRequire(import.meta.url);
for (const extension of [".html", ".svg"]) {
  require.extensions[extension] = (module, filename) => {
    module.exports = readFileSync(filename, "utf8");
  };
}
const { default: staffModule } = await import("../src/staff.ts");

function b64url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  return Buffer.from(bytes).toString("base64url");
}

async function accessFixture(subject, email) {
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  publicJwk.kid = "staff-test-key";
  publicJwk.alg = "RS256";
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", kid: publicJwk.kid }));
  const payload = b64url(JSON.stringify({ sub: subject, email, iss: "https://team.cloudflareaccess.com", aud: ["staff-audience"], iat: now - 1, exp: now + 3600 }));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return { token: `${header}.${payload}.${b64url(signature)}`, publicJwk };
}

test("staff ads funnel shows exact D1 totals and trend fallback without analytics", async () => {
  const staffApp = typeof staffModule.request === "function" ? staffModule : staffModule.default;
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: { DB: "staff-ads-funnel" } });
  const originalFetch = globalThis.fetch;
  try {
    const db = await mf.getD1Database("DB");
    const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
    for (const statement of schema.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) await db.prepare(statement).run();
    const now = Math.floor(Date.now() / 1000);
    await db.prepare("INSERT INTO accounts (id, email, pw_hash, email_verified, created_at) VALUES (1, 'paid@example.com', 'x', 1, ?)").bind(now).run();
    await db.prepare("INSERT INTO ads_attributions (account_id, gclid, landing_path, created_at) VALUES (1, 'g1', '/blogger-alternative', ?)").bind(now).run();
    await db.prepare("INSERT INTO ads_conversions (account_id, transaction_id, value_minor, currency, reported_at) VALUES (1, 'cs_test_1', 3600, 'USD', ?)").bind(now).run();
    const access = await accessFixture("staff|admin", "admin@example.com");
    await db.prepare("INSERT INTO staff_users (subject, email, role, active, created_at, updated_at) VALUES ('staff|admin', 'admin@example.com', 'admin', 1, ?, ?)").bind(now, now).run();
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/cdn-cgi/access/certs")) return new Response(JSON.stringify({ keys: [access.publicJwk] }), { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    };
    const env = { DB: db, ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "staff-audience" };
    const res = await staffApp.request(new Request("https://staff.blognice.test/staff/ads-funnel", {
      headers: { "Cf-Access-Jwt-Assertion": access.token },
    }), undefined, env);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Paid-ads funnel/);
    assert.match(html, /Attributed signups/);
    assert.match(html, /cs_test_1/);
    assert.match(html, /36\.00/);
    assert.match(html, /\/blogger-alternative/);
    assert.match(html, /Trend data unavailable/);
    assert.match(html, /Ads funnel/);
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});

test("staff ads funnel renders analytics trends when configured", async () => {
  const staffApp = typeof staffModule.request === "function" ? staffModule : staffModule.default;
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: { DB: "staff-ads-funnel-trends" } });
  const originalFetch = globalThis.fetch;
  try {
    const db = await mf.getD1Database("DB");
    const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
    for (const statement of schema.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) await db.prepare(statement).run();
    const now = Math.floor(Date.now() / 1000);
    const access = await accessFixture("staff|admin", "admin@example.com");
    await db.prepare("INSERT INTO staff_users (subject, email, role, active, created_at, updated_at) VALUES ('staff|admin', 'admin@example.com', 'admin', 1, ?, ?)").bind(now, now).run();
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/cdn-cgi/access/certs")) return new Response(JSON.stringify({ keys: [access.publicJwk] }), { status: 200 });
      if (String(url).includes("/analytics_engine/sql")) {
        return new Response(JSON.stringify({ data: [
          { date: "2026-09-20", event: "ads:signup", landing: "/blogger-alternative", events: 3 },
        ] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const env = { DB: db, ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "staff-audience", CF_ACCOUNT_ID: "acct", CF_ANALYTICS_TOKEN: "tok" };
    const res = await staffApp.request(new Request("https://staff.blognice.test/staff/ads-funnel", {
      headers: { "Cf-Access-Jwt-Assertion": access.token },
    }), undefined, env);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /2026-09-20/);
    assert.match(html, /signup/);
    assert.doesNotMatch(html, /Trend data unavailable/);
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});
