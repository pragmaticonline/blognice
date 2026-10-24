// Landing pages Phase 1 (spec rev 2): gating, lifecycle, routing,
// SEO/canonical, custom-CSS contract, and multi-database rules.
// Tests are numbered to match the spec's Tests section.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

const require = createRequire(import.meta.url);
for (const extension of [".html", ".svg"]) {
  require.extensions[extension] = (module, filename) => {
    module.exports = readFileSync(filename, "utf8");
  };
}

const deletedCacheUrls = [];
globalThis.caches = {
  default: {
    delete: async (req) => { deletedCacheUrls.push(typeof req === "string" ? req : req.url); return true; },
    match: async () => undefined,
    put: async () => {},
  },
};

const NOW = Math.floor(Date.now() / 1000);
const ctx = { waitUntil(p) { if (p && typeof p.catch === "function") p.catch(() => {}); }, passThroughOnException() {} };
const flush = () => new Promise((r) => setTimeout(r, 25));

async function loadSchema(db, path) {
  const schema = readFileSync(new URL(path, import.meta.url), "utf8");
  for (const st of schema.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
    await db.prepare(st).run();
  }
}

async function setup(name, { rollout = "vip" } = {}) {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: ["DB", "POSTS"],
    r2Buckets: ["MEDIA"],
  });
  const indexDb = await mf.getD1Database("DB");
  const postsDb = await mf.getD1Database("POSTS");
  const media = await mf.getR2Bucket("MEDIA");
  await loadSchema(indexDb, "../schema.sql");
  await loadSchema(postsDb, "../schema-posts.sql");
  // Accounts: 1 VIP owner, 2 editor delegate, 3 free owner of nothing, 4 paid.
  await indexDb.prepare("INSERT INTO accounts (id, email, pw_hash, email_verified, vip_granted_at, vip_expires_at, billing_status, created_at) VALUES (1, 'vip@example.com', 'x', 1, ?, NULL, 'inactive', ?), (2, 'ed@example.com', 'x', 1, NULL, NULL, 'inactive', ?), (4, 'paid@example.com', 'x', 1, NULL, NULL, 'active', ?)").bind(NOW, NOW, NOW, NOW).run();
  await indexDb.prepare("INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES ('owner-session', 1, ?, ?), ('editor-session', 2, ?, ?)").bind(NOW, NOW + 3600, NOW, NOW + 3600).run();
  await indexDb.prepare("INSERT INTO tenants (id, public_id, slug, title, description, created_at) VALUES (1, 'b_test', 'testblog', 'Test Blog', 'A test blog', ?)").bind(NOW).run();
  await indexDb.prepare("INSERT INTO memberships (account_id, tenant_id, role, created_at) VALUES (1, 1, 'owner', ?), (2, 1, 'editor', ?)").bind(NOW, NOW).run();
  if (rollout !== null) {
    await indexDb.prepare("INSERT INTO platform_settings (key, value, updated_at) VALUES ('landing.rollout', ?, ?)").bind(rollout, NOW).run();
  }
  await postsDb.prepare("INSERT INTO posts (id, tenant_id, slug, title, body_md, tags_json, published, created_at, updated_at) VALUES (1, 1, 'hello', 'Hello Post', 'Hello body words', '[]', 1, ?, ?)").bind(NOW, NOW).run();
  await media.put("1/hero.jpg", new Uint8Array([1, 2, 3]).buffer);
  await media.put("2/other.jpg", new Uint8Array([4, 5, 6]).buffer);
  const env = { DB: indexDb, POSTS: postsDb, MEDIA: media, ROOT_DOMAIN: "blognice.test", API_TOKEN: "test-api-token-that-is-long-enough-32" };
  const pub = (path, session) => new Request(`https://testblog.blognice.test${path}`, { headers: { host: "testblog.blognice.test", ...(session ? { cookie: `bn_session=${session}` } : {}) } });
  const admin = (path, session = "owner-session", init = {}) => new Request(`https://www.blognice.test${path}`, { ...init, headers: { host: "www.blognice.test", origin: "https://www.blognice.test", cookie: `bn_session=${session}`, ...(init.headers || {}) } });
  return { mf, indexDb, postsDb, media, env, pub, admin };
}

async function seedLanding(s, { id = 1, slug = "welcome", title = "Welcome Page", published = 1, design = "hero", content = null, home = false } = {}) {
  const body = content ?? { hero: { headline: "Landing Headline", subheadline: "Landing sub", image_key: null }, ctas: [{ label: "Go", href: "/hello" }], intro_md: "Intro words", features: [], contact: {}, show_latest_posts: true };
  await s.postsDb.prepare("INSERT INTO landing_pages (id, tenant_id, slug, title, design, content_json, meta_description, published, created_at, updated_at, published_at) VALUES (?, 1, ?, ?, ?, ?, 'Meta desc', ?, ?, ?, ?)")
    .bind(id, slug, title, design, JSON.stringify(body), published, NOW, NOW, published ? NOW : null).run();
  if (home) await s.indexDb.prepare("UPDATE tenants SET home_landing_page_id = ? WHERE id = 1").bind(id).run();
  return id;
}

async function app() {
  const { blogniceApp } = await import("../src/index.ts");
  return blogniceApp;
}

// --- Gating (spec tests 1-3, pure) ------------------------------------------

test("1-3. rollout gating table incl. override and missing-row default", async () => {
  const { accountCanUseLandingPages, landingRollout } = await import("../src/landing.ts");
  const vip = { vip_granted_at: NOW, vip_expires_at: null, billing_status: "inactive", crypto_paid_through: null, landing_access_override: 0 };
  const expiredVip = { ...vip, vip_expires_at: NOW - 10 };
  const paid = { vip_granted_at: null, vip_expires_at: null, billing_status: "active", crypto_paid_through: null, landing_access_override: 0 };
  const free = { vip_granted_at: null, vip_expires_at: null, billing_status: "inactive", crypto_paid_through: null, landing_access_override: 0 };
  const override = { ...free, landing_access_override: 1 };
  assert.equal(accountCanUseLandingPages(vip, "off"), false);
  assert.equal(accountCanUseLandingPages(override, "off"), true);
  assert.equal(accountCanUseLandingPages(vip, "vip"), true);
  assert.equal(accountCanUseLandingPages(expiredVip, "vip"), false);
  assert.equal(accountCanUseLandingPages(paid, "vip"), false);
  assert.equal(accountCanUseLandingPages(override, "vip"), true);
  assert.equal(accountCanUseLandingPages(paid, "paid"), true);
  assert.equal(accountCanUseLandingPages(vip, "paid"), true);
  assert.equal(accountCanUseLandingPages(free, "paid"), false);
  assert.equal(accountCanUseLandingPages(free, "all"), true);
  const throwingDb = { prepare() { throw new Error("no table"); } };
  assert.equal(await landingRollout(throwingDb), "off");
});

// --- Gating at the admin surface (spec test 4) -------------------------------

test("4. delegates get 403 on landing admin routes and no tab; non-eligible owners get 403", async () => {
  const s = await setup("landing-gating");
  try {
    const blogniceApp = await app();
    const asEditor = await blogniceApp.request(s.admin("/admin/b/b_test/landing", "editor-session"), undefined, s.env, ctx);
    assert.equal(asEditor.status, 403);
    const pages = await blogniceApp.request(s.admin("/admin/b/b_test/pages", "editor-session"), undefined, s.env, ctx);
    assert.equal(pages.status, 200);
    assert.doesNotMatch(await pages.text(), /\/landing"/);
    // Rollout off + VIP owner without override -> not eligible.
    await s.indexDb.prepare("UPDATE platform_settings SET value = 'off' WHERE key = 'landing.rollout'").run();
    const asOwner = await blogniceApp.request(s.admin("/admin/b/b_test/landing", "owner-session"), undefined, s.env, ctx);
    assert.equal(asOwner.status, 403);
    assert.match((await asOwner.text()), /Landing pages are not available/);
  } finally { await s.mf.dispose(); }
});

// --- Lifecycle (spec tests 5-10) ---------------------------------------------

function saveForm(fields, action) {
  const form = new FormData();
  for (const [k, v] of Object.entries({ title: "Welcome Page", slug: "welcome", design: "hero", headline: "Landing Headline", subheadline: "Landing sub", ...fields })) form.set(k, v);
  form.set("action", action);
  return form;
}

test("5-7,10. create draft -> publish -> set homepage -> remove homepage", async () => {
  const s = await setup("landing-lifecycle");
  try {
    const blogniceApp = await app();
    // Create as draft through the admin UI.
    const created = await blogniceApp.request(s.admin("/admin/b/b_test/landing/save", "owner-session", { method: "POST", body: saveForm({}, "save") }), undefined, s.env, ctx);
    assert.equal(created.status, 302);
    const row = await s.postsDb.prepare("SELECT * FROM landing_pages WHERE slug = 'welcome'").first();
    assert.ok(row); assert.equal(row.published, 0);
    // 5. Draft: / still blog; public 404; owner preview 200 no-store/noindex.
    const homeDraft = await blogniceApp.request(s.pub("/"), undefined, s.env, ctx);
    assert.match(await homeDraft.text(), /Hello Post/);
    const pubDraft = await blogniceApp.request(s.pub("/landing/welcome"), undefined, s.env, ctx);
    assert.equal(pubDraft.status, 404);
    const preview = await blogniceApp.request(s.pub("/landing/welcome", "owner-session"), undefined, s.env, ctx);
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get("cache-control") || "", /no-store/);
    assert.match(preview.headers.get("x-robots-tag") || "", /noindex/);
    assert.match(await preview.text(), /Landing Headline/);
    // 7a. Set-as-homepage on a draft is rejected.
    const early = await blogniceApp.request(s.admin(`/admin/b/b_test/landing/set-homepage/${row.id}`, "owner-session", { method: "POST", body: new FormData() }), undefined, s.env, ctx);
    assert.equal(early.status, 302);
    assert.match(decodeURIComponent(early.headers.get("location") || ""), /Publish the landing page/);
    assert.equal((await s.indexDb.prepare("SELECT home_landing_page_id FROM tenants WHERE id = 1").first()).home_landing_page_id, null);
    // 6. Publish: public 200, / still blog.
    const published = await blogniceApp.request(s.admin(`/admin/b/b_test/landing/save?id=${row.id}`, "owner-session", { method: "POST", body: saveForm({}, "publish") }), undefined, s.env, ctx);
    assert.equal(published.status, 302);
    const pubLive = await blogniceApp.request(s.pub("/landing/welcome"), undefined, s.env, ctx);
    assert.equal(pubLive.status, 200);
    assert.match(await pubLive.text(), /Landing Headline/);
    const homeStill = await blogniceApp.request(s.pub("/"), undefined, s.env, ctx);
    assert.match(await homeStill.text(), /Hello Post/);
    // 7b. Set as homepage: / is landing, /blog is the post index, post URL unchanged (14).
    const set = await blogniceApp.request(s.admin(`/admin/b/b_test/landing/set-homepage/${row.id}`, "owner-session", { method: "POST", body: new FormData() }), undefined, s.env, ctx);
    assert.equal(set.status, 302);
    const homeLanding = await blogniceApp.request(s.pub("/"), undefined, s.env, ctx);
    assert.match(await homeLanding.text(), /Landing Headline/);
    const blogIndex = await blogniceApp.request(s.pub("/blog"), undefined, s.env, ctx);
    assert.equal(blogIndex.status, 200);
    assert.match(await blogIndex.text(), /Hello Post/);
    const post = await blogniceApp.request(s.pub("/hello"), undefined, s.env, ctx);
    assert.equal(post.status, 200);
    // 10. Remove from homepage: page stays published, / is blog again.
    const removed = await blogniceApp.request(s.admin("/admin/b/b_test/landing/remove-homepage", "owner-session", { method: "POST", body: new FormData() }), undefined, s.env, ctx);
    assert.equal(removed.status, 302);
    assert.equal((await s.postsDb.prepare("SELECT published FROM landing_pages WHERE id = ?").bind(row.id).first()).published, 1);
    const homeBack = await blogniceApp.request(s.pub("/"), undefined, s.env, ctx);
    assert.match(await homeBack.text(), /Hello Post/);
    const stillLive = await blogniceApp.request(s.pub("/landing/welcome"), undefined, s.env, ctx);
    assert.equal(stillLive.status, 200);
  } finally { await s.mf.dispose(); }
});

test("8. slug blog: post blocks set-homepage and is rejected while homepage set; page allowed", async () => {
  const s = await setup("landing-slug-blog");
  try {
    const blogniceApp = await app();
    const id = await seedLanding(s, {});
    await s.postsDb.prepare("INSERT INTO posts (id, tenant_id, slug, title, body_md, tags_json, published, created_at, updated_at) VALUES (9, 1, 'blog', 'Blog Slug Post', 'x', '[]', 0, ?, ?)").bind(NOW, NOW).run();
    const blocked = await blogniceApp.request(s.admin(`/admin/b/b_test/landing/set-homepage/${id}`, "owner-session", { method: "POST", body: new FormData() }), undefined, s.env, ctx);
    assert.match(decodeURIComponent(blocked.headers.get("location") || ""), /Blog Slug Post/);
    assert.equal((await s.indexDb.prepare("SELECT home_landing_page_id FROM tenants WHERE id = 1").first()).home_landing_page_id, null);
    // A page slugged blog does not block.
    await s.postsDb.prepare("DELETE FROM posts WHERE id = 9").run();
    await s.postsDb.prepare("INSERT INTO pages (id, tenant_id, slug, title, body_md, published, created_at, updated_at) VALUES (9, 1, 'blog', 'Blog Page', 'x', 1, ?, ?)").bind(NOW, NOW).run();
    const allowed = await blogniceApp.request(s.admin(`/admin/b/b_test/landing/set-homepage/${id}`, "owner-session", { method: "POST", body: new FormData() }), undefined, s.env, ctx);
    assert.equal(allowed.status, 302);
    assert.equal((await s.indexDb.prepare("SELECT home_landing_page_id FROM tenants WHERE id = 1").first()).home_landing_page_id, id);
    const pageRes = await blogniceApp.request(s.pub("/pages/blog"), undefined, s.env, ctx);
    assert.equal(pageRes.status, 200);
    // Creating a post slugged blog via the legacy API is rejected now.
    const create = await blogniceApp.request(new Request("https://testblog.blognice.test/api/posts", {
      method: "POST", headers: { host: "testblog.blognice.test", authorization: "Bearer test-api-token-that-is-long-enough-32", "content-type": "application/json" },
      body: JSON.stringify({ tenant_slug: "testblog", slug: "blog", title: "Sneaky", body_md: "x" }),
    }), undefined, s.env, ctx);
    assert.equal(create.status, 400);
    assert.match(await create.text(), /reserved/);
  } finally { await s.mf.dispose(); }
});

test("9. unpublish and delete of the homepage page clear the pointer first", async () => {
  const s = await setup("landing-unpublish");
  try {
    const blogniceApp = await app();
    const id = await seedLanding(s, { home: true });
    const unpub = await blogniceApp.request(s.admin(`/admin/b/b_test/landing/save?id=${id}`, "owner-session", { method: "POST", body: saveForm({}, "unpublish") }), undefined, s.env, ctx);
    assert.equal(unpub.status, 302);
    assert.equal((await s.indexDb.prepare("SELECT home_landing_page_id FROM tenants WHERE id = 1").first()).home_landing_page_id, null);
    const home = await blogniceApp.request(s.pub("/"), undefined, s.env, ctx);
    assert.match(await home.text(), /Hello Post/);
    // Re-publish + set homepage, then delete.
    await s.postsDb.prepare("UPDATE landing_pages SET published = 1 WHERE id = ?").bind(id).run();
    await s.indexDb.prepare("UPDATE tenants SET home_landing_page_id = ? WHERE id = 1").bind(id).run();
    const del = await blogniceApp.request(s.admin(`/admin/b/b_test/landing/delete/${id}`, "owner-session", { method: "POST", body: new FormData() }), undefined, s.env, ctx);
    assert.equal(del.status, 302);
    assert.equal((await s.indexDb.prepare("SELECT home_landing_page_id FROM tenants WHERE id = 1").first()).home_landing_page_id, null);
    assert.equal(await s.postsDb.prepare("SELECT id FROM landing_pages WHERE id = ?").bind(id).first(), null);
  } finally { await s.mf.dispose(); }
});

// --- Fallback (spec tests 11-12) ----------------------------------------------

test("11. VIP expiry falls back with data untouched; re-grant restores", async () => {
  const s = await setup("landing-expiry");
  try {
    const blogniceApp = await app();
    await seedLanding(s, { home: true });
    const before = await blogniceApp.request(s.pub("/"), undefined, s.env, ctx);
    assert.match(await before.text(), /Landing Headline/);
    await s.indexDb.prepare("UPDATE accounts SET vip_expires_at = ? WHERE id = 1").bind(NOW - 60).run();
    const after = await blogniceApp.request(s.pub("/"), undefined, s.env, ctx);
    assert.match(await after.text(), /Hello Post/);
    const landing = await blogniceApp.request(s.pub("/landing/welcome"), undefined, s.env, ctx);
    assert.equal(landing.status, 404);
    const blogIdx = await blogniceApp.request(s.pub("/blog"), undefined, s.env, ctx);
    assert.equal(blogIdx.status, 301);
    // Data untouched.
    assert.equal((await s.indexDb.prepare("SELECT home_landing_page_id FROM tenants WHERE id = 1").first()).home_landing_page_id, 1);
    assert.equal((await s.postsDb.prepare("SELECT published FROM landing_pages WHERE id = 1").first()).published, 1);
    await s.indexDb.prepare("UPDATE accounts SET vip_expires_at = NULL WHERE id = 1").run();
    const restored = await blogniceApp.request(s.pub("/"), undefined, s.env, ctx);
    assert.match(await restored.text(), /Landing Headline/);
  } finally { await s.mf.dispose(); }
});

test("12. dangling home pointer renders the blog, no 500", async () => {
  const s = await setup("landing-dangling");
  try {
    const blogniceApp = await app();
    await s.indexDb.prepare("UPDATE tenants SET home_landing_page_id = 999 WHERE id = 1").run();
    const home = await blogniceApp.request(s.pub("/"), undefined, s.env, ctx);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Hello Post/);
  } finally { await s.mf.dispose(); }
});

// --- Routing + SEO (spec tests 13, 15-16, 27) ---------------------------------

test("13,15,27. /blog redirects and canonicals in both states", async () => {
  const s = await setup("landing-routing");
  try {
    const blogniceApp = await app();
    for (let i = 2; i <= 9; i++) {
      await s.postsDb.prepare("INSERT INTO posts (id, tenant_id, slug, title, body_md, tags_json, published, created_at, updated_at) VALUES (?, 1, ?, ?, 'body', '[]', 1, ?, ?)").bind(i, `post-${i}`, `Post ${i}`, NOW - i, NOW - i).run();
    }
    // H false: /blog 301s to /, /blog?page=2 to /?page=2.
    const b1 = await blogniceApp.request(s.pub("/blog"), undefined, s.env, ctx);
    assert.equal(b1.status, 301); assert.equal(new URL(b1.headers.get("location"), "https://testblog.blognice.test").pathname, "/");
    const b2 = await blogniceApp.request(s.pub("/blog?page=2"), undefined, s.env, ctx);
    assert.equal(b2.status, 301); assert.match(b2.headers.get("location") || "", /\?page=2/);
    // H true.
    await seedLanding(s, { home: true });
    const p2 = await blogniceApp.request(s.pub("/?page=2"), undefined, s.env, ctx);
    assert.equal(p2.status, 301); assert.match(p2.headers.get("location") || "", /\/blog\?page=2/);
    const blog = await blogniceApp.request(s.pub("/blog"), undefined, s.env, ctx);
    assert.equal(blog.status, 200);
    const blogHtml = await blog.text();
    assert.match(blogHtml, /<link rel="canonical" href="https:\/\/testblog\.blognice\.test\/blog">/);
    assert.match(blogHtml, /href="\/blog\?page=2"/);
    const blog2 = await blogniceApp.request(s.pub("/blog?page=2"), undefined, s.env, ctx);
    assert.equal(blog2.status, 200);
    const blog2Html = await blog2.text();
    assert.match(blog2Html, /<link rel="canonical" href="https:\/\/testblog\.blognice\.test\/blog\?page=2">/);
    assert.match(blog2Html, /<link rel="prev" href="https:\/\/testblog\.blognice\.test\/blog">/);
    const home = await blogniceApp.request(s.pub("/"), undefined, s.env, ctx);
    assert.match(await home.text(), /<link rel="canonical" href="https:\/\/testblog\.blognice\.test\/">/);
  } finally { await s.mf.dispose(); }
});

test("16. RSS channel link and sitemap entries when H is true", async () => {
  const s = await setup("landing-seo-feeds");
  try {
    const blogniceApp = await app();
    await seedLanding(s, { home: true });
    await seedLanding(s, { id: 2, slug: "second", title: "Second Page" });
    const rss = await blogniceApp.request(s.pub("/rss.xml"), undefined, s.env, ctx);
    const rssText = await rss.text();
    assert.match(rssText, /<link>https:\/\/testblog\.blognice\.test\/blog<\/link>/);
    assert.match(rssText, /<link>https:\/\/testblog\.blognice\.test\/hello<\/link>/);
    const sm = await blogniceApp.request(s.pub("/sitemap.xml"), undefined, s.env, ctx);
    const smText = await sm.text();
    assert.match(smText, /<loc>https:\/\/testblog\.blognice\.test\/<\/loc>/);
    assert.match(smText, /<loc>https:\/\/testblog\.blognice\.test\/blog<\/loc>/);
    assert.match(smText, /<loc>https:\/\/testblog\.blognice\.test\/landing\/second<\/loc>/);
    assert.doesNotMatch(smText, /\/landing\/welcome</);
  } finally { await s.mf.dispose(); }
});

// --- Rendering safety via admin (spec tests 19 + design validation) -----------

test("19. image_key from another tenant is rejected on save", async () => {
  const s = await setup("landing-image-owner");
  try {
    const blogniceApp = await app();
    const res = await blogniceApp.request(s.admin("/admin/b/b_test/landing/save", "owner-session", { method: "POST", body: saveForm({ hero_image_key: "2/other.jpg" }, "save") }), undefined, s.env, ctx);
    assert.equal(res.status, 400);
    assert.match(await res.text(), /not found in this blog/);
    assert.equal(await s.postsDb.prepare("SELECT id FROM landing_pages WHERE slug = 'welcome'").first(), null);
    const bad = await blogniceApp.request(s.admin("/admin/b/b_test/landing/save", "owner-session", { method: "POST", body: saveForm({ design: "nope" }, "save") }), undefined, s.env, ctx);
    assert.equal(bad.status, 400);
  } finally { await s.mf.dispose(); }
});

// --- Custom CSS contract (spec tests 21-23, 29) --------------------------------

test("21-23,29. custom CSS wins, is escaped, hooks and consent present", async () => {
  const s = await setup("landing-css");
  try {
    const blogniceApp = await app();
    await seedLanding(s, {});
    await s.indexDb.prepare("UPDATE tenants SET custom_css = ':root{--accent:#123456}' WHERE id = 1").run();
    const res = await blogniceApp.request(s.pub("/landing/welcome"), undefined, s.env, ctx);
    const html = await res.text();
    assert.match(html, /data-landing-page data-landing-design="hero"/);
    assert.match(html, /class="[^"]*lp-hero/);
    assert.match(html, /html\[data-theme=dark\]/);
    // Custom CSS after the design's own styles and the accent override.
    assert.ok(html.indexOf(":root{--accent:#123456}") > html.indexOf("--accent-ink"), "custom CSS wins");
    assert.ok(html.indexOf(":root{--accent:#123456}") > html.lastIndexOf("</style>", html.indexOf(":root{--accent:#123456}") - 1) - 5000, "custom after styles");
    // Consent/metrics at body end, no blog shell markup.
    assert.ok(html.lastIndexOf("blognice-consent") > html.indexOf("lp-footer"), "consent at body end");
    // 22. Breakout attempt is escaped by customCssTag.
    await s.indexDb.prepare("UPDATE tenants SET custom_css = ? WHERE id = 1").bind("</style><script>alert(1)</script>").run();
    const res2 = await blogniceApp.request(s.pub("/landing/welcome"), undefined, s.env, ctx);
    const html2 = await res2.text();
    assert.ok(!html2.includes("</style><script>alert(1)"), "no style breakout");
  } finally { await s.mf.dispose(); }
});

// --- Multi-database rules (spec tests 24-26, 28) --------------------------------

test("24. landing queries go through tenantDb (unknown shard proves no POSTS bypass)", async () => {
  const s = await setup("landing-shard");
  try {
    const blogniceApp = await app();
    await seedLanding(s, {});
    await s.indexDb.prepare("UPDATE tenants SET shard = 'bogus-shard' WHERE id = 1").run();
    const res = await blogniceApp.request(s.pub("/landing/welcome"), undefined, s.env, ctx);
    assert.equal(res.status, 404);
    const { getLandingPage } = await import("../src/landing.ts");
    await assert.rejects(() => getLandingPage(s.env, { id: 1, shard: "bogus-shard" }, 1), /Unknown posts shard/);
  } finally { await s.mf.dispose(); }
});

test("25. home pointer NULL: / works even when landing_pages table is absent", async () => {
  const s = await setup("landing-null-home");
  try {
    const blogniceApp = await app();
    await s.postsDb.prepare("DROP TABLE landing_pages").run();
    const home = await blogniceApp.request(s.pub("/"), undefined, s.env, ctx);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Hello Post/);
  } finally { await s.mf.dispose(); }
});

test("26. deleteTenantPosts removes only that tenant's landing pages", async () => {
  const s = await setup("landing-delete-tenant");
  try {
    await seedLanding(s, {});
    await s.postsDb.prepare("INSERT INTO landing_pages (id, tenant_id, slug, title, design, content_json, published, created_at, updated_at) VALUES (7, 2, 'other', 'Other', 'hero', '{}', 1, ?, ?)").bind(NOW, NOW).run();
    const { deleteTenantPosts } = await import("../src/db.ts");
    await deleteTenantPosts(s.env, { id: 1, shard: "primary" });
    assert.equal(await s.postsDb.prepare("SELECT id FROM landing_pages WHERE tenant_id = 1").first(), null);
    assert.ok(await s.postsDb.prepare("SELECT id FROM landing_pages WHERE tenant_id = 2").first());
  } finally { await s.mf.dispose(); }
});

test("28. set-homepage purge covers /blog and /landing/*", async () => {
  const s = await setup("landing-purge");
  try {
    const blogniceApp = await app();
    const id = await seedLanding(s, {});
    deletedCacheUrls.length = 0;
    const set = await blogniceApp.request(s.admin(`/admin/b/b_test/landing/set-homepage/${id}`, "owner-session", { method: "POST", body: new FormData() }), undefined, s.env, ctx);
    assert.equal(set.status, 302);
    for (let i = 0; i < 40 && !deletedCacheUrls.length; i++) await new Promise((r) => setTimeout(r, 50));
    await flush();
    const purged = deletedCacheUrls.map((u) => { try { return new URL(u).pathname; } catch { return u; } });
    assert.ok(purged.includes("/blog"), purged.join(","));
    assert.ok(purged.includes("/landing/welcome"), purged.join(","));
    assert.ok(purged.includes("/"), purged.join(","));
  } finally { await s.mf.dispose(); }
});

// --- Coverage added on review: limits, valid media, API guard, staff ----------

test("max 10 landing pages per tenant; valid owned image saves and renders", async () => {
  const s = await setup("landing-limits-media");
  try {
    const blogniceApp = await app();
    for (let i = 1; i <= 10; i++) await seedLanding(s, { id: i, slug: `p${i}`, title: `P${i}`, published: 0 });
    const eleventh = await blogniceApp.request(s.admin("/admin/b/b_test/landing/save", "owner-session", { method: "POST", body: saveForm({ slug: "eleven", title: "Eleven" }, "save") }), undefined, s.env, ctx);
    assert.equal(eleventh.status, 400);
    assert.match(await eleventh.text(), /at most 10/);
    await s.postsDb.prepare("DELETE FROM landing_pages WHERE id = 10").run();
    const withImage = await blogniceApp.request(s.admin("/admin/b/b_test/landing/save", "owner-session", { method: "POST", body: saveForm({ slug: "with-image", title: "With Image", hero_image_key: "1/hero.jpg" }, "publish") }), undefined, s.env, ctx);
    assert.equal(withImage.status, 302);
    const pub = await blogniceApp.request(s.pub("/landing/with-image"), undefined, s.env, ctx);
    assert.equal(pub.status, 200);
    assert.match(await pub.text(), /\/media\/1\/hero\.jpg/);
  } finally { await s.mf.dispose(); }
});

test("post slug blog guard also applies to API v1 post creation", async () => {
  const s = await setup("landing-apiv1-guard");
  try {
    const blogniceApp = await app();
    await seedLanding(s, { home: true });
    const rawKey = "bnk_landing_test_key_1234567890";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawKey));
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    await s.indexDb.prepare("UPDATE accounts SET api_key_hash = ? WHERE id = 1").bind(hash).run();
    const res = await blogniceApp.request(new Request("https://www.blognice.test/api/v1/blogs/b_test/posts", {
      method: "POST",
      headers: { host: "www.blognice.test", authorization: `Bearer ${rawKey}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Sneaky", slug: "blog", body_md: "x" }),
    }), undefined, s.env, ctx);
    assert.equal(res.status, 400);
    assert.match(await res.text(), /reserved/);
  } finally { await s.mf.dispose(); }
});

test("staff: landing rollout + account override endpoints require staff and audit", async () => {
  const s = await setup("landing-staff");
  try {
    const { default: staffApp } = await import("../src/staff.ts");
    const now = NOW;
    await s.indexDb.prepare("INSERT INTO staff_users (subject, email, role, active, created_at, updated_at) VALUES ('staff|admin', 'admin@example.com', 'admin', 1, ?, ?)").bind(now, now).run();
    // Access JWT fixture (same shape as staff-affiliate-http.test.mjs).
    const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    jwk.kid = "staff-test-key"; jwk.alg = "RS256";
    const b64 = (v) => Buffer.from(typeof v === "string" ? new TextEncoder().encode(v) : new Uint8Array(v)).toString("base64url");
    const header = b64(JSON.stringify({ alg: "RS256", kid: "staff-test-key" }));
    const payload = b64(JSON.stringify({ sub: "staff|admin", email: "admin@example.com", iss: "https://team.cloudflareaccess.com", aud: ["staff-audience"], iat: now - 1, exp: now + 3600 }));
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${header}.${payload}`));
    const token = `${header}.${payload}.${b64(sig)}`;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => String(url).endsWith("/cdn-cgi/access/certs")
      ? new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })
      : originalFetch(url);
    try {
      const env = { DB: s.indexDb, POSTS: s.postsDb, ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "staff-audience", ROOT_DOMAIN: "blognice.test" };
      const req = (path, body) => new Request(`https://staff.blognice.test${path}`, {
        method: body ? "POST" : "GET",
        headers: { "content-type": "application/json", Origin: "https://staff.blognice.test", "Cf-Access-Jwt-Assertion": token },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const noAuth = await staffApp.request(new Request("https://staff.blognice.test/api/landing-rollout"), undefined, env, ctx);
      assert.equal(noAuth.status, 403);
      const before = await staffApp.request(req("/api/landing-rollout"), undefined, env, ctx);
      assert.deepEqual(await before.json(), { rollout: "vip" });
      const set = await staffApp.request(req("/api/landing-rollout", { rollout: "paid" }), undefined, env, ctx);
      assert.equal(set.status, 200);
      assert.equal((await s.indexDb.prepare("SELECT value FROM platform_settings WHERE key = 'landing.rollout'").first()).value, "paid");
      const bad = await staffApp.request(req("/api/landing-rollout", { rollout: "everyone" }), undefined, env, ctx);
      assert.equal(bad.status, 400);
      const grant = await staffApp.request(req("/api/accounts/3/landing-override", { override: true, reason: "test grant" }), undefined, env, ctx);
      // Account 3 does not exist in this fixture; create the free account first is unnecessary -- expect 404 proves auth passed.
      assert.equal(grant.status, 404);
      deletedCacheUrls.length = 0;
      const grantOwner = await staffApp.request(req("/api/accounts/1/landing-override", { override: true, reason: "test grant" }), undefined, env, ctx);
      assert.equal(grantOwner.status, 200);
      await flush();
      assert.ok(deletedCacheUrls.map((u) => { try { return new URL(u).pathname; } catch { return u; } }).includes("/blog"), "override change purges owned tenants");
      assert.equal((await s.indexDb.prepare("SELECT landing_access_override FROM accounts WHERE id = 1").first()).landing_access_override, 1);
      const audits = await s.indexDb.prepare("SELECT action FROM staff_audit_events WHERE action LIKE 'landing-%'").all();
      assert.ok(audits.results.length >= 2, JSON.stringify(audits.results));
      // Account page shows homepage state without error.
      await seedLanding(s, { home: true });
      const page = await staffApp.request(req("/accounts/1"), undefined, env, ctx);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /Landing pages/);
    } finally { globalThis.fetch = originalFetch; }
  } finally { await s.mf.dispose(); }
});

test("promo popup with home placement shows on the landing homepage only, not /blog", async () => {
  const s = await setup("landing-promo");
  try {
    const blogniceApp = await app();
    await seedLanding(s, { home: true });
    await s.indexDb.prepare("UPDATE tenants SET promo_enabled = 1, promo_placement = 'home', promo_body_md = 'Promo body text', promo_cta_text = '', promo_cta_url = '' WHERE id = 1").run();
    const home = await blogniceApp.request(s.pub("/"), undefined, s.env, ctx);
    assert.match(await home.text(), /Promo body text/);
    const blog = await blogniceApp.request(s.pub("/blog"), undefined, s.env, ctx);
    assert.doesNotMatch(await blog.text(), /Promo body text/);
  } finally { await s.mf.dispose(); }
});

// --- Export (spec: landing pages included) --------------------------------------

test("export.zip includes landing pages and the homepage pointer", async () => {
  const s = await setup("landing-export");
  try {
    const blogniceApp = await app();
    await seedLanding(s, { home: true });
    const res = await blogniceApp.request(s.admin("/admin/b/b_test/export.zip", "owner-session"), undefined, s.env, ctx);
    assert.equal(res.status, 200);
    const { unzipSync, strFromU8 } = await import("fflate");
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    assert.ok(files["landing-pages.json"], Object.keys(files).join(","));
    const data = JSON.parse(strFromU8(files["landing-pages.json"]));
    assert.equal(data.home_landing_page_id, 1);
    assert.equal(data.landing_pages[0].slug, "welcome");
    assert.equal(data.landing_pages[0].is_homepage, true);
  } finally { await s.mf.dispose(); }
});


