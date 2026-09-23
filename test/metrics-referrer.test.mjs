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

test("metrics ingest keeps the bare-hostname referrer the beacon sends", async () => {
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

    const points = [];
    const env = {
      DB: indexDb, POSTS: postsDb, ROOT_DOMAIN: "blognice.test",
      METRICS: { writeDataPoint(dp) { points.push(dp); } },
    };
    const ctx = { waitUntil() {}, passThroughOnException() {} };
    const res = await blogniceApp.request(
      new Request("https://testblog.blognice.test/_blognice/metrics", {
        method: "POST",
        headers: {
          host: "testblog.blognice.test",
          origin: "https://testblog.blognice.test",
          "content-type": "application/json",
          "x-blognice-consent": "v1",
        },
        body: JSON.stringify({
          path: "/hello", referrer: "x.com", visitor: "123e4567-e89b-12d3-a456-426614174000",
          consent: "v1",
        }),
      }),
      undefined, env, ctx,
    );
    assert.equal(res.status, 204);
    assert.equal(points.length, 1);
    assert.equal(points[0].blobs[1], "x.com");
  } finally {
    await mf.dispose();
  }
});
