import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const renderSource = readFileSync(new URL("../src/render.ts", import.meta.url), "utf8");
const homepage = readFileSync(new URL("../homepage.html", import.meta.url), "utf8");

test("www homepage asset is complete and contains the supplied landing page", () => {
  assert.match(homepage, /<!DOCTYPE html>/i);
  assert.match(homepage, /A nicer way to blog/);
  assert.match(homepage, /<\/html>/i);
});

test("www is routed to the dedicated landing page before tenant resolution", () => {
  assert.match(indexSource, /host === `www\.\$\{c\.env\.ROOT_DOMAIN\.toLowerCase\(\)\}`/);
  assert.match(indexSource, /new Response\(homepage/);
  assert.match(indexSource, /cache-control.*s-maxage=3600/);
});

test("tenant homepages use the mockup navigation without the legacy masthead", () => {
  assert.match(renderSource, /showMasthead: false/);
});

test("tenant homepages advertise an RSS feed and expose published posts as RSS", () => {
  assert.match(renderSource, /application\/rss\+xml/);
  assert.match(renderSource, /rss-global/);
  assert.match(indexSource, /app\.get\(\"\/rss\.xml\"/);
  assert.match(indexSource, /<rss version=\"2\.0\">/);
  assert.match(indexSource, /published = 1/);
});
