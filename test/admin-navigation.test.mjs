import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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

test("post actions use labeled edit, view, and delete icons", () => {
  assert.match(admin, /aria-label="Edit \$\{esc\(p\.title\)\}"/);
  assert.match(admin, /aria-label="View \$\{esc\(p\.title\)\}"/);
  assert.match(admin, /aria-label="Delete \$\{esc\(p\.title\)\}"/);
  assert.match(admin, /publicHost/);
});
