import assert from "node:assert/strict";
import { test } from "node:test";
import { hashPassword, verifyPassword } from "../src/auth.ts";

test("password hashing uses the supported scrypt profile and verifies successfully", async () => {
  const password = "a-long-test-password-123!";
  const hash = await hashPassword(password);

  assert.match(hash, /^scrypt\$32768\$8\$3\$/);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword("wrong-password", hash), false);
});
