import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

// purgeTenant touches the Cache API; stub it outside workerd.
globalThis.caches = { default: { delete: async () => true } };

const RAW_KEY = "bnk_testc0ffee000000000000000000000001";
const KEY_HASH = createHash("sha256").update(RAW_KEY).digest("hex");

async function loadSchema(db, path) {
  const schema = readFileSync(new URL(path, import.meta.url), "utf8");
  const statements = schema
    .replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "")
    .split(/;\s*(?=\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const st of statements) await db.prepare(st).run();
}

test("PATCH without tags preserves stored tags; explicit tags normalize", async () => {
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
      "INSERT INTO accounts (id, email, pw_hash, billing_status, api_key_hash, created_at) VALUES (1, 'owner@example.com', 'x', 'active', ?, ?)",
    ).bind(KEY_HASH, now).run();
    await indexDb.prepare(
      "INSERT INTO tenants (id, public_id, slug, title, created_at) VALUES (1, 'testblog12', 'testblog', 'Test Blog', ?)",
    ).bind(now).run();
    await indexDb.prepare(
      "INSERT INTO memberships (account_id, tenant_id, role, created_at) VALUES (1, 1, 'owner', ?)",
    ).bind(now).run();
    await postsDb.prepare(
      "INSERT INTO posts (id, tenant_id, slug, title, body_md, tags_json, published, created_at, updated_at) VALUES (1, 1, 'hello', 'Hello', 'body', ?, 0, ?, ?)",
    ).bind(JSON.stringify(["ai", "code-search"]), now, now).run();

    const env = { DB: indexDb, POSTS: postsDb, ROOT_DOMAIN: "blognice.test" };
    const ctx = { waitUntil() {}, passThroughOnException() {} };
    const patch = (body) => blogniceApp.request(
      new Request("https://www.blognice.test/api/v1/blogs/testblog12/posts/1", {
        method: "PATCH",
        headers: { authorization: `Bearer ${RAW_KEY}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      undefined, env, ctx,
    );

    const kept = await patch({ title: "Hello edited" });
    assert.equal(kept.status, 200);
    assert.deepEqual((await kept.json()).post.tags, ["ai", "code-search"]);
    assert.equal(
      (await postsDb.prepare("SELECT tags_json AS j FROM posts WHERE id = 1").first()).j,
      JSON.stringify(["ai", "code-search"]),
    );

    const renamed = await patch({ tags: ["  New Tag ", "UPPER", "new tag"] });
    assert.equal(renamed.status, 200);
    assert.deepEqual((await renamed.json()).post.tags, ["new tag", "upper"]);
  } finally {
    await mf.dispose();
  }
});
