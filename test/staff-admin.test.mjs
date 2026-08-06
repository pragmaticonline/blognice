import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const staff = readFileSync(new URL("../src/staff.ts", import.meta.url), "utf8");
const auth = readFileSync(new URL("../src/auth.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/014-staff-administration.sql", import.meta.url), "utf8");
const config = readFileSync(new URL("../wrangler.staff.production.example.jsonc", import.meta.url), "utf8");
const mailnice = readFileSync(new URL("../src/mailnice.ts", import.meta.url), "utf8");

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
  assert.match(staff, /test-email/);
  assert.match(staff, /Send test email/);
  assert.match(staff, /subscriber-welcome/);
  assert.match(staff, /new-post/);
  assert.match(staff, /password-reset/);
  assert.match(staff, /Reset your password/);
  assert.match(staff, /List-Unsubscribe/);
});

test("staff test email uses MailNice without exposing its API key", () => {
  assert.match(mailnice, /api\.mailnice\.net\/api\/v1\/send\/message/);
  assert.match(mailnice, /X-Server-API-Key/);
  assert.match(mailnice, /plain_body/);
  assert.doesNotMatch(staff, /MAILNICE_API_KEY[^\n]*=[^?]/);
});

test("staff can manage the global pronunciation dictionary", () => {
  assert.match(staff, /Pronunciation dictionary/);
  assert.match(staff, /api\/pronunciations/);
  assert.match(staff, /upsert-pronunciation/);
  assert.match(staff, /delete-pronunciation/);
});

test("staff can generate short pronunciation samples", () => {
  assert.match(staff, /TTS test/);
  assert.match(staff, /api\/tts-test/);
  assert.match(staff, /TTS_MODEL/);
  assert.match(staff, /short phrase/);
  assert.match(config, /"ai":\s*\{\s*"binding":\s*"AI"\s*\}/);
});

test("staff can send a rate-limited password reset email with an audit trail", () => {
  assert.match(staff, /send-password-reset/);
  assert.match(staff, /password_resets/);
  assert.match(staff, /A reset email was already issued/);
  assert.match(staff, /send-password-reset/);
  assert.match(staff, /Reset your Blog Nice password/);
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
