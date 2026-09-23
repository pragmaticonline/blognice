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

test("rss items carry post tags as categories", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: ["DB", "POSTS"],
  });
  try {
    const indexDb = await mf.getD1Database("DB");
    const postsDb = await mf.getD1Database("POSTS");
    await loadSchema(indexDb, "../schema.sql");
    await loadSchema(postsDb, "../schema-posts.sql");
    const now = Math.floor(Date.now() / 1000);
    await indexDb.prepare(
      "INSERT INTO tenants (id, public_id, slug, title, created_at) VALUES (1, 'testblog12', 'testblog', 'Test Blog', ?)",
    ).bind(now).run();
    await postsDb.prepare(
      "INSERT INTO posts (id, tenant_id, slug, title, body_md, tags_json, published, created_at, updated_at) VALUES (1, 1, 'hello', 'Hello', 'body', ?, 1, ?, ?)",
    ).bind(JSON.stringify(["ai", "code-search"]), now, now).run();

    const env = { DB: indexDb, POSTS: postsDb, ROOT_DOMAIN: "blognice.test" };
    const ctx = { waitUntil() {}, passThroughOnException() {} };
    const res = await blogniceApp.request(
      new Request("https://testblog.blognice.test/rss.xml", { headers: { host: "testblog.blognice.test" } }),
      undefined, env, ctx,
    );
    assert.equal(res.status, 200);
    const xml = await res.text();
    assert.match(xml, /<category>ai<\/category>/);
    assert.match(xml, /<category>code-search<\/category>/);
  } finally {
    await mf.dispose();
  }
});
