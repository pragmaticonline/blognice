import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const render = readFileSync(new URL("../src/render.ts", import.meta.url), "utf8");
const homepage = readFileSync(new URL("../homepage.html", import.meta.url), "utf8");

test("public blog shell emits complete social metadata", () => {
  assert.match(render, /property=\"og:site_name\"/);
  assert.match(render, /property=\"og:image\"/);
  assert.match(render, /name=\"twitter:title\"/);
  assert.match(render, /name=\"twitter:description\"/);
  assert.match(render, /twitter:card.*summary_large_image/);
  assert.match(render, /article:published_time/);
  assert.match(render, /article:modified_time/);
  assert.match(render, /site-footer/);
  assert.match(render, /site-footer\$\{wide \? " homepage-footer" : ""\}/);
  assert.match(render, /footer\.site-footer\.homepage-footer \{ max-width: 82\.5rem; \}/);
  assert.match(render, /tenant\.footer_name\?\.trim\(\) \|\| tenant\.title/);
  assert.match(render, /site-footer-inner/);
  assert.match(render, /href="\/rss\.xml">RSS/);
  assert.match(render, /Blognice policies/);
  assert.doesNotMatch(render, /Analytics preferences/);
  assert.match(render, /Powered by <a href="https:\/\/www\.blognice\.com" target="_blank"/);
  assert.doesNotMatch(render, /Pragmatic Online Co\., Ltd\.<\/span>/);
});

test("post sharing includes an accessible Reddit link with the title and URL", () => {
  assert.match(render, /share-reddit/);
  assert.match(render, /www\.reddit\.com\/submit\?url=/);
  assert.match(render, /data-tooltip="Reddit"/);
  assert.match(render, /aria-label="Share on Reddit"/);
});

test("post pages place a home control on the left", () => {
  assert.match(render, /class="post-home" href="\/"/);
  assert.match(render, /Back to all posts/);
  assert.match(render, /\.post-home svg/);
});

test("marketing homepage has canonical and social metadata", () => {
  assert.match(homepage, /<meta name="description"/);
  assert.match(homepage, /<link rel="canonical" href="https:\/\/www\.blognice\.com\/"/);
  assert.match(homepage, /property="og:image"/);
  assert.match(homepage, /name="twitter:card" content="summary_large_image"/);
});
