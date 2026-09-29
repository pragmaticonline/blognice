import test from "node:test";
import assert from "node:assert/strict";
import fs, { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Miniflare } from "miniflare";
import {
  MAX_PROMO_BODY_LENGTH,
  MAX_PROMO_CTA_TEXT_LENGTH,
  normalizePromoBody,
  normalizePromoCtaText,
  normalizePromoImage,
  normalizePromoPlacement,
  PROMO_STYLES,
  promoContentId,
  promoForPage,
  promoImageSrc,
  promoModal,
  renderHome,
  renderPost,
} from "../src/render.ts";

const require = createRequire(import.meta.url);
for (const extension of [".html", ".svg"]) {
  require.extensions[extension] = (module, filename) => {
    module.exports = readFileSync(filename, "utf8");
  };
}

globalThis.caches = { default: { delete: async () => true, match: async () => undefined, put: async () => {} } };

const { blogniceApp } = await import("../src/index.ts");

function execSql(db, sql) {
  const cleaned = sql.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "");
  const stmts = cleaned.split(/;\s*(?=\r?\n|$)/).map(s => s.trim()).filter(Boolean);
  return Promise.all(stmts.map(s => db.prepare(s).run()));
}

const OWNER_KEY = "bnk_testpromoownerkey1234567890ab";
const apiHash = (key) => createHash("sha256").update(key).digest("hex");
const ORIGIN = "https://www.blognice.test";

async function setup() {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: ["DB", "POSTS"],
    r2Buckets: ["MEDIA"],
  });
  const db = await mf.getD1Database("DB");
  const postsDb = await mf.getD1Database("POSTS");
  const media = await mf.getR2Bucket("MEDIA");
  await execSql(db, fs.readFileSync("schema.sql", "utf8"));
  await execSql(postsDb, fs.readFileSync("schema-posts.sql", "utf8"));
  const now = Math.floor(Date.now() / 1000);
  await db.prepare("INSERT INTO accounts (id,email,pw_hash,billing_status,api_key_hash,created_at) VALUES (1,'owner@x.com','h','active',?,?)").bind(apiHash(OWNER_KEY), now).run();
  await db.prepare("INSERT INTO accounts (id,email,pw_hash,created_at) VALUES (2,'free@x.com','h',?)").bind(now).run();
  await db.prepare("INSERT INTO tenants (id,public_id,slug,title,description,footer_name,accent_color,topics_json,social_links_json,navigation_links_json,browser_push_enabled,header_link_url,created_at) VALUES (1,'promoblog1','promoblog','Promo Blog','tag','','#1a8917','[]','{}','[]',1,'/',?)").bind(now).run();
  await db.prepare("INSERT INTO tenants (id,public_id,slug,title,description,footer_name,accent_color,topics_json,social_links_json,navigation_links_json,browser_push_enabled,header_link_url,created_at) VALUES (2,'freeblog1','freeblog','Free Blog','tag','','#1a8917','[]','{}','[]',1,'/',?)").bind(now).run();
  await db.prepare("INSERT INTO memberships (account_id,tenant_id,role,created_at) VALUES (1,1,'owner',?)").bind(now).run();
  await db.prepare("INSERT INTO memberships (account_id,tenant_id,role,created_at) VALUES (2,2,'owner',?)").bind(now).run();
  await db.prepare("INSERT INTO sessions (token,account_id,created_at,expires_at) VALUES ('sess',1,?,?)").bind(now, now + 86400).run();
  await db.prepare("INSERT INTO sessions (token,account_id,created_at,expires_at) VALUES ('sess-free',2,?,?)").bind(now, now + 86400).run();
  await postsDb.prepare("INSERT INTO posts (id, tenant_id, slug, title, body_md, published, created_at, updated_at) VALUES (1, 1, 'hello', 'Hello', 'Hi.', 1, ?, ?)").bind(now, now).run();
  const env = { DB: db, POSTS: postsDb, MEDIA: media, ROOT_DOMAIN: "blognice.test", EVENTS: { writeDataPoint() {} } };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  return { mf, db, env, ctx };
}

const tenant = { id: 1, public_id: "t", slug: "s", custom_domain: null, title: "T", description: "", avatar_key: null, favicon_key: null, accent_color: null, topics_json: "[]", shard: "primary", created_at: 1, deleted_at: null };
const promoTenant = {
  ...tenant,
  promo_enabled: 1,
  promo_placement: "all",
  promo_image: "https://cdn.example.com/book.jpg",
  promo_body_md: "## My new book is out\n\nTwo years of essays.",
  promo_cta_text: "Buy the book",
  promo_cta_url: "https://shop.example.com/book",
};
const post = { id: 1, tenant_id: 1, slug: "hello", title: "Hello", featured_image_key: null, audio_key: null, body_md: "Hi.", tags_json: "[]", published: 1, created_at: 1, updated_at: 1 };

test("promo placement normalizes to home or all", () => {
  assert.equal(normalizePromoPlacement("all"), "all");
  assert.equal(normalizePromoPlacement(" All "), "all");
  assert.equal(normalizePromoPlacement("home"), "home");
  assert.equal(normalizePromoPlacement("everywhere"), "home");
  assert.equal(normalizePromoPlacement(null), "home");
  assert.equal(normalizePromoPlacement(undefined), "home");
});

test("promo image accepts keys, media URLs, and https URLs", () => {
  assert.deepEqual(normalizePromoImage(""), { image: "" });
  assert.deepEqual(normalizePromoImage("1/cover-ab12.jpg"), { image: "1/cover-ab12.jpg" });
  assert.deepEqual(normalizePromoImage("/media/1/cover.jpg"), { image: "/media/1/cover.jpg" });
  assert.deepEqual(normalizePromoImage("https://cdn.example.com/book.jpg"), { image: "https://cdn.example.com/book.jpg" });
  assert.match(normalizePromoImage("http://cdn.example.com/book.jpg").error || "", /https/);
  assert.match(normalizePromoImage("has space.jpg").error || "", /media key/);
  assert.match(normalizePromoImage("../secret").error || "", /media key/);
  assert.match(normalizePromoImage('x".jpg').error || "", /media key/);
  assert.match(normalizePromoImage("a".repeat(501)).error || "", /500 characters or fewer/);
});

test("promo body and button text enforce lengths", () => {
  assert.equal(MAX_PROMO_BODY_LENGTH, 2000);
  assert.equal(MAX_PROMO_CTA_TEXT_LENGTH, 80);
  assert.deepEqual(normalizePromoBody("hi"), { body: "hi" });
  assert.match(normalizePromoBody("a".repeat(2001)).error || "", /2000 characters or fewer/);
  assert.deepEqual(normalizePromoCtaText("Buy"), { text: "Buy" });
  assert.match(normalizePromoCtaText("a".repeat(81)).error || "", /80 characters or fewer/);
});

test("promo image src resolves keys under /media/", () => {
  assert.equal(promoImageSrc("https://cdn.example.com/b.jpg"), "https://cdn.example.com/b.jpg");
  assert.equal(promoImageSrc("/media/1/b.jpg"), "/media/1/b.jpg");
  assert.equal(promoImageSrc("1/b.jpg"), "/media/1/b.jpg");
});

test("promo content id is stable and changes with content", () => {
  const a = promoContentId("i", "b", "t", "u");
  assert.equal(promoContentId("i", "b", "t", "u"), a);
  assert.notEqual(promoContentId("i", "b!", "t", "u"), a);
  assert.match(a, /^[0-9a-z]+$/);
});

test("promo modal has dialog semantics, dismiss, Markdown, art, and CTA", () => {
  const html = promoModal(promoTenant);
  assert.match(html, /class="promo-backdrop" hidden data-promo data-promo-id="[0-9a-z]+"/);
  assert.match(html, /role="dialog" aria-modal="true"/);
  assert.match(html, /class="promo-close"[^>]*aria-label="Dismiss">×<\/button>/);
  assert.match(html, /<h2[^>]*>My new book is out<\/h2>/);
  assert.match(html, /<p>Two years of essays\.<\/p>/);
  assert.ok(html.indexOf('class="promo-text"') < html.indexOf('class="promo-art"'), "text left, art right");
  assert.match(html, /<img src="https:\/\/cdn\.example\.com\/book\.jpg" alt="" loading="lazy"/);
  assert.match(html, /<a class="promo-cta" href="https:\/\/shop\.example\.com\/book" target="_blank" rel="noopener noreferrer">Buy the book<\/a>/);
  assert.match(html, /localStorage/);
  assert.match(html, /Escape/);
  assert.match(html, /setTimeout\(open,800\)/);
  assert.match(html, /\.promo-art img/);
  assert.match(html, /addEventListener\("error",drop\)/);
});

test("promo modal sanitizes Markdown and degrades gracefully", () => {
  const hostile = promoModal({ ...promoTenant, promo_body_md: "Hi <script>alert(1)</script> [x](javascript:alert(1))" });
  assert.doesNotMatch(hostile, /<script>alert/);
  assert.doesNotMatch(hostile, /javascript:/);
  assert.match(hostile, /<p>Hi  <a>x<\/a><\/p>|<p>Hi/);
  const noArt = promoModal({ ...promoTenant, promo_image: "" });
  assert.match(noArt, /promo-noart/);
  assert.doesNotMatch(noArt, /<div class="promo-art"/);
  const noCta = promoModal({ ...promoTenant, promo_cta_text: "" });
  assert.doesNotMatch(noCta, /promo-cta"/);
  const internal = promoModal({ ...promoTenant, promo_cta_url: "/books" });
  assert.match(internal, /<a class="promo-cta" href="\/books">Buy the book<\/a>/);
  assert.equal(promoModal({ ...tenant }), "");
  assert.equal(promoModal({ ...promoTenant, promo_body_md: "  " }), "");
});

test("promo placement gates home vs every page", () => {
  const home = { ...promoTenant, promo_placement: "home" };
  assert.ok(promoForPage(home, "home").includes("promo-backdrop"));
  assert.equal(promoForPage(home, "page"), "");
  assert.ok(promoForPage(promoTenant, "page").includes("promo-backdrop"));
  assert.ok(promoForPage(promoTenant, "home").includes("promo-backdrop"));
  assert.equal(promoForPage({ ...promoTenant, promo_enabled: 0 }, "home"), "");
  assert.equal(promoForPage(promoTenant, undefined), "");
});

test("promo styles stack art on top for phones and honor reduced motion", () => {
  assert.match(PROMO_STYLES, /@media \(max-width: 640px\)/);
  assert.match(PROMO_STYLES, /\.promo-modal \{ flex-direction: column/);
  assert.match(PROMO_STYLES, /\.promo-art \{ order: -1/);
  assert.match(PROMO_STYLES, /prefers-reduced-motion/);
  assert.match(PROMO_STYLES, /\.promo-backdrop\[hidden\] \{ display: none !important/);
  assert.match(PROMO_STYLES, /z-index: 80/);
});

test("public pages show the promo per placement", () => {
  const homeOnly = { ...promoTenant, promo_placement: "home" };
  const home = renderHome(homeOnly, [], "https://s.blognice.test");
  assert.match(home, /class="promo-backdrop"/);
  assert.match(home, /\.promo-backdrop/);
  const homePost = renderPost(homeOnly, post, "<p>Hi.</p>", "https://s.blognice.test", "https://www.blognice.test");
  assert.doesNotMatch(homePost, /class="promo-backdrop"/);
  assert.doesNotMatch(homePost, /\.promo-backdrop \{/);
  const allPost = renderPost(promoTenant, post, "<p>Hi.</p>", "https://s.blognice.test", "https://www.blognice.test");
  assert.match(allPost, /class="promo-backdrop"/);
  const off = renderHome({ ...tenant }, [], "https://s.blognice.test");
  assert.doesNotMatch(off, /class="promo-backdrop"/);
  assert.doesNotMatch(off, /PROMO_STYLES/);
});

test("settings save persists a promo and it renders on the home page", async () => {
  const { mf, db, env, ctx } = await setup();
  try {
    const params = new URLSearchParams({
      slug: "promoblog", title: "Promo Blog", accent_color: "#1a8917",
      promo_enabled: "1", promo_placement: "home", promo_image: "https://cdn.example.com/book.jpg",
      promo_body_md: "## Book out now", promo_cta_text: "Buy", promo_cta_url: "https://shop.example.com/b",
    });
    const res = await blogniceApp.request(`${ORIGIN}/admin/b/promoblog1/settings`, {
      method: "POST",
      headers: { Origin: ORIGIN, Cookie: "bn_session=sess", "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    }, env, ctx);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Saved\./);
    const row = await db.prepare("SELECT promo_enabled, promo_placement, promo_image, promo_body_md, promo_cta_text, promo_cta_url FROM tenants WHERE id=1").first();
    assert.deepEqual(row, { promo_enabled: 1, promo_placement: "home", promo_image: "https://cdn.example.com/book.jpg", promo_body_md: "## Book out now", promo_cta_text: "Buy", promo_cta_url: "https://shop.example.com/b" });

    const page = await blogniceApp.request("https://promoblog.blognice.test/", {
      headers: { host: "promoblog.blognice.test" },
    }, env, ctx);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Book out now/);

    const settingsHtml = await (await blogniceApp.request(`${ORIGIN}/admin/b/promoblog1/settings`, {
      headers: { Cookie: "bn_session=sess" },
    }, env, ctx)).text();
    assert.match(settingsHtml, /name="promo_enabled" value="1" checked/);
    assert.match(settingsHtml, /name="promo_placement" value="home" checked/);
    assert.match(settingsHtml, /name="promo_body_md"/);
    assert.match(settingsHtml, /id="promo-preview"/);
    assert.match(settingsHtml, /id="promo-choose"/);
    assert.match(settingsHtml, /id="promo-media-dialog"/);
    assert.match(settingsHtml, /id="promo-file-input"/);
    assert.match(settingsHtml, /media\.json/);
    assert.match(settingsHtml, /\/upload/);
  } finally {
    await mf.dispose();
  }
});

test("invalid promo input is rejected with a clear error", async () => {
  const { mf, db, env, ctx } = await setup();
  try {
    const badUrl = new URLSearchParams({ slug: "promoblog", title: "Promo Blog", accent_color: "#1a8917", promo_cta_url: "not-a-url" });
    const res = await blogniceApp.request(`${ORIGIN}/admin/b/promoblog1/settings`, {
      method: "POST",
      headers: { Origin: ORIGIN, Cookie: "bn_session=sess", "Content-Type": "application/x-www-form-urlencoded" },
      body: badUrl.toString(),
    }, env, ctx);
    assert.equal(res.status, 400);
    const long = new URLSearchParams({ slug: "promoblog", title: "Promo Blog", accent_color: "#1a8917", promo_body_md: "a".repeat(2001) });
    const res2 = await blogniceApp.request(`${ORIGIN}/admin/b/promoblog1/settings`, {
      method: "POST",
      headers: { Origin: ORIGIN, Cookie: "bn_session=sess", "Content-Type": "application/x-www-form-urlencoded" },
      body: long.toString(),
    }, env, ctx);
    assert.equal(res2.status, 400);
    assert.match(await res2.text(), /2000 characters or fewer/);
    const row = await db.prepare("SELECT promo_enabled, promo_body_md FROM tenants WHERE id=1").first();
    assert.deepEqual(row, { promo_enabled: 0, promo_body_md: "" });
  } finally {
    await mf.dispose();
  }
});

test("free owners see the Pro upsell and their promo is left alone", async () => {
  const { mf, db, env, ctx } = await setup();
  try {
    const page = await blogniceApp.request(`${ORIGIN}/admin/b/freeblog1/settings`, {
      headers: { Cookie: "bn_session=sess-free" },
    }, env, ctx);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /promo popup is a Pro feature/);
    assert.doesNotMatch(html, /name="promo_enabled"/);
    assert.doesNotMatch(html, /name="promo_body_md"/);
    assert.doesNotMatch(html, /id="promo-choose"/);

    const res = await blogniceApp.request(`${ORIGIN}/admin/b/freeblog1/settings`, {
      method: "POST",
      headers: { Origin: ORIGIN, Cookie: "bn_session=sess-free", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ slug: "freeblog", title: "Free Blog", accent_color: "#1a8917", promo_enabled: "1", promo_body_md: "Sneaky" }).toString(),
    }, env, ctx);
    assert.equal(res.status, 200);
    const row = await db.prepare("SELECT promo_enabled, promo_body_md FROM tenants WHERE id=2").first();
    assert.deepEqual(row, { promo_enabled: 0, promo_body_md: "" });
  } finally {
    await mf.dispose();
  }
});

test("promo media keys must belong to the blog and exist", async () => {
  const { mf, db, env, ctx } = await setup();
  try {
    const auth = { Authorization: `Bearer ${OWNER_KEY}`, "Content-Type": "application/json" };
    const foreign = await blogniceApp.request(`${ORIGIN}/api/v1/blogs/promoblog1`, {
      method: "PATCH", headers: auth, body: JSON.stringify({ promo_image: "999/other.jpg" }),
    }, env, ctx);
    assert.equal(foreign.status, 403);
    assert.match((await foreign.json()).error, /belong to this blog/);

    const missing = await blogniceApp.request(`${ORIGIN}/api/v1/blogs/promoblog1`, {
      method: "PATCH", headers: auth, body: JSON.stringify({ promo_image: "cover.jpg" }),
    }, env, ctx);
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /not found in media/);

    await env.MEDIA.put("1/cover.jpg", new TextEncoder().encode("fake-image"), { httpMetadata: { contentType: "image/jpeg" } });
    const ok = await blogniceApp.request(`${ORIGIN}/api/v1/blogs/promoblog1`, {
      method: "PATCH", headers: auth, body: JSON.stringify({ promo_image: "/media/1/cover.jpg" }),
    }, env, ctx);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).blog.promo_image, "1/cover.jpg");

    const form = await blogniceApp.request(`${ORIGIN}/admin/b/promoblog1/settings`, {
      method: "POST",
      headers: { Origin: ORIGIN, Cookie: "bn_session=sess", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ slug: "promoblog", title: "Promo Blog", accent_color: "#1a8917", promo_image: "gone.jpg" }).toString(),
    }, env, ctx);
    assert.equal(form.status, 400);
    assert.match(await form.text(), /not found in media/);
  } finally {
    await mf.dispose();
  }
});

test("API manages promo fields", async () => {
  const { mf, env, ctx } = await setup();
  try {
    const patch = await blogniceApp.request(`${ORIGIN}/api/v1/blogs/promoblog1`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${OWNER_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ promo_enabled: true, promo_placement: "all", promo_body_md: "Sale!", promo_cta_text: "Shop", promo_cta_url: "/sale" }),
    }, env, ctx);
    assert.equal(patch.status, 200);
    const blog = (await patch.json()).blog;
    assert.equal(blog.promo_enabled, true);
    assert.equal(blog.promo_placement, "all");
    assert.equal(blog.promo_body_md, "Sale!");

    const get = await blogniceApp.request(`${ORIGIN}/api/v1/blogs/promoblog1`, {
      headers: { Authorization: `Bearer ${OWNER_KEY}` },
    }, env, ctx);
    assert.equal((await get.json()).blog.promo_cta_url, "/sale");

    const bad = await blogniceApp.request(`${ORIGIN}/api/v1/blogs/promoblog1`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${OWNER_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ promo_placement: "everywhere" }),
    }, env, ctx);
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /promo_placement must be/);
  } finally {
    await mf.dispose();
  }
});
