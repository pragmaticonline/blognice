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

test("marketing homepage clearly distinguishes founding and planned standard pricing", () => {
  assert.match(homepage, /Founding member pricing/);
  assert.match(homepage, /\$36\/year or \$5\/month/);
  assert.match(homepage, /Planned standard pricing:<\/strong> \$119\/year or \$9\.99\/month/);
  assert.equal((homepage.match(/Founding member price/g) || []).length, 2);
  assert.doesNotMatch(homepage, /Founding rates available now/);
});

test("marketing homepage protects narrow mobile layout and anchor targets", () => {
  assert.match(homepage, /scroll-padding-top:74px/);
  assert.match(homepage, /@media \(max-width: 560px\)[\s\S]*?scroll-padding-top:64px/);
  assert.match(homepage, /class="nav-actions"/);
  assert.match(homepage, /class="nav-cta-short">Start<\/span>/);
  assert.match(homepage, /grid-template-columns:minmax\(0,1fr\) 20px/);
  assert.match(homepage, /bottom:max\(16px, env\(safe-area-inset-bottom\)\)/);
  assert.match(homepage, /\.footer-actions a\{min-height:44px;justify-content:center;\}/);
});

test("marketing homepage FAQ exposes accessible expansion state", () => {
  assert.equal((homepage.match(/aria-expanded="false"/g) || []).length, 5);
  assert.equal((homepage.match(/aria-controls="faq-a-[1-5]"/g) || []).length, 5);
  assert.equal((homepage.match(/<div class="faq-a" id="faq-a-[1-5]" hidden>/g) || []).length, 5);
  assert.match(homepage, /setAttribute\('aria-expanded', 'true'\)/);
  assert.match(homepage, /ans\.hidden = false/);
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
  assert.match(renderSource, /blog-featured-section/);
  assert.match(renderSource, /blog-topics-bottom/);
  assert.ok(renderSource.indexOf("blog-featured-section") < renderSource.indexOf("blog-topics-bottom"));
});

test("tenant homepages paginate posts beyond the first six", () => {
  assert.match(indexSource, /c\.req\.query\("page"\)/);
  assert.match(indexSource, /LIMIT \? OFFSET \?/);
  assert.match(indexSource, /hasMorePosts/);
      assert.match(renderSource, /blog-pagination/);
      assert.match(renderSource, /See all <span aria-hidden="true">→<\/span>/);
      assert.match(renderSource, /pageNumber \+ 1/);
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
test("evergreen pages have a dedicated public route and admin lifecycle", () => {
  assert.match(indexSource, /app\.get\("\/pages\/:slug"/);
  assert.match(indexSource, /SELECT \* FROM pages WHERE tenant_id = \? AND slug = \?/);
  assert.match(indexSource, /app\.get\("\/admin\/b\/:blogId\/pages"/);
  assert.match(indexSource, /app\.post\("\/admin\/b\/:blogId\/pages\/save"/);
  assert.match(renderSource, /export function renderPage/);
  assert.match(renderSource, /<a href=\"\/\">Home<\/a>/);
  assert.match(indexSource, /pageListPage\(/);
});
