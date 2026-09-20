import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { commentRoomName, signRoomRequest, verifyRoomRequest } from "../src/comment-room-protocol.ts";

const require = createRequire(import.meta.url);
for (const extension of [".html", ".svg"]) {
  require.extensions[extension] = (module, filename) => {
    module.exports = readFileSync(filename, "utf8");
  };
}

const SECRET = "test-room-secret";
const OTHER_SECRET = "wrong-secret";
const METHOD = "POST";
const PATH = "/internal/broadcast";
const BODY = JSON.stringify({ type: "comment-approved", comment: { id: 1 } });

test("room broadcast authentication accepts fresh signatures and rejects abuse", async () => {
  const seen = new Set();
  const now = Date.now();
  const { nonce, mac } = await signRoomRequest(SECRET, METHOD, PATH, BODY);
  assert.equal(await verifyRoomRequest(SECRET, METHOD, PATH, BODY, nonce, mac, seen, now), true);

  // Replays are single-use.
  assert.equal(await verifyRoomRequest(SECRET, METHOD, PATH, BODY, nonce, mac, seen, now), false);

  // Tampered bodies, wrong secrets, and bad nonces fail.
  const again = await signRoomRequest(SECRET, METHOD, PATH, BODY);
  const seen2 = new Set();
  assert.equal(await verifyRoomRequest(SECRET, METHOD, PATH, BODY + "x", again.nonce, again.mac, seen2, now), false);
  assert.equal(await verifyRoomRequest(OTHER_SECRET, METHOD, PATH, BODY, again.nonce, again.mac, new Set(), now), false);
  assert.equal(await verifyRoomRequest(SECRET, METHOD, PATH, BODY, "garbage", again.mac, new Set(), now), false);
  assert.equal(await verifyRoomRequest(SECRET, METHOD, PATH, BODY, null, again.mac, new Set(), now), false);
  assert.equal(await verifyRoomRequest(SECRET, METHOD, PATH, BODY, again.nonce, null, new Set(), now), false);

  // Stale nonces fail (10 minutes old, TTL is 5).
  const stale = `${now - 10 * 60 * 1000}:abcdef1234567890`;
  const staleMac = (await signRoomRequest(SECRET, METHOD, PATH, BODY, stale)).mac;
  assert.equal(await verifyRoomRequest(SECRET, METHOD, PATH, BODY, stale, staleMac, new Set(), now), false);

  // Room names scope broadcasts per blog and post.
  assert.equal(commentRoomName(1, 7), "comment-room:1:7");
  assert.notEqual(commentRoomName(1, 7), commentRoomName(2, 7));
});

function commentState(extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    tenant: {
      id: 1, public_id: "b_comments", slug: "commentblog", title: "Comment Blog",
      description: "", accent_color: "#1a8917", comments_enabled: 1, shard: "primary",
      created_at: now, deleted_at: null,
    },
    posts: {
      "live-post": { id: 7, tenant_id: 1, slug: "live-post", title: "Live", body_md: "Hi.", tags_json: "[]", published: 1, created_at: now, updated_at: now, author_visible: 1 },
      "unfinished": { id: 8, tenant_id: 1, slug: "unfinished", title: "Draft", body_md: "Hi.", tags_json: "[]", published: 0, created_at: now, updated_at: now, author_visible: 1 },
    },
    ...extra,
  };
}

function roomCapture() {
  const calls = [];
  return {
    calls,
    namespace: {
      idFromName: (name) => ({ name }),
      get: (id) => ({
        fetch: async (url, init = {}) => {
          const headers = {};
          const raw = init.headers || {};
          if (typeof raw.forEach === "function") raw.forEach((v, k) => { headers[k.toLowerCase()] = v; });
          else for (const [k, v] of Object.entries(raw)) headers[String(k).toLowerCase()] = String(v);
          calls.push({ room: id.name, url: String(url), method: init.method || "GET", headers, body: String(init.body || "") });
          return new Response("ok");
        },
      }),
    },
  };
}

function commentDb(state) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => {
              if (sql.includes("tenant_slug_aliases")) return null;
              if (sql.includes("FROM tenants")) return state.tenant;
              if (sql.includes("FROM posts")) return state.posts[args[args.length - 1]] ?? null;
              if (sql.includes("FROM comments")) {
                return (state.comments || []).find((c) => c.tenant_id === args[0] && c.id === args[1]) ?? null;
              }
              if (sql.includes("FROM comment_identities")) {
                const hash = args.find((a) => typeof a === "string" && /^[0-9a-f]{64}$/.test(a));
                return (Object.values(state.identities || {}).find((r) => r.cookie_hash === hash) ?? null);
              }
              return null;
            },
            all: async () => ({ results: [] }),
            run: async () => ({ success: true, meta: { last_row_id: (state.comments?.length || 0) + 1 } }),
          };
        },
      };
    },
  };
}

const req = (host, path, opts = {}) => new Request(`https://${host}${path}`, {
  ...opts,
  headers: { host, ...(opts.headers || {}) },
});

test("new comments and moderation decisions broadcast to the post room", async () => {
  const { blogniceApp, broadcastCommentEvent } = await import("../src/index.ts");
  const now = Math.floor(Date.now() / 1000);
  const state = commentState({
    identities: {},
    comments: [],
  });
  state.identities = {};
  const room = roomCapture();
  const db = commentDb(state);
  const env = { DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test", COMMENTS_ROOM_SECRET: SECRET, COMMENT_ROOMS: room.namespace };
  const executionCtx = { waitUntil(p) { if (p && typeof p.catch === "function") p.catch(() => {}); }, passThroughOnException() {} };
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => {} } };
  try {
    // Direct helper: the room can verify what the worker signs.
    const ok = await broadcastCommentEvent(env, state.tenant, 7, { type: "comment-approved", comment: { id: 1 } });
    assert.equal(ok, true);
    assert.equal(room.calls.length, 1);
    assert.equal(room.calls[0].room, "comment-room:1:7");
    const seen = new Set();
    assert.equal(await verifyRoomRequest(
      SECRET, "POST", "/internal/broadcast", room.calls[0].body,
      room.calls[0].headers["x-bn-nonce"], room.calls[0].headers["x-bn-mac"], seen, Date.now()
    ), true);

    // Submit path emits comment-approved with the stored fields.
    const { createHash } = await import("node:crypto");
    const realCookieHash = createHash("sha256").update("reader-cookie").digest("hex");
    state.identities = { reader: { email_hash: "e1", author_name: "Reader", cookie_hash: realCookieHash, verified_at: now } };
    const posted = await blogniceApp.request(req("commentblog.blognice.test", "/live-post/comments", {
      method: "POST", headers: { "content-type": "application/json", cookie: "bn_comment=reader-cookie" },
      body: JSON.stringify({ body: "Live comment." }),
    }), undefined, env, executionCtx);
    assert.equal(posted.status, 201);
    await new Promise((r) => setTimeout(r, 50)); // let waitUntil work flush
    const approved = room.calls.find((c) => {
      try { return JSON.parse(c.body).comment?.body === "Live comment."; } catch { return false; }
    });
    assert.ok(approved, "submit broadcasts comment-approved");
    assert.equal(JSON.parse(approved.body).comment.body, "Live comment.");
    assert.equal(JSON.parse(approved.body).comment.parent_id, null);
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test("comment watch socket is guarded by flag, publication, and room config", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const state = commentState();
  const room = roomCapture();
  const db = commentDb(state);
  const base = { DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test" };
  const executionCtx = { waitUntil() {}, passThroughOnException() {} };
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  try {
    const withRoom = { ...base, COMMENTS_ROOM_SECRET: SECRET, COMMENT_ROOMS: room.namespace };
    const watch = await blogniceApp.request(req("commentblog.blognice.test", "/live-post/comments/watch"), undefined, withRoom, executionCtx);
    assert.equal(watch.status, 200);
    assert.equal(room.calls.length, 1);
    assert.equal(room.calls[0].room, "comment-room:1:7");

    // Drafts never get a room.
    assert.equal((await blogniceApp.request(req("commentblog.blognice.test", "/unfinished/comments/watch"), undefined, withRoom, executionCtx)).status, 404);
    // Disabled blogs stay silent.
    state.tenant.comments_enabled = 0;
    assert.equal((await blogniceApp.request(req("commentblog.blognice.test", "/live-post/comments/watch"), undefined, withRoom, executionCtx)).status, 404);
    state.tenant.comments_enabled = 1;
    // Unconfigured rooms fail closed so clients keep polling.
    assert.equal((await blogniceApp.request(req("commentblog.blognice.test", "/live-post/comments/watch"), undefined, base, executionCtx)).status, 503);
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});
