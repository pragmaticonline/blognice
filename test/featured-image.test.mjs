import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const renderSource = readFileSync(new URL("../src/render.ts", import.meta.url), "utf8");
const adminSource = readFileSync(new URL("../src/admin.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("featured images render in the public feed and post page", () => {
  assert.match(renderSource, /class="blog-art"/);
  assert.match(renderSource, /featured_image_key/);
  assert.match(renderSource, /class="featured-image"/);
});

test("drop caps are limited to substantial opening paragraphs", () => {
  assert.match(renderSource, /openingParagraphHasDropCap/);
  assert.match(renderSource, /length >= 20/);
  assert.match(renderSource, /prose lead-dropcap/);
  assert.match(renderSource, /\.prose\.lead-dropcap > p:first-of-type::first-letter \{[^}]*color: var\(--accent\);/s);
});

test("editor saves a featured image key and supports choosing or removing it", () => {
  assert.match(adminSource, /name="featured_image_key"/);
  assert.match(adminSource, /id="choose-featured"/);
  assert.match(adminSource, /id="remove-featured"/);
  assert.match(adminSource, /id="featured-preview-trigger"/);
  assert.match(adminSource, /id="featured-lightbox"/);
  assert.match(adminSource, /setFeatured\(data\.key, data\.url\)/);
});

test("post writes persist the featured image and validate it against R2", () => {
  assert.match(indexSource, /checkedFeaturedImage/);
  assert.match(indexSource, /env\.MEDIA\.head\(key\)/);
  assert.match(indexSource, /INSERT INTO posts \(tenant_id, slug, title, featured_image_key/);
  assert.match(indexSource, /UPDATE posts SET slug = \?, title = \?, featured_image_key = \?/);
});
