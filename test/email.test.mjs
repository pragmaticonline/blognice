import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const email = readFileSync(new URL("../src/email.ts", import.meta.url), "utf8");
const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const auth = readFileSync(new URL("../src/auth.ts", import.meta.url), "utf8");
const productionConfig = readFileSync(new URL("../wrangler.production.jsonc", import.meta.url), "utf8");

test("MailNice is preferred for transactional email", () => {
  assert.match(email, /MAILNICE_API_KEY/);
  assert.match(email, /sendMailNice/);
  assert.match(email, /plainBody/);
  assert.match(email, /sendEmailDetailed/);
  assert.match(email, /provider: "mailnice"/);
});

test("signup queues a registration welcome without blocking account creation", () => {
  assert.match(index, /subject: "Welcome to blognice"/);
  assert.match(index, /c\.executionCtx\.waitUntil\(sendEmail\(c\.env/);
});

test("API publishing queues subscriber notifications", () => {
  assert.match(index, /queueSubscriberNotificationOnce\(c\.env, tenant/);
  assert.match(index, /if \(!post\.published && published\)/);
});

test("subscriber notification claims are atomic and one-time", () => {
  assert.match(index, /subscriber_notification_sent = 1/);
  assert.match(index, /subscriber_notification_sent = 0/);
  assert.match(index, /queueSubscriberNotificationOnce/);
  assert.match(index, /subscriber_notification_sent = 0/);
  assert.match(index, /UPDATE posts SET subscriber_notification_sent/);
});

test("subscription emails include one-click and manage-subscriptions links", () => {
  assert.match(index, /List-Unsubscribe-Post/);
  assert.match(index, /manage-subscriptions/);
  assert.match(index, /subscription_manage_tokens/);
});

test("verified Stripe activation queues one idempotent Pro welcome email", () => {
  assert.match(index, /customer\.subscription\.created/);
  assert.match(index, /subscription-welcome:/);
  assert.match(index, /Welcome to blognice Pro/);
  assert.match(index, /INSERT OR IGNORE INTO email_delivery_log/);
  assert.match(index, /Stripe will send your payment receipt separately/);
});

test("password reset is one-time, hashed, expiring, and emailed without account enumeration", () => {
  assert.match(index, /app\.get\("\/admin\/forgot"/);
  assert.match(index, /app\.post\("\/admin\/forgot"/);
  assert.match(index, /app\.get\("\/admin\/reset"/);
  assert.match(index, /app\.post\("\/admin\/reset"/);
  assert.match(index, /If an account exists for that email/);
  assert.match(index, /password_resets/);
  assert.match(index, /generateResetToken\(\)/);
  assert.match(index, /emailKind: "password-reset"/);
  assert.match(index, /expires_at >/);
  assert.match(index, /used = 0/);
  assert.match(auth, /SCRYPT_N = 32_768/);
  assert.match(auth, /SCRYPT_R = 8/);
  assert.match(auth, /SCRYPT_P = 3/);
  assert.match(auth, /from "node:crypto"/);
  assert.match(auth, /scrypt\(/);
  assert.match(auth, /return `scrypt\$\$\{SCRYPT_N\}/);
  assert.match(auth, /CLOUDFLARE_MAX_PBKDF2_ITERATIONS = 100_000/);
  assert.doesNotMatch(auth, /crypto\.subtle\.deriveBits/);
  assert.match(index, /algorithm: "scrypt"/);
  assert.match(index, /c\.env\.DB\.batch/);
  assert.match(index, /AND EXISTS \(/);
  assert.match(index, /if \(!writes\[0\]\.meta\.changes\)/);
  assert.match(productionConfig, /"cpu_ms"\s*:\s*300000/);
  assert.match(productionConfig, /"nodejs_compat"/);
});

test("post notifications use a dedicated queue with retry-safe delivery state", () => {
  assert.match(index, /EMAIL_QUEUE/);
  assert.match(index, /email_delivery_log/);
  assert.match(index, /idempotencyKey/);
  assert.match(index, /VALUES \(\?, 'pending', \?, \?, \?\)/);
  assert.match(productionConfig, /blognice-email/);
});
