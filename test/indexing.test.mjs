import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const production = readFileSync(new URL("../wrangler.production.jsonc", import.meta.url), "utf8");

test("custom domains redirect platform URLs and preserve the requested path", () => {
  assert.match(source, /customDomainRedirect/);
  assert.match(source, /request\.protocol = "https:"/);
  assert.match(source, /request\.host = custom/);
  assert.match(source, /Response\.redirect\(request\.toString\(\), 301\)/);
});

test("www exposes a central sitemap index and robots points to it", () => {
  assert.match(source, /app\.get\("\/sitemap-index\.xml"/);
  assert.match(source, /sitemap-index\.xml/);
  assert.match(source, /custom_domain IS NULL/);
});

test("published changes queue IndexNow notifications without blocking saves", () => {
  assert.match(source, /INDEXNOW_QUEUE/);
  assert.match(source, /api\.indexnow\.org\/indexnow/);
  assert.match(source, /keyLocation/);
  assert.match(source, /queueIndexNow/);
  assert.match(production, /blognice-indexnow/);
});
