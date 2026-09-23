import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";
import { strFromU8, unzipSync } from "fflate";

const require = createRequire(import.meta.url);
for (const extension of [".html", ".svg"]) {
  require.extensions[extension] = (module, filename) => {
    module.exports = readFileSync(filename, "utf8");
  };
}

globalThis.caches = { default: { delete: async () => true, match: async () => undefined, put: async () => {} } };

async function loadSchema(db, path) {
  const schema = readFileSync(new URL(path, import.meta.url), "utf8");
  const statements = schema
    .replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "")
    .split(/;\s*(?=\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const st of statements) await db.prepare(st).run();
}

async function createCommentsTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, post_id INTEGER NOT NULL,
    parent_id INTEGER, author_name TEXT NOT NULL, email_hash TEXT NOT NULL,
    body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'approved',
    created_at INTEGER NOT NULL, decided_at INTEGER,
    UNIQUE (tenant_id, post_id, id))`).run();
}

test("one-click export bundles posts, pages, images, subscribers, comments", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: ["DB", "POSTS"],
    r2Buckets: ["MEDIA"],
  });
  try {
    const indexDb = await mf.getD1Database("DB");
    const postsDb = await mf.getD1Database("POSTS");
    const media = await mf.getR2Bucket("MEDIA");
    await loadSchema(indexDb, "../schema.sql");
    await loadSchema(postsDb, "../schema-posts.sql");
    await createCommentsTable(postsDb);
    const now = Math.floor(Date.now() / 1000);
    await indexDb.prepare(
      "INSERT INTO accounts (id, email, pw_hash, email_verified, created_at) VALUES (1, 'owner@example.com', 'x', 1, ?)",
    ).bind(now).run();
    await indexDb.prepare(
      "INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES ('export-session', 1, ?, ?)",
    ).bind(now, now + 3600).run();
    await indexDb.prepare(
      "INSERT INTO tenants (id, public_id, slug, title, created_at) VALUES (1, 'testblog12', 'testblog', 'Test Blog', ?)",
    ).bind(now).run();
    await indexDb.prepare(
      "INSERT INTO memberships (account_id, tenant_id, role, created_at) VALUES (1, 1, 'owner', ?)",
    ).bind(now).run();
    await postsDb.prepare(
      "INSERT INTO posts (id, tenant_id, slug, title, body_md, tags_json, published, created_at, updated_at, author_name) VALUES (1, 1, 'hello', 'Hello', ?, ?, 1, ?, ?, 'Owner')",
    ).bind("See ![pic](/media/1/pic.webp) here.", JSON.stringify(["ai"]), now, now).run();
    await postsDb.prepare(
      "INSERT INTO pages (id, tenant_id, slug, title, body_md, published, created_at, updated_at) VALUES (2, 1, 'about', 'About', 'About us.', 1, ?, ?)",
    ).bind(now, now).run();
    await postsDb.prepare(
      "INSERT INTO comments (id, tenant_id, post_id, parent_id, author_name, email_hash, body, status, created_at) VALUES (1, 1, 1, NULL, 'Reader', 'hash1', 'Nice post!', 'approved', ?)",
    ).bind(now).run();
    await indexDb.prepare(
      "INSERT INTO subscribers (tenant_id, email, token, created_at, confirmed_at) VALUES (1, 'reader@example.com', 'tok1', ?, ?)",
    ).bind(now, now).run();
    await media.put("1/pic.webp", new Uint8Array([1, 2, 3, 4]).buffer,
      { customMetadata: { originalKey: "1/pic.orig.png", originalName: "pic.webp" } });
    await media.put("1/pic.orig.png", new Uint8Array([5, 6, 7, 8]).buffer,
      { customMetadata: { originalName: "pic.png", derivativeOf: "1/pic.webp" } });

    const env = { DB: indexDb, POSTS: postsDb, MEDIA: media, ROOT_DOMAIN: "blognice.test" };
    const ctx = { waitUntil() {}, passThroughOnException() {} };
    const res = await blogniceApp.request(
      new Request("https://www.blognice.test/admin/b/testblog12/export.zip", {
        headers: { cookie: "bn_session=export-session" },
      }),
      undefined, env, ctx,
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/zip/);
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const names = Object.keys(files).sort();
    assert.ok(names.includes("posts/1-hello.md"), names.join(","));
    assert.ok(names.includes("pages/2-about.md"), names.join(","));
    assert.ok(names.includes("images/pic.orig.png"), names.join(","));
    assert.ok(!names.includes("images/pic.webp"), names.join(","));
    assert.ok(names.includes("subscribers.csv"), names.join(","));
    assert.ok(names.includes("comments.json"), names.join(","));

    const post = strFromU8(files["posts/1-hello.md"]);
    assert.match(post, /title: "Hello"/);
    assert.match(post, /tags: \["ai"\]/);
    assert.match(post, /images\/pic\.orig\.png/);
    assert.doesNotMatch(post, /\/media\//);
    const comments = JSON.parse(strFromU8(files["comments.json"]));
    assert.equal(comments.length, 1);
    assert.equal(comments[0].body, "Nice post!");
    assert.match(strFromU8(files["subscribers.csv"]), /reader@example\.com/);
  } finally {
    await mf.dispose();
  }
});
