import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Miniflare } from "miniflare";
import {
  deleteDuplicatePosts,
  findDuplicatePosts,
  normalizePostTitle,
  unlinkAutopilotPostLinks,
} from "../src/autopilot-dedup.ts";

const postsSchema = readFileSync(new URL("../schema-posts.sql", import.meta.url), "utf8");

async function setup() {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { POSTS: "autopilot-dedup-posts", DB: "autopilot-dedup-index" },
  });
  const posts = await mf.getD1Database("POSTS");
  const index = await mf.getD1Database("DB");
  for (const statement of postsSchema
    .replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "")
    .split(/;\s*(?=\r?\n|$)/)
    .map((v) => v.trim())
    .filter(Boolean)) {
    await posts.prepare(statement).run();
  }
  await index
    .prepare(
      "CREATE TABLE autopilot_runs (id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL, source_url TEXT, source_title TEXT, post_id INTEGER, error TEXT)"
    )
    .run();
  return { mf, posts, index };
}

async function seedPost(posts, { tenant = 33, slug, title, published = 1, created }) {
  const res = await posts
    .prepare(
      "INSERT INTO posts (tenant_id, slug, title, body_md, tags_json, published, created_at, updated_at) VALUES (?, ?, ?, 'body', '[]', ?, ?, ?)"
    )
    .bind(tenant, slug, title, published, created, created)
    .run();
  return Number(res.meta.last_row_id);
}

test("normalizePostTitle folds case and whitespace", () => {
  assert.equal(normalizePostTitle("  Common  Household\nPet "), normalizePostTitle("common household pet"));
});

test("findDuplicatePosts keeps the earliest post and flags later same-title rows", async () => {
  const { mf, posts } = await setup();
  try {
    const first = await seedPost(posts, { slug: "a-1", title: "Common Household Pet", created: 100 });
    const second = await seedPost(posts, { slug: "a-2", title: "common  household PET", created: 200 });
    const third = await seedPost(posts, { slug: "a-3", title: "Unrelated Story", created: 300 });
    const dupes = await findDuplicatePosts(posts, 33);
    assert.deepEqual(dupes.map((d) => d.id), [second]);
    assert.equal(dupes[0].title, "common  household PET");
    void first;
    void third;
  } finally {
    await mf.dispose();
  }
});

test("findDuplicatePosts is tenant-scoped and ignores drafts", async () => {
  const { mf, posts } = await setup();
  try {
    await seedPost(posts, { slug: "t1", title: "Same Title", created: 100 });
    await seedPost(posts, { slug: "t2", title: "Same Title", created: 200, tenant: 34 });
    await seedPost(posts, { slug: "t3", title: "Same Title", created: 300, published: 0 });
    assert.deepEqual(await findDuplicatePosts(posts, 33), []);
    assert.deepEqual(await findDuplicatePosts(posts, 34), []);
  } finally {
    await mf.dispose();
  }
});

test("deleteDuplicatePosts removes only the given ids for the tenant", async () => {
  const { mf, posts } = await setup();
  try {
    const keep = await seedPost(posts, { slug: "k", title: "Keep Me", created: 100 });
    const dupe = await seedPost(posts, { slug: "d", title: "Keep Me", created: 200 });
    const other = await seedPost(posts, { slug: "o", title: "Keep Me", created: 200, tenant: 34 });
    assert.equal(await deleteDuplicatePosts(posts, 33, []), 0);
    assert.equal(await deleteDuplicatePosts(posts, 33, [dupe, 999999]), 1);
    const remaining = await posts.prepare("SELECT id FROM posts ORDER BY id").all();
    assert.deepEqual(remaining.results.map((r) => r.id), [keep, other]);
  } finally {
    await mf.dispose();
  }
});

test("unlinkAutopilotPostLinks nulls only the tenant's run links", async () => {
  const { mf, posts, index } = await setup();
  try {
    const dupe = await seedPost(posts, { slug: "d", title: "Linked", created: 200 });
    await index
      .prepare("INSERT INTO autopilot_runs (id, tenant_id, started_at, status, post_id) VALUES ('r1', 33, 1, 'success', ?), ('r2', 34, 1, 'success', ?)")
      .bind(dupe, dupe)
      .run();
    assert.equal(await unlinkAutopilotPostLinks(index, 33, [dupe]), 1);
    const rows = await index.prepare("SELECT id, post_id FROM autopilot_runs ORDER BY id").all();
    assert.deepEqual(
      rows.results.map((r) => [r.id, r.post_id]),
      [["r1", null], ["r2", dupe]]
    );
  } finally {
    await mf.dispose();
  }
});
