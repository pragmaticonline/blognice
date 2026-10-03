// Cross-device comment verification: a first comment submitted on one device
// (phone) must go live when the confirmation email is clicked on another
// device (desktop). The draft lives server-side as an `unverified` row and
// the verify click publishes it — no second Send press on any device.
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
              if (sql.includes("AND id = ?")) return Object.values(state.posts).find((p) => p.id === args[args.length - 1]) ?? null;
              return state.posts[args[args.length - 1]] ?? null;
            }
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
              return null;
            }
            if (sql.includes("FROM comments")) {
              if (sql.includes("COUNT(*)")) {
                let rows = state.comments.filter((c) => c.tenant_id === args[0]);
                if (sql.includes("email_hash")) rows = rows.filter((c) => c.email_hash === args[1]);
                if (sql.includes("status = 'unverified'")) rows = rows.filter((c) => c.status === "unverified");
                if (sql.includes("status = 'approved'")) rows = rows.filter((c) => c.status === "approved");
                return { count: rows.length };
              }
              return state.comments.find((c) => {
                if (c.tenant_id !== args[0]) return false;
                if (sql.includes("email_hash = ?") && c.email_hash !== args[1]) return false;
                if (sql.includes("body = ?") && c.body !== args[2]) return false;
                if (sql.includes("created_at >") && !(c.created_at > args[args.length - 1])) return false;
                if (sql.includes("AND id = ?") && c.id !== args[args.length - 1]) return false;
                if (sql.includes("status = 'approved'") && c.status !== "approved") return false;
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
                return { count: scoped.filter((a) => a.email_hash === args[1]).length };
              }
              return { count: 0 };
            }
            return null;
          };
          return {
            first,
            all: async () => {
              if (sql.includes("FROM comments")) {
                let rows = state.comments.filter((c) => c.tenant_id === args[0]);
                if (sql.includes("post_id = ?")) rows = rows.filter((c) => c.post_id === args[1]);
                if (sql.includes("email_hash = ?")) rows = rows.filter((c) => c.email_hash === args.find((a) => typeof a === "string" && /^[0-9a-f]{64}$/.test(a)));
                if (sql.includes("status = 'approved'")) rows = rows.filter((c) => c.status === "approved");
                if (sql.includes("status = 'unverified'")) rows = rows.filter((c) => c.status === "unverified");
                if (sql.includes("created_at > ?")) rows = rows.filter((c) => c.created_at > args[args.length - 1]);
                if (sql.includes("id > ?")) rows = rows.filter((c) => c.id > args[args.length - 1]);
                return { results: rows };
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
              if (sql.startsWith("UPDATE comments SET author_name") || sql.startsWith("UPDATE comments SET website")) {
                for (const c of state.comments) {
                  if (c.tenant_id === args[1] && c.email_hash === args[2]) c[sql.includes("author_name") ? "author_name" : "website"] = args[0];
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
              if (sql.startsWith("UPDATE comments SET status")) {
                const id = args[args.length - 1];
                const row = state.comments.find((c) => c.id === id && c.status === "unverified");
                if (!row) return { success: true, meta: { changes: 0 } };
                row.status = "approved";
                row.parent_id = args[args.length - 3];
                row.decided_at = args[args.length - 2];
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.startsWith("UPDATE comments SET body")) {
                const row = state.comments.find((c) => c.id === args[args.length - 1]);
                if (row) {
                  row.body = args[0];
                  row.author_name = args[1];
                  row.website = args[2];
                  row.avatar_hue = args[3];
                  row.created_at = args[4];
                }
                return { success: true };
              }
              if (sql.startsWith("DELETE FROM comments")) {
                const before = state.comments.length;
                if (sql.includes("AND id = ?")) {
                  state.comments = state.comments.filter((c) => !(c.tenant_id === args[0] && c.id === args[1] && c.status === "unverified"));
                } else {
                  state.comments = state.comments.filter((c) => !(c.tenant_id === args[0] && c.email_hash === args[1] && c.status === "unverified" && c.created_at <= args[2]));
                }
                return { success: true, meta: { changes: before - state.comments.length } };
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

function makeHarness() {
  const sentEmails = [];
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.fetch = async (url, init) => {
    sentEmails.push(String(init?.body || ""));
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  };
  globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => {} } };
  return {
    sentEmails,
    tokenFrom: (body) => (String(body).match(/token=([0-9a-f]{32,})/) || [])[1],
    cookieFrom: (res) => ((res.headers.get("set-cookie") || "").match(/bn_comment=([^;]+)/) || [])[1],
    restore() {
      globalThis.fetch = originalFetch;
      if (originalCaches === undefined) delete globalThis.caches;
      else globalThis.caches = originalCaches;
    },
  };
}

test("first comment submitted on one device goes live when email is confirmed on another", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const state = makeState();
  const db = fakeDb(state);
  const env = { DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test", EMAIL_FROM: "Blog <hello@blognice.test>", MAILNICE_API_KEY: "test-key" };
  const executionCtx = { waitUntil() {}, passThroughOnException() {} };
  const h = makeHarness();
  const req = (path, opts = {}) => new Request(`https://commentblog.blognice.test${path}`, {
    ...opts,
    headers: { host: "commentblog.blognice.test", ...(opts.headers || {}) },
  });
  try {
    // Device A (phone, no cookie): submit with identity; the draft is held
    // server-side and a confirmation mail goes out.
    const submit = await blogniceApp.request(req("/live-post/comments", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Phone comment here.", email: "phone@example.com", author_name: "Phoney" }),
    }), undefined, env, executionCtx);
    assert.equal(submit.status, 202);
    assert.equal((await submit.json()).pending, true);
    assert.equal(h.sentEmails.length, 1);
    const token = h.tokenFrom(h.sentEmails[0]);
    assert.ok(token, "confirmation email carries a token");
    assert.equal(state.comments.length, 1);
    assert.equal(state.comments[0].status, "unverified");

    // The draft is invisible until confirmed: page and catch-up feed.
    const page = await blogniceApp.request(req("/live-post"), undefined, env, executionCtx);
    assert.equal(page.status, 200);
    assert.ok(!(await page.text()).includes("Phone comment here."), "draft not server-rendered");
    const feed = await blogniceApp.request(req("/live-post/comments?since_id=0"), undefined, env, executionCtx);
    assert.deepEqual((await feed.json()).comments, []);

    // Device B (desktop, its own empty jar): the email click publishes.
    const verify = await blogniceApp.request(req(`/live-post/comments/verify?token=${token}`), undefined, env, executionCtx);
    assert.equal(verify.status, 302);
    assert.match(verify.headers.get("location") || "", /published=1/);
    const cookieB = h.cookieFrom(verify);
    assert.ok(cookieB, "confirming device gets its own cookie");
    assert.equal(state.comments[0].status, "approved");

    // The comment is live on the post page with no second Send press.
    const live = await blogniceApp.request(req("/live-post"), undefined, env, executionCtx);
    assert.ok((await live.text()).includes("Phone comment here."), "published draft renders");

    // Device B is fully verified and can post directly.
    const fromB = await blogniceApp.request(req("/live-post/comments", {
      method: "POST", headers: { "content-type": "application/json", cookie: `bn_comment=${cookieB}` },
      body: JSON.stringify({ body: "Desktop follow-up." }),
    }), undefined, env, executionCtx);
    assert.equal(fromB.status, 201);

    // Device A is still unverified: re-tapping Send neither duplicates the
    // live comment nor strands a second draft — it just re-verifies A.
    const retap = await blogniceApp.request(req("/live-post/comments", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Phone comment here.", email: "phone@example.com", author_name: "Phoney" }),
    }), undefined, env, executionCtx);
    assert.equal(retap.status, 202);
    assert.equal((await retap.json()).already_posted, true);
    assert.equal(state.comments.filter((c) => c.body === "Phone comment here.").length, 1);
    const tokenA = h.tokenFrom(h.sentEmails[h.sentEmails.length - 1]);
    const verifyA = await blogniceApp.request(req(`/live-post/comments/verify?token=${tokenA}`), undefined, env, executionCtx);
    assert.equal(verifyA.status, 302);
    assert.match(verifyA.headers.get("location") || "", /published=0/);
    const cookieA = h.cookieFrom(verifyA);
    assert.ok(cookieA, "original device verifies independently");
    const fromA = await blogniceApp.request(req("/live-post/comments", {
      method: "POST", headers: { "content-type": "application/json", cookie: `bn_comment=${cookieA}` },
      body: JSON.stringify({ body: "Phone, now verified." }),
    }), undefined, env, executionCtx);
    assert.equal(fromA.status, 201);
  } finally {
    h.restore();
  }
});

test("unverified drafts stay out of votes, replies, and stale publishes", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const state = makeState();
  const db = fakeDb(state);
  const env = { DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test", EMAIL_FROM: "Blog <hello@blognice.test>", MAILNICE_API_KEY: "test-key" };
  const executionCtx = { waitUntil() {}, passThroughOnException() {} };
  const h = makeHarness();
  const req = (path, opts = {}) => new Request(`https://commentblog.blognice.test${path}`, {
    ...opts,
    headers: { host: "commentblog.blognice.test", ...(opts.headers || {}) },
  });
  try {
    const submit = await blogniceApp.request(req("/live-post/comments", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Drafty.", email: "draft@example.com", author_name: "Draft" }),
    }), undefined, env, executionCtx);
    assert.equal(submit.status, 202);
    const token = h.tokenFrom(h.sentEmails[0]);

    // A second submit before verifying replaces the draft instead of stacking.
    const resubmit = await blogniceApp.request(req("/live-post/comments", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Drafty, edited.", email: "draft@example.com", author_name: "Draft" }),
    }), undefined, env, executionCtx);
    assert.equal(resubmit.status, 202);
    assert.equal(state.comments.length, 1);
    assert.equal(state.comments[0].body, "Drafty, edited.");
    const token2 = h.tokenFrom(h.sentEmails[h.sentEmails.length - 1]);
    assert.ok(token2 && token2 !== token, "resubmit rotates the token");

    // Votes and replies treat the draft as nonexistent.
    const verify = await blogniceApp.request(req(`/live-post/comments/verify?token=${token2}`), undefined, env, executionCtx);
    const cookie = h.cookieFrom(verify);
    assert.ok(cookie);
    assert.equal(state.comments[0].status, "approved");
    const draftId = state.comments[0].id;

    // A fresh unverified draft from another address is untouchable.
    await blogniceApp.request(req("/live-post/comments", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Untouchable.", email: "other@example.com", author_name: "Other" }),
    }), undefined, env, executionCtx);
    const other = state.comments.find((c) => c.body === "Untouchable.");
    assert.equal((await blogniceApp.request(req(`/live-post/comments/${other.id}/vote`, {
      method: "POST", headers: { "content-type": "application/json", cookie: `bn_comment=${cookie}` },
      body: JSON.stringify({ vote: 1 }),
    }), undefined, env, executionCtx)).status, 404);
    assert.equal((await blogniceApp.request(req("/live-post/comments", {
      method: "POST", headers: { "content-type": "application/json", cookie: `bn_comment=${cookie}` },
      body: JSON.stringify({ body: "Reply to draft.", parent_id: other.id }),
    }), undefined, env, executionCtx)).status, 400);
    assert.ok(draftId > 0);

    // Stale drafts (older than the verification window) are cleaned up, not published.
    other.created_at = NOW - 86400 - 1;
    const otherToken = h.tokenFrom(h.sentEmails[h.sentEmails.length - 1]);
    const verifyStale = await blogniceApp.request(req(`/live-post/comments/verify?token=${otherToken}`), undefined, env, executionCtx);
    assert.equal(verifyStale.status, 302);
    assert.match(verifyStale.headers.get("location") || "", /published=0/);
    assert.ok(!state.comments.some((c) => c.body === "Untouchable."), "stale draft deleted on verify");
  } finally {
    h.restore();
  }
});

test("scheduled sweep deletes stale unverified drafts on every shard", async () => {
  const { cleanupUnverifiedComments } = await import("../src/index.ts");
  const deleted = [];
  const env = {
    DB: {
      prepare: () => ({
        bind: () => ({ all: async () => ({ results: [{ shard: "primary" }, { shard: "primary" }] }) }),
      }),
    },
    POSTS: {
      prepare: (sql) => ({
        bind: (...args) => ({
          run: async () => {
            deleted.push({ sql, cutoff: args[0] });
            return { success: true };
          },
        }),
      }),
    },
  };
  await cleanupUnverifiedComments(env, NOW);
  assert.equal(deleted.length, 1, "one sweep per distinct shard");
  assert.match(deleted[0].sql, /status = 'unverified'/);
  assert.equal(deleted[0].cutoff, NOW - 86400, "drafts live one token TTL");
});
