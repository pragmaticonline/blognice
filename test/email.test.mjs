import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { passwordResetEmail, postNotificationEmail, subscriberWelcomeEmail } from "../src/email.ts";

const email = readFileSync(new URL("../src/email.ts", import.meta.url), "utf8");
const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const render = readFileSync(new URL("../src/render.ts", import.meta.url), "utf8");
const auth = readFileSync(new URL("../src/auth.ts", import.meta.url), "utf8");
const postsSchema = readFileSync(new URL("../schema-posts.sql", import.meta.url), "utf8");
const productionConfig = readFileSync(new URL("../wrangler.production.jsonc", import.meta.url), "utf8");
const subscriberMigration = readFileSync(new URL("../migrations/040-subscriber-double-opt-in.sql", import.meta.url), "utf8");
const subscriberOptin = readFileSync(new URL("../src/subscriber-optin.ts", import.meta.url), "utf8");

test("MailNice is preferred for transactional email", () => {
  assert.match(email, /MAILNICE_API_KEY/);
  assert.match(email, /sendMailNice/);
  assert.match(email, /plainBody/);
  assert.match(email, /sendEmailDetailed/);
  assert.match(email, /provider: "mailnice"/);
  assert.match(email, /Sent by .* via blognice/);
  assert.match(email, /PLATFORM_SUPPORT/);
  assert.match(email, /PLATFORM_POSTAL/);
});

test("signup queues a registration welcome without blocking account creation", () => {
  assert.match(index, /registrationWelcomeEmail\(\{ signInUrl: "https:\/\/www\.blognice\.com\/admin" \}\)/);
  assert.match(index, /invitationWelcomeEmail\(\{ signInUrl: `https:\/\/www\.blognice\.com\/admin\/b\/\$\{tenant\.public_id\}`/);
  assert.match(email, /export function registrationWelcomeEmail/);
  assert.match(email, /export function invitationWelcomeEmail/);
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
  assert.match(postsSchema, /subscriber_notification_sent INTEGER NOT NULL DEFAULT 0/);
});

test("email templates use branded reset links and enriched post notifications", () => {
  assert.match(index, /https:\/\/www\.blognice\.com\/admin\/reset\?token=/);
  const reset = passwordResetEmail({ resetUrl: "https://www.blognice.com/admin/reset?token=test" });
  const post = postNotificationEmail({ blogTitle: "Example Blog", postTitle: "A safe title", postUrl: "https://example.blognice.com/a-safe-title", imageUrl: "https://example.blognice.com/media/1/image.jpg", publishedLabel: "Aug 8, 2026", readingMinutes: 2, excerpt: "A short excerpt.", unsubscribeUrl: "https://example.blognice.com/unsubscribe/test", manageUrl: "https://www.blognice.com/manage-subscriptions/test" });
  assert.match(reset.html, /Or copy and paste this link into your browser/);
  assert.match(post.html, /media\/1\/image\.jpg/);
  assert.equal(post.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.match(post.html, /Read it/);
});

test("subscription emails include one-click and manage-subscriptions links", () => {
  const welcome = subscriberWelcomeEmail({ blogTitle: "Example Blog", unsubscribeUrl: "https://example.blognice.com/unsubscribe/test", manageUrl: "https://www.blognice.com/manage-subscriptions/test" });
  assert.equal(welcome.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.match(welcome.html, /manage-subscriptions/);
  assert.match(index, /subscription_manage_tokens/);
});

test("email subjects and unsubscribe headers reject control characters", () => {
  const post = postNotificationEmail({ blogTitle: "Example", postTitle: "Hello\r\nBcc: attacker@example.com", postUrl: "https://example.blognice.com/post", publishedLabel: "Aug 8, 2026", readingMinutes: 1, excerpt: "Excerpt", unsubscribeUrl: "https://example.blognice.com/unsubscribe/test\r\nBcc: attacker@example.com", manageUrl: "https://www.blognice.com/manage-subscriptions/test" });
  const welcome = subscriberWelcomeEmail({ blogTitle: "Example\nBcc: attacker@example.com", unsubscribeUrl: "https://example.blognice.com/unsubscribe/test", manageUrl: "https://www.blognice.com/manage-subscriptions/test" });
  assert.doesNotMatch(post.subject, /[\r\n]/);
  assert.doesNotMatch(post.headers["List-Unsubscribe"], /[\r\n]/);
  assert.doesNotMatch(welcome.subject, /[\r\n]/);
});

test("subscriber confirmation uses the shared Maew template", () => {
  assert.match(index, /subscriberConfirmationEmail/);
  assert.match(email, /Confirm your subscription/);
  assert.match(email, /won't be subscribed unless you confirm/);
  assert.match(email, /subjectTitle/);
});

test("subscriber signup requires double opt-in and cannot resend pending confirmations", () => {
  const subscribeBlock = index.slice(index.indexOf('app.post("/subscribe"'), index.indexOf('app.get("/privacy"'));
  assert.match(index, /subscriber_confirmations/);
  assert.match(index, /app\.get\("\/subscribe\/confirm"/);
  assert.match(index, /app\.post\("\/subscribe\/confirm"/);
  assert.match(subscriberOptin, /method === "GET/);
  assert.match(email, /Confirm your subscription/);
  assert.match(subscribeBlock, /senderName: tenant\.title/);
  assert.match(email, /won't be subscribed unless you confirm/);
  assert.match(email, /overflow-wrap:anywhere/);
  assert.match(index, /INSERT OR IGNORE INTO subscriber_confirmations/);
  assert.match(index, /sent_at <= \?/);
  assert.match(index, /subscriber-confirmation:/);
  assert.match(index, /confirmed_at IS NOT NULL/);
  assert.match(render, /Check your inbox to confirm your subscription/);
  assert.match(subscriberMigration, /ALTER TABLE subscribers ADD COLUMN confirmed_at/);
  assert.match(subscriberMigration, /UNIQUE \(tenant_id, email\)/);
});

test("subscriber confirmation delivery failures release the retry lock", () => {
  assert.match(subscriberOptin, /if \(!await input\.deliver\(\)\) throw/);
  assert.match(index, /await c\.env\.EMAIL_QUEUE\.send\(job\)/);
  assert.match(index, /return sendEmail\(c\.env, job\)/);
  assert.match(index, /DELETE FROM subscriber_confirmations WHERE token_hash = \?/);
  assert.match(index, /subscriber confirmation delivery failed/);
  assert.match(index, /expires_at <= \? AND sent_at <= \?/);
  assert.match(index, /bind\(now - 86400, now - 86400\)/);
});

test("subscription requests use an enumeration-safe response", () => {
  assert.match(index, /cannot be used to enumerate/);
  assert.match(index, /: c\.json\(\{ ok: true \}\)/);
  assert.doesNotMatch(index, /c\.json\(\{ ok: true, already, pending \}\)/);
  assert.doesNotMatch(render, /d\.already/);
});

test("subscription confirmation state machine is behavioral and replay safe", async () => {
  const { requestSubscriberConfirmation, applySubscriberConfirmation } = await import("../src/subscriber-optin.ts");
  let pending = false;
  let confirmed = false;
  let deliveries = 0;
  let removals = 0;
  const request = () => requestSubscriberConfirmation({
    isConfirmed: async () => confirmed,
    hasPending: async () => pending,
    insert: async () => { if (pending) return false; pending = true; return true; },
    deliver: async () => { deliveries++; return true; },
    remove: async () => { pending = false; removals++; },
  });
  assert.equal(await request(), "accepted");
  assert.equal(deliveries, 1);
  assert.equal(await request(), "accepted");
  assert.equal(deliveries, 1);

  let subscriberRows = 0;
  const confirm = (method) => applySubscriberConfirmation({
    method,
    lookup: async () => pending,
    insert: async () => { if (subscriberRows) return false; subscriberRows++; confirmed = true; pending = false; return true; },
    remove: async () => { pending = false; removals++; },
  });
  assert.equal(await confirm("GET"), "preview");
  assert.equal(subscriberRows, 0);
  assert.equal(await confirm("POST"), "confirmed");
  assert.equal(await confirm("POST"), "invalid");
  assert.equal(subscriberRows, 1);

  pending = false;
  confirmed = false;
  deliveries = 0;
  const failed = await requestSubscriberConfirmation({
    isConfirmed: async () => false,
    hasPending: async () => false,
    insert: async () => { pending = true; return true; },
    deliver: async () => false,
    remove: async () => { pending = false; removals++; },
  });
  assert.equal(failed, "delivery-failed");
  assert.equal(pending, false);
});

test("confirmation welcome email uses the persisted unsubscribe token", () => {
  const confirmationBlock = index.slice(index.indexOf("async function subscriberConfirmation"), index.indexOf("app.get(\"/subscribe/confirm\""));
  assert.equal((confirmationBlock.match(/const unsubscribeToken = crypto\.randomUUID\(\)/g) || []).length, 0);
  assert.match(confirmationBlock, /let unsubscribeToken = \"\"/);
  assert.match(confirmationBlock, /unsubscribeToken = crypto\.randomUUID\(\)/);
  assert.match(confirmationBlock, /const unsub = `\$\{origin\}\/unsubscribe\/\$\{unsubscribeToken\}`/);
});

test("confirmation delivery failures retain the generic subscription response", () => {
  const subscribeBlock = index.slice(index.indexOf('app.post("/subscribe"'), index.indexOf("async function subscriberConfirmation"));
  assert.match(subscribeBlock, /if \(result === "delivery-failed"\)/);
  assert.match(subscribeBlock, /return ok\(\);/);
  assert.doesNotMatch(subscribeBlock, /status unavailable/);
  assert.doesNotMatch(subscribeBlock, /c\.json\(\{ error: .*confirmation email/);
});

test("verified Stripe activation queues one idempotent Pro welcome email", () => {
  assert.match(index, /customer\.subscription\.created/);
  assert.match(index, /subscription-welcome:/);
  assert.match(index, /subscriptionActiveEmail/);
  assert.match(index, /emailKind: "subscription-active"/);
  assert.match(index, /DELETE FROM email_delivery_log WHERE idempotency_key/);
  assert.match(index, /stripe_subscription_id === String\(object\.id\)/);
  assert.match(index, /already being queued/);
  assert.match(index, /status = 'queued'/);
  assert.match(index, /INSERT OR IGNORE INTO email_delivery_log/);
  assert.match(email, /Stripe will send your payment receipt separately/);
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
