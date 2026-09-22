import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

// Stateful POSTS stand-in with vote-row and counter handling.
function fakeDb(state) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => {
              if (sql.includes("FROM tenants")) return state.tenant;
              if (sql.includes("FROM posts")) return state.posts["live-post"] ?? null;
              if (sql.includes("FROM comment_identities")) {
                const rows = Object.values(state.identities);
                if (sql.includes("cookie_hash")) return rows.find((r) => r.cookie_hash === args[args.length - 1]) ?? null;
                return null;
              }
              if (sql.includes("FROM comment_votes")) {
                return state.votes.find((v) => v.tenant_id === args[0] && v.comment_id === args[1] && v.email_hash === args[2]) ?? null;
              }
              if (sql.includes("FROM comments")) {
                return state.comments.find((c) => c.tenant_id === args[0] && c.id === args[1]) ?? null;
              }
              if (sql.includes("COUNT(*)")) {
                const kind = args.find((a) => a === "vote");
                const since = args[args.length - 1];
                return { count: state.attempts.filter((a) => a.tenant_id === args[0] && a.kind === kind && a.created_at > since).length };
              }
              return null;
            },
            all: async () => ({ results: [] }),
            run: async () => {
              if (sql.startsWith("INSERT INTO comment_votes")) {
                state.votes.push({ tenant_id: args[0], comment_id: args[1], email_hash: args[2], vote: args[3], created_at: args[4] });
                return { success: true };
              }
              if (sql.startsWith("UPDATE comment_votes")) {
                const row = state.votes.find((v) => v.tenant_id === args[2] && v.comment_id === args[3] && v.email_hash === args[4]);
                if (row) { row.vote = args[0]; row.created_at = args[1]; }
                return { success: true };
              }
              if (sql.startsWith("DELETE FROM comment_votes")) {
                state.votes = state.votes.filter((v) => !(v.tenant_id === args[0] && v.comment_id === args[1] && v.email_hash === args[2]));
                return { success: true };
              }
              if (sql.startsWith("UPDATE comments SET likes")) {
                const c = state.comments.find((x) => x.tenant_id === args[2] && x.id === args[3]);
                if (c) { c.likes = Math.max(0, c.likes + args[0]); c.dislikes = Math.max(0, c.dislikes + args[1]); }
                return { success: true };
              }
              if (sql.startsWith("INSERT INTO comment_attempts")) {
                state.attempts.push({ tenant_id: args[0], email_hash: args[1], kind: args[2], created_at: args[3] });
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

function makeState() {
  return {
    tenant: {
      id: 1, public_id: "b_comments", slug: "commentblog", title: "Comment Blog",
      description: "", accent_color: "#1a8917", comments_enabled: 1, shard: "primary",
      created_at: NOW, deleted_at: null,
    },
    posts: {
      "live-post": { id: 7, tenant_id: 1, slug: "live-post", title: "Live", body_md: "x", tags_json: "[]", published: 1, created_at: NOW, updated_at: NOW },
    },
    identities: {},
    attempts: [],
    votes: [],
    comments: [
      { id: 5, tenant_id: 1, post_id: 7, parent_id: null, author_name: "Votable", email_hash: "e5", body: "Vote on me.", status: "approved", created_at: NOW, likes: 0, dislikes: 0 },
      { id: 6, tenant_id: 1, post_id: 7, parent_id: null, author_name: "Gone", email_hash: "e6", body: "Removed.", status: "removed", created_at: NOW, likes: 0, dislikes: 0 },
    ],
  };
}

const cookieHash = (cookie) => createHash("sha256").update(cookie).digest("hex");

test("comment votes toggle, flip, clear, and broadcast counts", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const state = makeState();
  state.identities = { reader: { email_hash: "r1", author_name: "Reader", cookie_hash: cookieHash("reader-cookie"), verified_at: NOW } };
  const roomBodies = [];
  const room = { idFromName: (name) => ({ name }), get: () => ({ fetch: async (url, init) => { roomBodies.push(String(init.body)); return new Response("ok"); } }) };
  const db = fakeDb(state);
  const env = { DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test", COMMENTS_ROOM_SECRET: "s", COMMENT_ROOMS: room };
  const executionCtx = { waitUntil() {}, passThroughOnException() {} };
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => {} } };
  const req = (path, opts = {}) => new Request(`https://commentblog.blognice.test${path}`, {
    ...opts,
    headers: { host: "commentblog.blognice.test", ...(opts.headers || {}) },
  });
  const vote = (id, body, cookie = "reader-cookie") => blogniceApp.request(req(`/live-post/comments/${id}/vote`, {
    method: "POST", headers: { "content-type": "application/json", cookie: `bn_comment=${cookie}` },
    body: JSON.stringify(body),
  }), undefined, env, executionCtx);
  try {
    // Anonymous votes are rejected.
    assert.equal((await blogniceApp.request(req("/live-post/comments/5/vote", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ vote: 1 }),
    }), undefined, env, executionCtx)).status, 401);

    // Guards: bad values, missing and removed comments.
    assert.equal((await vote(5, { vote: 2 })).status, 400);
    assert.equal((await vote(5, { vote: "1" })).status, 400);
    assert.equal((await vote(999, { vote: 1 })).status, 404);
    assert.equal((await vote(6, { vote: 1 })).status, 404);

    // Like sticks with an op echo for race ordering.
    const liked = await vote(5, { vote: 1, op: "op-1" });
    assert.equal(liked.status, 200);
    assert.deepEqual(await liked.json(), { comment: { id: 5, likes: 1, dislikes: 0, my_vote: 1 }, op: "op-1" });
    assert.equal(state.comments[0].likes, 1);

    // Same vote again clears it.
    const cleared = await vote(5, { vote: 1, op: "op-2" });
    assert.equal((await cleared.json()).comment.likes, 0);
    assert.equal(state.votes.length, 0);

    // Dislike then like flips both counters.
    await vote(5, { vote: -1 });
    assert.deepEqual([state.comments[0].likes, state.comments[0].dislikes], [0, 1]);
    const flipped = await vote(5, { vote: 1 });
    assert.deepEqual((await flipped.json()).comment, { id: 5, likes: 1, dislikes: 0, my_vote: 1 });
    assert.deepEqual([state.comments[0].likes, state.comments[0].dislikes], [1, 0]);

    // Votes broadcast so other readers converge without reloading.
    const event = roomBodies.map((b) => { try { return JSON.parse(b); } catch { return null; } }).find((m) => m && m.type === "comment-votes");
    assert.ok(event, "vote broadcasts comment-votes");
    assert.deepEqual(event.comment, { id: 5, likes: 1, dislikes: 0 });
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});
