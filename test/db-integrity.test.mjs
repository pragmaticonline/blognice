import assert from "node:assert/strict";
import test from "node:test";
import { Miniflare } from "miniflare";
import { deleteTenantPosts, tenantDb } from "../src/db.ts";

test("tenant database routing fails closed for an unbound shard", () => {
  const primary = {};
  assert.equal(tenantDb({ DB: {}, POSTS: primary }, { shard: "primary" }), primary);
  assert.throws(() => tenantDb({ DB: {}, POSTS: primary }, { shard: "missing" }), /Unknown posts shard/);
});

test("cross-database tenant cleanup removes posts and pages", async () => {
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: { POSTS: "tenant-cleanup" } });
  try {
    const db = await mf.getD1Database("POSTS");
    await db.exec(`
      CREATE TABLE posts (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL);
      CREATE TABLE pages (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL);
      INSERT INTO posts (id, tenant_id) VALUES (1, 7), (2, 8);
      INSERT INTO pages (id, tenant_id) VALUES (1, 7), (2, 8);
    `);
    await deleteTenantPosts({ DB: db, POSTS: db }, { id: 7, shard: "primary" });
    assert.equal((await db.prepare("SELECT COUNT(*) count FROM posts WHERE tenant_id = 7").first()).count, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) count FROM pages WHERE tenant_id = 7").first()).count, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) count FROM posts WHERE tenant_id = 8").first()).count, 1);
  } finally {
    await mf.dispose();
  }
});
