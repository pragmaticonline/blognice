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

function fakeDb(state) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => {
              if (sql.includes("FROM tenants")) return state.tenant;
              if (sql.includes("FROM posts")) return state.posts["live-post"] ?? null;
              if (sql.includes("comment_sessions")) {
                const session = state.sessions.find((s) => s.tenant_id === args[0] && s.cookie_hash === args[args.length - 1]);
                if (!session) return null;
                return Object.values(state.identities).find((r) => r.tenant_id === session.tenant_id && r.email_hash === session.email_hash) ?? null;
              }
              if (sql.includes("FROM comment_identities")) {
                const rows = Object.values(state.identities);
                if (sql.includes("token_hash")) {
                  const hash = args.find((a) => typeof a === "string" && /^[0-9a-f]{64}$/.test(a));
                  return rows.find((r) => r.token_hash === hash) ?? null;
                }
                if (sql.includes("email_hash")) return rows.find((r) => r.email_hash === args[args.length - 1]) ?? null;
                if (sql.includes("cookie_hash")) return rows.find((r) => r.cookie_hash === args[args.length - 1]) ?? null;
                return null;
              }
              if (sql.includes("FROM subscribers")) {
                return state.subscribers.find((s) => s.tenant_id === args[0] && s.email === args[1]) ?? null;
              }
              if (sql.includes("FROM subscriber_confirmations")) {
                return state.confirmations.find((s) => s.tenant_id === args[0] && s.email === args[1]) ?? null;
              }
              if (sql.includes("UPDATE comments SET")) return { success: true };
              if (sql.includes("FROM comments")) return null;
              if (sql.includes("COUNT(*)")) return { count: 0 };
              return null;
            },
            all: async () => ({ results: [] }),
            run: async () => {
              if (sql.startsWith("INSERT INTO comment_identities")) {
                const cols = sql.slice(sql.indexOf("comment_identities (") + 20, sql.indexOf(") VALUES")).split(",").map((p) => p.trim().split(" ")[0]);
                const row = {};
                cols.forEach((col, i) => { row[col] = args[i]; });
                state.identities[row.email_hash] = { ...(state.identities[row.email_hash] || {}), ...row };
                return { success: true };
              }
              if (sql.startsWith("INSERT OR IGNORE INTO comment_sessions")) {
                state.sessions.push({ tenant_id: args[0], email_hash: args[1], cookie_hash: args[2], created_at: args[3] });
                return { success: true };
              }
              if (sql.startsWith("UPDATE comment_identities")) {
                const cols = sql.slice(sql.indexOf("SET") + 3, sql.indexOf("WHERE")).split(",").map((p) => p.trim().split(" ")[0]);
                const row = state.identities[args[args.length - 1]];
                if (row) cols.forEach((col, i) => { row[col] = args[i]; });
                return { success: true };
              }
              if (sql.startsWith("INSERT INTO comments")) {
                state.comments.push({ id: state.comments.length + 1 });
                return { success: true, meta: { last_row_id: state.comments.length } };
              }
              if (sql.startsWith("INSERT OR IGNORE INTO subscriber_confirmations")) {
                const exists = state.confirmations.some((s) => s.tenant_id === args[0] && s.email === args[1]);
                if (!exists) state.confirmations.push({ tenant_id: args[0], email: args[1] });
                return { success: true, meta: { changes: exists ? 0 : 1 } };
              }
              if (sql.startsWith("DELETE FROM subscriber_confirmations")) return { success: true };
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
    sessions: [],
    attempts: [],
    comments: [],
    subscribers: [],
    confirmations: [],
  };
}

const tokenFrom = (body) => (body.match(/token=([0-9a-f]{32,})/) || [])[1];
const cookieFrom = (res) => ((res.headers.get("set-cookie") || "").match(/bn_comment=([^;]+)/) || [])[1];

test("comment form offers a checked-by-default subscribe box", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const state = makeState();
  const env = { DB: fakeDb(state), POSTS: fakeDb(state), ROOT_DOMAIN: "blognice.test" };
  const executionCtx = { waitUntil() {}, passThroughOnException() {} };
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  try {
    const res = await blogniceApp.request(new Request("https://commentblog.blognice.test/live-post", {
      headers: { host: "commentblog.blognice.test" },
    }), undefined, env, executionCtx);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /data-field-subscribe[^>]*checked|checked[^>]*data-field-subscribe/, "subscribe box is checked by default");
  assert.match(html, /Email me updates/, "subscribe box promises updates");
  assert.match(html, /\.comment-form \.subscribe-row\[hidden\][^}]*display:\s*none/, "ask-once hiding beats the flex row");
  assert.match(html, /data-subscribe-row hidden/, "page form ships the box hidden before placement");
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test("verified subscribe taps enter double opt-in; others do nothing", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const state = makeState();
  const queued = [];
  const db = fakeDb(state);
  const env = { DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test", EMAIL_FROM: "Blog <hello@blognice.test>", MAILNICE_API_KEY: "test-key", EMAIL_QUEUE: { send: async (job) => { queued.push(job); } } };
  const executionCtx = { waitUntil() {}, passThroughOnException() {} };
  const sentEmails = [];
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.fetch = async (url, init) => {
    sentEmails.push(String(init?.body || ""));
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  };
  globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => {} } };
  const req = (path, opts = {}) => new Request(`https://commentblog.blognice.test${path}`, {
    ...opts,
    headers: { host: "commentblog.blognice.test", ...(opts.headers || {}) },
  });
  try {
    const start = await blogniceApp.request(req("/live-post/comments/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "fan@example.com", author_name: "Fan" }),
    }), undefined, env, executionCtx);
    assert.equal(start.status, 200);
    const verify = await blogniceApp.request(req(`/live-post/comments/verify?token=${tokenFrom(sentEmails[0])}`), undefined, env, executionCtx);
    const cookie = cookieFrom(verify);
    const post = (body) => blogniceApp.request(req("/live-post/comments", {
      method: "POST", headers: { "content-type": "application/json", cookie: `bn_comment=${cookie}` },
      body: JSON.stringify(body),
    }), undefined, env, executionCtx);

    // Unchecked box subscribes nobody.
    const plain = await post({ body: "No thanks." });
    assert.equal(plain.status, 201);
    assert.equal(state.confirmations.length, 0);

    // Checked box starts double opt-in from the verified comment.
    const subbed = await post({ body: "Yes please.", subscribe: true, email: "fan@example.com" });
    assert.equal(subbed.status, 201);
    assert.equal((await subbed.json()).comment.subscribed, "pending");
    assert.equal(state.confirmations.length, 1);
    assert.equal(state.confirmations[0].email, "fan@example.com");
    assert.equal(queued.length, 1);

    // Already-confirmed readers report active without new mail.
    state.subscribers.push({ tenant_id: 1, email: "fan@example.com", confirmed_at: NOW });
    const again = await post({ body: "Again.", subscribe: true, email: "fan@example.com" });
    assert.equal((await again.json()).comment.subscribed, "active");
    assert.equal(queued.length, 1);

    // Bad addresses post the comment but subscribe nothing.
    const bad = await post({ body: "Bad addr.", subscribe: true, email: "not-an-email" });
    assert.equal(bad.status, 201);
    assert.equal((await bad.json()).comment.subscribed, false);
    assert.equal(state.confirmations.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test("settings can subscribe later via double opt-in", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const state = makeState();
  const queued = [];
  const db = fakeDb(state);
  const env = { DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test", EMAIL_FROM: "Blog <hello@blognice.test>", MAILNICE_API_KEY: "test-key", EMAIL_QUEUE: { send: async (job) => { queued.push(job); } } };
  const executionCtx = { waitUntil() {}, passThroughOnException() {} };
  const sentEmails = [];
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.fetch = async (url, init) => {
    sentEmails.push(String(init?.body || ""));
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  };
  globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => {} } };
  const req = (path, opts = {}) => new Request(`https://commentblog.blognice.test${path}`, {
    ...opts,
    headers: { host: "commentblog.blognice.test", ...(opts.headers || {}) },
  });
  try {
    await blogniceApp.request(req("/live-post/comments/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "later@example.com", author_name: "Later" }),
    }), undefined, env, executionCtx);
    const verify = await blogniceApp.request(req(`/live-post/comments/verify?token=${tokenFrom(sentEmails[0])}`), undefined, env, executionCtx);
    const cookie = cookieFrom(verify);
    const save = (body) => blogniceApp.request(req("/live-post/comments/identity", {
      method: "POST", headers: { "content-type": "application/json", cookie: `bn_comment=${cookie}` },
      body: JSON.stringify(body),
    }), undefined, env, executionCtx);

    // Plain settings saves subscribe nothing.
    const plain = await save({ author_name: "Later", website: "https://later.example.com" });
    assert.equal(plain.status, 200);
    assert.equal((await plain.json()).subscribed, false);
    assert.equal(state.confirmations.length, 0);

    // Checking the box enrolls with confirmation mail.
    const subbed = await save({ author_name: "Later", website: "https://later.example.com", subscribe: true, email: "later@example.com" });
    assert.equal(subbed.status, 200);
    assert.equal((await subbed.json()).subscribed, "pending");
    assert.equal(state.confirmations.length, 1);
    assert.equal(queued.length, 1);

    // Bad addresses are ignored, settings still save.
    const bad = await save({ author_name: "Later", website: "https://later.example.com", subscribe: true, email: "nope" });
    assert.equal(bad.status, 200);
    assert.equal((await bad.json()).subscribed, false);
    assert.equal(state.confirmations.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test("unverified subscribe taps subscribe nobody", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const state = makeState();
  const db = fakeDb(state);
  const env = { DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test" };
  const executionCtx = { waitUntil() {}, passThroughOnException() {} };
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => {} } };
  try {
    const res = await blogniceApp.request(new Request("https://commentblog.blognice.test/live-post/comments", {
      method: "POST", headers: { host: "commentblog.blognice.test", "content-type": "application/json" },
      body: JSON.stringify({ body: "Sneaky.", subscribe: true, email: "sneaky@example.com" }),
    }), undefined, env, executionCtx);
    assert.equal(res.status, 401);
    assert.equal(state.confirmations.length, 0);
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});
