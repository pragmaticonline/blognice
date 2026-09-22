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

// Stateful POSTS/index stand-in. Understands only the comment queries;
// parses INSERT column lists and UPDATE SET clauses so it stays robust.
function fakeDb(state) {
  const colsOf = (sql, from, to) => sql.slice(sql.indexOf(from) + from.length, sql.indexOf(to)).split(",").map((part) => part.trim().split(" ")[0]).filter(Boolean);
  return {
    prepare(sql) {
      return {
        bind(...args) {
          const first = async () => {
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
              if (sql.includes("token_hash")) {
                const hash = args.find((a) => typeof a === "string" && /^[0-9a-f]{64}$/.test(a));
                return rows.find((r) => r.token_hash === hash) ?? null;
              }
              if (sql.includes("email_hash")) return rows.find((r) => r.email_hash === args[args.length - 1]) ?? null;
              if (sql.includes("cookie_hash")) return rows.find((r) => r.cookie_hash === args[args.length - 1]) ?? null;
              return null;
            }
            if (sql.includes("FROM comments")) {
              return state.comments.find((c) => {
                if (c.tenant_id !== args[0]) return false;
                if (sql.includes("email_hash") && c.email_hash !== args[1]) return false;
                if (sql.includes("body") && c.body !== args[2]) return false;
                if (sql.includes("created_at >") && !(c.created_at > args[args.length - 1])) return false;
                if (sql.includes("AND id = ?") && c.id !== args[args.length - 1]) return false;
                return true;
              }) ?? null;
            }
            if (sql.includes("COUNT(*)")) {
              if (sql.includes("comment_attempts")) {
                const hasEmail = sql.includes("email_hash");
                const kind = args.find((a) => a === "start" || a === "submit" || a === "identity");
                const since = args[args.length - 1];
                const scoped = state.attempts.filter((a) => a.tenant_id === args[0] && a.kind === kind && a.created_at > since);
                if (!hasEmail) return { count: scoped.length };
                const hash = args[1];
                return { count: scoped.filter((a) => a.email_hash === hash).length };
              }
              return { count: 0 };
            }
            return null;
          };
          return {
            first,
            all: async () => {
              if (sql.includes("SELECT DISTINCT post_id")) {
                const seen = [...new Set(state.comments.filter((c) => c.tenant_id === args[0] && c.email_hash === args[1]).map((c) => c.post_id))];
                return { results: seen.map((post_id) => ({ post_id })) };
              }
              if (sql.includes("SELECT slug FROM posts")) {
                const ids = args.slice(1);
                return { results: Object.values(state.posts).filter((p) => ids.includes(p.id)).map((p) => ({ slug: p.slug })) };
              }
              return { results: [] };
            },
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
              if (sql.startsWith("UPDATE comments SET avatar_key")) {
                const value = sql.includes("= NULL") ? null : args[0];
                for (const c of state.comments) {
                  if (c.tenant_id === args[args.length - 2] && c.email_hash === args[args.length - 1]) c.avatar_key = value;
                }
                return { success: true };
              }
              if (sql.startsWith("INSERT INTO comment_attempts")) {
                state.attempts.push({ tenant_id: args[0], email_hash: args[1], kind: args[2], created_at: args[3] });
                return { success: true };
              }
              if (sql.startsWith("DELETE FROM comment_attempts")) {
                state.attempts = state.attempts.filter((a) => a.created_at > args[0]);
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
      "unfinished": { id: 8, tenant_id: 1, slug: "unfinished", title: "Draft", body_md: "x", tags_json: "[]", published: 0, created_at: NOW, updated_at: NOW },
    },
    identities: {},
    attempts: [],
    comments: [],
  };
}

const tokenFrom = (body) => (body.match(/token=([0-9a-f]{32,})/) || [])[1];
const cookieFrom = (res) => {
  const set = res.headers.get("set-cookie") || "";
  return (set.match(/bn_comment=([^;]+)/) || [])[1];
};

test("verified readers post auto-approved comments; guards hold", async () => {
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
    // Start verification for a new address.
    const start = await blogniceApp.request(req("/live-post/comments/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "reader@example.com", author_name: "Reader" }),
    }), undefined, env, executionCtx);
    assert.equal(start.status, 200);
    assert.equal(sentEmails.length, 1);
    const token = tokenFrom(sentEmails[0]);
    assert.ok(token, "verification email carries a token");

    // Submitting before verifying is rejected.
    const early = await blogniceApp.request(req("/live-post/comments", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Too soon." }),
    }), undefined, env, executionCtx);
    assert.equal(early.status, 401);

    // Verify: single-use token, cookie set, redirect to the post.
    const verify = await blogniceApp.request(req(`/live-post/comments/verify?token=${token}`), undefined, env, executionCtx);
    assert.equal(verify.status, 302);
    assert.match(verify.headers.get("location") || "", /\/live-post\?verified=1#/);
    const cookie = cookieFrom(verify);
    assert.ok(cookie, "browser identity cookie set");
    const replay = await blogniceApp.request(req(`/live-post/comments/verify?token=${token}`), undefined, env, executionCtx);
    assert.ok([400, 410].includes(replay.status), "token is single-use");

    const withCookie = (body) => req("/live-post/comments", {
      method: "POST", headers: { "content-type": "application/json", cookie: `bn_comment=${cookie}` },
      body: JSON.stringify(body),
    });

    // Verified submit is auto-approved.
    const posted = await blogniceApp.request(withCookie({ body: "First!" }), undefined, env, executionCtx);
    assert.equal(posted.status, 201);
    const postedJson = await posted.json();
    assert.equal(postedJson.comment.body, "First!");
    assert.equal(postedJson.comment.status, "approved");
    assert.equal(state.comments.length, 1);

    // Guards: duplicates, markup, length, bad parents.
    assert.equal((await blogniceApp.request(withCookie({ body: "First!" }), undefined, env, executionCtx)).status, 409);
    assert.equal((await blogniceApp.request(withCookie({ body: "<b>bold</b>" }), undefined, env, executionCtx)).status, 400);
    assert.equal((await blogniceApp.request(withCookie({ body: "x".repeat(2001) }), undefined, env, executionCtx)).status, 400);
    assert.equal((await blogniceApp.request(withCookie({ body: "Ghost reply.", parent_id: 999 }), undefined, env, executionCtx)).status, 400);

    // Replies attach to the tree.
    const reply = await blogniceApp.request(withCookie({ body: "Agreed.", parent_id: 1 }), undefined, env, executionCtx);
    assert.equal(reply.status, 201);
    assert.equal((await reply.json()).comment.parent_id, 1);

    // Chosen avatar hues stick to the comment; junk hues are ignored.
    const hued = await blogniceApp.request(withCookie({ body: "Colourful.", avatar_hue: 200 }), undefined, env, executionCtx);
    assert.equal(hued.status, 201);
    assert.equal((await hued.json()).comment.avatar_hue, 200);
    assert.equal(state.comments[state.comments.length - 1].avatar_hue, 200);
    const junk = await blogniceApp.request(withCookie({ body: "No hue.", avatar_hue: 999 }), undefined, env, executionCtx);
    assert.equal(junk.status, 201);
    assert.equal((await junk.json()).comment.avatar_hue, null);

    // Draft posts and disabled blogs accept nothing.
    assert.equal((await blogniceApp.request(req("/unfinished/comments", {
      method: "POST", headers: { "content-type": "application/json", cookie: `bn_comment=${cookie}` },
      body: JSON.stringify({ body: "Sneaky." }),
    }), undefined, env, executionCtx)).status, 404);
    state.tenant.comments_enabled = 0;
    assert.equal((await blogniceApp.request(req("/live-post/comments/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "other@example.com", author_name: "Other" }),
    }), undefined, env, executionCtx)).status, 404);
    state.tenant.comments_enabled = 1;

    // Lost cookie recovery: re-verify the same address, old cookie keeps working too.
    const recover = await blogniceApp.request(req("/live-post/comments/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "reader@example.com", author_name: "Reader" }),
    }), undefined, env, executionCtx);
    assert.equal(recover.status, 200);
    const token2 = tokenFrom(sentEmails[sentEmails.length - 1]);
    assert.ok(token2 && token2 !== token, "recovery issues a fresh token");
    const verify2 = await blogniceApp.request(req(`/live-post/comments/verify?token=${token2}`), undefined, env, executionCtx);
    assert.equal(verify2.status, 302);
    const cookie2 = cookieFrom(verify2);
    assert.ok(cookie2, "recovery sets a fresh cookie");
    const afterRecovery = await blogniceApp.request(req("/live-post/comments", {
      method: "POST", headers: { "content-type": "application/json", cookie: `bn_comment=${cookie2}` },
      body: JSON.stringify({ body: "Back again." }),
    }), undefined, env, executionCtx);
    assert.equal(afterRecovery.status, 201);

    // Submit rate limit: 20 per 10 minutes per identity (5 posted above).
    for (let i = 0; i < 15; i++) {
      const res = await blogniceApp.request(req("/live-post/comments", {
        method: "POST", headers: { "content-type": "application/json", cookie: `bn_comment=${cookie2}` },
        body: JSON.stringify({ body: `Filler ${i}.` }),
      }), undefined, env, executionCtx);
      assert.equal(res.status, 201);
    }
    const limited = await blogniceApp.request(req("/live-post/comments", {
      method: "POST", headers: { "content-type": "application/json", cookie: `bn_comment=${cookie2}` },
      body: JSON.stringify({ body: "One too many." }),
    }), undefined, env, executionCtx);
    assert.equal(limited.status, 429);

    // Start rate limit: 5 verification requests per hour per address (2 above).
    for (let i = 0; i < 3; i++) {
      const res = await blogniceApp.request(req("/live-post/comments/start", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "reader@example.com", author_name: "Reader" }),
      }), undefined, env, executionCtx);
      assert.equal(res.status, 200);
    }
    const startLimited = await blogniceApp.request(req("/live-post/comments/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "reader@example.com", author_name: "Reader" }),
    }), undefined, env, executionCtx);
    assert.equal(startLimited.status, 429);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test("failed verification sends are logged with provider detail", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const state = makeState();
  const db = fakeDb(state);
  const env = { DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test", EMAIL_FROM: "Blog <hello@blognice.test>", MAILNICE_API_KEY: "test-key" };
  const background = [];
  const executionCtx = { waitUntil(p) { background.push(p); }, passThroughOnException() {} };
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => { errors.push(args.join(" ")); };
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("api.mailnice.net")) {
      return new Response(JSON.stringify({ status: "error", error: "bad-key" }), { status: 401, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const start = await blogniceApp.request(new Request("https://commentblog.blognice.test/live-post/comments/start", {
      method: "POST",
      headers: { host: "commentblog.blognice.test", "content-type": "application/json" },
      body: JSON.stringify({ email: "reader@example.com", author_name: "Reader" }),
    }), undefined, env, executionCtx);
    assert.equal(start.status, 200);
    await Promise.all(background);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /not delivered/);
    assert.match(errors[0], /mailnice/);
    assert.match(errors[0], /bad-key/);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});

test("verified readers rename themselves from comment settings", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const state = makeState();
  const db = fakeDb(state);
  const env = { DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test", EMAIL_FROM: "Blog <hello@blognice.test>", MAILNICE_API_KEY: "test-key" };
  const pending = [];
  const purged = [];
  const executionCtx = { waitUntil(p) { pending.push(Promise.resolve(p)); }, passThroughOnException() {} };
  const sentEmails = [];
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.fetch = async (url, init) => {
    sentEmails.push(String(init?.body || ""));
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  };
  globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async (req) => { purged.push(String(req.url || req)); } } };
  const req = (path, opts = {}) => new Request(`https://commentblog.blognice.test${path}`, {
    ...opts,
    headers: { host: "commentblog.blognice.test", ...(opts.headers || {}) },
  });
  try {
    const start = await blogniceApp.request(req("/live-post/comments/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "renamer@example.com", author_name: "Old Name" }),
    }), undefined, env, executionCtx);
    assert.equal(start.status, 200);
    const verify = await blogniceApp.request(req(`/live-post/comments/verify?token=${tokenFrom(sentEmails[0])}`), undefined, env, executionCtx);
    assert.equal(verify.status, 302);
    const cookie = cookieFrom(verify);
    assert.ok(cookie, "browser identity cookie set");
    const authed = (path, body) => req(path, {
      method: "POST", headers: { "content-type": "application/json", cookie: `bn_comment=${cookie}` },
      body: JSON.stringify(body),
    });

    // Anonymous renames are rejected.
    assert.equal((await blogniceApp.request(req("/live-post/comments/identity", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ author_name: "Nobody" }),
    }), undefined, env, executionCtx)).status, 401);

    // Guards: empty and over-long names.
    assert.equal((await blogniceApp.request(authed("/live-post/comments/identity", { author_name: " " }), undefined, env, executionCtx)).status, 400);
    assert.equal((await blogniceApp.request(authed("/live-post/comments/identity", { author_name: "x".repeat(61) }), undefined, env, executionCtx)).status, 400);

    // A comment posted under the old name keeps it stamped until a rename.
    const emailHash = createHash("sha256").update("renamer@example.com").digest("hex");
    state.comments.push({ id: 90, tenant_id: 1, post_id: 7, parent_id: null, author_name: "Old Name", email_hash: emailHash, body: "Before rename.", status: "approved", created_at: NOW });
    // Rename sticks, future comments carry it, and past comments are renamed too.
    const renamed = await blogniceApp.request(authed("/live-post/comments/identity", { author_name: "New Name", website: "newname.example.com" }), undefined, env, executionCtx);
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).author_name, "New Name");
    assert.equal(state.comments.find((c) => c.id === 90).author_name, "New Name");
    await Promise.allSettled(pending);
    assert.ok(purged.some((url) => url.includes("/live-post")), "rename purges pages carrying the reader's comments");
    const posted = await blogniceApp.request(authed("/live-post/comments", { body: "After rename." }), undefined, env, executionCtx);
    assert.equal(posted.status, 201);
    assert.equal((await posted.json()).comment.author_name, "New Name");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test("verified readers upload and remove profile photos", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const state = makeState();
  const db = fakeDb(state);
  const uploads = [];
  const deleted = [];
  const env = {
    DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test",
    EMAIL_FROM: "Blog <hello@blognice.test>", MAILNICE_API_KEY: "test-key",
    MEDIA: {
      put: async (key, body, opts) => { uploads.push({ key, size: body.byteLength, type: opts?.httpMetadata?.contentType }); },
      delete: async (key) => { deleted.push(key); },
    },
  };
  const executionCtx = { waitUntil() {}, passThroughOnException() {} };
  const sentEmails = [];
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.fetch = async (url, init) => {
    sentEmails.push(String(init?.body || ""));
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  };
  globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => {} } };
  const png = (size) => {
    const bytes = new Uint8Array(size);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return new File([bytes], "me.png", { type: "image/png" });
  };
  const upload = (cookie, file) => {
    const form = new FormData();
    if (file) form.append("avatar", file);
    const headers = { host: "commentblog.blognice.test" };
    if (cookie) headers.cookie = `bn_comment=${cookie}`;
    return blogniceApp.request(new Request("https://commentblog.blognice.test/live-post/comments/avatar", {
      method: "POST", headers, body: form,
    }), undefined, env, executionCtx);
  };
  try {
    const start = await blogniceApp.request(new Request("https://commentblog.blognice.test/live-post/comments/start", {
      method: "POST", headers: { host: "commentblog.blognice.test", "content-type": "application/json" },
      body: JSON.stringify({ email: "photo@example.com", author_name: "Shutter" }),
    }), undefined, env, executionCtx);
    assert.equal(start.status, 200);
    const verify = await blogniceApp.request(new Request(`https://commentblog.blognice.test/live-post/comments/verify?token=${tokenFrom(sentEmails[0])}`, {
      headers: { host: "commentblog.blognice.test" },
    }), undefined, env, executionCtx);
    assert.equal(verify.status, 302);
    const cookie = cookieFrom(verify);

    // Guards: anonymous, missing file, spoofed type, oversized.
    assert.equal((await upload(null, png(1024))).status, 401);
    assert.equal((await upload(cookie, null)).status, 400);
    const spoof = new File(["hello"], "evil.png", { type: "image/png" });
    assert.equal((await upload(cookie, spoof)).status, 400);
    assert.equal((await upload(cookie, png(3 * 1024 * 1024))).status, 413);

    // Valid upload stores the key on the identity and serves it back.
    const done = await upload(cookie, png(1024));
    assert.equal(done.status, 201);
    const { url, key } = await done.json();
    assert.match(url, /^\/media\/avatars\/1-[0-9a-f]{8}-[0-9a-f]{8}\.png$/);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].type, "image/png");

    // New comments carry the photo.
    const posted = await blogniceApp.request(new Request("https://commentblog.blognice.test/live-post/comments", {
      method: "POST", headers: { host: "commentblog.blognice.test", cookie: `bn_comment=${cookie}`, "content-type": "application/json" },
      body: JSON.stringify({ body: "With photo." }),
    }), undefined, env, executionCtx);
    assert.equal(posted.status, 201);
    assert.equal((await posted.json()).comment.avatar_key, key);

    // A photo change restamps past comments too, not just future ones.
    const postedRow = state.comments.find((c) => c.body === "With photo.");
    const done2 = await upload(cookie, png(2048));
    assert.equal(done2.status, 201);
    const { key: key2 } = await done2.json();
    assert.notEqual(key2, key);
    assert.equal(postedRow.avatar_key, key2);
    assert.ok(deleted.includes(key), "replaced photo object is deleted");

    // Removal clears the identity and deletes the object.
    const removed = await blogniceApp.request(new Request("https://commentblog.blognice.test/live-post/comments/avatar", {
      method: "DELETE", headers: { host: "commentblog.blognice.test", cookie: `bn_comment=${cookie}` },
    }), undefined, env, executionCtx);
    assert.equal(removed.status, 200);
    assert.ok(deleted.includes(key2));
    assert.equal(postedRow.avatar_key, null, "removal clears past comments");
    const reposted = await blogniceApp.request(new Request("https://commentblog.blognice.test/live-post/comments", {
      method: "POST", headers: { host: "commentblog.blognice.test", cookie: `bn_comment=${cookie}`, "content-type": "application/json" },
      body: JSON.stringify({ body: "Without photo." }),
    }), undefined, env, executionCtx);
    assert.equal((await reposted.json()).comment.avatar_key, null);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test("settings saves are rate-limited per reader", async () => {
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
    await blogniceApp.request(req("/live-post/comments/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "limited@example.com", author_name: "Limited" }),
    }), undefined, env, executionCtx);
    const verify = await blogniceApp.request(req(`/live-post/comments/verify?token=${tokenFrom(sentEmails[0])}`), undefined, env, executionCtx);
    const cookie = cookieFrom(verify);
    const save = (name) => blogniceApp.request(req("/live-post/comments/identity", {
      method: "POST", headers: { "content-type": "application/json", cookie: `bn_comment=${cookie}` },
      body: JSON.stringify({ author_name: name, website: "https://limited.example.com" }),
    }), undefined, env, executionCtx);
    for (let i = 0; i < 10; i++) assert.equal((await save(`Limited ${i}`)).status, 200);
    assert.equal((await save("Limited 11")).status, 429);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});
