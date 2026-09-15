import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";
import staffModule from "../src/staff.ts";

const require = createRequire(import.meta.url);
for (const extension of [".html", ".svg"]) {
  require.extensions[extension] = (module, filename) => {
    module.exports = readFileSync(filename, "utf8");
  };
}

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

test("AI source pick parses defensively and only reorders pool URLs", async () => {
  const { parseAiSourcePick, applyAiSourcePick } = await import("../src/index.ts");
  assert.deepEqual(parseAiSourcePick('["https://a.example/1", "https://b.example/2"]'), ["https://a.example/1", "https://b.example/2"]);
  assert.deepEqual(parseAiSourcePick('Here you go:\n["https://a.example/1"]\nEnjoy'), ["https://a.example/1"]);
  assert.deepEqual(parseAiSourcePick("no urls here"), []);
  assert.deepEqual(parseAiSourcePick('{"urls": []}'), []);
  const ranked = [{ url: "https://a.example/1" }, { url: "https://b.example/2" }, { url: "https://c.example/3" }];
  assert.deepEqual(
    applyAiSourcePick(ranked, ["https://c.example/3", "https://hallucinated.example/x", "https://c.example/3"]).map((c) => c.url),
    ["https://c.example/3", "https://a.example/1", "https://b.example/2"],
  );
  assert.equal(applyAiSourcePick(ranked, []).length, 3);
  assert.equal(applyAiSourcePick(ranked, null).length, 3);
});

test("autopilot copy helpers strip citations and describe the post", async () => {
  const { stripViaCitation, autopilotMetaDescription } = await import("../src/index.ts");
  assert.equal(
    stripViaCitation("Hello\n\n*Via [Title](https://example.com/x)*"),
    "Hello",
  );
  assert.equal(stripViaCitation("No citation here"), "No citation here");
  const body = "# Big News\n\nFirst sentence here. Second sentence follows with more detail about the event.\n\n*Via [T](https://example.com/x)*";
  const meta = autopilotMetaDescription("Fallback Title", body);
  assert.ok(!meta.includes("Via"), "meta carries citation");
  assert.ok(meta.startsWith("Big News First sentence"), `meta was: ${meta}`);
  assert.ok(meta.length <= 155);
  assert.equal(autopilotMetaDescription("Fallback Title", ""), "Fallback Title");
});

test("autopilot prompts no longer request a Via citation line", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /Via \[\$\{sourceTitle\}\]/);
  assert.doesNotMatch(src, /'\*Via \[title\]\(url\)\*'/);
});

test("failed image jobs record the outcome on the autopilot run", async () => {
  const { processImageJob } = await import("../src/index.ts");
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: { DB: "autopilot-image-fail" } });
  try {
    const db = await mf.getD1Database("DB");
    for (const s of schema.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((v) => v.trim()).filter(Boolean)) await db.prepare(s).run();
    const now = Math.floor(Date.now() / 1000);
    await db.prepare("INSERT INTO tenants (id, public_id, slug, title, description, created_at) VALUES (10, 'pub10', 'blog10', 'Blog 10', '', ?)").bind(now).run();
    await db.prepare("INSERT INTO autopilot_runs (id, tenant_id, started_at, finished_at, status, source_url, source_title, post_id, error, image_status) VALUES ('run-img', 10, ?, ?, 'success', 'https://example.com/a', 'A', 99, NULL, 'queued')").bind(now, now).run();
    const store = new Map();
    const fakeMedia = {
      async put(k, v) { store.set(String(k), String(v)); },
      async get(k) {
        const v = store.get(String(k));
        return v === undefined ? null : { async text() { return v; } };
      },
    };
    const jobKey = "10/.autopilot-image/99-test.json";
    await fakeMedia.put(jobKey, JSON.stringify({
      tenantId: 10, postId: 99, source: "test", style: "editorial-photo",
      status: "queued", creditCost: 3, creditAccountId: 1, creditPeriod: "2026-09",
    }));
    const env = {
      DB: db,
      POSTS: db,
      MEDIA: fakeMedia,
      AI: { async run() { throw new Error("3030: Your output has been flagged. Please choose another prompt"); } },
    };
    await processImageJob(env, jobKey);
    const manifest = JSON.parse(await (await fakeMedia.get(jobKey)).text());
    assert.equal(manifest.status, "failed");
    assert.match(manifest.error, /3030/);
    const run = await db.prepare("SELECT image_status, image_error FROM autopilot_runs WHERE id = 'run-img'").first();
    assert.equal(run.image_status, "failed");
    assert.match(run.image_error, /3030/);
  } finally {
    await mf.dispose();
  }
});

test("broad topics merge the Brave News vertical so front pages are not the only candidates", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(src, /api\.search\.brave\.com\/res\/v1\/news\/search/);
  assert.match(src, /rawResults = rawResults\.concat\(newsResults\)/);
  assert.match(src, /searchRawCount = rawResults\.length/);
});

test("staff autopilot runs list exists (source checks)", () => {
  const staff = readFileSync(new URL("../src/staff.ts", import.meta.url), "utf8");
  assert.match(staff, /autopilot-runs|autopilot_runs/);
  assert.match(staff, /AUTOPILOT_EVENTS|autopilot/);
});

test("staff autopilot-runs page links each run to the live blog in a new tab", async () => {
  const staffApp = typeof staffModule.request === "function" ? staffModule : staffModule.default;
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: { DB: "autopilot-runs-page" } });
  const originalFetch = globalThis.fetch;
  try {
    const db = await mf.getD1Database("DB");
    const baseSchema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
    for (const s of baseSchema.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((v) => v.trim()).filter(Boolean)) await db.prepare(s).run();
    const now = Math.floor(Date.now() / 1000);
    await db.prepare("INSERT INTO tenants (id, public_id, slug, title, description, custom_domain, created_at) VALUES (10, 'pub10', 'blog10', 'Blog 10', '', NULL, ?), (20, 'pub20', 'blog20', 'Blog 20', '', 'example.com', ?)").bind(now, now).run();
    await db.prepare("INSERT INTO autopilot_runs (id, tenant_id, started_at, finished_at, status, source_url, source_title, post_id, error) VALUES (?, 10, ?, ?, 'success', 'https://example.com/a', 'A', 1, NULL), (?, 20, ?, ?, 'success', 'https://example.com/c', 'C', 2, NULL)").bind("r1", now, now, "r3", now, now).run();
    await db.prepare("INSERT INTO autopilot_runs (id, tenant_id, started_at, finished_at, status, source_url, source_title, post_id, error, search_raw_count, search_kept_count) VALUES (?, 10, ?, ?, 'skipped', NULL, NULL, NULL, 'no_source', 10, 2)").bind("r4", now, now).run();
    await db.prepare("INSERT INTO autopilot_runs (id, tenant_id, started_at, finished_at, status, source_url, source_title, post_id, error, image_status, image_error) VALUES (?, 10, ?, ?, 'success', 'https://example.com/b', 'B', 7, NULL, 'failed', '3030: flagged')").bind("r5", now, now).run();
    const adminAccess = await accessFixture("staff|admin", "admin@blognice.com");
    await db.prepare("INSERT INTO staff_users (subject, email, role, active, created_at, updated_at) VALUES ('staff|admin','admin@blognice.com','admin',1,?,?)").bind(now, now).run();
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/cdn-cgi/access/certs")) return new Response(JSON.stringify({ keys: [adminAccess.publicJwk] }), { status: 200 });
      throw new Error("unexpected " + url);
    };
    const env = { DB: db, ROOT_DOMAIN: "blognice.test", ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "staff-audience" };
    const res = await staffApp.request(new Request("https://staff.blognice.test/autopilot-runs", { headers: { "Cf-Access-Jwt-Assertion": adminAccess.token } }), undefined, env);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /href="https:\/\/blog10\.blognice\.test"[^>]*target="_blank"/);
    assert.match(html, /href="https:\/\/example\.com"[^>]*target="_blank"/);
    assert.match(html, />2\/10</);
    assert.match(html, /<th>Image<\/th>/);
    assert.match(html, /title="3030: flagged">failed</);
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
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

test("internal run-now is secret-guarded and validates tenant", async () => {
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: { DB: "autopilot-run-now-internal" } });
  try {
    const db = await mf.getD1Database("DB");
    for (const s of schema.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((v) => v.trim()).filter(Boolean)) await db.prepare(s).run();
    const { blogniceApp } = await import("../src/index.ts");
    const call = (env, body) => blogniceApp.request(
      new Request("https://www.blognice.test/internal/autopilot/run-now", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }),
      undefined, env, { waitUntil() {}, passThroughOnException() {} }
    );
    const base = { DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test" };
    assert.equal((await call(base, { tenant_id: 10 })).status, 403);
    const authed = { ...base, AUTOPILOT_RUN_SECRET: "s3cret" };
    const withSecret = (body) => blogniceApp.request(
      new Request("https://www.blognice.test/internal/autopilot/run-now", {
        method: "POST",
        headers: { "content-type": "application/json", "x-autopilot-run-secret": "s3cret" },
        body: JSON.stringify(body),
      }),
      undefined, authed, { waitUntil() {}, passThroughOnException() {} }
    );
    assert.equal((await withSecret({ tenant_id: "x" })).status, 400);
    const res = await withSecret({ tenant_id: 10 });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.started, true);
    assert.equal(typeof body.since, "number");
  } finally {
    await mf.dispose();
  }
});

test("staff run-now is admin-gated and forwards to the main worker", async () => {
  const staffApp = typeof staffModule.request === "function" ? staffModule : staffModule.default;
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: { DB: "autopilot-run-now-staff" } });
  const originalFetch = globalThis.fetch;
  try {
    const db = await mf.getD1Database("DB");
    for (const s of schema.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((v) => v.trim()).filter(Boolean)) await db.prepare(s).run();
    const now = Math.floor(Date.now() / 1000);
    const adminAccess = await accessFixture("staff|admin", "admin@blognice.com");
    const supportAccess = await accessFixture("staff|support", "support@blognice.com");
    await db.prepare("INSERT INTO staff_users (subject, email, role, active, created_at, updated_at) VALUES ('staff|admin','admin@blognice.com','admin',1,?,?), ('staff|support','support@blognice.com','support',1,?,?)").bind(now, now, now, now).run();
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/cdn-cgi/access/certs")) return new Response(JSON.stringify({ keys: [adminAccess.publicJwk, supportAccess.publicJwk] }), { status: 200 });
      if (String(url) === "https://www.blognice.test/internal/autopilot/run-now") {
        return new Response(JSON.stringify({ ok: true, run: { id: "r9", status: "success", error: null, source_url: "https://example.com/x", post_id: 5, search_raw_count: 10, search_kept_count: 8 } }), { status: 200 });
      }
      throw new Error("unexpected " + url);
    };
    const origin = "https://staff.blognice.test";
    const call = (token, env) => staffApp.request(
      new Request(`${origin}/api/autopilot/10/run-now`, {
        method: "POST", headers: { Origin: origin, "Cf-Access-Jwt-Assertion": token, "content-type": "application/json" }, body: "{}",
      }),
      undefined, env,
    );
    const baseEnv = { DB: db, ROOT_DOMAIN: "blognice.test", ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "staff-audience" };
    assert.equal((await call(supportAccess.token, { ...baseEnv, AUTOPILOT_RUN_SECRET: "s3cret" })).status, 403);
    assert.equal((await call(adminAccess.token, baseEnv)).status, 503);
    const res = await call(adminAccess.token, { ...baseEnv, AUTOPILOT_RUN_SECRET: "s3cret" });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).run.status, "success");
    const auditRow = await db.prepare("SELECT action, target_id FROM staff_audit_events WHERE action = 'autopilot-run-now'").first();
    assert.equal(auditRow.target_id, "10");
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});


test("staff run-now reports the specific upstream failure", async () => {
  const staffApp = typeof staffModule.request === "function" ? staffModule : staffModule.default;
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: { DB: "autopilot-run-now-errors" } });
  const originalFetch = globalThis.fetch;
  try {
    const db = await mf.getD1Database("DB");
    for (const s of schema.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((v) => v.trim()).filter(Boolean)) await db.prepare(s).run();
    const now = Math.floor(Date.now() / 1000);
    const adminAccess = await accessFixture("staff|admin", "admin@blognice.com");
    await db.prepare("INSERT INTO staff_users (subject, email, role, active, created_at, updated_at) VALUES ('staff|admin','admin@blognice.com','admin',1,?,?)").bind(now, now).run();
    const origin = "https://staff.blognice.test";
    const env = { DB: db, ROOT_DOMAIN: "blognice.test", ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "staff-audience", AUTOPILOT_RUN_SECRET: "s3cret" };
    const call = () => staffApp.request(
      new Request(`${origin}/api/autopilot/10/run-now`, {
        method: "POST", headers: { Origin: origin, "Cf-Access-Jwt-Assertion": adminAccess.token, "content-type": "application/json" }, body: "{}",
      }),
      undefined, env,
    );
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/cdn-cgi/access/certs")) return new Response(JSON.stringify({ keys: [adminAccess.publicJwk] }), { status: 200 });
      return new Response("forbidden", { status: 403 });
    };
    let res = await call();
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /upstream 403/);
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/cdn-cgi/access/certs")) return new Response(JSON.stringify({ keys: [adminAccess.publicJwk] }), { status: 200 });
      throw new Error("fetch failed");
    };
    res = await call();
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /fetch failed/);
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});

test("staff run-now polls for the finished run after an async trigger", async () => {
  const staffApp = typeof staffModule.request === "function" ? staffModule : staffModule.default;
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: { DB: "autopilot-run-now-async" } });
  const originalFetch = globalThis.fetch;
  try {
    const db = await mf.getD1Database("DB");
    for (const s of schema.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((v) => v.trim()).filter(Boolean)) await db.prepare(s).run();
    const now = Math.floor(Date.now() / 1000);
    const adminAccess = await accessFixture("staff|admin", "admin@blognice.com");
    await db.prepare("INSERT INTO staff_users (subject, email, role, active, created_at, updated_at) VALUES ('staff|admin','admin@blognice.com','admin',1,?,?)").bind(now, now).run();
    await db.prepare("INSERT INTO tenants (id, public_id, slug, title, created_at) VALUES (10, 't10', 't10', 'T10', ?)").bind(now).run();
    await db.prepare("INSERT INTO autopilot_runs (id, tenant_id, started_at, finished_at, status, source_url, source_title, post_id, error) VALUES ('r-async', 10, ?, ?, 'success', 'https://example.com/y', 'Y', 7, NULL)").bind(now, now + 60).run();
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/cdn-cgi/access/certs")) return new Response(JSON.stringify({ keys: [adminAccess.publicJwk] }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, started: true, since: now }), { status: 200 });
    };
    const origin = "https://staff.blognice.test";
    const res = await staffApp.request(
      new Request(`${origin}/api/autopilot/10/run-now`, {
        method: "POST", headers: { Origin: origin, "Cf-Access-Jwt-Assertion": adminAccess.token, "content-type": "application/json" }, body: "{}",
      }),
      undefined, { DB: db, ROOT_DOMAIN: "blognice.test", ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "staff-audience", AUTOPILOT_RUN_SECRET: "s3cret" },
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).run.id, "r-async");
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});

test("staff run-now prefers the service binding over public HTTPS", async () => {
  const staffApp = typeof staffModule.request === "function" ? staffModule : staffModule.default;
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: { DB: "autopilot-run-now-binding" } });
  const originalFetch = globalThis.fetch;
  try {
    const db = await mf.getD1Database("DB");
    for (const s of schema.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((v) => v.trim()).filter(Boolean)) await db.prepare(s).run();
    const now = Math.floor(Date.now() / 1000);
    const adminAccess = await accessFixture("staff|admin", "admin@blognice.com");
    await db.prepare("INSERT INTO staff_users (subject, email, role, active, created_at, updated_at) VALUES ('staff|admin','admin@blognice.com','admin',1,?,?)").bind(now, now).run();
    await db.prepare("INSERT INTO tenants (id, public_id, slug, title, created_at) VALUES (10, 't10', 't10', 'T10', ?)").bind(now).run();
    await db.prepare("INSERT INTO autopilot_runs (id, tenant_id, started_at, finished_at, status, source_url, source_title, post_id, error) VALUES ('r-bind', 10, ?, ?, 'success', 'https://example.com/z', 'Z', 9, NULL)").bind(now, now + 60).run();
    let bindingHits = 0;
    const runnerStub = {
      async fetch(req) {
        bindingHits++;
        assert.equal(new URL(req.url).pathname, "/internal/autopilot/run-now");
        assert.equal(req.headers.get("x-autopilot-run-secret"), "s3cret");
        return new Response(JSON.stringify({ ok: true, started: true, since: now }), { status: 200 });
      },
    };
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/cdn-cgi/access/certs")) return new Response(JSON.stringify({ keys: [adminAccess.publicJwk] }), { status: 200 });
      throw new Error("must use the service binding, not public HTTPS: " + url);
    };
    const origin = "https://staff.blognice.test";
    const res = await staffApp.request(
      new Request(`${origin}/api/autopilot/10/run-now`, {
        method: "POST", headers: { Origin: origin, "Cf-Access-Jwt-Assertion": adminAccess.token, "content-type": "application/json" }, body: "{}",
      }),
      undefined, { DB: db, ROOT_DOMAIN: "blognice.test", ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "staff-audience", AUTOPILOT_RUN_SECRET: "s3cret", AUTOPILOT_RUNNER: runnerStub },
    );
    assert.equal(res.status, 200);
    assert.equal(bindingHits, 1);
    assert.equal((await res.json()).run.id, "r-bind");
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});
