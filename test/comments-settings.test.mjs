import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const require = createRequire(import.meta.url);
for (const extension of [".html", ".svg"]) {
  require.extensions[extension] = (module, filename) => {
    module.exports = readFileSync(filename, "utf8");
  };
}

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

function tables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
}

test("comments schema ships in fresh installs and migrates existing posts databases", () => {
  // Fresh installs get the tables from schema-posts.sql.
  const fresh = new DatabaseSync(":memory:");
  fresh.exec(read("schema-posts.sql"));
  for (const table of ["comments", "comment_identities", "comment_attempts"]) {
    assert.ok(tables(fresh).includes(table), `fresh schema has ${table}`);
  }
  const cols = fresh.prepare("PRAGMA table_info(comments)").all().map((row) => row.name);
  assert.ok(cols.includes("parent_id"), "comments tree supports replies");

  // Migration 069 applies cleanly (idempotent) and creates the same tables.
  const migrated = new DatabaseSync(":memory:");
  migrated.exec(read("migrations/069-comments.sql"));
  migrated.exec(read("migrations/069-comments.sql"));
  for (const table of ["comments", "comment_identities", "comment_attempts"]) {
    assert.ok(tables(migrated).includes(table), `migration creates ${table}`);
  }

  // Fresh index databases carry the per-blog flag; migration 070 adds it.
  assert.match(read("schema.sql"), /comments_enabled/);
  const tenants = new DatabaseSync(":memory:");
  tenants.exec("CREATE TABLE tenants (id INTEGER PRIMARY KEY, slug TEXT)");
  tenants.exec(read("migrations/070-tenant-comments-enabled.sql"));
  const tenantCols = tenants.prepare("PRAGMA table_info(tenants)").all().map((row) => row.name);
  assert.ok(tenantCols.includes("comments_enabled"), "migration adds comments_enabled");

  // Comments are on by default: fresh schemas default the flag to 1, both
  // blog-creation inserts set it explicitly (existing installs keep a 0
  // column default), and migration 080 flips every blog that lacks it.
  assert.match(read("schema.sql"), /comments_enabled INTEGER NOT NULL DEFAULT 1/);
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.equal(
    (src.match(/INSERT INTO tenants \(public_id, slug, title, description, shard, browser_push_enabled, comments_enabled, created_at\)/g) || []).length,
    2, "both tenant inserts enable comments",
  );
  const indexDb = new DatabaseSync(":memory:");
  indexDb.exec("CREATE TABLE tenants (id INTEGER PRIMARY KEY, slug TEXT, comments_enabled INTEGER NOT NULL DEFAULT 0)");
  indexDb.exec("INSERT INTO tenants (id, slug, comments_enabled) VALUES (1, 'off', 0), (2, 'on', 1)");
  indexDb.exec(read("migrations/080-comments-default-on.sql"));
  assert.deepEqual(
    indexDb.prepare("SELECT id, comments_enabled AS enabled FROM tenants ORDER BY id").all().map((r) => ({ ...r })),
    [{ id: 1, enabled: 1 }, { id: 2, enabled: 1 }],
  );

  // Reader-chosen avatar hues ride on the comment row: fresh schemas carry
  // the column and migration 072 adds it idempotently to existing tables.
  const freshCols = fresh.prepare("PRAGMA table_info(comments)").all().map((row) => row.name);
  assert.ok(freshCols.includes("avatar_hue"), "fresh schema has avatar_hue");
  migrated.exec(read("migrations/072-comment-avatar-hue.sql"));
  const migratedCols = migrated.prepare("PRAGMA table_info(comments)").all().map((row) => row.name);
  assert.ok(migratedCols.includes("avatar_hue"), "migration adds avatar_hue");

  // Reader profile photos ride on identity and comment rows.
  migrated.exec(read("migrations/074-comment-avatar-key.sql"));
  const photoCols = (table) => migrated.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  assert.ok(photoCols("comments").includes("avatar_key"), "migration adds comments.avatar_key");
  assert.ok(photoCols("comment_identities").includes("avatar_key"), "migration adds identities.avatar_key");
  assert.ok(fresh.prepare("PRAGMA table_info(comments)").all().map((row) => row.name).includes("avatar_key"), "fresh schema has comments.avatar_key");
  assert.ok(fresh.prepare("PRAGMA table_info(comment_identities)").all().map((row) => row.name).includes("avatar_key"), "fresh schema has identities.avatar_key");

  // Reader website addresses ride on identity and comment rows.
  migrated.exec(read("migrations/075-comment-website.sql"));
  assert.ok(photoCols("comments").includes("website"), "migration adds comments.website");
  assert.ok(photoCols("comment_identities").includes("website"), "migration adds identities.website");
  assert.ok(fresh.prepare("PRAGMA table_info(comments)").all().map((row) => row.name).includes("website"), "fresh schema has comments.website");
  assert.ok(fresh.prepare("PRAGMA table_info(comment_identities)").all().map((row) => row.name).includes("website"), "fresh schema has identities.website");

  // Comment likes/dislikes: counters on the row, one vote per reader.
  migrated.exec(read("migrations/076-comment-votes.sql"));
  const migratedVoteCols = (table) => migrated.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  assert.ok(migratedVoteCols("comments").includes("likes"), "migration adds comments.likes");
  assert.ok(migratedVoteCols("comments").includes("dislikes"), "migration adds comments.dislikes");
  assert.ok(migratedVoteCols("comment_votes").includes("vote"), "migration creates comment_votes");
  assert.ok(fresh.prepare("PRAGMA table_info(comments)").all().map((row) => row.name).includes("likes"), "fresh schema has comments.likes");
  assert.ok(fresh.prepare("PRAGMA table_info(comment_votes)").all().map((row) => row.name).includes("vote"), "fresh schema has comment_votes");

  // Both migrations are recorded in the production runbook.
  const runbook = read("docs/production-operations.md");
  assert.match(runbook, /069-comments\.sql/);
  assert.match(runbook, /070-tenant-comments-enabled\.sql/);
  assert.match(runbook, /072-comment-avatar-hue\.sql/);
  assert.match(runbook, /074-comment-avatar-key\.sql/);
  assert.match(runbook, /075-comment-website\.sql/);
  assert.match(runbook, /076-comment-votes\.sql/);
  assert.match(runbook, /077-comment-avatar-resync\.sql/);
  assert.match(runbook, /078-comment-sessions\.sql/);
  assert.match(runbook, /079-comment-identity-resync\.sql/);
  assert.match(runbook, /080-comments-default-on\.sql/);
  assert.match(runbook, /081-comment-pending-subscribe\.sql/);
  // A ticked updates box waits on the identity until the verification click.
  const pendingCols = (table) => fresh.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  assert.ok(pendingCols("comment_identities").includes("pending_subscribe_email"), "fresh schema has identities.pending_subscribe_email");
  const pendingDb = new DatabaseSync(":memory:");
  pendingDb.exec(read("migrations/069-comments.sql"));
  pendingDb.exec(read("migrations/081-comment-pending-subscribe.sql"));
  assert.ok(pendingDb.prepare("PRAGMA table_info(comment_identities)").all().map((row) => row.name).includes("pending_subscribe_email"), "migration adds identities.pending_subscribe_email");
});

test("migration 078 creates reader sessions and preserves the signed-in cookie", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(read("migrations/069-comments.sql"));
  db.exec("INSERT INTO comment_identities (tenant_id, email_hash, author_name, cookie_hash, verified_at, created_at) VALUES (1, 'h1', 'Multi', 'deadbeef', 7, 1)");
  db.exec(read("migrations/078-comment-sessions.sql"));
  assert.ok(tables(db).includes("comment_sessions"), "migration creates comment_sessions");
  const rows = db.prepare("SELECT tenant_id, email_hash, cookie_hash FROM comment_sessions").all();
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0] }, { tenant_id: 1, email_hash: "h1", cookie_hash: "deadbeef" });
  // Idempotent: re-running keeps the single preserved row.
  db.exec(read("migrations/078-comment-sessions.sql"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM comment_sessions").get().n, 1);
  const fresh = new DatabaseSync(":memory:");
  fresh.exec(read("schema-posts.sql"));
  assert.ok(tables(fresh).includes("comment_sessions"), "fresh schema ships comment_sessions");
});

test("migration 077 resyncs past comment photos to current identity keys", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(read("migrations/069-comments.sql"));
  db.exec(read("migrations/074-comment-avatar-key.sql"));
  db.exec("INSERT INTO comment_identities (tenant_id, email_hash, author_name, verified_at, created_at, avatar_key) VALUES (1, 'h1', 'Photo', 1, 1, 'avatars/1-new.png')");
  db.exec("INSERT INTO comment_identities (tenant_id, email_hash, author_name, verified_at, created_at, avatar_key) VALUES (1, 'h2', 'Plain', 1, 1, NULL)");
  db.exec("INSERT INTO comments (tenant_id, post_id, author_name, email_hash, body, status, created_at, avatar_key) VALUES (1, 7, 'Photo', 'h1', 'missing photo', 'approved', 1, NULL)");
  db.exec("INSERT INTO comments (tenant_id, post_id, author_name, email_hash, body, status, created_at, avatar_key) VALUES (1, 7, 'Photo', 'h1', 'stale photo', 'approved', 2, 'avatars/1-old.png')");
  db.exec("INSERT INTO comments (tenant_id, post_id, author_name, email_hash, body, status, created_at, avatar_key) VALUES (1, 7, 'Photo', 'h1', 'current photo', 'approved', 3, 'avatars/1-new.png')");
  db.exec("INSERT INTO comments (tenant_id, post_id, author_name, email_hash, body, status, created_at, avatar_key) VALUES (1, 7, 'Plain', 'h2', 'no photo anywhere', 'approved', 4, NULL)");
  db.exec(read("migrations/077-comment-avatar-resync.sql"));
  const key = (body) => db.prepare("SELECT avatar_key AS k FROM comments WHERE body = ?").get(body).k;
  assert.equal(key("missing photo"), "avatars/1-new.png");
  assert.equal(key("stale photo"), "avatars/1-new.png");
  assert.equal(key("current photo"), "avatars/1-new.png");
  assert.equal(key("no photo anywhere"), null);
});

test("migration 079 resyncs past comment names and sites", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(read("migrations/069-comments.sql"));
  db.exec(read("migrations/075-comment-website.sql"));
  db.exec("INSERT INTO comment_identities (tenant_id, email_hash, author_name, verified_at, created_at, website) VALUES (1, 'h1', 'New Name', 1, 1, 'https://new.example.com')");
  db.exec("INSERT INTO comment_identities (tenant_id, email_hash, author_name, verified_at, created_at, website) VALUES (1, 'h2', 'Plain', 1, 1, NULL)");
  db.exec("INSERT INTO comments (tenant_id, post_id, author_name, email_hash, body, status, created_at, website) VALUES (1, 7, 'Old Name', 'h1', 'stale row', 'approved', 1, 'https://old.example.com')");
  db.exec("INSERT INTO comments (tenant_id, post_id, author_name, email_hash, body, status, created_at, website) VALUES (1, 7, 'New Name', 'h1', 'half-synced row', 'approved', 2, NULL)");
  db.exec("INSERT INTO comments (tenant_id, post_id, author_name, email_hash, body, status, created_at, website) VALUES (1, 7, 'New Name', 'h1', 'current row', 'approved', 3, 'https://new.example.com')");
  db.exec("INSERT INTO comments (tenant_id, post_id, author_name, email_hash, body, status, created_at, website) VALUES (1, 7, 'Plain', 'h2', 'siteless row', 'approved', 4, NULL)");
  db.exec(read("migrations/079-comment-identity-resync.sql"));
  const row = (body) => db.prepare("SELECT author_name AS n, website AS w FROM comments WHERE body = ?").get(body);
  assert.deepEqual({ ...row("stale row") }, { n: "New Name", w: "https://new.example.com" });
  assert.deepEqual({ ...row("half-synced row") }, { n: "New Name", w: "https://new.example.com" });
  assert.deepEqual({ ...row("current row") }, { n: "New Name", w: "https://new.example.com" });
  assert.deepEqual({ ...row("siteless row") }, { n: "Plain", w: null });
});

// Blog settings round-trip for the comments flag, through the admin form.
test("owners toggle comments from blog settings and it persists", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const now = Math.floor(Date.now() / 1000);
  const tenant = {
    id: 1, public_id: "b_comments", slug: "commentblog", title: "Comment Blog",
    description: "", footer_name: "", accent_color: "#1a8917", topics_json: "[]",
    social_links_json: "{}", navigation_links_json: "[]", browser_push_enabled: 0,
    comments_enabled: 0, header_link_url: "/", avatar_key: null, custom_domain: null,
    shard: "primary", created_at: now, deleted_at: null,
  };
  const updates = [];
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => {
              if (sql.includes("FROM sessions")) {
                return { id: 1, email: "owner@example.com", billing_status: "inactive" };
              }
              if (sql.includes("JOIN memberships")) {
                return args[0] === "b_comments" ? { ...tenant, membership_role: "owner" } : null;
              }
              if (sql.includes("FROM tenants")) return tenant;
              if (sql.includes("FROM memberships")) return { role: "owner" };
              return null;
            },
            all: async () => ({ results: [] }),
            run: async () => {
              if (sql.startsWith("UPDATE tenants SET")) {
                updates.push({ sql, args });
                const cols = sql.slice(sql.indexOf("SET") + 3, sql.indexOf("WHERE")).split(",").map((part) => part.trim().split(" ")[0]);
                if (cols.includes("comments_enabled")) tenant.comments_enabled = args[cols.indexOf("comments_enabled")];
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
  const env = { DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test" };
  const executionCtx = { waitUntil() {}, passThroughOnException() {} };
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => {} } };
  try {
    const form = new FormData();
    form.set("slug", "commentblog");
    form.set("title", "Comment Blog");
    form.set("description", "");
    form.set("accent_color", "#1a8917");
    form.set("topics", "");
    form.set("header_link_url", "/");
    form.set("comments_enabled", "1");
    const save = await blogniceApp.request(new Request("https://www.blognice.test/admin/b/b_comments/settings", {
      method: "POST", body: form,
      headers: { cookie: "bn_session=owner-session", Origin: "https://www.blognice.test" },
    }), undefined, env, executionCtx);
    assert.equal(save.status, 200);
    assert.match(await save.text(), /Saved\./);
    assert.ok(updates.length > 0, "settings UPDATE issued");
    assert.equal(tenant.comments_enabled, 1);

    const page = await blogniceApp.request(new Request("https://www.blognice.test/admin/b/b_comments/settings", {
      headers: { cookie: "bn_session=owner-session" },
    }), undefined, env, executionCtx);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /name="comments_enabled"/);
    assert.match(html, /name="comments_enabled" value="1" checked/);
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});
