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

function makeState() {
  return {
    tenant: {
      id: 1, public_id: "b_comments", slug: "commentblog", title: "Comment Blog",
      description: "", accent_color: "#1a8917", comments_enabled: 1, shard: "primary",
      created_at: NOW, deleted_at: null,
    },
    accounts: {
      1: { id: 1, email: "owner@example.com", billing_status: "inactive" },
      2: { id: 2, email: "editor@example.com", billing_status: "inactive" },
      3: { id: 3, email: "author@example.com", billing_status: "inactive" },
    },
    roles: { 1: "owner", 2: "editor", 3: "author" },
    sessions: { "owner-session": 1, "editor-session": 2, "author-session": 3 },
    posts: {
      7: { id: 7, tenant_id: 1, slug: "live-post", title: "Live", published: 1 },
    },
    comments: [
      { id: 1, tenant_id: 1, post_id: 7, parent_id: null, author_name: "Reader", email_hash: "e1", body: "Hello.", status: "approved", created_at: NOW - 50, decided_at: NOW - 50 },
      { id: 2, tenant_id: 1, post_id: 7, parent_id: 1, author_name: "Spammer", email_hash: "e2", body: "Buy now.", status: "approved", created_at: NOW - 40, decided_at: NOW - 40 },
    ],
    purged: [],
  };
}

function fakeDb(state) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => {
              if (sql.includes("FROM sessions")) {
                const id = state.sessions[args[0]];
                return id ? state.accounts[id] : null;
              }
              if (sql.includes("JOIN memberships")) {
                if (args[0] !== "b_comments") return null;
                // ownedBlog binds (public_id, account_id).
                return { ...state.tenant, membership_role: state.roles[args[1]] ?? null };
              }
              if (sql.includes("FROM tenants")) return state.tenant;
              if (sql.includes("FROM comments")) {
                return state.comments.find((c) => c.tenant_id === args[0] && c.id === args[1]) ?? null;
              }
              if (sql.includes("FROM posts")) {
                return state.posts[args[1]] ?? null;
              }
              return null;
            },
            all: async () => {
              if (sql.includes("FROM comments")) {
                const rows = state.comments
                  .filter((c) => c.tenant_id === args[0])
                  .map((c) => ({ ...c, post_slug: state.posts[c.post_id]?.slug, post_title: state.posts[c.post_id]?.title }))
                  .sort((a, b) => b.id - a.id);
                return { results: rows };
              }
              return { results: [] };
            },
            run: async () => {
              if (sql.startsWith("UPDATE comments SET")) {
                const row = state.comments.find((c) => c.id === args[args.length - 1]);
                if (row) { row.status = args[0]; row.decided_at = args[1]; }
                return { success: true };
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
}

function adminReq(state, path, session, opts = {}) {
  return new Request(`https://www.blognice.test${path}`, {
    ...opts,
    headers: {
      host: "www.blognice.test",
      cookie: `bn_session=${session}`,
      Origin: "https://www.blognice.test",
      ...(opts.headers || {}),
    },
  });
}

test("owners and editors moderate comments; authors cannot", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const state = makeState();
  const db = fakeDb(state);
  const deleted = [];
  const env = { DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test" };
  const executionCtx = { waitUntil() {}, passThroughOnException() {} };
  const originalCaches = globalThis.caches;
  globalThis.caches = {
    default: {
      match: async () => undefined,
      put: async () => {},
      delete: async (key) => { deleted.push(String(key.url || key)); },
    },
  };
  try {
    // Owner sees the queue with both comments and a nav entry.
    const list = await blogniceApp.request(adminReq(state, "/admin/b/b_comments/comments", "owner-session"), undefined, env, executionCtx);
    assert.equal(list.status, 200);
    const listHtml = await list.text();
    assert.match(listHtml, /Hello\./);
    assert.match(listHtml, /Buy now\./);
    assert.match(listHtml, />Comments</);

    // Authors cannot moderate.
    const authorForm = new FormData();
    authorForm.set("comment_id", "2");
    const denied = await blogniceApp.request(adminReq(state, "/admin/b/b_comments/comments/2/remove", "author-session", {
      method: "POST", body: authorForm,
    }), undefined, env, executionCtx);
    assert.equal(denied.status, 403);
    assert.equal(state.comments[1].status, "approved");

    // An editor removes the spam: tombstoned, purged, audited in spirit.
    const form = new FormData();
    form.set("comment_id", "2");
    const removed = await blogniceApp.request(adminReq(state, "/admin/b/b_comments/comments/2/remove", "editor-session", {
      method: "POST", body: form,
    }), undefined, env, executionCtx);
    assert.ok([302, 303].includes(removed.status), "redirects back to the queue");
    assert.equal(state.comments[1].status, "removed");
    assert.ok(deleted.some((url) => url.includes("/live-post")), "post page purged");

    // The queue now offers restore instead of remove for that row.
    const relist = await blogniceApp.request(adminReq(state, "/admin/b/b_comments/comments", "owner-session"), undefined, env, executionCtx);
    const relistHtml = await relist.text();
    assert.match(relistHtml, /Restore/);

    // Restore brings it back.
    const restoreForm = new FormData();
    restoreForm.set("comment_id", "2");
    const restored = await blogniceApp.request(adminReq(state, "/admin/b/b_comments/comments/2/restore", "owner-session", {
      method: "POST", body: restoreForm,
    }), undefined, env, executionCtx);
    assert.ok([302, 303].includes(restored.status));
    assert.equal(state.comments[1].status, "approved");

    // Flag off: the queue is gone.
    state.tenant.comments_enabled = 0;
    assert.equal((await blogniceApp.request(adminReq(state, "/admin/b/b_comments/comments", "owner-session"), undefined, env, executionCtx)).status, 404);
    state.tenant.comments_enabled = 1;
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});
