import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeBlogTheme, renderPost } from "../src/render.ts";

const source = readFileSync(new URL("../src/render.ts", import.meta.url), "utf8");

test("blog homepage inherits the global light/dark theme variables", () => {
  const homepage = source.match(/\.homepage-wrap\s*\{([\s\S]*?)\n\s*\}/)?.[1] || "";
  assert.doesNotMatch(homepage, /--bg\s*:/);
  assert.doesNotMatch(homepage, /background:\s*var\(--bg\)/);
  assert.match(source, /html\[data-theme="dark"\]/);
});

test("public pages provide a scroll-to-top control after scrolling", () => {
  assert.match(source, /id="to-top"/);
  assert.match(source, /scrollY\/max>\.35/);
  assert.match(source, /scrollTo\(\{top:0,behavior:"smooth"\}\)/);
});

test("blog theme normalizes to modern or blogspot", () => {
  assert.equal(normalizeBlogTheme("blogspot"), "blogspot");
  assert.equal(normalizeBlogTheme(" Blogspot "), "blogspot");
  assert.equal(normalizeBlogTheme("classic"), "blogspot");
  assert.equal(normalizeBlogTheme("modern"), "modern");
  assert.equal(normalizeBlogTheme("minima"), "modern");
  assert.equal(normalizeBlogTheme(null), "modern");
  assert.equal(normalizeBlogTheme(undefined), "modern");
});

test("blogspot theme only restyles blogspot blogs", () => {
  const tenant = { id: 1, public_id: "t", slug: "s", custom_domain: null, title: "T", description: "", avatar_key: null, favicon_key: null, accent_color: null, topics_json: "[]", shard: "primary", created_at: 1, deleted_at: null };
  const post = { id: 1, tenant_id: 1, slug: "hello", title: "Hello", featured_image_key: null, audio_key: null, body_md: "Hi.", tags_json: "[]", published: 1, created_at: 1, updated_at: 1 };
  const modern = renderPost(tenant, post, "<p>Hi.</p>", "https://s.blognice.test", "https://www.blognice.test");
  assert.doesNotMatch(modern, /data-blog-theme="blogspot"/);
  assert.doesNotMatch(modern, /--panel:/);
  const blogspot = renderPost({ ...tenant, theme: "blogspot" }, post, "<p>Hi.</p>", "https://s.blognice.test", "https://www.blognice.test");
  assert.match(blogspot, /<body data-blog-theme="blogspot">/);
  assert.match(blogspot, /--panel:/);
  assert.match(blogspot, /Trebuchet MS/);
  const legacy = renderPost({ ...tenant, theme: "classic" }, post, "<p>Hi.</p>", "https://s.blognice.test", "https://www.blognice.test");
  assert.match(legacy, /<body data-blog-theme="blogspot">/);
});

test("blogspot overrides stay scoped under the theme attribute", () => {
  const block = source.match(/export const BLOGSPOT_STYLES = \/\* css \*\/ `([\s\S]*?)`;/)[1];
  assert.match(block, /html\[data-theme="dark"\] body\[data-blog-theme="blogspot"\]/);
  const withoutMedia = block.replace(/@media[^{]*\{[\s\S]*?\n  \}\n/, "");
  for (const rule of withoutMedia.split("}")) {
    const selector = rule.split("{")[0].trim();
    if (!selector) continue;
    for (const part of selector.split(",")) {
      const scoped = part.trim().replace(/^html\[data-theme="dark"\] /, "");
      assert.ok(scoped.startsWith('body[data-blog-theme="blogspot"]'), `unscoped blogspot rule: ${part.trim()}`);
    }
  }
});
