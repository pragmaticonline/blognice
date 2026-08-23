import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const index = fs.readFileSync("src/index.ts", "utf8");

test("Bruv P1: /verify-pending redirects verified users to /admin (cross-tab handoff)", () => {
  const block = index.slice(index.indexOf('app.get("/verify-pending"'), index.indexOf('app.get("/verify-pending"') + 500);
  assert.match(block, /currentAccount/);
  assert.match(block, /isEmailVerified\(acct\)/);
  assert.match(block, /emailEnabled\(c\.env\)/);
  assert.match(block, /return c\.redirect\("\/admin"\)/);
  assert.match(block, /verificationPendingPage\(email\)/);
});

test("Bruv P1: /verify-email is atomic DB.batch and rate-limited (cross-tab same token)", () => {
  const block = index.slice(index.indexOf('app.get("/verify-email"'), index.indexOf('app.get("/verify-email"') + 3000);
  assert.match(block, /DB\.batch\(\[/);
  assert.match(block, /UPDATE accounts SET email_verified=1/);
  assert.match(block, /DELETE FROM account_email_verifications WHERE account_id=\?/);
  assert.match(block, /verify:\$\{getClientIp/);
  assert.match(block, /checkSignupRateLimit\(c, ipVerify, ipVerify\)/);
});

test("Bruv P1: verification flow uses sha256 token hash and sends welcome email", () => {
  const block = index.slice(index.indexOf('app.get("/verify-email"'), index.indexOf('app.get("/verify-email"') + 3500);
  assert.match(block, /sha256hex\(token\)/);
  assert.match(block, /registrationWelcomeEmail/);
  assert.match(block, /verificationResultPage\(true\)/);
});
