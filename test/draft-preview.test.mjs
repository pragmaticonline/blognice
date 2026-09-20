import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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
