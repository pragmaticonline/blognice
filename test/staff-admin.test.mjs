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

test("affiliate offer experiment reporting stays Access-protected and controls are admin-only, same-origin, and audited", () => {
  assert.match(staff, /app\.get\("\/staff\/experiments\/affiliate-offer"/);
  assert.match(staff, /app\.post\("\/api\/experiments\/affiliate-offer\/status"/);
  assert.match(staff, /if \(!canAdmin\(staff\)\)/);
  assert.match(staff, /if \(!sameOrigin\(c\)\)/);
  assert.match(staff, /affiliate-offer-experiment-status/);
  assert.match(staff, /Exact D1 funnel totals/);
  assert.match(staff, /Analytics Engine estimates use sampling intervals/);
  assert.match(staff, /Decision diagnostics/);
  assert.match(staff, /Payment failures/);
  assert.match(staff, /Largest affiliate share/);
  assert.match(staff, /Trend data unavailable/);
  assert.match(staff, /No trend events have been recorded yet/);
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

test("staff payout reconciliation is inspectable and restricted to admins", () => {
  assert.match(staff, /app\.get\("\/api\/affiliate-payouts"/);
  assert.match(staff, /getAffiliatePayoutQueueInDb/);
  assert.match(staff, /app\.post\("\/api\/affiliate-payouts\/:id\/reconcile"/);
  assert.match(staff, /admin role required for payout reconciliation/);
  assert.match(staff, /decision must be confirm_paid or cancel/);
  assert.match(staff, /evidence is required/);
  assert.match(staff, /affiliate-payout-reconcile/);
  assert.match(staff, /reconcilePayoutInDb/);
});

test("manual affiliate corrections are admin-only, same-origin, immutable, and audited", () => {
  assert.match(staff, /app\.post\("\/api\/accounts\/:id\/affiliate-adjustment"/);
  assert.match(staff, /admin role required for affiliate adjustments/);
  assert.match(staff, /recordManualAffiliateAdjustmentInDb/);
  assert.match(staff, /affiliate-manual-adjustment/);
  assert.match(staff, /a unique source_key is required/);
  assert.match(staff, /Append this immutable commission correction/);
});

test("only Stripe transfer creation is classified as an ambiguous dispatch", () => {
  const route = staff.slice(
    staff.indexOf('app.post("/api/affiliate-payouts/:id/dispatch"'),
    staff.indexOf("async function mutateAccount"),
  );
  const ambiguityBoundary = route.match(/try \{([\s\S]*?)\n  \} catch \(error\) \{/);
  assert.ok(ambiguityBoundary);
  assert.match(ambiguityBoundary[1], /createAffiliateTransfer/);
  assert.doesNotMatch(ambiguityBoundary[1], /recordPayoutDispatchResultInDb/);
  assert.doesNotMatch(ambiguityBoundary[1], /await audit/);
});

test("staff can operate the affiliate payout queue from one page", () => {
  assert.match(staff, /app\.get\("\/affiliate-payouts"/);
  assert.match(staff, /href="\/affiliate-payouts" data-staff-nav>Affiliate payouts/);
  assert.match(staff, /Affiliate payout operations/);
  assert.match(staff, /Awaiting reconciliation/);
  assert.match(staff, /Dispatch through Stripe/);
  assert.match(staff, /Confirm paid/);
  assert.match(staff, /Cancel payout/);
  assert.match(staff, /Stripe transfer ID/);
  assert.match(staff, /Evidence/);
  assert.match(staff, /\/api\/affiliate-payouts\/.*\/dispatch/);
  assert.match(staff, /\/api\/affiliate-payouts\/.*\/reconcile/);
});

test("staff account pages expose read-only affiliate support context", () => {
  assert.match(staff, /getAffiliateSupportSummaryInDb\(c\.env\.DB, id/);
  assert.match(staff, /getAffiliateSupportActivityInDb\(c\.env\.DB, id\)/);
  assert.match(staff, /Affiliate program/);
  assert.match(staff, /Referral code/);
  assert.match(staff, /Matured balance/);
  assert.match(staff, /Open reserve/);
  assert.match(staff, /Paid payouts/);
  assert.match(staff, /Referral attributions/);
  assert.match(staff, /Commission ledger/);
  assert.match(staff, /Payout history/);
});

test("admins can suspend and reactivate an affiliate without changing account state", () => {
  assert.match(staff, /app\.post\("\/api\/accounts\/:id\/affiliate-status"/);
  assert.match(staff, /admin role required for affiliate status changes/);
  assert.match(staff, /status must be active or suspended/);
  assert.match(staff, /UPDATE affiliate_profiles SET status = \?/);
  assert.match(staff, /affiliate-status-change/);
  assert.match(staff, /Suspend affiliate/);
  assert.match(staff, /Reactivate affiliate/);
  assert.match(staff, /\/api\/accounts\/\$\{id\}\/affiliate-status/);
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
  assert.match(staff, /TTS_RETRY_DELAYS/);
  assert.match(staff, /classifyTtsError/);
  assert.match(staff, /attempts/);
  assert.match(staff, /transient/);
});

test("staff can send a rate-limited password reset email with an audit trail", () => {
  assert.match(staff, /send-password-reset/);
  assert.match(staff, /password_resets/);
  assert.match(staff, /A reset email was already issued/);
  assert.match(staff, /send-password-reset/);
  assert.match(staff, /Reset your blognice password/);
});

test("suspended accounts can log in but cannot perform actions", () => {
  assert.match(auth, /isSuspended/);
  assert.match(auth, /COALESCE\(a\.status, 'active'\) AS status/);
  assert.doesNotMatch(auth, /WHERE s\.token = \? AND s\.expires_at > \? AND COALESCE\(a\.status/);
  assert.match(auth, /status_reason/);
  assert.match(migration, /status TEXT NOT NULL DEFAULT 'active'/);
  assert.match(migration, /staff_audit_events/);
  const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(indexSource, /suspendedAccountPage/);
  assert.match(indexSource, /isSuspended\(account\)/);
  assert.match(indexSource, /Your account is currently suspended and you should contact support/);
  const admin = readFileSync(new URL("../src/admin.ts", import.meta.url), "utf8");
  assert.match(admin, /suspendedAccountPage/);
  assert.match(admin, /Your account is currently suspended/);
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
  assert.match(staff, /app\.get\("\/email-preview"/);
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
  assert.match(staff, /staff-content a:not\(\.btn\).*#1a8917/);
  assert.match(staff, /staff-sidebar\{visibility:hidden;position:fixed/);
  assert.match(staff, /event\.key==='Escape'/);
  assert.match(staff, /path\.indexOf\('\/accounts\/'\)===0/);
  assert.match(staff, /id="email-preview"/);
  assert.match(staff, /href="\/email-preview" data-staff-nav>Email preview/);
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

test("account deletion cannot orphan an owned blog", () => {
  assert.match(staff, /m\.account_id=\? AND m\.role='owner' LIMIT 1/);
  assert.match(staff, /transfer or delete owned blogs before deleting this account/);
});
