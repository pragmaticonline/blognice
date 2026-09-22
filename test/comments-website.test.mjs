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

test("normalizeCommentWebsite keeps only safe http(s) addresses", async () => {
  const { normalizeCommentWebsite } = await import("../src/index.ts");
  assert.equal(normalizeCommentWebsite("example.com"), "https://example.com");
  assert.equal(normalizeCommentWebsite("  https://example.com/blog  "), "https://example.com/blog");
  assert.equal(normalizeCommentWebsite("http://example.com"), "http://example.com");
  assert.equal(normalizeCommentWebsite(""), null);
  assert.equal(normalizeCommentWebsite(null), null);
  assert.equal(normalizeCommentWebsite("javascript:alert(1)"), null);
  assert.equal(normalizeCommentWebsite("data:text/html,x"), null);
  assert.equal(normalizeCommentWebsite("not a site"), null);
  assert.equal(normalizeCommentWebsite("<img src=x>"), null);
  assert.equal(normalizeCommentWebsite("example"), null);
  assert.equal(normalizeCommentWebsite(`https://${"a".repeat(200)}.com`), null);
});

// Stateful POSTS stand-in with generic INSERT/UPDATE handling.
function fakeDb(state) {
  const colsOf = (sql, from, to) => sql.slice(sql.indexOf(from) + from.length, sql.indexOf(to)).split(",").map((part) => part.trim().split(" ")[0]).filter(Boolean);
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
              return null;
            },
            all: async () => ({ results: [] }),
            run: async () => {
              if (sql.startsWith("INSERT INTO comment_identities")) {
                const cols = colsOf(sql, "comment_identities (", ") VALUES");
                const row = {};
                cols.forEach((col, i) => { row[col] = args[i]; });
                state.identities[row.email_hash] = { ...(state.identities[row.email_hash] || {}), ...row };
                return { success: true };
              }
              if (sql.startsWith("UPDATE comment_identities")) {
                const cols = colsOf(sql, "SET", "WHERE");
                const row = state.identities[args[args.length - 1]];
                if (row) cols.forEach((col, i) => { row[col] = args[i]; });
                return { success: true };
              }
              if (sql.startsWith("UPDATE comments SET author_name")) {
                for (const c of state.comments) {
                  if (c.tenant_id === args[1] && c.email_hash === args[2]) c.author_name = args[0];
                }
                return { success: true };
              }
              if (sql.startsWith("UPDATE comments SET website")) {
                for (const c of state.comments) {
                  if (c.tenant_id === args[1] && c.email_hash === args[2]) c.website = args[0];
                }
                return { success: true };
              }
              if (sql.startsWith("INSERT OR IGNORE INTO comment_sessions")) {
                state.sessions.push({ tenant_id: args[0], email_hash: args[1], cookie_hash: args[2], created_at: args[3] });
                return { success: true };
              }
              if (sql.startsWith("INSERT INTO comment_attempts")) {
                state.attempts.push({ tenant_id: args[0], email_hash: args[1], kind: args[2], created_at: args[3] });
                return { success: true };
              }
              if (sql.startsWith("INSERT INTO comments")) {
                const cols = colsOf(sql, "comments (", ") VALUES");
                const row = { id: state.comments.length + 1 };
                cols.forEach((col, i) => { row[col] = args[i]; });
                state.comments.push(row);
                return { success: true, meta: { last_row_id: row.id } };
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
  };
}

const tokenFrom = (body) => (body.match(/token=([0-9a-f]{32,})/) || [])[1];
const cookieFrom = (res) => ((res.headers.get("set-cookie") || "").match(/bn_comment=([^;]+)/) || [])[1];

async function verified(t, state, env, executionCtx, req, sentEmails, email, name, website) {
  const body = { email, author_name: name };
  if (website !== undefined) body.website = website;
  const start = await t.request(req("/live-post/comments/start", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), undefined, env, executionCtx);
  assert.equal(start.status, 200);
  const verify = await t.request(req(`/live-post/comments/verify?token=${tokenFrom(sentEmails[sentEmails.length - 1])}`), undefined, env, executionCtx);
  assert.equal(verify.status, 302);
  return cookieFrom(verify);
}

test("website flows from verification to stamped comments and settings backfill", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const state = makeState();
  const db = fakeDb(state);
  const env = { DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test", EMAIL_FROM: "Blog <hello@blognice.test>", MAILNICE_API_KEY: "test-key" };
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
    const emailHash = createHash("sha256").update("sited@example.com").digest("hex");
    const cookie = await verified(blogniceApp, state, env, executionCtx, req, sentEmails, "sited@example.com", "Sited", "sited.example.com");
    assert.equal(state.identities[emailHash].website, "https://sited.example.com");
    const authed = (path, body) => req(path, {
      method: "POST", headers: { "content-type": "application/json", cookie: `bn_comment=${cookie}` },
      body: JSON.stringify(body),
    });

    // Submits stamp the identity website and return it.
    const posted = await blogniceApp.request(authed("/live-post/comments", { body: "Hello." }), undefined, env, executionCtx);
    assert.equal(posted.status, 201);
    assert.equal((await posted.json()).comment.website, "https://sited.example.com");
    assert.equal(state.comments[0].website, "https://sited.example.com");

    // Settings save requires a website and backfills past comments.
    assert.equal((await blogniceApp.request(authed("/live-post/comments/identity", { author_name: "Sited" }), undefined, env, executionCtx)).status, 400);
    assert.equal((await blogniceApp.request(authed("/live-post/comments/identity", { author_name: "Sited", website: "javascript:alert(1)" }), undefined, env, executionCtx)).status, 400);
    state.comments[0].website = null;
    const saved = await blogniceApp.request(authed("/live-post/comments/identity", { author_name: "Sited", website: "blog.example.com/work" }), undefined, env, executionCtx);
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).website, "https://blog.example.com/work");
    assert.equal(state.identities[emailHash].website, "https://blog.example.com/work");
    assert.equal(state.comments[0].website, "https://blog.example.com/work");

    // Readers without a site still comment; their rows carry no link.
    const plainCookie = await verified(blogniceApp, state, env, executionCtx, req, sentEmails, "plain@example.com", "Plain");
    const plain = await blogniceApp.request(req("/live-post/comments", {
      method: "POST", headers: { "content-type": "application/json", cookie: `bn_comment=${plainCookie}` },
      body: JSON.stringify({ body: "No site." }),
    }), undefined, env, executionCtx);
    assert.equal(plain.status, 201);
    assert.equal((await plain.json()).comment.website, null);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test("re-verification restamps past names and sites", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const state = makeState();
  const db = fakeDb(state);
  const env = { DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test", EMAIL_FROM: "Blog <hello@blognice.test>", MAILNICE_API_KEY: "test-key" };
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
    const emailHash = createHash("sha256").update("restamp@example.com").digest("hex");
    const cookie = await verified(blogniceApp, state, env, executionCtx, req, sentEmails, "restamp@example.com", "Old Name", "old.example.com");
    const posted = await blogniceApp.request(req("/live-post/comments", {
      method: "POST", headers: { "content-type": "application/json", cookie: `bn_comment=${cookie}` },
      body: JSON.stringify({ body: "First." }),
    }), undefined, env, executionCtx);
    assert.equal(posted.status, 201);
    assert.equal(state.comments[0].author_name, "Old Name");
    assert.equal(state.comments[0].website, "https://old.example.com");

    // The same email re-verifies (new device) with a new name and site:
    // identity and past rows move together, like a settings save.
    await verified(blogniceApp, state, env, executionCtx, req, sentEmails, "restamp@example.com", "New Name", "new.example.com");
    assert.equal(state.identities[emailHash].author_name, "New Name");
    assert.equal(state.identities[emailHash].website, "https://new.example.com");
    assert.equal(state.comments[0].author_name, "New Name");
    assert.equal(state.comments[0].website, "https://new.example.com");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});
