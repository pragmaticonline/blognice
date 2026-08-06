import assert from "node:assert/strict";
import test from "node:test";

import { hashPassword, verifyPassword } from "../src/auth.ts";

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
