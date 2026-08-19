import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Miniflare } from "miniflare";
import { build } from "esbuild";

async function createBundle() {
  const bundle = await build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    format: "esm",
    write: false,
    platform: "neutral",
    mainFields: ["module", "main"],
    external: ["node:*", "assert", "buffer", "crypto", "http", "https", "net", "stream", "tls", "tty", "url", "util"],
    loader: { ".html": "text", ".svg": "text" },
    plugins: [{
      name: "stub",
      setup(p) {
        p.onResolve({ filter: /^web-push$/ }, () => ({ path: "stub", namespace: "stub" }));
        p.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export default { sendNotification: async()=>({statusCode:201}) }", loader: "js" }));
      },
    }],
  });
  return bundle.outputFiles[0].text;
}

function execSql(db, sql) {
  const cleaned = sql.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "");
  const stmts = cleaned.split(/;\s*(?=\r?\n|$)/).map(s => s.trim()).filter(Boolean);
  return Promise.all(stmts.map(s => db.prepare(s).run()));
}

test("admin settings save succeeds and persists branding", async () => {
  const script = await createBundle();
  const mf = new Miniflare({
    modules: true,
    script,
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "settings-a", POSTS: "settings-a-posts" },
    r2Buckets: ["MEDIA"],
    bindings: { ROOT_DOMAIN: "blognice.com" },
  });
  const db = await mf.getD1Database("DB");
  const postsDb = await mf.getD1Database("POSTS");
  await execSql(db, fs.readFileSync("schema.sql", "utf8"));
  await execSql(postsDb, fs.readFileSync("schema-posts.sql", "utf8"));
  const now = Math.floor(Date.now() / 1000);
  await db.prepare("INSERT INTO accounts (id,email,pw_hash,created_at) VALUES (1,'a@a.com','h',?)").bind(now).run();
  await db.prepare("INSERT INTO tenants (id,public_id,slug,title,description,footer_name,accent_color,topics_json,social_links_json,navigation_links_json,browser_push_enabled,header_link_url,created_at) VALUES (1,'test1234','myblog','My Blog','tag','','#1a8917','[]','{}','[]',1,'/',?)").bind(now).run();
  await db.prepare("INSERT INTO memberships (account_id,tenant_id,role,created_at) VALUES (1,1,'owner',?)").bind(now).run();
  await db.prepare("INSERT INTO sessions (token,account_id,created_at,expires_at) VALUES ('sess',1,?,?)").bind(now, now + 86400).run();

  const params = new URLSearchParams({
    slug: "myblog",
    title: "My Updated Blog",
    description: "new tagline",
    header_link_url: "https://example.com",
    footer_name: "My Co",
    accent_color: "#ff0000",
    topics: "tech, travel",
    browser_push_enabled: "1",
    social_x: "https://x.com/user",
  });
  const res = await mf.dispatchFetch("https://www.blognice.com/admin/b/test1234/settings", {
    method: "POST",
    headers: { Origin: "https://www.blognice.com", Cookie: "bn_session=sess", "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Saved\./);

  const row = await db.prepare("SELECT slug,title,description,footer_name,accent_color,topics_json,social_links_json,header_link_url,browser_push_enabled FROM tenants WHERE id=1").first();
  assert.equal(row.slug, "myblog");
  assert.equal(row.title, "My Updated Blog");
  assert.equal(row.description, "new tagline");
  assert.equal(row.footer_name, "My Co");
  assert.equal(row.accent_color, "#ff0000");
  assert.equal(row.header_link_url, "https://example.com");
  assert.equal(row.browser_push_enabled, 1);
  assert.deepEqual(JSON.parse(row.topics_json), ["tech", "travel"]);
  assert.deepEqual(JSON.parse(row.social_links_json), { x: "https://x.com/user" });

  await mf.dispose();
});

test("admin settings validates accent colour and header link", async () => {
  const script = await createBundle();
  const mf = new Miniflare({
    modules: true,
    script,
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "settings-b", POSTS: "settings-b-posts" },
    r2Buckets: ["MEDIA"],
    bindings: { ROOT_DOMAIN: "blognice.com" },
  });
  const db = await mf.getD1Database("DB");
  const postsDb = await mf.getD1Database("POSTS");
  await execSql(db, fs.readFileSync("schema.sql", "utf8"));
  await execSql(postsDb, fs.readFileSync("schema-posts.sql", "utf8"));
  const now = Math.floor(Date.now() / 1000);
  await db.prepare("INSERT INTO accounts (id,email,pw_hash,created_at) VALUES (1,'a@a.com','h',?)").bind(now).run();
  await db.prepare("INSERT INTO tenants (id,public_id,slug,title,description,accent_color,topics_json,social_links_json,navigation_links_json,browser_push_enabled,header_link_url,created_at) VALUES (1,'test1234','myblog','My Blog','tag','#1a8917','[]','{}','[]',1,'/',?)").bind(now).run();
  await db.prepare("INSERT INTO memberships (account_id,tenant_id,role,created_at) VALUES (1,1,'owner',?)").bind(now).run();
  await db.prepare("INSERT INTO sessions (token,account_id,created_at,expires_at) VALUES ('sess',1,?,?)").bind(now, now + 86400).run();

  const badAccent = new URLSearchParams({ slug: "myblog", title: "t", description: "", header_link_url: "/", footer_name: "", accent_color: "invalid", topics: "" });
  const res1 = await mf.dispatchFetch("https://www.blognice.com/admin/b/test1234/settings", {
    method: "POST",
    headers: { Origin: "https://www.blognice.com", Cookie: "bn_session=sess", "Content-Type": "application/x-www-form-urlencoded" },
    body: badAccent.toString(),
  });
  assert.equal(res1.status, 400);
  const html1 = await res1.text();
  assert.match(html1, /Brand colour must be a six-digit hex value/);

  const badHeader = new URLSearchParams({ slug: "myblog", title: "t", description: "", header_link_url: "not-a-url", footer_name: "", accent_color: "#ff0000", topics: "" });
  const res2 = await mf.dispatchFetch("https://www.blognice.com/admin/b/test1234/settings", {
    method: "POST",
    headers: { Origin: "https://www.blognice.com", Cookie: "bn_session=sess", "Content-Type": "application/x-www-form-urlencoded" },
    body: badHeader.toString(),
  });
  assert.equal(res2.status, 400);
  const html2 = await res2.text();
  assert.match(html2, /Header link must be an absolute https URL or a path starting with/);

  await mf.dispose();
});

test("admin settings recovers when header_link_url column is missing", async () => {
  const script = await createBundle();
  const mf = new Miniflare({
    modules: true,
    script,
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "settings-c", POSTS: "settings-c-posts" },
    r2Buckets: ["MEDIA"],
    bindings: { ROOT_DOMAIN: "blognice.com" },
  });
  const db = await mf.getD1Database("DB");
  const postsDb = await mf.getD1Database("POSTS");
  let schema = fs.readFileSync("schema.sql", "utf8").replace(/.*header_link_url.*\n/, "");
  await execSql(db, schema);
  await execSql(postsDb, fs.readFileSync("schema-posts.sql", "utf8"));
  const now = Math.floor(Date.now() / 1000);
  await db.prepare("INSERT INTO accounts (id,email,pw_hash,created_at) VALUES (1,'a@a.com','h',?)").bind(now).run();
  await db.prepare("INSERT INTO tenants (id,public_id,slug,title,description,accent_color,topics_json,social_links_json,navigation_links_json,browser_push_enabled,created_at) VALUES (1,'test1234','myblog','My Blog','tag','#1a8917','[]','{}','[]',1,?)").bind(now).run();
  await db.prepare("INSERT INTO memberships (account_id,tenant_id,role,created_at) VALUES (1,1,'owner',?)").bind(now).run();
  await db.prepare("INSERT INTO sessions (token,account_id,created_at,expires_at) VALUES ('sess',1,?,?)").bind(now, now + 86400).run();

  const params = new URLSearchParams({ slug: "myblog", title: "Recovered", description: "ok", header_link_url: "/", footer_name: "", accent_color: "#00ff00", topics: "" });
  const res = await mf.dispatchFetch("https://www.blognice.com/admin/b/test1234/settings", {
    method: "POST",
    headers: { Origin: "https://www.blognice.com", Cookie: "bn_session=sess", "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  assert.equal(res.status, 200);
  const row = await db.prepare("SELECT header_link_url, title FROM tenants WHERE id=1").first();
  assert.equal(row.title, "Recovered");
  assert.equal(row.header_link_url, "/");

  await mf.dispose();
});
