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

  // Both migrations are recorded in the production runbook.
  const runbook = read("docs/production-operations.md");
  assert.match(runbook, /069-comments\.sql/);
  assert.match(runbook, /070-tenant-comments-enabled\.sql/);
  assert.match(runbook, /072-comment-avatar-hue\.sql/);
  assert.match(runbook, /074-comment-avatar-key\.sql/);
  assert.match(runbook, /075-comment-website\.sql/);
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
