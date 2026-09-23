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

globalThis.caches = { default: { delete: async () => true, match: async () => undefined, put: async () => {} } };

const RAW_KEY = "bnk_testc0ffee000000000000000000000002";
const KEY_HASH = createHash("sha256").update(RAW_KEY).digest("hex");
// Magic bytes only: detectedImageType sniffs the header, not full decodes.
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2, 3]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function loadSchema(db, path) {
  const schema = readFileSync(new URL(path, import.meta.url), "utf8");
  const statements = schema
    .replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "")
    .split(/;\s*(?=\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const st of statements) await db.prepare(st).run();
}

async function setup() {
  const { blogniceApp } = await import("../src/index.ts");
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
  return { blogniceApp, mf, env: { DB: indexDb, POSTS: postsDb, MEDIA: media, ROOT_DOMAIN: "blognice.test" } };
}

test("media upload keeps the original alongside the optimized file", async () => {
  const { blogniceApp, mf, env } = await setup();
  try {
    const ctx = { waitUntil() {}, passThroughOnException() {} };
    const form = new FormData();
    form.append("file", new Blob([WEBP], { type: "image/webp" }), "pic.webp");
    form.append("original", new Blob([PNG], { type: "image/png" }), "pic.png");
    const res = await blogniceApp.request(
      new Request("https://www.blognice.test/api/v1/blogs/testblog12/media", {
        method: "POST",
        headers: { authorization: `Bearer ${RAW_KEY}` },
        body: form,
      }),
      undefined, env, ctx,
    );
    assert.equal(res.status, 201);
    const created = await res.json();

    const list = await blogniceApp.request(
      new Request("https://www.blognice.test/api/v1/blogs/testblog12/media", {
        headers: { authorization: `Bearer ${RAW_KEY}` },
      }),
      undefined, env, ctx,
    );
    const items = (await list.json()).media;
    assert.equal(items.length, 1);
    assert.ok(items[0].originalKey, "optimized item links its original");
    assert.match(items[0].originalKey, /\.orig\.png$/);

    const stored = await env.MEDIA.get(items[0].originalKey);
    assert.ok(stored, "original bytes stored");
    assert.deepEqual(new Uint8Array(await stored.arrayBuffer()), PNG);
    assert.equal(created.key, items[0].key);
  } finally {
    await mf.dispose();
  }
});

test("media upload without an original stays single-file", async () => {
  const { blogniceApp, mf, env } = await setup();
  try {
    const ctx = { waitUntil() {}, passThroughOnException() {} };
    const form = new FormData();
    form.append("file", new Blob([WEBP], { type: "image/webp" }), "pic.webp");
    const res = await blogniceApp.request(
      new Request("https://www.blognice.test/api/v1/blogs/testblog12/media", {
        method: "POST",
        headers: { authorization: `Bearer ${RAW_KEY}` },
        body: form,
      }),
      undefined, env, ctx,
    );
    assert.equal(res.status, 201);
    const list = await blogniceApp.request(
      new Request("https://www.blognice.test/api/v1/blogs/testblog12/media", {
        headers: { authorization: `Bearer ${RAW_KEY}` },
      }),
      undefined, env, ctx,
    );
    const items = (await list.json()).media;
    assert.equal(items.length, 1);
    assert.equal(items[0].originalKey ?? null, null);
  } finally {
    await mf.dispose();
  }
});
