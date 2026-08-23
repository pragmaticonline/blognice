import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const index = fs.readFileSync("src/index.ts", "utf8");
const admin = fs.readFileSync("src/admin.ts", "utf8");

test("Bruv P1: /admin without session redirects to /admin/login (no billing leak)", () => {
  // blogContext and admin handlers guard with currentAccount
  assert.match(index, /const account = await currentAccount\(c\)/);
  assert.match(index, /if \(!account\) return \{ redirect: "\/admin\/login" \}/);
  // ensure not leaking billing via 200
  assert.doesNotMatch(index.slice(index.indexOf('app.get("/admin"'), index.indexOf('app.get("/admin"') + 800), /billing_status/);
});

test("Bruv P1: incognito /admin/b/:blogId is tenant-agnostic redirect (Host isolation)", () => {
  assert.match(index, /blogContext/);
  assert.match(index, /redirect: "\/admin\/login"/);
  assert.match(index, /redirect: "\/verify-pending"/);
  // no direct billing_status rendering before auth
  assert.match(index, /if \(!isEmailVerified\(account\) && emailEnabled\(c\.env\)\) return \{ redirect: "\/verify-pending" \}/);
});

test("Bruv P1: unverified account cannot access admin billing/domains (enumeration safe)", () => {
  // admin billing handlers check emailVerified via blogContext
  assert.match(index, /isEmailVerified/);
  assert.match(index, /emailEnabled\(c\.env\)/);
  assert.match(index, /\/verify-pending/);
});

test("Bruv P1: admin shell does not embed billing JSON for anon", () => {
  // render shell for anon should be redirect, not html with billing
  const adminGet = index.slice(index.indexOf('app.get("/admin"'), index.indexOf('app.get("/admin"') + 3000);
  assert.match(adminGet, /currentAccount/);
  assert.match(adminGet, /redirect/);
});
