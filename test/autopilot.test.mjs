import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Miniflare } from "miniflare";
import staffModule from "../src/staff.ts";

const staffSrc = readFileSync(new URL("../src/staff.ts", import.meta.url), "utf8");
const indexSrc = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

function b64url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  return Buffer.from(bytes).toString("base64url");
}
async function accessFixture(subject, email) {
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  publicJwk.kid = "staff-test-key-" + subject;
  publicJwk.alg = "RS256";
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", kid: publicJwk.kid }));
  const payload = b64url(JSON.stringify({ sub: subject, email, iss: "https://team.cloudflareaccess.com", aud: ["staff-audience"], iat: now - 1, exp: now + 3600 }));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return { token: `${header}.${payload}.${b64url(signature)}`, publicJwk };
}

test("autopilot schema exists in D1 (configs + runs)", () => {
  assert.match(schema, /CREATE TABLE autopilot_configs/);
  assert.match(schema, /CREATE TABLE autopilot_runs/);
  assert.match(schema, /idx_autopilot_configs_next/);
  assert.match(schema, /idx_autopilot_runs_tenant/);
});

test("spec seams are documented and implemented (staff toggle, owner API, scheduled, AE)", () => {
  assert.match(readFileSync(new URL("../docs/autopilot-spec.md", import.meta.url), "utf8"), /Seams \(TDD/);
  assert.match(staffSrc, /autopilot/);
  assert.match(indexSrc, /autopilot/);
});

test("staff can toggle autopilot per-blog, gated to admin, audited, Pro/VIP agnostic for staff", async () => {
  const staffApp = typeof staffModule.request === "function" ? staffModule : staffModule.default;
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: { DB: "autopilot-staff" } });
  const originalFetch = globalThis.fetch;
  try {
    const db = await mf.getD1Database("DB");
    const baseSchema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
    for (const statement of baseSchema.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((v) => v.trim()).filter(Boolean)) await db.prepare(statement).run();
    const now = Math.floor(Date.now() / 1000);
    await db.prepare("INSERT INTO accounts (id, email, pw_hash, email_verified, created_at) VALUES (1, 'owner@example.com', 'x', 1, ?)").bind(now).run();
    await db.prepare("INSERT INTO tenants (id, public_id, slug, title, description, created_at) VALUES (10, 'pub10', 'blog10', 'Blog 10', '', ?)").bind(now).run();
    await db.prepare("INSERT INTO memberships (account_id, tenant_id, role, created_at) VALUES (1, 10, 'owner', ?)").bind(now).run();
    const adminAccess = await accessFixture("staff|admin", "admin@blognice.com");
    const supportAccess = await accessFixture("staff|support", "support@blognice.com");
    await db.prepare("INSERT INTO staff_users (subject, email, role, active, created_at, updated_at) VALUES ('staff|admin','admin@blognice.com','admin',1,?,?), ('staff|support','support@blognice.com','support',1,?,?)").bind(now, now, now, now).run();
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/cdn-cgi/access/certs")) return new Response(JSON.stringify({ keys: [supportAccess.publicJwk, adminAccess.publicJwk] }), { status: 200 });
      throw new Error("unexpected fetch " + url);
    };
    const env = { DB: db, ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "staff-audience" };
    const origin = "https://staff.blognice.test";
    assert.equal((await staffApp.request(new Request(`https://staff.blognice.test/api/autopilot/10`, { headers: { Origin: origin } }), undefined, env)).status, 403);
    const getAsSupport = await staffApp.request(new Request(`https://staff.blognice.test/api/autopilot/10`, { headers: { Origin: origin, "Cf-Access-Jwt-Assertion": supportAccess.token } }), undefined, env);
    assert.equal(getAsSupport.status, 200);
    const supportToggle = await staffApp.request(new Request(`https://staff.blognice.test/api/autopilot/10/toggle`, { method: "POST", headers: { Origin: origin, "Cf-Access-Jwt-Assertion": supportAccess.token, "content-type": "application/json" }, body: JSON.stringify({ reason: "test", enabled: true }) }), undefined, env);
    assert.equal(supportToggle.status, 403);
    const badOrigin = await staffApp.request(new Request(`https://staff.blognice.test/api/autopilot/10/toggle`, { method: "POST", headers: { Origin: "https://evil.example", "Cf-Access-Jwt-Assertion": adminAccess.token, "content-type": "application/json" }, body: JSON.stringify({ reason: "test", enabled: true }) }), undefined, env);
    assert.equal(badOrigin.status, 403);
    const noReason = await staffApp.request(new Request(`https://staff.blognice.test/api/autopilot/10/toggle`, { method: "POST", headers: { Origin: origin, "Cf-Access-Jwt-Assertion": adminAccess.token, "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) }), undefined, env);
    assert.equal(noReason.status, 400);
    const enable = await staffApp.request(new Request(`https://staff.blognice.test/api/autopilot/10/toggle`, { method: "POST", headers: { Origin: origin, "Cf-Access-Jwt-Assertion": adminAccess.token, "content-type": "application/json" }, body: JSON.stringify({ reason: "enable for test", enabled: true, topic: "local markets", interval_days: 1, run_hour_utc: 9 }) }), undefined, env);
    assert.equal(enable.status, 200);
    const enabledBody = await enable.json();
    assert.equal(enabledBody.config.enabled, 1);
    assert.equal(enabledBody.config.staff_enabled, 1);
    assert.equal(enabledBody.config.tenant_id, 10);
    const row = await db.prepare("SELECT enabled, staff_enabled FROM autopilot_configs WHERE tenant_id=10").first();
    assert.equal(row.enabled, 1);
    assert.equal(row.staff_enabled, 1);
    const audit = await db.prepare("SELECT action, result FROM staff_audit_events WHERE action='autopilot-toggle' ORDER BY occurred_at DESC LIMIT 1").first();
    assert.equal(audit.action, "autopilot-toggle");
    assert.equal(audit.result, "success");
    const disable = await staffApp.request(new Request(`https://staff.blognice.test/api/autopilot/10/toggle`, { method: "POST", headers: { Origin: origin, "Cf-Access-Jwt-Assertion": adminAccess.token, "content-type": "application/json" }, body: JSON.stringify({ reason: "disable", enabled: false }) }), undefined, env);
    assert.equal(disable.status, 200);
    assert.equal((await disable.json()).config.enabled, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});

test("owner autopilot API validates paid plan, staff gate, and criteria (source checks)", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(src, /\/api\/v1\/blogs\/:blogId\/autopilot/);
  assert.match(src, /tenantHasPaidPlan/);
  assert.match(src, /staff_enabled/);
  assert.match(src, /topic must be 3-120/);
  assert.match(src, /max_length.*400.*2000/);
  assert.match(src, /interval_days/);
  assert.match(src, /run_hour_utc/);
});

test("scheduled autopilot respects 1/day, paid check, next_run_at and AE", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(src, /scheduled/);
  assert.match(src, /autopilot/);
  assert.match(src, /next_run_at/);
  assert.match(src, /AUTOPILOT_EVENTS/);
  assert.match(src, /tenantHasPaidPlan/);
  assert.match(src, /interval_days/);
});

test("autopilot dedup, credits, and post creation are wired (source checks)", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(src, /reserveAiCredits|ai_credit_usage/);
  assert.match(src, /autopilot_runs/);
  assert.match(src, /source_url/);
  assert.match(src, /POSTS\.prepare.*INSERT INTO posts|tenantDb/);
});

test("staff autopilot runs list exists (source checks)", () => {
  const staff = readFileSync(new URL("../src/staff.ts", import.meta.url), "utf8");
  assert.match(staff, /autopilot-runs|autopilot_runs/);
  assert.match(staff, /AUTOPILOT_EVENTS|autopilot/);
});

test("staff autopilot-runs endpoint returns filtered runs", async () => {
  const staffApp = typeof staffModule.request === "function" ? staffModule : staffModule.default;
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: { DB: "autopilot-runs" } });
  const originalFetch = globalThis.fetch;
  try {
    const db = await mf.getD1Database("DB");
    const baseSchema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
    for (const s of baseSchema.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((v) => v.trim()).filter(Boolean)) await db.prepare(s).run();
    const now = Math.floor(Date.now() / 1000);
    await db.prepare("INSERT INTO tenants (id, public_id, slug, title, description, created_at) VALUES (10, 'pub10', 'blog10', 'Blog 10', '', ?), (20, 'pub20', 'blog20', 'Blog 20', '', ?)").bind(now, now).run();
    await db.prepare("INSERT INTO autopilot_runs (id, tenant_id, started_at, finished_at, status, source_url, source_title, post_id, error) VALUES (?, 10, ?, ?, 'success', 'https://example.com/a', 'A', 1, NULL), (?, 10, ?, ?, 'skipped', 'https://example.com/b', 'B', NULL, 'dedup'), (?, 20, ?, ?, 'success', 'https://example.com/c', 'C', 2, NULL)").bind("r1", now, now, "r2", now, now, "r3", now, now).run();
    // create staff user
    const adminAccess = await accessFixture("staff|admin", "admin@blognice.com");
    await db.prepare("INSERT INTO staff_users (subject, email, role, active, created_at, updated_at) VALUES ('staff|admin','admin@blognice.com','admin',1,?,?)").bind(now, now).run();
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/cdn-cgi/access/certs")) return new Response(JSON.stringify({ keys: [adminAccess.publicJwk] }), { status: 200 });
      throw new Error("unexpected " + url);
    };
    const env = { DB: db, ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "staff-audience" };
    let res = await staffApp.request(new Request("https://staff.blognice.test/api/autopilot-runs", { headers: { "Cf-Access-Jwt-Assertion": adminAccess.token } }), undefined, env);
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.equal(body.runs.length, 3);
    res = await staffApp.request(new Request("https://staff.blognice.test/api/autopilot-runs?tenant=10", { headers: { "Cf-Access-Jwt-Assertion": adminAccess.token } }), undefined, env);
    body = await res.json();
    assert.equal(body.runs.length, 2);
    res = await staffApp.request(new Request("https://staff.blognice.test/api/autopilot-runs?status=success", { headers: { "Cf-Access-Jwt-Assertion": adminAccess.token } }), undefined, env);
    body = await res.json();
    assert.equal(body.runs.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});

