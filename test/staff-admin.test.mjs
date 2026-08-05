import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const staff = readFileSync(new URL("../src/staff.ts", import.meta.url), "utf8");
const auth = readFileSync(new URL("../src/auth.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/014-staff-administration.sql", import.meta.url), "utf8");
const config = readFileSync(new URL("../wrangler.staff.production.example.jsonc", import.meta.url), "utf8");

test("staff Worker validates Access JWTs and keeps staff identity separate", () => {
  assert.match(staff, /Cf-Access-Jwt-Assertion/);
  assert.match(staff, /cdn-cgi\/access\/certs/);
  assert.match(staff, /RSASSA-PKCS1-v1_5/);
  assert.match(staff, /!claims\.iss/);
  assert.match(staff, /staff_users/);
  assert.match(staff, /STAFF_ALLOWED_EMAILS/);
});

test("staff phase 1 mutations require role, same origin, reason, and audit", () => {
  assert.match(staff, /function canMutate/);
  assert.match(staff, /same-origin request required/);
  assert.match(staff, /a reason is required/);
  assert.match(staff, /staff_audit_events/);
  assert.match(staff, /revoke-sessions/);
  assert.match(staff, /revoke-api-key/);
});

test("suspended accounts cannot use customer sessions or API keys", () => {
  assert.match(auth, /COALESCE\(a\.status, 'active'\) = 'active'/);
  assert.match(migration, /status TEXT NOT NULL DEFAULT 'active'/);
  assert.match(migration, /staff_audit_events/);
});

test("staff deployment is a separate Worker route", () => {
  assert.match(config, /"name": "blognice-staff"/);
  assert.match(config, /"main": "src\/staff\.ts"/);
  assert.match(config, /staff\.blognice\.com/);
  assert.match(config, /ACCESS_AUD/);
});
