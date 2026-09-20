import assert from "node:assert/strict";
import test from "node:test";
import { shell } from "../src/admin.ts";

const account = {
  email: "owner@example.com",
  billing_status: "inactive",
  crypto_paid_through: 0,
  vip_granted_at: null,
  vip_expires_at: null,
};
const tenant = { public_id: "b_test", title: "Test blog", accent_color: "#146b54" };

test("admin shell applies a stored day/night preference before first paint", () => {
  const html = shell("Posts", "<div></div>", account, tenant);
  assert.match(html, /localStorage\.getItem\("blognice-admin-theme"\)/);
  assert.match(html, /documentElement.*data-theme/);
  // Explicit choice must beat the OS media query in both directions.
  assert.match(html, /:root\[data-theme="dark"\]/);
  assert.match(html, /:root\[data-theme="light"\]/);
  // The choice is persisted when toggled.
  assert.match(html, /var KEY="blognice-admin-theme"/);
  assert.match(html, /localStorage\.setItem\(KEY/);
});

test("admin shell exposes a day/night toggle in the blog and account topbars", () => {
  const blogBar = shell("Posts", "<div></div>", account, tenant);
  assert.match(blogBar, /class="[^"]*theme-toggle[^"]*"/);
  assert.match(blogBar, /aria-label="Switch to (dark|light) mode"/);
  const accountBar = shell("Blogs", "<div></div>", account);
  assert.match(accountBar, /class="[^"]*theme-toggle[^"]*"/);
});
