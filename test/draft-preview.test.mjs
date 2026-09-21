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

const NOW = Math.floor(Date.now() / 1000);
const TENANT = {
  id: 1, public_id: "b_draftblog", slug: "draftblog", title: "Draft Blog",
  description: "", accent_color: "#1a8917", avatar_key: null, shard: "primary", deleted_at: null,
};
const OWNER = { id: 1, email: "owner@example.com" };
const EDITOR = { id: 2, email: "editor@example.com" };
const DRAFT = {
  id: 1, tenant_id: 1, slug: "unfinished", title: "Unfinished Post",
  featured_image_key: null, audio_key: null, body_md: "Secret draft words here.",
  tags_json: "[]", published: 0, created_at: NOW, updated_at: NOW, author_visible: 1,
};
const LIVE = { ...DRAFT, id: 2, slug: "live-post", title: "Live Post", body_md: "Public words here.", published: 1 };

// Minimal in-memory D1 stand-in: answers only the queries the public post
// route makes. Anything else returns empty so stranger paths stay 404.
function fakeDb({ sessions, memberships }) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          const first = async () => {
            if (sql.includes("tenant_slug_aliases")) return null;
            if (sql.includes("FROM tenants")) {
              return args.some((a) => a === "draftblog") ? TENANT : null;
            }
            if (sql.includes("FROM sessions")) {
              const account = sessions[args[0]];
              return account ?? null;
            }
            if (sql.includes("FROM memberships")) {
              return memberships[`${args[0]}:${args[1]}`] ?? null;
            }
            if (sql.includes("FROM posts")) {
              const slug = args[args.length - 1];
              if (slug === "unfinished") {
                // The published-only listing must not see the draft.
                return sql.includes("published = 1") ? null : DRAFT;
              }
              if (slug === "live-post") return LIVE;
              return null;
            }
            return null;
          };
          return { first, all: async () => ({ results: [] }), run: async () => ({ success: true }) };
        },
      };
    },
  };
}

function get(path, session) {
  return new Request(`https://draftblog.blognice.test${path}`, {
    headers: { host: "draftblog.blognice.test", ...(session ? { cookie: `bn_session=${session}` } : {}) },
  });
}

test("blog members preview drafts with a banner; everyone else gets a 404", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const db = fakeDb({
    sessions: { "owner-session": OWNER, "editor-session": EDITOR, "stranger-session": { id: 3, email: "stranger@example.com" } },
    memberships: { "1:1": { role: "owner" }, "1:2": { role: "editor" } },
  });
  const env = { DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test" };
  const executionCtx = { waitUntil() {}, passThroughOnException() {} };
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  try {
    // Anonymous visitors must not see the draft (or learn it exists).
    const anon = await blogniceApp.request(get("/unfinished"), undefined, env, executionCtx);
    assert.equal(anon.status, 404);
    assert.doesNotMatch(await anon.text(), /Secret draft words/);

    // Logged-in strangers must not see it either.
    const stranger = await blogniceApp.request(get("/unfinished", "stranger-session"), undefined, env, executionCtx);
    assert.equal(stranger.status, 404);
    assert.doesNotMatch(await stranger.text(), /Secret draft words/);

    // The owner and a delegate see the draft with a clear banner.
    for (const session of ["owner-session", "editor-session"]) {
      const preview = await blogniceApp.request(get("/unfinished", session), undefined, env, executionCtx);
      assert.equal(preview.status, 200);
      const html = await preview.text();
      assert.match(html, /Secret draft words/);
      assert.match(html, /class="draft-band"/);
      assert.match(html, /Draft/);
      assert.match(html, /noindex/);
      assert.match(html, /admin\/b\/b_draftblog\/edit\/1/);
      assert.match(String(preview.headers.get("cache-control") || ""), /private|no-store/i);
    }

    // Published posts are unaffected: public, no banner.
    const live = await blogniceApp.request(get("/live-post"), undefined, env, executionCtx);
    assert.equal(live.status, 200);
    const liveHtml = await live.text();
    assert.match(liveHtml, /Public words here/);
    assert.doesNotMatch(liveHtml, /class="draft-band"/);
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test("owners mint expiring preview links that open drafts on any host", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const owner = { id: 1, email: "owner@example.com", email_verified: 1 };
  const tenant = { ...TENANT, custom_domain: "rayreport.com" };
  let previewHash = null;
  let previewExp = 0;
  const draft = () => ({ ...DRAFT, author_account_id: 1, preview_token_hash: previewHash, preview_token_expires_at: previewExp });
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          const first = async () => {
            if (sql.includes("tenant_slug_aliases")) return null;
            if (sql.includes("FROM tenants")) {
              if (sql.includes("JOIN memberships")) return { ...tenant, membership_role: "owner" };
              return args.some((a) => a === "draftblog" || a === "rayreport.com") ? tenant : null;
            }
            if (sql.includes("FROM sessions")) return args[0] === "owner-session" ? owner : null;
            if (sql.includes("FROM memberships")) return { role: "owner" };
            if (sql.includes("FROM posts")) {
              // SELECT by id (mint endpoint) or by slug (preview gate); the
              // published-only listing must not see the draft.
              if (sql.includes("published = 1")) return null;
              if (args.includes(1) && sql.includes("id = ?")) return draft();
              if (args[args.length - 1] === "unfinished") return draft();
              return null;
            }
            return null;
          };
          return {
            first,
            all: async () => ({ results: [] }),
            run: async () => {
              if (sql.startsWith("UPDATE posts SET preview_token_hash")) {
                previewHash = args[0];
                previewExp = args[1];
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
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  try {
    // Minting needs the owner session; the link points at the custom domain.
    // (Origin header included: admin POSTs without one are rejected as CSRF.)
    const anonMint = await blogniceApp.request(new Request("https://www.blognice.test/admin/b/b_draftblog/posts/1/preview-link", {
      method: "POST", headers: { host: "www.blognice.test", Origin: "https://www.blognice.test", "content-type": "application/json" },
    }), undefined, env, executionCtx);
    assert.equal(anonMint.status, 401);
    const minted = await blogniceApp.request(new Request("https://www.blognice.test/admin/b/b_draftblog/posts/1/preview-link", {
      method: "POST", headers: { host: "www.blognice.test", Origin: "https://www.blognice.test", cookie: "bn_session=owner-session", "content-type": "application/json" },
    }), undefined, env, executionCtx);
    assert.equal(minted.status, 200);
    const { url } = await minted.json();
    assert.match(url, /^https:\/\/rayreport\.com\/unfinished\?preview=[0-9a-f]{32}$/);
    const token = url.split("preview=")[1];

    // The token opens the draft on the custom domain with no session at all.
    const custom = new Request(`https://rayreport.com/unfinished?preview=${token}`, { headers: { host: "rayreport.com" } });
    const preview = await blogniceApp.request(custom, undefined, env, executionCtx);
    assert.equal(preview.status, 200);
    const html = await preview.text();
    assert.match(html, /Secret draft words/);
    assert.match(html, /class="draft-band"/);

    // Wrong tokens stay 404 and leak nothing.
    const wrong = await blogniceApp.request(new Request("https://rayreport.com/unfinished?preview=" + "0".repeat(32), { headers: { host: "rayreport.com" } }), undefined, env, executionCtx);
    assert.equal(wrong.status, 404);
    assert.doesNotMatch(await wrong.text(), /Secret draft words/);

    // Expired tokens stop working.
    previewExp = Math.floor(Date.now() / 1000) - 10;
    const stale = await blogniceApp.request(custom, undefined, env, executionCtx);
    assert.equal(stale.status, 404);
    assert.doesNotMatch(await stale.text(), /Secret draft words/);
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test("preview token columns ship in fresh installs, migrations, and the runbook", () => {
  const root = new URL("../", import.meta.url);
  const read = (path) => readFileSync(new URL(path, root), "utf8");
  const fresh = new DatabaseSync(":memory:");
  fresh.exec(read("schema-posts.sql"));
  const freshCols = fresh.prepare("PRAGMA table_info(posts)").all().map((row) => row.name);
  assert.ok(freshCols.includes("preview_token_hash"), "fresh schema has preview_token_hash");
  assert.ok(freshCols.includes("preview_token_expires_at"), "fresh schema has preview_token_expires_at");
  const migrated = new DatabaseSync(":memory:");
  migrated.exec(read("migrations/069-comments.sql"));
  migrated.exec("CREATE TABLE posts (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, slug TEXT NOT NULL)");
  migrated.exec(read("migrations/073-post-preview-links.sql"));
  const migratedCols = migrated.prepare("PRAGMA table_info(posts)").all().map((row) => row.name);
  assert.ok(migratedCols.includes("preview_token_hash"), "migration adds preview_token_hash");
  assert.ok(migratedCols.includes("preview_token_expires_at"), "migration adds preview_token_expires_at");
  assert.match(read("docs/production-operations.md"), /073-post-preview-links\.sql/);
});

test("dashboard draft eye opens through a preview link; live eye links directly", async () => {
  const { postListPage } = await import("../src/admin.ts");
  const account = { id: 1, email: "owner@example.com" };
  const tenant = { ...TENANT, public_id: "b_draftblog", custom_domain: "rayreport.com" };
  const draftPost = { ...DRAFT, id: 9, title: "Draft Nine", slug: "draft-nine", published: 0, created_at: NOW };
  const livePost = { ...DRAFT, id: 10, title: "Live Ten", slug: "live-ten", published: 1, created_at: NOW };
  const html = postListPage(account, tenant, [draftPost, livePost], "blognice.test");
  assert.match(html, /data-preview-open="\/admin\/b\/b_draftblog\/posts\/9\/preview-link"/);
  assert.doesNotMatch(html, /href="https:\/\/rayreport\.com\/draft-nine"/);
  assert.match(html, /href="https:\/\/rayreport\.com\/live-ten"/);
});
