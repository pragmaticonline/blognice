import test from "node:test";
import assert from "node:assert/strict";
import fs, { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Miniflare } from "miniflare";
import { normalizeCustomCss, customCssTag, renderPost, MAX_CUSTOM_CSS_LENGTH } from "../src/render.ts";

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

const OWNER_KEY = "bnk_testcssownerkey1234567890abc";
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
  await db.prepare("INSERT INTO accounts (id,email,pw_hash,billing_status,api_key_hash,created_at) VALUES (1,'paid@x.com','h','active',?,?)").bind(apiHash(OWNER_KEY), now).run();
  await db.prepare("INSERT INTO accounts (id,email,pw_hash,created_at) VALUES (2,'free@x.com','h',?)").bind(now).run();
  await db.prepare("INSERT INTO tenants (id,public_id,slug,title,description,footer_name,accent_color,topics_json,social_links_json,navigation_links_json,browser_push_enabled,header_link_url,created_at) VALUES (1,'paidblog1','paidblog','Paid Blog','tag','','#1a8917','[]','{}','[]',1,'/',?)").bind(now).run();
  await db.prepare("INSERT INTO tenants (id,public_id,slug,title,description,footer_name,accent_color,topics_json,social_links_json,navigation_links_json,browser_push_enabled,header_link_url,created_at) VALUES (2,'freeblog1','freeblog','Free Blog','tag','','#1a8917','[]','{}','[]',1,'/',?)").bind(now).run();
  await db.prepare("INSERT INTO memberships (account_id,tenant_id,role,created_at) VALUES (1,1,'owner',?)").bind(now).run();
  await db.prepare("INSERT INTO memberships (account_id,tenant_id,role,created_at) VALUES (2,2,'owner',?)").bind(now).run();
  await db.prepare("INSERT INTO sessions (token,account_id,created_at,expires_at) VALUES ('sess-paid',1,?,?)").bind(now, now + 86400).run();
  await db.prepare("INSERT INTO sessions (token,account_id,created_at,expires_at) VALUES ('sess-free',2,?,?)").bind(now, now + 86400).run();
  const env = { DB: db, POSTS: postsDb, MEDIA: media, ROOT_DOMAIN: "blognice.test", EVENTS: { writeDataPoint() {} } };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  return { mf, db, env, ctx };
}

function settingsForm(extra = {}) {
  return new URLSearchParams({ slug: "paidblog", title: "Paid Blog", accent_color: "#1a8917", ...extra });
}

function settingsPost(url, cookie, params) {
  return [url, {
    method: "POST",
    headers: { Origin: ORIGIN, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  }];
}

test("custom CSS validator accepts plain CSS and trims to empty", () => {
  assert.equal(MAX_CUSTOM_CSS_LENGTH, 20000);
  assert.deepEqual(normalizeCustomCss("  p.custom { color: red; }  "), { css: "p.custom { color: red; }" });
  assert.deepEqual(normalizeCustomCss(""), { css: "" });
  assert.deepEqual(normalizeCustomCss(null), { css: "" });
  assert.deepEqual(normalizeCustomCss(undefined), { css: "" });
  assert.deepEqual(normalizeCustomCss("@import url('https://fonts.example.com/x.css');"), {
    css: "@import url('https://fonts.example.com/x.css');",
  });
});

test("custom CSS validator rejects oversized and dangerous payloads", () => {
  const tooLong = normalizeCustomCss("a".repeat(MAX_CUSTOM_CSS_LENGTH + 1));
  assert.equal(tooLong.css, "");
  assert.match(tooLong.error || "", /20000 characters or fewer/);
  const breakout = normalizeCustomCss("p{} </STYLE><script>alert(1)</script>");
  assert.equal(breakout.css, "");
  assert.match(breakout.error || "", /<\/style>/i);
  const jsUrl = normalizeCustomCss("p { background: url(javascript:alert(1)); }");
  assert.equal(jsUrl.css, "");
  assert.match(jsUrl.error || "", /javascript:/i);
  const expression = normalizeCustomCss("p { width: expression(alert(1)); }");
  assert.equal(expression.css, "");
  assert.match(expression.error || "", /expression/i);
});

test("custom CSS tag escapes style-breakout defensively and stays empty when blank", () => {
  assert.equal(customCssTag({ custom_css: null }), "");
  assert.equal(customCssTag({ custom_css: "   " }), "");
  assert.equal(customCssTag({}), "");
  const tag = customCssTag({ custom_css: "p.x{color:red}" });
  assert.match(tag, /^<style>p\.x\{color:red\}<\/style>$/);
  const hostile = customCssTag({ custom_css: "p{}</style><script>alert(1)</script>" });
  assert.equal(hostile.match(/<\/style/gi).length, 1); // only the tag's own closing tag
  assert.match(hostile, /<\\\/style/);
});

test("public pages append custom CSS after the theme styles", () => {
  const tenant = { id: 1, public_id: "t", slug: "s", custom_domain: null, title: "T", description: "", avatar_key: null, favicon_key: null, accent_color: null, topics_json: "[]", shard: "primary", created_at: 1, deleted_at: null };
  const post = { id: 1, tenant_id: 1, slug: "hello", title: "Hello", featured_image_key: null, audio_key: null, body_md: "Hi.", tags_json: "[]", published: 1, created_at: 1, updated_at: 1 };
  const plain = renderPost(tenant, post, "<p>Hi.</p>", "https://s.blognice.test", "https://www.blognice.test");
  assert.doesNotMatch(plain, /p\.custom-theme-probe/);
  const styled = renderPost({ ...tenant, custom_css: "p.custom-theme-probe{color:red}" }, post, "<p>Hi.</p>", "https://s.blognice.test", "https://www.blognice.test");
  assert.match(styled, /p\.custom-theme-probe\{color:red\}/);
  assert.ok(styled.indexOf("--accent:") < styled.indexOf("p.custom-theme-probe"), "custom CSS must come after the accent block");
  const blogspot = renderPost({ ...tenant, theme: "blogspot", custom_css: "p.custom-theme-probe{color:red}" }, post, "<p>Hi.</p>", "https://s.blognice.test", "https://www.blognice.test");
  assert.ok(blogspot.indexOf("--panel:") < blogspot.indexOf("p.custom-theme-probe"), "custom CSS must come after the blogspot overrides");
});

test("paid owners can save custom CSS from settings and it renders publicly", async () => {
  const { mf, db, env, ctx } = await setup();
  try {
    const res = await blogniceApp.request(...settingsPost(`${ORIGIN}/admin/b/paidblog1/settings`, "bn_session=sess-paid", settingsForm({ custom_css: "p.paid-probe{color:green}" })), env, ctx);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Saved\./);
    const row = await db.prepare("SELECT custom_css FROM tenants WHERE id=1").first();
    assert.equal(row.custom_css, "p.paid-probe{color:green}");

    const page = await blogniceApp.request("https://paidblog.blognice.test/", {
      headers: { host: "paidblog.blognice.test" },
    }, env, ctx);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /p\.paid-probe\{color:green\}/);
  } finally {
    await mf.dispose();
  }
});

test("free owners see the Pro upsell and their custom CSS is left alone", async () => {
  const { mf, db, env, ctx } = await setup();
  try {
    const page = await blogniceApp.request(`${ORIGIN}/admin/b/freeblog1/settings`, {
      headers: { Cookie: "bn_session=sess-free" },
    }, env, ctx);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Custom CSS is a Pro feature/);
    assert.doesNotMatch(html, /name="custom_css"/);

    const res = await blogniceApp.request(...settingsPost(
      `${ORIGIN}/admin/b/freeblog1/settings`,
      "bn_session=sess-free",
      new URLSearchParams({ slug: "freeblog", title: "Free Blog", accent_color: "#1a8917", custom_css: "p.sneaky{color:red}" }),
    ), env, ctx);
    assert.equal(res.status, 200);
    const row = await db.prepare("SELECT custom_css FROM tenants WHERE id=2").first();
    assert.equal(row.custom_css, "");
  } finally {
    await mf.dispose();
  }
});

test("invalid custom CSS is rejected with a clear error", async () => {
  const { mf, db, env, ctx } = await setup();
  try {
    const res = await blogniceApp.request(...settingsPost(`${ORIGIN}/admin/b/paidblog1/settings`, "bn_session=sess-paid", settingsForm({ custom_css: "p{}</style><script>alert(1)</script>" })), env, ctx);
    assert.equal(res.status, 400);
    assert.match(await res.text(), /&lt;\/style&gt;/);
    const row = await db.prepare("SELECT custom_css FROM tenants WHERE id=1").first();
    assert.equal(row.custom_css, "");
  } finally {
    await mf.dispose();
  }
});

test("API PATCH manages custom CSS for paid accounts", async () => {
  const { mf, env, ctx } = await setup();
  try {
    const patch = await blogniceApp.request(`${ORIGIN}/api/v1/blogs/paidblog1`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${OWNER_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ custom_css: ".api-probe{color:blue}" }),
    }, env, ctx);
    assert.equal(patch.status, 200);
    assert.equal((await patch.json()).blog.custom_css, ".api-probe{color:blue}");

    const get = await blogniceApp.request(`${ORIGIN}/api/v1/blogs/paidblog1`, {
      headers: { Authorization: `Bearer ${OWNER_KEY}` },
    }, env, ctx);
    assert.equal(get.status, 200);
    assert.equal((await get.json()).blog.custom_css, ".api-probe{color:blue}");

    const bad = await blogniceApp.request(`${ORIGIN}/api/v1/blogs/paidblog1`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${OWNER_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ custom_css: "p{background:url(javascript:alert(1))}" }),
    }, env, ctx);
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /javascript:/i);
  } finally {
    await mf.dispose();
  }
});
