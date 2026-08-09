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
  assert.match(homepage, /footer-inner/);
  assert.match(homepage, /href="\/privacy"/);
  assert.match(homepage, /Create your blog/);
});

test("marketing homepage provides a central login button", () => {
  assert.match(homepage, /href="https:\/\/www\.blognice\.com\/admin\/login"[^>]*>Log in<\/a>/);
});

test("marketing homepage showcases AI images and an opt-in voice sample", () => {
  assert.match(homepage, /id="ai"/);
  assert.match(homepage, /\/marketing-ai\/writing\.webp/);
  assert.match(homepage, /id="ai-voice-sample"/);
  assert.match(homepage, /fetch\('\/marketing-audio'/);
  assert.doesNotMatch(homepage, /speechSynthesis/);
  assert.match(indexSource, /generateSpeechWithRecovery\(c\.env\.AI/);
  assert.match(indexSource, /TTS_MODEL/);
  assert.match(indexSource, /app\.get\("\/marketing-ai\/:file"/);
  assert.match(indexSource, /app\.get\("\/marketing-audio"/);
  assert.match(indexSource, /marketing\/ai-voice\.wav/);
  assert.match(indexSource, /audio\/wav/);
  assert.match(indexSource, /marketing_audio_state/);
  assert.match(indexSource, /INSERT OR IGNORE INTO marketing_audio_state/);
});

test("marketing homepage real example uses generic blogger imagery and address", () => {
  assert.match(homepage, /src="\/marketing-ai\/blogger\.webp"/);
  assert.match(homepage, /alt="A blogger writing at a laptop"/);
  assert.match(homepage, /blognice\.blognice\.com\/blog-nice-vs-wordpress/);
  assert.match(indexSource, /MEDIA\.get\(`marketing\/\$\{file\}`\)/);
  assert.doesNotMatch(indexSource, /import marketingWriting/);
});

test("www is routed to the dedicated landing page before tenant resolution", () => {
  assert.match(indexSource, /host === `www\.\$\{c\.env\.ROOT_DOMAIN\.toLowerCase\(\)\}`/);
  assert.match(indexSource, /new Response\(homepage/);
  assert.match(indexSource, /cache-control.*s-maxage=0/);
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

test("tag pages use the same homepage shell and card layout", () => {
  assert.match(indexSource, /app\.get\("\/tag\/:tag"/);
  assert.match(indexSource, /renderTagPage\(tenant, tag, posts/);
  assert.match(renderSource, /export function renderTagPage/);
  assert.match(renderSource, /class="blog-nav"/);
  assert.match(renderSource, /class="tag-page-title"/);
  assert.match(renderSource, /class="blog-cards"/);
});
