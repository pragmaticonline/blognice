import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
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

const OWNER_KEY = "bnk_testownerkey1234567890abcdef";
const EDITOR_KEY = "bnk_testeditorkey1234567890abcdef";
const apiHash = (key) => createHash("sha256").update(key).digest("hex");
const ORIGIN = "https://www.blognice.com";

async function setup() {
  const script = await createBundle();
  const mf = new Miniflare({
    modules: true,
    script,
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "blog-delete", POSTS: "blog-delete-posts" },
    r2Buckets: ["MEDIA"],
    bindings: { ROOT_DOMAIN: "blognice.com" },
  });
  const db = await mf.getD1Database("DB");
  const postsDb = await mf.getD1Database("POSTS");
  await execSql(db, fs.readFileSync("schema.sql", "utf8"));
  await execSql(postsDb, fs.readFileSync("schema-posts.sql", "utf8"));
  const now = Math.floor(Date.now() / 1000);
  await db.prepare("INSERT INTO accounts (id,email,pw_hash,created_at) VALUES (1,'owner@x.com','h',?)").bind(now).run();
  await db.prepare("INSERT INTO accounts (id,email,pw_hash,billing_status,api_key_hash,created_at) VALUES (2,'editor@x.com','h','active',?,?)").bind(apiHash(EDITOR_KEY), now).run();
  await db.prepare("UPDATE accounts SET billing_status='active', api_key_hash=? WHERE id=1").bind(apiHash(OWNER_KEY)).run();
  await db.prepare("INSERT INTO tenants (id,public_id,slug,title,description,footer_name,accent_color,topics_json,social_links_json,navigation_links_json,browser_push_enabled,header_link_url,created_at) VALUES (1,'test1234','myblog','My Blog','tag','','#1a8917','[]','{}','[]',1,'/',?)").bind(now).run();
  await db.prepare("INSERT INTO memberships (account_id,tenant_id,role,created_at) VALUES (1,1,'owner',?),(2,1,'editor',?)").bind(now, now).run();
  await db.prepare("INSERT INTO sessions (token,account_id,created_at,expires_at) VALUES ('sess',1,?,?),('sess2',2,?,?)").bind(now, now + 86400, now, now + 86400).run();
  return { mf, db, now };
}

const cookie = (sess) => ({ Cookie: `bn_session=${sess}` });

test("delete confirm page is owner-only and asks for the typed title", async () => {
  const { mf } = await setup();
  try {
    const res = await mf.dispatchFetch(`${ORIGIN}/admin/b/test1234/delete`, { headers: cookie("sess") });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /type the blog title exactly/);
    assert.match(html, /<code>My Blog<\/code>/);
    assert.match(html, /name="confirm"/);
    assert.match(html, /name="understand"/);
    const denied = await mf.dispatchFetch(`${ORIGIN}/admin/b/test1234/delete`, { headers: cookie("sess2") });
    assert.equal(denied.status, 403);
  } finally {
    await mf.dispose();
  }
});

test("wrong title or missing checkbox keeps the blog", async () => {
  const { mf, db } = await setup();
  try {
    const post = (params) => mf.dispatchFetch(`${ORIGIN}/admin/b/test1234/delete`, {
      method: "POST",
      headers: { Origin: ORIGIN, ...cookie("sess"), "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const wrong = await post(new URLSearchParams({ understand: "1", confirm: "Wrong Title" }));
    assert.equal(wrong.status, 400);
    assert.match(await wrong.text(), /does not match/);
    const nocheck = await post(new URLSearchParams({ confirm: "My Blog" }));
    assert.equal(nocheck.status, 400);
    const row = await db.prepare("SELECT deleted_at FROM tenants WHERE id=1").first();
    assert.equal(row.deleted_at, null);
  } finally {
    await mf.dispose();
  }
});

test("correct title soft-deletes: page gone, lists clean, slot freed", async () => {
  const { mf, db } = await setup();
  try {
    const res = await mf.dispatchFetch(`${ORIGIN}/admin/b/test1234/delete`, {
      method: "POST",
      headers: { Origin: ORIGIN, ...cookie("sess"), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ understand: "1", confirm: "My Blog" }).toString(),
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location") || "", /\/admin\?list=1/);
    const row = await db.prepare("SELECT deleted_at, slug FROM tenants WHERE id=1").first();
    assert.ok(row.deleted_at > 0);
    assert.equal(row.slug, "myblog");

    const settings = await mf.dispatchFetch(`${ORIGIN}/admin/b/test1234/settings`, { headers: cookie("sess"), redirect: "manual" });
    assert.equal(settings.status, 302);

    const pub = await mf.dispatchFetch("https://myblog.blognice.com/");
    assert.equal(pub.status, 404);

    const list = await mf.dispatchFetch(`${ORIGIN}/admin?list=1`, { headers: cookie("sess") });
    assert.doesNotMatch(await list.text(), /My Blog/);
    const json = await mf.dispatchFetch(`${ORIGIN}/admin/blogs.json`, { headers: cookie("sess") });
    assert.deepEqual((await json.json()).blogs, []);

    const me = await mf.dispatchFetch(`${ORIGIN}/api/v1/me`, { headers: { Authorization: `Bearer ${OWNER_KEY}` } });
    assert.deepEqual((await me.json()).blogs, []);

    // The freed slot lets this free-plan owner create again.
    const create = await mf.dispatchFetch(`${ORIGIN}/admin/new-blog`, {
      method: "POST",
      headers: { ...cookie("sess"), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ slug: "second", title: "Second" }).toString(),
      redirect: "manual",
    });
    assert.equal(create.status, 302);
    const live = await db.prepare("SELECT COUNT(*) AS n FROM tenants WHERE deleted_at IS NULL").first();
    assert.equal(live.n, 1);
  } finally {
    await mf.dispose();
  }
});

test("API delete requires the exact title and owner role", async () => {
  const { mf, db } = await setup();
  try {
    const del = (key, body) => mf.dispatchFetch(`${ORIGIN}/api/v1/blogs/test1234`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal((await del(OWNER_KEY, {})).status, 400);
    const wrong = await del(OWNER_KEY, { confirm: "Nope" });
    assert.equal(wrong.status, 400);
    const editor = await del(EDITOR_KEY, { confirm: "My Blog" });
    assert.equal(editor.status, 403);
    const ok = await del(OWNER_KEY, { confirm: "My Blog" });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { deleted: true, slug: "myblog" });
    const row = await db.prepare("SELECT deleted_at FROM tenants WHERE id=1").first();
    assert.ok(row.deleted_at > 0);
    const again = await del(OWNER_KEY, { confirm: "My Blog" });
    assert.equal(again.status, 404);
  } finally {
    await mf.dispose();
  }
});
