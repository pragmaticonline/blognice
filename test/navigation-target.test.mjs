import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { Miniflare } from "miniflare";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { parseNavigationLinks, navigationLinkNewTab, renderHome, renderPage } from "../src/render.ts";
import { pageEditorPage, pageListPage } from "../src/admin.ts";

const require = createRequire(import.meta.url);
for (const extension of [".html", ".svg"]) {
  require.extensions[extension] = (module, filename) => { module.exports = readFileSync(filename, "utf8"); };
}
globalThis.caches = { default: { delete: async () => true, match: async () => undefined, put: async () => {} } };
const { blogniceApp } = await import("../src/index.ts");
function execSql(db, sql) {
  const cleaned = sql.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "");
  return Promise.all(cleaned.split(/;\s*(?=\r?\n|$)/).map((s) => s.trim()).filter(Boolean).map((s) => db.prepare(s).run()));
}

const tenant = {
  id: 1, public_id: "t1", slug: "myblog", custom_domain: null, title: "My Blog",
  description: "tag", footer_name: "", avatar_key: null, favicon_key: null,
  accent_color: "#1a8917", topics_json: "[]", social_links_json: "{}",
  navigation_links_json: "[]", shard: "primary", created_at: 1, deleted_at: null,
};
const account = { email: "owner@example.com", billing_status: "inactive", crypto_paid_through: 0, vip_granted_at: null, vip_expires_at: null };

test("custom navigation links keep an explicit same/new tab choice", () => {
  const links = parseNavigationLinks({
    ...tenant,
    navigation_links_json: JSON.stringify([
      { label: "Shop", href: "https://example.com/shop", order: 0, new_tab: false },
      { label: "Docs", href: "/docs", order: 1, new_tab: true },
      { label: "Legacy external", href: "https://example.com/old", order: 2 },
      { label: "Legacy path", href: "/old", order: 3 },
    ]),
  });
  assert.equal(links[0].new_tab, false);
  assert.equal(links[1].new_tab, true);
  // Links stored before this option existed keep their old behaviour:
  // external links open in a new tab, same-site paths in the same tab.
  assert.equal(navigationLinkNewTab(links[0]), false);
  assert.equal(navigationLinkNewTab(links[1]), true);
  assert.equal(navigationLinkNewTab(links[2]), true);
  assert.equal(navigationLinkNewTab(links[3]), false);
});

test("blog header renders each navigation item with its chosen target", () => {
  const items = [
    { label: "About", href: "/pages/about", newTab: true },
    { label: "Shop", href: "https://example.com/shop", newTab: false },
  ];
  const home = renderHome(tenant, [], "https://myblog.blognice.com", false, [], items);
  assert.match(home, /<a href="\/pages\/about" target="_blank" rel="noopener noreferrer">About<\/a>/);
  assert.match(home, /<a href="https:\/\/example\.com\/shop">Shop<\/a>/);

  const page = { id: 1, tenant_id: 1, slug: "about", title: "About", body_md: "Hi", published: 1, show_in_navigation: 1, created_at: 1, updated_at: 1 };
  const pageHtml = renderPage(tenant, page, "<p>Hi</p>", "https://myblog.blognice.com", false, false, items);
  assert.match(pageHtml, /<a href="https:\/\/example\.com\/shop">Shop<\/a>/);
});

test("admin choices persist and reach the public blog header", async () => {
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: ["DB", "POSTS"], r2Buckets: ["MEDIA"] });
  try {
    const db = await mf.getD1Database("DB");
    const postsDb = await mf.getD1Database("POSTS");
    const media = await mf.getR2Bucket("MEDIA");
    const env = { DB: db, POSTS: postsDb, MEDIA: media, ROOT_DOMAIN: "blognice.test", EVENTS: { writeDataPoint() {} } };
    const ctx = { waitUntil() {}, passThroughOnException() {} };
    await execSql(db, fs.readFileSync("schema.sql", "utf8"));
    await execSql(postsDb, fs.readFileSync("schema-posts.sql", "utf8"));
    const now = Math.floor(Date.now() / 1000);
    await db.prepare("INSERT INTO accounts (id,email,pw_hash,created_at) VALUES (1,'a@a.com','h',?)").bind(now).run();
    await db.prepare("INSERT INTO tenants (id,public_id,slug,title,description,footer_name,accent_color,topics_json,social_links_json,navigation_links_json,browser_push_enabled,header_link_url,created_at) VALUES (1,'test1234','myblog','My Blog','tag','','#1a8917','[]','{}','[]',1,'/',?)").bind(now).run();
    await db.prepare("INSERT INTO memberships (account_id,tenant_id,role,created_at) VALUES (1,1,'owner',?)").bind(now).run();
    await db.prepare("INSERT INTO sessions (token,account_id,created_at,expires_at) VALUES ('sess',1,?,?)").bind(now, now + 86400).run();
    const admin = { Origin: "https://www.blognice.test", Cookie: "bn_session=sess", "Content-Type": "application/x-www-form-urlencoded" };

    const save = await blogniceApp.request("https://www.blognice.test/admin/b/test1234/pages/save", { method: "POST", headers: admin, body: new URLSearchParams({ title: "About", slug: "about", body_md: "About us", published: "1", show_in_navigation: "1", navigation_target: "new" }).toString(), redirect: "manual" }, env, ctx);
    assert.equal(save.status, 302, await save.text());
    const pageRow = await postsDb.prepare("SELECT navigation_new_tab FROM pages WHERE slug='about'").first();
    assert.equal(pageRow.navigation_new_tab, 1);

    const add = await blogniceApp.request("https://www.blognice.test/admin/b/test1234/navigation-links", { method: "POST", headers: admin, body: new URLSearchParams({ label: "Shop", href: "https://example.com/shop", order: "1", navigation_target: "same" }).toString(), redirect: "manual" }, env, ctx);
    assert.equal(add.status, 302, await add.text());
    const tenantRow = await db.prepare("SELECT navigation_links_json FROM tenants WHERE id=1").first();
    assert.deepEqual(JSON.parse(tenantRow.navigation_links_json), [{ label: "Shop", href: "https://example.com/shop", order: 1, new_tab: false }]);

    const home = await blogniceApp.request("https://myblog.blognice.test/", { headers: { host: "myblog.blognice.test" } }, env, ctx);
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /<a href="\/pages\/about" target="_blank" rel="noopener noreferrer">About<\/a>/);
    assert.match(html, /<a href="https:\/\/example\.com\/shop">Shop<\/a>/);
  } finally { await mf.dispose(); }
});

test("admin pages UI offers the same/new tab choice", () => {
  const editor = pageEditorPage(account, tenant, { id: 1, title: "About", slug: "about", body_md: "", published: 1, show_in_navigation: 1, navigation_new_tab: 1 });
  assert.match(editor, /name="navigation_target"/);
  assert.match(editor, /<option value="new" selected>New tab<\/option>/);

  const withLink = { ...tenant, navigation_links_json: JSON.stringify([{ label: "Shop", href: "https://example.com/shop", order: 0, new_tab: false }]) };
  const list = pageListPage(account, withLink, [], "blognice.com");
  assert.match(list, /name="navigation_target"/);
  assert.match(list, /Same tab/);
  assert.match(list, /New tab/);
});
