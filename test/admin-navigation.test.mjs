import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { shell } from "../src/admin.ts";

const admin = readFileSync(new URL("../src/admin.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("admin navigation keeps global and current-blog contexts visible", () => {
  assert.match(admin, /class="topbar globalbar owner-topbar"/);
  assert.match(admin, /class="contextbar owner-toolbar"/);
  assert.match(admin, /id="blog-switcher-toggle"/);
  assert.match(admin, /\/admin\/blogs\.json/);
  assert.match(indexSource, /app\.get\("\/admin\/blogs\.json"/);
  assert.match(admin, /Current blog/);
  assert.match(admin, /--admin-measure: 76\.25rem/);
  assert.match(admin, /scrollbar-gutter: stable/);
  assert.match(admin, /\.page \{ width: min\(var\(--admin-measure\), calc\(100% - 2 \* var\(--admin-gutter\)\)\)/);
  assert.match(admin, /\.owner-topbar-inner, \.owner-toolbar-inner \{ width: min\(var\(--admin-measure\), calc\(100% - 2 \* var\(--admin-gutter\)\)\)/);
  assert.match(admin, /opaque.*public_id/s);
  assert.match(admin, /aria-label="Blog navigation"/);
  assert.match(admin, /owner-drawer/);
  assert.match(admin, /owner-drawer[^>]*inert/);
  assert.match(admin, /removeAttribute\("inert"\)/);
  assert.match(admin, /event\.key !== "Tab"/);
  assert.match(admin, /event\.shiftKey/);
  assert.match(admin, /owner-menu-open/);
  assert.match(admin, /class="breadcrumb"/);
  assert.match(admin, /plan-badge/);
  assert.match(admin, />Pro<|Pro/);
  assert.match(admin, />Free<|Free/);
  assert.match(admin, /eventually consistent/);
});

test("every authenticated admin page shares one compact topbar", () => {
  const account = {
    email: "owner@example.com",
    billing_status: "inactive",
    crypto_paid_through: 0,
    vip_granted_at: null,
    vip_expires_at: null,
  };
  const tenant = { public_id: "b_test", title: "Test blog", accent_color: "#146b54" };
  const blogHtml = shell("Posts", "<div></div>", account, tenant);
  const listHtml = shell("Blogs", "<div></div>", account);
  for (const html of [blogHtml, listHtml]) {
    assert.match(html, /class="topbar globalbar owner-topbar"/);
    assert.match(html, /\/admin\/billing/);
    assert.match(html, /\/admin\/affiliate/);
    assert.match(html, /owner-drawer/);
    assert.match(html, /class="[^"]*theme-toggle[^"]*"/);
  }
  // The old full-width account bar and its dropdown menu are gone.
  assert.doesNotMatch(listHtml, /id="topbar-menu-open"/);
  assert.doesNotMatch(listHtml, /id="topbar-menu"/);
  assert.doesNotMatch(listHtml, /class="topbar"/);
});

test("post actions use labeled edit, view, and delete icons", () => {
  assert.match(admin, /aria-label="Edit \$\{esc\(p\.title\)\}"/);
  assert.match(admin, /aria-label="View \$\{esc\(p\.title\)\}"/);
  assert.match(admin, /aria-label="Delete \$\{esc\(p\.title\)\}"/);
  assert.match(admin, /publicHost/);
});
