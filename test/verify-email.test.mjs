import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("getClientIp uses only cf-connecting-ip and is not spoofable via X-Forwarded-For", () => {
  const block = source.slice(source.indexOf("function getClientIp"), source.indexOf("async function checkSignupRateLimit"));
  assert.match(block, /cf-connecting-ip/);
  assert.doesNotMatch(block, /x-forwarded-for/i);
  assert.doesNotMatch(block, /x-real-ip/i);
  assert.match(block, /return "unknown"/);
  assert.match(block, /slice\(0,64\)/);
});

test("signup rate limit enforces 5 per IP and 3 per email per hour with prune", () => {
  assert.match(source, /const maxPerIp = 5/);
  assert.match(source, /const maxPerEmail = 3/);
  assert.match(source, /windowSec = 3600/);
  // ip and email keys are namespaced
  assert.match(source, /ip:\$\{ip\}/);
  assert.match(source, /email:\$\{email\.toLowerCase\(\)\}/);
  // window bucket + increment logic present
  assert.match(source, /window_start === windowStart && ipRow\.count >= maxPerIp/);
  assert.match(source, /window_start === windowStart && emRow\.count >= maxPerEmail/);
  // prune deletes stale rows older than 24h
  assert.match(source, /DELETE FROM signup_rate_limits WHERE window_start < \?/);
  assert.match(source, /now - 86400/);
});

test("POST /verify-email/resend is enumeration-safe — returns 200 pending for unknown, missing, already-verified", () => {
  const block = source.slice(source.indexOf('app.post("/verify-email/resend"'), source.indexOf('app.post("/verify-email/resend"') + 3500);
  // missing email falls back to verificationPendingPage
  assert.match(block, /if \(!email\) return c\.html\(verificationPendingPage/);
  // unknown account returns pending, not 404
  assert.match(block, /if \(!acct\) return c\.html\(verificationPendingPage/);
  // already verified returns pending, not "Already verified"
  assert.match(block, /if \(Number\(acct\.email_verified\)===1\) return c\.html\(verificationPendingPage/);
  // no enumeration strings
  assert.doesNotMatch(block, /404/);
  assert.doesNotMatch(block, /Already verified/);
  assert.match(block, /verificationPendingPage\(email, true\)/);
  // rate-limited via checkSignupRateLimit with ip + email
  assert.match(block, /checkSignupRateLimit\(c, ipResend, email\)/);
  assert.match(block, /429/);
});

test("GET /verify-email is rate-limited on verify: ip key and is atomic", () => {
  const block = source.slice(source.indexOf('app.get("/verify-email"'), source.indexOf('app.get("/verify-email"') + 3000);
  assert.match(block, /verify:\$\{getClientIp/);
  assert.match(block, /checkSignupRateLimit\(c, ipVerify, ipVerify\)/);
  assert.match(block, /429/);
  // atomic batch: UPDATE accounts + DELETE verification
  assert.match(block, /DB\.batch\(\[/);
  assert.match(block, /UPDATE accounts SET email_verified=1/);
  assert.match(block, /DELETE FROM account_email_verifications WHERE account_id=\?/);
  // token hashing
  assert.match(block, /sha256hex\(token\)/);
});

test("verificationPendingPage does not leak whether email exists", () => {
  // The page is same shell for all cases — check shell not condition on found
  assert.match(source, /function verificationPendingPage\(email: string/);
  assert.match(source, /We sent a verification link to/);
  assert.match(source, /expires in 24 hours/);
  // resend flag just adds green note, not different status
  assert.match(source, /New link sent — check your inbox/);
});
