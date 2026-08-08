import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildSitemapIndexXml, cacheVariants, customDomainRedirectUrl, indexNowKey, CACHE_VERSION } from "../src/indexing.ts";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const production = readFileSync(new URL("../wrangler.production.jsonc", import.meta.url), "utf8");

test("custom domains redirect platform URLs and preserve the requested path", () => {
  assert.match(source, /Response\.redirect\(location, 308\)/);
  assert.equal(
    customDomainRedirectUrl(
      "https://ray.blognice.com/hello?from=home",
      { slug: "ray", custom_domain: "blog.example.com" },
      "blognice.com",
    ),
    "https://blog.example.com/hello?from=home",
  );
});

test("custom-domain redirect behavior is method-preserving and loop-free", () => {
  assert.equal(customDomainRedirectUrl("https://ray.blognice.com/hello?from=home", { slug: "ray", custom_domain: "blog.example.com" }, "blognice.com"), "https://blog.example.com/hello?from=home");
  assert.equal(customDomainRedirectUrl("https://blog.example.com/hello?from=home", { slug: "ray", custom_domain: "blog.example.com" }, "blognice.com"), null);
});

test("www exposes a central sitemap index and robots points to it", () => {
  assert.match(source, /app\.get\("\/sitemap-index\.xml"/);
  assert.match(source, /sitemap-index\.xml/);
  assert.match(source, /custom_domain IS NULL/);
});

test("sitemap index output escapes hosts and cache purge variants match the reader key", async () => {
  const xml = buildSitemapIndexXml(["ray", "science&arts"], "blognice.com");
  assert.match(xml, /https:\/\/ray\.blognice\.com\/sitemap\.xml/);
  assert.match(xml, /science&amp;arts/);
  assert.deepEqual(cacheVariants("https://www.blognice.com/sitemap-index.xml"), [
    "https://www.blognice.com/sitemap-index.xml",
    `https://www.blognice.com/sitemap-index.xml?_bn_shell=${CACHE_VERSION}`,
  ]);
  const key = await indexNowKey("secret", "Ray.BlogNice.com");
  assert.match(key, /^[0-9a-f]{64}$/);
});

test("published changes queue IndexNow notifications without blocking saves", () => {
  assert.match(source, /INDEXNOW_QUEUE/);
  assert.match(source, /api\.indexnow\.org\/indexnow/);
  assert.match(source, /keyLocation/);
  assert.match(source, /queueIndexNow/);
  assert.match(source, /SELECT slug, published, audio_key FROM posts/);
  assert.match(source, /\.\.\.\(previousSlug \? \["\/" \+ previousSlug\] : \[\]\)/);
  assert.match(production, /blognice-indexnow/);
});

test("the authenticated API can re-queue IndexNow only for published content", () => {
  assert.match(source, /app\.post\("\/api\/v1\/blogs\/:blogId\/indexnow"/);
  assert.match(source, /post_ids/);
  assert.match(source, /paths must refer to published posts/);
  assert.match(source, /published = 1 AND id IN/);
  assert.match(source, /INDEXNOW_QUEUE\.send\(\{ kind: "indexnow", urls \}\)/);
});
