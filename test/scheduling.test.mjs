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

const RAW_KEY = "bnk_testsched0000000000000000000001";
const KEY_HASH = createHash("sha256").update(RAW_KEY).digest("hex");
const CONTRIBUTOR_KEY = "bnk_testsched0000000000000000000002";
const CONTRIBUTOR_HASH = createHash("sha256").update(CONTRIBUTOR_KEY).digest("hex");

const FUTURE_ISO = "2030-06-01T12:00:00Z";
const FUTURE_EPOCH = Math.floor(Date.parse(FUTURE_ISO) / 1000);
const FUTURE_OFFSET_ISO = "2030-07-01T12:00:00+02:00";
const FUTURE_OFFSET_EPOCH = Math.floor(Date.parse(FUTURE_OFFSET_ISO) / 1000);
const PAST_ISO = "2000-01-01T00:00:00Z";

let dbCounter = 0;

async function loadStatements(db, sql) {
  const statements = sql
    .replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "")
    .split(/;\s*(?=\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const st of statements) await db.prepare(st).run();
}

async function setup() {
  dbCounter += 1;
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: `sched-db-${dbCounter}`, POSTS: `sched-posts-${dbCounter}` },
  });
  const indexDb = await mf.getD1Database("DB");
  const postsDb = await mf.getD1Database("POSTS");
  await loadStatements(indexDb, readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  await loadStatements(postsDb, readFileSync(new URL("../schema-posts.sql", import.meta.url), "utf8"));
  return { mf, indexDb, postsDb };
}

async function seedOwnerBlog(indexDb, { push = true, deleted = false } = {}) {
  const now = Math.floor(Date.now() / 1000);
  await indexDb.prepare(
    "INSERT INTO accounts (id, email, pw_hash, billing_status, api_key_hash, created_at) VALUES (1, 'owner@example.com', 'x', 'active', ?, ?)",
  ).bind(KEY_HASH, now).run();
  await indexDb.prepare(
    "INSERT INTO tenants (id, public_id, slug, title, browser_push_enabled, deleted_at, created_at) VALUES (1, 'schedblog1', 'schedblog', 'Sched Blog', ?, ?, ?)",
  ).bind(push ? 1 : 0, deleted ? now : null, now).run();
  await indexDb.prepare(
    "INSERT INTO memberships (account_id, tenant_id, role, created_at) VALUES (1, 1, 'owner', ?)",
  ).bind(now).run();
  await indexDb.prepare(
    "INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES ('owner-session', 1, ?, ?)",
  ).bind(now, now + 3600).run();
  return now;
}

function queueStub() {
  const sent = [];
  return { sent, send: async (msg) => { sent.push(msg); } };
}

function testEnv(indexDb, postsDb, queues) {
  return {
    DB: indexDb,
    POSTS: postsDb,
    ROOT_DOMAIN: "blognice.test",
    EMAIL_FROM: "n@blognice.test",
    MAILNICE_API_KEY: "test",
    EMAIL_QUEUE: queues.email,
    VAPID_SUBJECT: "mailto:n@blognice.test",
    VAPID_PUBLIC_KEY: "x",
    VAPID_PRIVATE_KEY: "y",
    PUSH_QUEUE: queues.push,
  };
}

const testCtx = { waitUntil() {}, passThroughOnException() {} };

async function insertPost(postsDb, { slug, published = 0, scheduledAt = null, now }) {
  await postsDb.prepare(
    "INSERT INTO posts (tenant_id, slug, title, body_md, published, scheduled_at, created_at, updated_at) VALUES (1, ?, ?, 'body', ?, ?, ?, ?)",
  ).bind(slug, `Title ${slug}`, published, scheduledAt, now, now).run();
}

async function postRow(postsDb, slug) {
  return postsDb.prepare(
    "SELECT published, scheduled_at, subscriber_notification_sent, push_notification_sent FROM posts WHERE slug = ?",
  ).bind(slug).first();
}

test("tick publishes due scheduled posts exactly once with notifications", async () => {
  const { mf, indexDb, postsDb } = await setup();
  try {
    const now = await seedOwnerBlog(indexDb);
    const email = queueStub();
    const push = queueStub();
    const env = testEnv(indexDb, postsDb, { email, push });
    await insertPost(postsDb, { slug: "due", scheduledAt: now - 60, now });
    await insertPost(postsDb, { slug: "future", scheduledAt: now + 3600, now });
    await insertPost(postsDb, { slug: "draft", now });
    await insertPost(postsDb, { slug: "live", published: 1, now });

    const { publishDueScheduledPosts } = await import("../src/index.ts");
    assert.equal(await publishDueScheduledPosts(env, now), 1);

    const due = await postRow(postsDb, "due");
    assert.equal(due.published, 1);
    assert.equal(due.scheduled_at, null);
    assert.equal(due.subscriber_notification_sent, 1);
    assert.equal(due.push_notification_sent, 1);
    assert.equal(email.sent.length, 1);
    assert.equal(email.sent[0].kind, "email-fanout");
    assert.equal(push.sent.length, 1);
    assert.equal(push.sent[0].kind, "push-fanout");

    const future = await postRow(postsDb, "future");
    assert.equal(future.published, 0);
    assert.equal(future.scheduled_at, now + 3600);
    const draft = await postRow(postsDb, "draft");
    assert.equal(draft.published, 0);
    assert.equal(draft.scheduled_at, null);

    // A second tick finds nothing due: no double publish, no double notify.
    assert.equal(await publishDueScheduledPosts(env, now), 0);
    assert.equal(email.sent.length, 1);
    assert.equal(push.sent.length, 1);
    assert.equal((await postRow(postsDb, "due")).subscriber_notification_sent, 1);
  } finally {
    await mf.dispose();
  }
});

test("tick skips scheduled posts on soft-deleted blogs", async () => {
  const { mf, indexDb, postsDb } = await setup();
  try {
    const now = await seedOwnerBlog(indexDb, { deleted: true });
    const env = testEnv(indexDb, postsDb, { email: queueStub(), push: queueStub() });
    await insertPost(postsDb, { slug: "due", scheduledAt: now - 60, now });

    const { publishDueScheduledPosts } = await import("../src/index.ts");
    assert.equal(await publishDueScheduledPosts(env, now), 0);
    const row = await postRow(postsDb, "due");
    assert.equal(row.published, 0);
    assert.equal(row.scheduled_at, now - 60);
  } finally {
    await mf.dispose();
  }
});

test("API creates scheduled drafts and validates schedule input", async () => {
  const { mf, indexDb, postsDb } = await setup();
  try {
    await seedOwnerBlog(indexDb);
    const { blogniceApp } = await import("../src/index.ts");
    const env = testEnv(indexDb, postsDb, { email: queueStub(), push: queueStub() });
    const post = (body, key = RAW_KEY) => blogniceApp.request(
      new Request("https://www.blognice.test/api/v1/blogs/schedblog1/posts", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      undefined, env, testCtx,
    );

    // A schedule time implies a draft.
    const implied = await post({ title: "Implied", body_md: "b", scheduled_at: FUTURE_ISO });
    assert.equal(implied.status, 201);
    assert.deepEqual((await implied.json()).post, {
      id: 1, slug: "implied", title: "Implied", featured_image_key: null, tags: [],
      author_name: null, author_visible: true, published: false, scheduled_at: FUTURE_EPOCH,
    });

    const explicit = await post({ title: "Explicit", body_md: "b", published: false, scheduled_at: FUTURE_OFFSET_ISO });
    assert.equal(explicit.status, 201);
    assert.equal((await explicit.json()).post.scheduled_at, FUTURE_OFFSET_EPOCH);

    const combo = await post({ title: "Combo", body_md: "b", published: true, scheduled_at: FUTURE_ISO });
    assert.equal(combo.status, 400);
    assert.match((await combo.json()).error, /cannot combine published:true with scheduled_at/);

    const past = await post({ title: "Past", body_md: "b", published: false, scheduled_at: PAST_ISO });
    assert.equal(past.status, 400);
    assert.match((await past.json()).error, /must be in the future/);

    const naive = await post({ title: "Naive", body_md: "b", published: false, scheduled_at: "2030-01-01T10:00" });
    assert.equal(naive.status, 400);
    assert.match((await naive.json()).error, /explicit timezone offset/);

    const listed = await blogniceApp.request(
      new Request("https://www.blognice.test/api/v1/blogs/schedblog1/posts", {
        headers: { authorization: `Bearer ${RAW_KEY}` },
      }),
      undefined, env, testCtx,
    );
    assert.equal(listed.status, 200);
    const rows = (await listed.json()).posts;
    assert.equal(rows.find((p) => p.slug === "implied").scheduled_at, FUTURE_EPOCH);
    assert.equal(rows.find((p) => p.slug === "explicit").scheduled_at, FUTURE_OFFSET_EPOCH);

    const detail = await blogniceApp.request(
      new Request("https://www.blognice.test/api/v1/blogs/schedblog1/posts/1", {
        headers: { authorization: `Bearer ${RAW_KEY}` },
      }),
      undefined, env, testCtx,
    );
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).post.scheduled_at, FUTURE_EPOCH);
  } finally {
    await mf.dispose();
  }
});

test("API PATCH schedules, reschedules, clears, and publishes over a schedule", async () => {
  const { mf, indexDb, postsDb } = await setup();
  try {
    await seedOwnerBlog(indexDb);
    const { blogniceApp } = await import("../src/index.ts");
    const env = testEnv(indexDb, postsDb, { email: queueStub(), push: queueStub() });
    const patch = (id, body) => blogniceApp.request(
      new Request(`https://www.blognice.test/api/v1/blogs/schedblog1/posts/${id}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${RAW_KEY}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      undefined, env, testCtx,
    );
    const created = await blogniceApp.request(
      new Request("https://www.blognice.test/api/v1/blogs/schedblog1/posts", {
        method: "POST",
        headers: { authorization: `Bearer ${RAW_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ title: "Patchable", body_md: "b", published: false }),
      }),
      undefined, env, testCtx,
    );
    assert.equal(created.status, 201);

    const scheduled = await patch(1, { scheduled_at: FUTURE_ISO });
    assert.equal(scheduled.status, 200);
    assert.equal((await scheduled.json()).post.scheduled_at, FUTURE_EPOCH);

    const rescheduled = await patch(1, { scheduled_at: FUTURE_OFFSET_ISO });
    assert.equal(rescheduled.status, 200);
    assert.equal((await rescheduled.json()).post.scheduled_at, FUTURE_OFFSET_EPOCH);

    // Unrelated edits keep the schedule.
    const retitled = await patch(1, { title: "Patchable v2" });
    assert.equal(retitled.status, 200);
    assert.equal((await retitled.json()).post.scheduled_at, FUTURE_OFFSET_EPOCH);

    const cleared = await patch(1, { scheduled_at: null });
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json()).post.scheduled_at, null);

    // Publishing now clears any schedule.
    assert.equal((await patch(1, { scheduled_at: FUTURE_ISO })).status, 200);
    const published = await patch(1, { published: true });
    assert.equal(published.status, 200);
    const publishedPost = (await published.json()).post;
    assert.equal(publishedPost.published, true);
    assert.equal(publishedPost.scheduled_at, null);

    // A live post cannot be scheduled without unpublishing first.
    const liveSchedule = await patch(1, { scheduled_at: FUTURE_ISO });
    assert.equal(liveSchedule.status, 400);
    assert.match((await liveSchedule.json()).error, /set published:false/);

    const past = await patch(1, { published: false, scheduled_at: PAST_ISO });
    assert.equal(past.status, 400);
    assert.match((await past.json()).error, /must be in the future/);
  } finally {
    await mf.dispose();
  }
});

test("API scheduling requires the publish permission", async () => {
  const { mf, indexDb, postsDb } = await setup();
  try {
    const now = await seedOwnerBlog(indexDb);
    await indexDb.prepare(
      "INSERT INTO accounts (id, email, pw_hash, billing_status, api_key_hash, created_at) VALUES (2, 'contrib@example.com', 'x', 'active', ?, ?)",
    ).bind(CONTRIBUTOR_HASH, now).run();
    await indexDb.prepare(
      "INSERT INTO memberships (account_id, tenant_id, role, created_at) VALUES (2, 1, 'contributor', ?)",
    ).bind(now).run();
    const { blogniceApp } = await import("../src/index.ts");
    const env = testEnv(indexDb, postsDb, { email: queueStub(), push: queueStub() });
    const request = (method, path, body) => blogniceApp.request(
      new Request(`https://www.blognice.test${path}`, {
        method,
        headers: { authorization: `Bearer ${CONTRIBUTOR_KEY}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      undefined, env, testCtx,
    );

    const denied = await request("POST", "/api/v1/blogs/schedblog1/posts", {
      title: "Nope", body_md: "b", published: false, scheduled_at: FUTURE_ISO,
    });
    assert.equal(denied.status, 403);

    // Plain drafts are still fine without the publish permission.
    const draft = await request("POST", "/api/v1/blogs/schedblog1/posts", {
      title: "Plain", body_md: "b", published: false,
    });
    assert.equal(draft.status, 201);

    const patchDenied = await request("PATCH", "/api/v1/blogs/schedblog1/posts/1", { scheduled_at: FUTURE_ISO });
    assert.equal(patchDenied.status, 403);
  } finally {
    await mf.dispose();
  }
});

test("admin editor saves scheduled drafts and publishes over schedules", async () => {
  const { mf, indexDb, postsDb } = await setup();
  try {
    await seedOwnerBlog(indexDb);
    const { blogniceApp } = await import("../src/index.ts");
    // No email bindings: with email enabled, unverified owners redirect to /verify-pending.
    const env = { DB: indexDb, POSTS: postsDb, ROOT_DOMAIN: "blognice.test" };
    const save = (fields, id) => {
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) form.set(key, value);
      return blogniceApp.request(
        new Request(`https://www.blognice.test/admin/b/schedblog1/save${id ? `?id=${id}` : ""}`, {
          method: "POST",
          headers: {
            host: "www.blognice.test",
            Origin: "https://www.blognice.test",
            cookie: "bn_session=owner-session",
          },
          body: form,
        }),
        undefined, env, testCtx,
      );
    };

    const scheduled = await save({ title: "Admin scheduled", slug: "admin-scheduled", body_md: "b", scheduled_at: FUTURE_ISO });
    assert.equal(scheduled.status, 302);
    const row = await postRow(postsDb, "admin-scheduled");
    assert.equal(row.published, 0);
    assert.equal(row.scheduled_at, FUTURE_EPOCH);

    // Publishing now clears the schedule even when the box still holds a time.
    const id = (await postsDb.prepare("SELECT id FROM posts WHERE slug = 'admin-scheduled'").first()).id;
    const published = await save({ title: "Admin scheduled", slug: "admin-scheduled", body_md: "b", published: "on", scheduled_at: FUTURE_ISO }, id);
    assert.equal(published.status, 302);
    const live = await postRow(postsDb, "admin-scheduled");
    assert.equal(live.published, 1);
    assert.equal(live.scheduled_at, null);

    // Past times are rejected with the editor re-rendered.
    const past = await save({ title: "Admin past", slug: "admin-past", body_md: "b", scheduled_at: PAST_ISO });
    assert.equal(past.status, 400);
    assert.match(await past.text(), /must be in the future/);

    // An empty box saves a plain draft.
    const plain = await save({ title: "Admin plain", slug: "admin-plain", body_md: "b", scheduled_at: "" });
    assert.equal(plain.status, 302);
    const draft = await postRow(postsDb, "admin-plain");
    assert.equal(draft.published, 0);
    assert.equal(draft.scheduled_at, null);
  } finally {
    await mf.dispose();
  }
});

test("editor renders the schedule control and its scripts compile", async () => {
  const { editorPage } = await import("../src/admin.ts");
  const account = { id: 1, email: "owner@example.com", billing_status: "active" };
  const tenant = { id: 1, public_id: "schedblog1", slug: "schedblog", title: "Sched Blog", membership_role: "owner" };
  const scheduled = editorPage(account, tenant, "blognice.test",
    { id: 3, title: "D", slug: "d", body_md: "B", tags_json: "[]", published: 0, scheduled_at: FUTURE_EPOCH });
  assert.match(scheduled, /id="scheduled-at-local" type="datetime-local"/);
  const expectedIso = new Date(FUTURE_EPOCH * 1000).toISOString().replace(/\./g, "\\.");
  assert.match(scheduled, new RegExp(`id="scheduled-at" name="scheduled_at"[^>]*value="${expectedIso}"`));
  assert.match(scheduled, /scheduledToLocal\(\)/);
  assert.match(scheduled, /scheduledLocal\.addEventListener\("input", scheduledToHidden\)/);

  const draft = editorPage(account, tenant, "blognice.test",
    { id: 4, title: "D", slug: "d", body_md: "B", tags_json: "[]", published: 0 });
  assert.match(draft, /id="scheduled-at" name="scheduled_at"[^>]*value=""/);

  for (const match of scheduled.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(match[1]));
});

test("dashboard marks scheduled posts distinctly from drafts", async () => {
  const { postListPage } = await import("../src/admin.ts");
  const account = { id: 1, email: "owner@example.com", billing_status: "active" };
  const tenant = { id: 1, public_id: "schedblog1", slug: "schedblog", title: "Sched Blog" };
  const post = (overrides) => ({
    id: 1, tenant_id: 1, slug: "s", title: "T", featured_image_key: null, audio_key: null,
    body_md: "B", tags_json: "[]", published: 0, created_at: 1, updated_at: 1, ...overrides,
  });
  const html = postListPage(account, tenant, [
    post({ id: 1, slug: "live", published: 1 }),
    post({ id: 2, slug: "queued", scheduled_at: FUTURE_EPOCH }),
    post({ id: 3, slug: "draft", scheduled_at: null }),
  ], "blognice.test");
  assert.match(html, />Published</);
  assert.match(html, />Scheduled</);
  assert.match(html, />Draft</);
});

test("migration 091 applies to a pre-091 posts table; tick is wired to both crons", async () => {
  const migration = readFileSync(new URL("../migrations/091-post-scheduling.sql", import.meta.url), "utf8");
  assert.match(migration, /ALTER TABLE posts ADD COLUMN scheduled_at INTEGER/);
  assert.match(migration, /idx_posts_scheduled/);
  const postsSchema = readFileSync(new URL("../schema-posts.sql", import.meta.url), "utf8");
  assert.match(postsSchema, /scheduled_at INTEGER/);
  assert.match(postsSchema, /CREATE INDEX idx_posts_scheduled ON posts \(published, scheduled_at\)/);

  dbCounter += 1;
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: `sched-db-${dbCounter}` },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.prepare("CREATE TABLE posts (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, slug TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 1)").run();
    await loadStatements(db, migration);
    await db.prepare("SELECT scheduled_at FROM posts").all();
    const index = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_posts_scheduled'").first();
    assert.equal(index.name, "idx_posts_scheduled");
  } finally {
    await mf.dispose();
  }

  const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(indexSource, /ctx\.waitUntil\(publishDueScheduledPosts\(env, now\)\)/);
  assert.match(indexSource, /publishDueScheduledPosts\(env, now\), archivePreviousDay/);
});
