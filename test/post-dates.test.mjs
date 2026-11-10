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

const RAW_KEY = "bnk_testc0ffee000000000000000000000002";
const KEY_HASH = createHash("sha256").update(RAW_KEY).digest("hex");
const PAST_ISO = "2020-05-04T12:00:00+00:00";
const PAST_EPOCH = Math.floor(Date.parse(PAST_ISO) / 1000);
const FUTURE_ISO = "2999-01-01T00:00:00+00:00";

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
  });
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
  const env = { DB: indexDb, POSTS: postsDb, ROOT_DOMAIN: "blognice.test" };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const call = (method, path, body) => blogniceApp.request(
    new Request(`https://www.blognice.test${path}`, {
      method,
      headers: { authorization: `Bearer ${RAW_KEY}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    undefined, env, ctx,
  );
  return { mf, indexDb, postsDb, call, now };
}

test("POST with a past published_at backdates the display date", async (t) => {
  const { mf, postsDb, call } = await setup();
  try {
    const res = await call("POST", "/api/v1/blogs/testblog12/posts", {
      title: "Old news", body_md: "from the past", published_at: PAST_ISO,
    });
    assert.equal(res.status, 201);
    const post = (await res.json()).post;
    const row = await postsDb.prepare("SELECT created_at FROM posts WHERE id = ?").bind(post.id).first();
    assert.equal(row.created_at, PAST_EPOCH);
    const fetched = await (await call("GET", `/api/v1/blogs/testblog12/posts/${post.id}`)).json();
    assert.equal((fetched.post ?? fetched).created_at, PAST_EPOCH);
  } finally {
    await mf.dispose();
  }
});

test("POST rejects future, offset-less, null, and scheduled combinations", async (t) => {
  const { mf, call } = await setup();
  try {
    for (const bad of [
      { published_at: FUTURE_ISO },
      { published_at: "2020-05-04 12:00:00" },
      { published_at: "not a date" },
      { published_at: null },
    ]) {
      const res = await call("POST", "/api/v1/blogs/testblog12/posts", {
        title: "T", body_md: "B", ...bad,
      });
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
    const clash = await call("POST", "/api/v1/blogs/testblog12/posts", {
      title: "T", body_md: "B", published: false,
      published_at: PAST_ISO, scheduled_at: FUTURE_ISO,
    });
    assert.equal(clash.status, 400);
  } finally {
    await mf.dispose();
  }
});

test("PATCH published_at rewrites created_at and reorders the list", async (t) => {
  const { mf, postsDb, call } = await setup();
  try {
    const first = await (await call("POST", "/api/v1/blogs/testblog12/posts", {
      title: "Newer", body_md: "b",
    })).json();
    const second = await (await call("POST", "/api/v1/blogs/testblog12/posts", {
      title: "Backdated", body_md: "b",
    })).json();
    const patched = await call("PATCH", `/api/v1/blogs/testblog12/posts/${second.post.id}`, {
      published_at: PAST_ISO,
    });
    assert.equal(patched.status, 200);
    const row = await postsDb.prepare("SELECT created_at FROM posts WHERE id = ?").bind(second.post.id).first();
    assert.equal(row.created_at, PAST_EPOCH);
    const list = await (await call("GET", "/api/v1/blogs/testblog12/posts")).json();
    const slugs = list.posts.map((p) => p.slug);
    assert.deepEqual(slugs, [first.post.slug, second.post.slug]);

    const untouched = await call("PATCH", `/api/v1/blogs/testblog12/posts/${first.post.id}`, { title: "Newer v2" });
    assert.equal(untouched.status, 200);
    const kept = await postsDb.prepare("SELECT created_at FROM posts WHERE id = ?").bind(first.post.id).first();
    assert.ok(kept.created_at > PAST_EPOCH);

    for (const bad of [{ published_at: FUTURE_ISO }, { published_at: null }, { published_at: "yesterday" }]) {
      const res = await call("PATCH", `/api/v1/blogs/testblog12/posts/${first.post.id}`, bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
  } finally {
    await mf.dispose();
  }
});
