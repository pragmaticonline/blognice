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
const { blogniceApp } = await import("../src/index.ts");
const { appealApprovedEmail, appealDeniedEmail } = await import("../src/email.ts");

const staffApp = typeof staffModule.request === "function" ? staffModule : staffModule.default;
const ctx = { waitUntil() {}, passThroughOnException() {} };

async function setupDb(name) {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: name },
  });
  const db = await mf.getD1Database("DB");
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  for (const s of schema.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((v) => v.trim()).filter(Boolean)) {
    await db.prepare(s).run();
  }
  return { mf, db };
}

function env(db) {
  return { DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test" };
}

async function seedAccount(db, { id = 1, email = "user@example.com", status = "suspended", reason = "spam" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  await db.prepare("INSERT INTO accounts (id, email, pw_hash, status, status_reason, status_changed_at, created_at) VALUES (?, ?, 'x', ?, ?, ?, ?)")
    .bind(id, email, status, reason, now, now).run();
  await db.prepare("INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(`tok-${id}`, id, now, now + 86400).run();
  return { cookie: `bn_session=tok-${id}`, now };
}

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

async function seedStaff(db, subject, email, role) {
  const now = Math.floor(Date.now() / 1000);
  await db.prepare("INSERT INTO staff_users (subject, email, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)").bind(subject, email, role, now, now).run();
  return accessFixture(subject, email);
}

function staffEnv(db) {
  return { DB: db, ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "staff-audience" };
}

function withAccessCerts(jwks, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/cdn-cgi/access/certs")) return new Response(JSON.stringify({ keys: jwks }), { status: 200 });
    throw new Error("unexpected " + url);
  };
  return fn().finally(() => { globalThis.fetch = originalFetch; });
}

function appealForm(text) {
  const body = new FormData();
  body.set("text", text);
  return body;
}

test("suspended user sees the appeal form with their suspension reason", async () => {
  const { mf, db } = await setupDb("appeals-form");
  try {
    const { cookie } = await seedAccount(db, { reason: "spam links" });
    const res = await blogniceApp.request(new Request("https://www.blognice.test/admin/appeal", { headers: { Cookie: cookie } }), undefined, env(db), ctx);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Appeal your suspension/);
    assert.match(html, /spam links/);
    assert.match(html, /name="text"/);
  } finally { await mf.dispose(); }
});

test("appeal page redirects active users and strangers", async () => {
  const { mf, db } = await setupDb("appeals-gates");
  try {
    const { cookie } = await seedAccount(db, { status: "active", reason: "" });
    const active = await blogniceApp.request(new Request("https://www.blognice.test/admin/appeal", { headers: { Cookie: cookie } }), undefined, env(db), ctx);
    assert.equal(active.status, 302);
    assert.match(active.headers.get("location") || "", /\/admin$/);
    const anon = await blogniceApp.request(new Request("https://www.blognice.test/admin/appeal"), undefined, env(db), ctx);
    assert.equal(anon.status, 302);
    assert.match(anon.headers.get("location") || "", /\/admin\/login/);
  } finally { await mf.dispose(); }
});

test("submitting creates one pending appeal; resubmits stay pending", async () => {
  const { mf, db } = await setupDb("appeals-submit");
  try {
    const { cookie } = await seedAccount(db, {});
    const post = () => blogniceApp.request(new Request("https://www.blognice.test/admin/appeal", { method: "POST", body: appealForm("I was hacked, please look."), headers: { Cookie: cookie, Origin: "https://www.blognice.test" } }), undefined, env(db), ctx);
    const first = await post();
    assert.equal(first.status, 200);
    assert.match(await first.text(), /under review/);
    const second = await post();
    assert.equal(second.status, 200);
    const rows = await db.prepare("SELECT status, appeal_text FROM suspension_appeals WHERE account_id = 1").all();
    assert.equal(rows.results.length, 1);
    assert.equal(rows.results[0].status, "pending");
    assert.equal(rows.results[0].appeal_text, "I was hacked, please look.");
  } finally { await mf.dispose(); }
});

test("appeal text is required and capped", async () => {
  const { mf, db } = await setupDb("appeals-validation");
  try {
    const { cookie } = await seedAccount(db, {});
    const empty = await blogniceApp.request(new Request("https://www.blognice.test/admin/appeal", { method: "POST", body: appealForm("   "), headers: { Cookie: cookie, Origin: "https://www.blognice.test" } }), undefined, env(db), ctx);
    assert.equal(empty.status, 400);
    const long = await blogniceApp.request(new Request("https://www.blognice.test/admin/appeal", { method: "POST", body: appealForm("x".repeat(5001)), headers: { Cookie: cookie, Origin: "https://www.blognice.test" } }), undefined, env(db), ctx);
    assert.equal(long.status, 400);
    const rows = await db.prepare("SELECT id FROM suspension_appeals WHERE account_id = 1").all();
    assert.equal(rows.results.length, 0);
  } finally { await mf.dispose(); }
});

test("denied appeals show the note and enforce a 30-day cooldown", async () => {
  const { mf, db } = await setupDb("appeals-cooldown");
  try {
    const { cookie, now } = await seedAccount(db, {});
    await db.prepare("INSERT INTO suspension_appeals (account_id, status, appeal_text, staff_note, created_at, decided_at) VALUES (1, 'denied', 'please', 'Still looks automated.', ?, ?)").bind(now - 100, now - 100).run();
    const get = await blogniceApp.request(new Request("https://www.blognice.test/admin/appeal", { headers: { Cookie: cookie } }), undefined, env(db), ctx);
    assert.equal(get.status, 200);
    const html = await get.text();
    assert.match(html, /denied/);
    assert.match(html, /Still looks automated/);
    const post = await blogniceApp.request(new Request("https://www.blognice.test/admin/appeal", { method: "POST", body: appealForm("again please"), headers: { Cookie: cookie, Origin: "https://www.blognice.test" } }), undefined, env(db), ctx);
    assert.equal(post.status, 429);
    // After the cooldown the form returns.
    await db.prepare("UPDATE suspension_appeals SET decided_at = ? WHERE account_id = 1").bind(now - 31 * 86400).run();
    const again = await blogniceApp.request(new Request("https://www.blognice.test/admin/appeal", { headers: { Cookie: cookie } }), undefined, env(db), ctx);
    assert.equal(again.status, 200);
    assert.match(await again.text(), /Appeal your suspension/);
  } finally { await mf.dispose(); }
});

test("suspended page links the appeal flow", async () => {
  const { mf, db } = await setupDb("appeals-link");
  try {
    const { cookie } = await seedAccount(db, {});
    const res = await blogniceApp.request(new Request("https://www.blognice.test/admin", { headers: { Cookie: cookie } }), undefined, env(db), ctx);
    assert.equal(res.status, 403);
    assert.match(await res.text(), /href="\/admin\/appeal"/);
  } finally { await mf.dispose(); }
});

test("staff queue lists pending appeals; approve unsuspends", async () => {
  const { mf, db } = await setupDb("appeals-approve");
  try {
    const now = Math.floor(Date.now() / 1000);
    await db.prepare("INSERT INTO accounts (id, email, pw_hash, status, status_reason, status_changed_at, created_at) VALUES (1, 'user@example.com', 'x', 'suspended', 'spam', ?, ?)").bind(now, now).run();
    await db.prepare("INSERT INTO suspension_appeals (account_id, status, appeal_text, created_at) VALUES (1, 'pending', 'I was hacked.', ?)").bind(now).run();
    const admin = await seedStaff(db, "staff|admin", "admin@blognice.com", "admin");
    await withAccessCerts([admin.publicJwk], async () => {
      const page = await staffApp.request(new Request("https://staff.blognice.test/appeals", { headers: { "Cf-Access-Jwt-Assertion": admin.token } }), undefined, staffEnv(db));
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /user@example\.com/);
      assert.match(html, /I was hacked/);
      const res = await staffApp.request(new Request("https://staff.blognice.test/api/appeals/1/approve", {
        method: "POST", headers: { "Cf-Access-Jwt-Assertion": admin.token, Origin: "https://staff.blognice.test", "content-type": "application/json" },
        body: JSON.stringify({ note: "Legit, welcome back." }),
      }), undefined, staffEnv(db));
      assert.equal(res.status, 200);
      const account = await db.prepare("SELECT status, status_reason FROM accounts WHERE id = 1").first();
      assert.equal(account.status, "active");
      assert.equal(account.status_reason, "Appeal approved");
      const appeal = await db.prepare("SELECT status, staff_note FROM suspension_appeals WHERE id = 1").first();
      assert.equal(appeal.status, "approved");
      assert.equal(appeal.staff_note, "Legit, welcome back.");
      const audit = await db.prepare("SELECT action, result FROM staff_audit_events WHERE target_type = 'suspension_appeal'").all();
      assert.equal(audit.results.length, 1);
      assert.equal(audit.results[0].action, "appeal-approve");
      // Deciding twice is a conflict.
      const again = await staffApp.request(new Request("https://staff.blognice.test/api/appeals/1/approve", {
        method: "POST", headers: { "Cf-Access-Jwt-Assertion": admin.token, Origin: "https://staff.blognice.test", "content-type": "application/json" },
        body: JSON.stringify({}),
      }), undefined, staffEnv(db));
      assert.equal(again.status, 409);
    });
  } finally { await mf.dispose(); }
});

test("deny requires a note and keeps the suspension", async () => {
  const { mf, db } = await setupDb("appeals-deny");
  try {
    const now = Math.floor(Date.now() / 1000);
    await db.prepare("INSERT INTO accounts (id, email, pw_hash, status, status_reason, status_changed_at, created_at) VALUES (1, 'user@example.com', 'x', 'suspended', 'spam', ?, ?)").bind(now, now).run();
    await db.prepare("INSERT INTO suspension_appeals (account_id, status, appeal_text, created_at) VALUES (1, 'pending', 'please unban', ?)").bind(now).run();
    const support = await seedStaff(db, "staff|support", "support@blognice.com", "support");
    const reader = await seedStaff(db, "staff|reader", "reader@blognice.com", "read_only");
    await withAccessCerts([support.publicJwk, reader.publicJwk], async () => {
      const noNote = await staffApp.request(new Request("https://staff.blognice.test/api/appeals/1/deny", {
        method: "POST", headers: { "Cf-Access-Jwt-Assertion": support.token, Origin: "https://staff.blognice.test", "content-type": "application/json" },
        body: JSON.stringify({ note: "  " }),
      }), undefined, staffEnv(db));
      assert.equal(noNote.status, 400);
      const ro = await staffApp.request(new Request("https://staff.blognice.test/api/appeals/1/deny", {
        method: "POST", headers: { "Cf-Access-Jwt-Assertion": reader.token, Origin: "https://staff.blognice.test", "content-type": "application/json" },
        body: JSON.stringify({ note: "nope" }),
      }), undefined, staffEnv(db));
      assert.equal(ro.status, 403);
      const denied = await staffApp.request(new Request("https://staff.blognice.test/api/appeals/1/deny", {
        method: "POST", headers: { "Cf-Access-Jwt-Assertion": support.token, Origin: "https://staff.blognice.test", "content-type": "application/json" },
        body: JSON.stringify({ note: "Confirmed spam operation." }),
      }), undefined, staffEnv(db));
      assert.equal(denied.status, 200);
      const account = await db.prepare("SELECT status FROM accounts WHERE id = 1").first();
      assert.equal(account.status, "suspended");
      const appeal = await db.prepare("SELECT status, staff_note FROM suspension_appeals WHERE id = 1").first();
      assert.equal(appeal.status, "denied");
      assert.equal(appeal.staff_note, "Confirmed spam operation.");
    });
  } finally { await mf.dispose(); }
});

test("decision emails carry the verdict, note, and re-appeal date", () => {
  const ok = appealApprovedEmail({ note: "Welcome back." });
  assert.match(ok.subject, /appeal was approved/);
  assert.match(ok.plainText, /active again/);
  assert.match(ok.plainText, /Welcome back/);
  assert.match(ok.html, /admin\/login/);
  const plain = appealApprovedEmail();
  assert.doesNotMatch(plain.plainText, /note from our team/);
  const no = appealDeniedEmail({ note: "Confirmed spam.", reappealDate: "2026-11-01" });
  assert.match(no.subject, /appeal/);
  assert.match(no.plainText, /stays in place/);
  assert.match(no.plainText, /Confirmed spam/);
  assert.match(no.plainText, /2026-11-01/);
});
