import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const admin = readFileSync(new URL("../src/admin.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("admin navigation keeps global and current-blog contexts visible", () => {
  assert.match(admin, /class="topbar globalbar"/);
  assert.match(admin, /class="contextbar"/);
  assert.match(admin, /id="blog-switcher-toggle"/);
  assert.match(admin, /\/admin\/blogs\.json/);
  assert.match(indexSource, /app\.get\("\/admin\/blogs\.json"/);
  assert.match(admin, /Current blog/);
  assert.match(admin, /opaque.*public_id/s);
  assert.match(admin, /aria-label="Blog navigation"/);
  assert.match(admin, /class="breadcrumb"/);
});

test("post actions use labeled edit, view, and delete icons", () => {
  assert.match(admin, /aria-label="Edit \$\{esc\(p\.title\)\}"/);
  assert.match(admin, /aria-label="View \$\{esc\(p\.title\)\}"/);
  assert.match(admin, /aria-label="Delete \$\{esc\(p\.title\)\}"/);
  assert.match(admin, /publicHost/);
});
