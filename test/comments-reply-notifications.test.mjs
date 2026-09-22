// Reply notifications: a direct reply emails the parent author when they are
// a confirmed updates subscriber, and stays silent otherwise.
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
const sha = (s) => createHash("sha256").update(s).digest("hex");

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
    identities: {
      [sha("parent@example.com")]: { tenant_id: 1, email_hash: sha("parent@example.com"), author_name: "Parent", website: null, avatar_key: null, cookie_hash: sha("parent-cookie"), verified_at: NOW, created_at: NOW },
      [sha("replier@example.com")]: { tenant_id: 1, email_hash: sha("replier@example.com"), author_name: "Replier", website: null, avatar_key: null, cookie_hash: sha("replier-cookie"), verified_at: NOW, created_at: NOW },
    },
    comments: [
      { id: 1, tenant_id: 1, post_id: 7, parent_id: null, author_name: "Parent", email_hash: sha("parent@example.com"), body: "Original thought.", status: "approved", created_at: NOW - 50, decided_at: NOW - 50, avatar_hue: null, avatar_key: null, website: null, likes: 0, dislikes: 0 },
    ],
    attempts: [],
    subscribers: [
      { id: 1, tenant_id: 1, email: "parent@example.com", token: "tok-parent", created_at: NOW - 60, confirmed_at: NOW - 55 },
    ],
    manageTokens: {},
  };
}

function fakeDb(state) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => {
              if (sql.includes("tenant_slug_aliases")) return null;
              if (sql.includes("FROM tenants")) {
                return args.some((a) => a === "commentblog") ? state.tenant : null;
              }
              if (sql.includes("FROM posts")) {
                const slug = args[args.length - 1];
                return state.posts[slug] ?? null;
              }
              if (sql.includes("FROM comment_identities")) {
                const rows = Object.values(state.identities);
                if (sql.includes("cookie_hash")) return rows.find((r) => r.cookie_hash === args[args.length - 1]) ?? null;
                if (sql.includes("email_hash")) return rows.find((r) => r.email_hash === args[args.length - 1]) ?? null;
                return null;
              }
              if (sql.includes("FROM subscription_manage_tokens")) {
                return state.manageTokens[args[0]] ? { token: state.manageTokens[args[0]] } : null;
              }
              if (sql.includes("COUNT(*)") && sql.includes("comment_attempts")) return { count: 0 };
              if (sql.includes("FROM comments")) {
                return state.comments.find((c) => {
                  if (c.tenant_id !== args[0]) return false;
                  if (sql.includes("AND id = ?") && c.id !== args[args.length - 1]) return false;
                  if (sql.includes("email_hash") && c.email_hash !== args[1]) return false;
                  if (sql.includes("body") && c.body !== args[2]) return false;
                  return true;
                }) ?? null;
              }
              return null;
            },
            all: async () => {
              if (sql.includes("FROM subscribers")) {
                return { results: state.subscribers.filter((s) => s.tenant_id === args[0] && s.confirmed_at != null) };
              }
              return { results: [] };
            },
            run: async () => {
              if (sql.startsWith("INSERT INTO comments")) {
                const id = state.comments.length + 1;
                state.comments.push({ id, tenant_id: args[0], post_id: args[1], parent_id: args[2], author_name: args[3], email_hash: args[4], body: args[5], status: args[6] });
                return { success: true, meta: { last_row_id: id } };
              }
              if (sql.startsWith("INSERT INTO comment_attempts")) {
                state.attempts.push({ tenant_id: args[0], email_hash: args[1], kind: args[2], created_at: args[3] });
                return { success: true };
              }
              if (sql.startsWith("INSERT INTO subscription_manage_tokens")) {
                state.manageTokens[args[0]] = args[1];
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

function setup(state, withQueue) {
  const db = fakeDb(state);
  const queued = [];
  const env = {
    DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test",
    EMAIL_FROM: "Blog <hello@blognice.test>", MAILNICE_API_KEY: "test-key",
  };
  if (withQueue) env.EMAIL_QUEUE = { send: async (job) => { queued.push(job); } };
  const pending = [];
  const executionCtx = { waitUntil(p) { pending.push(Promise.resolve(p).catch(() => false)); }, passThroughOnException() {} };
  const sentEmails = [];
  globalThis.fetch = async (url, init) => {
    sentEmails.push({ url: String(url), body: String(init?.body || "") });
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  };
  globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => {} } };
  return { db, queued, env, pending, executionCtx, sentEmails };
}

const post = (app, env, ctx, cookie, body) => app.request(new Request("https://commentblog.blognice.test/live-post/comments", {
  method: "POST", headers: { host: "commentblog.blognice.test", cookie: `bn_comment=${cookie}`, "content-type": "application/json" },
  body: JSON.stringify(body),
}), undefined, env, ctx);

test("direct replies notify the subscribed parent author", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const state = makeState();
  const { queued, env, pending, executionCtx } = setup(state, true);
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  try {
    const res = await post(blogniceApp, env, executionCtx, "replier-cookie", { body: "I disagree, gently.", parent_id: 1 });
    assert.equal(res.status, 201);
    await Promise.all(pending);
    assert.equal(queued.length, 1);
    const job = queued[0];
    assert.equal(job.to, "parent@example.com");
    assert.match(job.idempotencyKey, /^comment-reply:1:2$/);
    assert.match(job.subject, /Replier/);
    assert.match(job.html, /I disagree, gently\./);
    assert.match(job.html, /\/unsubscribe\/tok-parent/);
    assert.match(job.plainText, /\/unsubscribe\/tok-parent/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test("replies stay silent without a subscribed parent", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  try {
    // Top-level comments notify nobody.
    {
      const state = makeState();
      const { queued, env, pending, executionCtx } = setup(state, true);
      const res = await post(blogniceApp, env, executionCtx, "replier-cookie", { body: "Fresh thread." });
      assert.equal(res.status, 201);
      await Promise.all(pending);
      assert.equal(queued.length, 0);
    }
    // Self-replies notify nobody.
    {
      const state = makeState();
      const { queued, env, pending, executionCtx } = setup(state, true);
      const res = await post(blogniceApp, env, executionCtx, "parent-cookie", { body: "Adding to my own point.", parent_id: 1 });
      assert.equal(res.status, 201);
      await Promise.all(pending);
      assert.equal(queued.length, 0);
    }
    // An unconfirmed parent has no address on file.
    {
      const state = makeState();
      state.subscribers = [];
      const { queued, env, pending, executionCtx } = setup(state, true);
      const res = await post(blogniceApp, env, executionCtx, "replier-cookie", { body: "Hello?", parent_id: 1 });
      assert.equal(res.status, 201);
      await Promise.all(pending);
      assert.equal(queued.length, 0);
    }
    // Without a queue the reply goes direct.
    {
      const state = makeState();
      const { queued, env, pending, executionCtx, sentEmails } = setup(state, false);
      const res = await post(blogniceApp, env, executionCtx, "replier-cookie", { body: "Direct path.", parent_id: 1 });
      assert.equal(res.status, 201);
      await Promise.all(pending);
      assert.equal(queued.length, 0);
      assert.ok(sentEmails.some((e) => e.body.includes("parent@example.com")), "direct send reaches the parent");
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});
