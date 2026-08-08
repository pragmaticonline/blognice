import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { hashPassword, verifyPassword } from "../src/auth.ts";
import { verifyPlatformBearer } from "../src/platform-auth.ts";

test("new password hashes use the supported OWASP scrypt parameters", async () => {
  const stored = await hashPassword("correct horse battery staple");
  assert.match(stored, /^scrypt\$32768\$8\$3\$/);
  assert.equal(await verifyPassword("correct horse battery staple", stored), true);
  assert.equal(await verifyPassword("wrong password", stored), false);
});

test("forced-reset and unsupported PBKDF2 hashes fail closed", async () => {
  assert.equal(await verifyPassword("anything", "reset_required"), false);
  assert.equal(await verifyPassword("anything", "pbkdf2$600000$bad$bad"), false);
});

test("platform bearer authentication fails closed when the secret is missing or weak", () => {
  const secret = "a".repeat(40);
  assert.equal(verifyPlatformBearer(undefined, undefined), false);
  assert.equal(verifyPlatformBearer("Bearer undefined", undefined), false);
  assert.equal(verifyPlatformBearer("Bearer weak", "weak"), false);
  assert.equal(verifyPlatformBearer("Basic " + secret, secret), false);
  assert.equal(verifyPlatformBearer("Bearer wrong", secret), false);
  assert.equal(verifyPlatformBearer(`Bearer ${secret}`, secret), true);
});
