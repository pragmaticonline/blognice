import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const renderSource = readFileSync(new URL("../src/render.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("public posts keep the owner edit control hidden until authorization succeeds", () => {
  assert.match(renderSource, /data-owner-edit hidden/);
  assert.match(renderSource, /_blognice\/edit-link\?tenant=/);
  assert.match(renderSource, /credentials:"include"/);
  assert.match(renderSource, /link\.hidden=false/);
  assert.match(renderSource, /aria-label="Edit post"/);
  assert.match(renderSource, /class="owner-edit"/);
});

test("edit-link lookup is uncached and verifies blog membership and post ownership", () => {
  assert.match(indexSource, /app\.get\("\/_blognice\/edit-link"/);
  assert.match(indexSource, /"cache-control": "private, no-store"/);
  assert.match(indexSource, /SELECT 1 FROM memberships WHERE tenant_id = \? AND account_id = \?/);
  assert.match(indexSource, /SELECT id FROM posts WHERE id = \? AND tenant_id = \?/);
  assert.match(indexSource, /url: `\$\{adminOriginOf\(c\)\}\/admin\/b/);
});

test("central login fallback permits credentials only from the blog's own host", () => {
  assert.match(indexSource, /`\$\{u\.protocol\}\/\/www\.\$\{c\.env\.ROOT_DOMAIN\}`/);
  assert.match(indexSource, /originHost !== platformHost && originHost !== customHost && !managedDomain/);
  assert.match(indexSource, /"access-control-allow-origin"/);
  assert.match(indexSource, /"access-control-allow-credentials"/);
  assert.doesNotMatch(indexSource, /headers\["access-control-allow-origin"\] = "\*"/);
});

test("admin traffic is redirected to the canonical host with a method-preserving status", () => {
  assert.match(indexSource, /app\.use\("\*", async \(c, next\) =>/);
  assert.match(indexSource, /url\.pathname === "\/admin" \|\| url\.pathname\.startsWith\("\/admin\/"\)/);
  assert.match(indexSource, /return c\.redirect\(url\.toString\(\), 308\)/);
});
