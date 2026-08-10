import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const staff = readFileSync(new URL("../src/staff.ts", import.meta.url), "utf8");
const auth = readFileSync(new URL("../src/auth.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/014-staff-administration.sql", import.meta.url), "utf8");
const config = readFileSync(new URL("../wrangler.staff.production.example.jsonc", import.meta.url), "utf8");
const mailnice = readFileSync(new URL("../src/mailnice.ts", import.meta.url), "utf8");
const email = readFileSync(new URL("../src/email.ts", import.meta.url), "utf8");

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
  assert.doesNotMatch(staff, /fetchSite === "same-origin" \|\| fetchSite === "same-site"/);
  assert.match(staff, /a reason is required/);
  assert.match(staff, /staff_audit_events/);
  assert.match(staff, /revoke-sessions/);
  assert.match(staff, /revoke-api-key/);
  assert.match(staff, /test-email/);
  assert.match(staff, /Send test email/);
  assert.match(staff, /subscriber-welcome/);
  assert.match(staff, /subscriber-confirmation/);
  assert.match(staff, /subscription-active/);
  assert.match(staff, /new-post/);
  assert.match(staff, /password-reset/);
  assert.match(staff, /Reset your password/);
  assert.match(email, /List-Unsubscribe/);
  assert.match(staff, /sendEmailDetailed/);
  assert.match(staff, /headers: template\.headers/);
  assert.match(staff, /emailKind: type === "subscriber-confirmation"/);
  assert.match(staff, /senderName: type === "subscriber-confirmation"/);
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
  assert.match(staff, /form method="post" action="\/api\/pronunciations\/\$\{row\.id\}\/delete"/);
  assert.match(staff, /Referer is the next-best CSRF signal/);
});

test("staff can generate short pronunciation samples", () => {
  assert.match(staff, /TTS test/);
  assert.match(staff, /api\/tts-test/);
  assert.match(staff, /TTS_MODEL/);
  assert.match(staff, /short phrase/);
  assert.match(config, /"ai":\s*\{\s*"binding":\s*"AI"\s*\}/);
  assert.match(staff, /ttsTestWithRetry/);
  assert.match(staff, /retryDelays = \[350, 750, 1_500, 2_500\]/);
});

test("staff can send a rate-limited password reset email with an audit trail", () => {
  assert.match(staff, /send-password-reset/);
  assert.match(staff, /password_resets/);
  assert.match(staff, /A reset email was already issued/);
  assert.match(staff, /send-password-reset/);
  assert.match(staff, /Reset your blognice password/);
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
  assert.match(config, /"ai":\s*\{\s*"binding":\s*"AI"\s*\}/);
});

test("all staff pages expose the shared navigation", () => {
  assert.match(staff, /app\.get\("\/dashboard"/);
  assert.match(staff, /Recent staff activity/);
  assert.match(staff, /crypto_paid_through/);
  assert.match(staff, /Pronunciation dictionary.*TTS test/s);
  assert.ok(staff.includes("blognice staff") && staff.includes("<nav"));
  assert.match(staff, /staff-footer/);
  assert.match(staff, /href="https:\/\/www\.blognice\.com\/policies"/);
  assert.doesNotMatch(staff, /staff-footer[\s\S]*mailto:/);
});

test("transactional email links use the Blognice palette", () => {
  const email = readFileSync(new URL("../src/email.ts", import.meta.url), "utf8");
  assert.doesNotMatch(email, /#9098a0/);
  assert.match(email, /href="\$\{unsub\}" style="color:#5c6455"/);
  assert.match(email, /href="\$\{manage\}" style="color:#5c6455"/);
});

test("staff panel exposes logout, audit history, search, and read-only account context", () => {
  assert.match(staff, /cdn-cgi\/access\/logout/);
  assert.match(staff, /class="staff-top"/);
  assert.match(staff, /class="staff-sidebar"/);
  assert.match(staff, /data-staff-nav/);
  assert.match(staff, /staff-menu-toggle/);
  assert.match(staff, /scrollbar-gutter:stable/);
  assert.match(staff, /staff-sidebar\{visibility:hidden;position:fixed/);
  assert.match(staff, /event\.key==='Escape'/);
  assert.match(staff, /path\.indexOf\('\/accounts\/'\)===0/);
  assert.match(staff, /id="email-preview"/);
  assert.match(staff, /hash!==\'#email-preview\'/);
  assert.match(staff, /app\.get\("\/audit"/);
  assert.match(staff, /FROM staff_audit_events ORDER BY occurred_at DESC/);
  assert.match(staff, /Search by email, account ID, blog title/);
  assert.match(staff, /Open in Stripe/);
  assert.match(staff, /View live blog/);
  assert.match(staff, /domain_status/);
  assert.match(staff, /billing_price_id/);
  assert.match(staff, /function boundedPage/);
  assert.match(staff, /ORDER BY a\.created_at DESC, a\.id DESC/);
  assert.match(staff, /Delete this pronunciation entry/);
});
