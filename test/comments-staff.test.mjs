import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createSign, createVerify, generateKeyPairSync } from "node:crypto";
import test from "node:test";

const require = createRequire(import.meta.url);
for (const extension of [".html", ".svg"]) {
  require.extensions[extension] = (module, filename) => {
    module.exports = readFileSync(filename, "utf8");
  };
}

const NOW = Math.floor(Date.now() / 1000);
const TEAM = "https://team.cloudflareaccess.com";
const AUD = "staff-aud";
const REASONS = ["spam", "harassment", "other"];

function makeState() {
  return {
    tenant: {
      id: 1, public_id: "b_comments", slug: "commentblog", title: "Comment Blog",
      description: "", accent_color: "#1a8917", comments_enabled: 1, shard: "primary",
      created_at: NOW, deleted_at: null,
    },
    posts: {
      "live-post": { id: 7, tenant_id: 1, slug: "live-post", title: "Live", body_md: "Hi.", tags_json: "[]", published: 1, created_at: NOW, updated_at: NOW, author_visible: 1 },
      "unfinished": { id: 8, tenant_id: 1, slug: "unfinished", title: "Draft", body_md: "Hi.", tags_json: "[]", published: 0, created_at: NOW, updated_at: NOW, author_visible: 1 },
    },
    comments: [
      { id: 1, tenant_id: 1, post_id: 7, parent_id: null, author_name: "Reader", email_hash: "e1", body: "Hello.", status: "approved", created_at: NOW - 50, decided_at: NOW - 50 },
    ],
    attempts: [],
    reports: [],
    staff_users: [
      { subject: "staff-admin-1", email: "admin@example.com", role: "admin", active: 1 },
      { subject: "staff-support-1", email: "support@example.com", role: "support", active: 1 },
      { subject: "staff-ro-1", email: "ro@example.com", role: "read_only", active: 1 },
    ],
  };
}

function mainDb(state) {
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
                return state.comments.find((c) => c.tenant_id === args[0] && c.id === args[args.length - 1] && (!sql.includes("status = 'approved'") || c.status === "approved")) ?? null;
              }
              if (sql.includes("COUNT(*)") && sql.includes("comment_attempts")) {
                const hasEmail = sql.includes("email_hash");
                const kind = args.find((a) => a === "report" || a === "submit" || a === "start");
                const since = args[args.length - 1];
                const scoped = state.attempts.filter((a) => a.tenant_id === args[0] && a.kind === kind && a.created_at > since);
                if (!hasEmail) return { count: scoped.length };
                return { count: scoped.filter((a) => a.email_hash === args[1]).length };
              }
              return null;
            },
            all: async () => ({ results: [] }),
            run: async () => {
              if (sql.startsWith("INSERT INTO comment_attempts")) {
                state.attempts.push({ tenant_id: args[0], email_hash: args[1], kind: args[2], created_at: args[3] });
              }
              if (sql.startsWith("DELETE FROM comment_attempts")) {
                state.attempts = state.attempts.filter((a) => a.created_at > args[0]);
              }
              if (sql.startsWith("INSERT INTO comment_reports")) {
                const cols = sql.slice(sql.indexOf("comment_reports (") + "comment_reports (".length, sql.indexOf(") VALUES")).split(",").map((p) => p.trim());
                const row = { id: state.reports.length + 1 };
                cols.forEach((col, i) => { row[col] = args[i]; });
                state.reports.push(row);
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
}

function staffDb(state) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => {
              if (sql.includes("FROM staff_users")) {
                return state.staff_users.find((u) => u.subject === args[0] && u.active === 1) ?? null;
              }
              if (sql.includes("FROM tenants")) {
                const t = state.tenant;
                if (args.length && args[0] !== t.id && args[0] !== t.public_id && args[0] !== t.slug) return null;
                return t;
              }
              if (sql.includes("FROM comment_reports")) {
                return state.reports.find((r) => r.id === args[0]) ?? null;
              }
              if (sql.includes("FROM comments")) {
                return state.comments.find((c) => c.tenant_id === args[0] && c.id === args[1]) ?? null;
              }
              return null;
            },
            all: async () => {
              if (sql.includes("FROM comment_reports")) {
                return {
                  results: state.reports
                    .filter((r) => !sql.includes("status = 'open'") || r.status === "open")
                    .map((r) => ({
                      ...r,
                      blog_title: state.tenant.title,
                      post_slug: state.posts["live-post"].slug,
                      comment_body: state.comments.find((c) => c.id === r.comment_id)?.body ?? null,
                    }))
                    .sort((a, b) => b.id - a.id),
                };
              }
              return { results: [] };
            },
            run: async () => {
              if (sql.startsWith("UPDATE comment_reports SET")) {
                const row = state.reports.find((r) => r.id === args[args.length - 1]);
                if (row) { row.status = args[0]; row.decided_at = args[1]; }
              }
              if (sql.startsWith("UPDATE comments SET")) {
                const row = state.comments.find((c) => c.id === args[args.length - 1]);
                if (row) { row.status = args[0]; row.decided_at = args[1]; }
              }
              if (sql.startsWith("UPDATE tenants SET comments_enabled")) {
                state.tenant.comments_enabled = args[0];
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
}

// Self-signed Cloudflare Access JWT for staff tests.
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const publicJwk = JSON.parse(JSON.stringify(require("crypto").createPublicKey(publicKey).export({ format: "jwk" })));
publicJwk.kid = "test-kid";

function b64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function staffJwt(sub) {
  const header = b64url(JSON.stringify({ alg: "RS256", kid: "test-kid", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ sub, email: `${sub}@example.com`, exp: NOW + 300, iat: NOW, iss: TEAM, aud: AUD }));
  const sig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey, "base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${header}.${payload}.${sig}`;
}

const staffHeaders = (sub) => ({
  host: "staff.test",
  Origin: "https://staff.test",
  "Cf-Access-Jwt-Assertion": staffJwt(sub),
});

test("readers report abusive comments within rate limits", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const state = makeState();
  const db = mainDb(state);
  const env = { DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test" };
  const executionCtx = { waitUntil() {}, passThroughOnException() {} };
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => {} } };
  const req = (path, opts = {}) => new Request(`https://commentblog.blognice.test${path}`, {
    ...opts,
    headers: { host: "commentblog.blognice.test", ...(opts.headers || {}) },
  });
  try {
    const report = (reason) => req("/live-post/comments/1/report", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    const first = await blogniceApp.request(report("spam"), undefined, env, executionCtx);
    assert.equal(first.status, 200);
    assert.equal(state.reports.length, 1);
    assert.equal(state.reports[0].reason, "spam");
    assert.equal(state.reports[0].status, "open");

    assert.equal((await blogniceApp.request(report("bogus"), undefined, env, executionCtx)).status, 400);
    assert.equal((await blogniceApp.request(req("/live-post/comments/999/report", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "spam" }),
    }), undefined, env, executionCtx)).status, 404);
    assert.equal((await blogniceApp.request(req("/unfinished/comments/1/report", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "spam" }),
    }), undefined, env, executionCtx)).status, 404);

    // 10 reports/hour per reporter (1 above); the 11th is rejected.
    for (let i = 0; i < 9; i++) {
      assert.equal((await blogniceApp.request(report("spam"), undefined, env, executionCtx)).status, 200);
    }
    assert.equal((await blogniceApp.request(report("spam"), undefined, env, executionCtx)).status, 429);

    // Disabled blogs accept no reports.
    state.tenant.comments_enabled = 0;
    assert.equal((await blogniceApp.request(report("spam"), undefined, env, executionCtx)).status, 404);
    state.tenant.comments_enabled = 1;
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test("staff triage reports, remove comments, and override the blog flag", async () => {
  const staffApp = (await import("../src/staff.ts")).default;
  const state = makeState();
  state.reports.push({ id: 1, tenant_id: 1, post_id: 7, comment_id: 1, reason: "spam", reporter_hash: "anon", status: "open", created_at: NOW - 10, decided_at: null });
  const db = staffDb(state);
  const env = { DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test", ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
  const executionCtx = { waitUntil() {}, passThroughOnException() {} };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/cdn-cgi/access/certs")) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  };
  const req = (path, sub, opts = {}) => new Request(`https://staff.test${path}`, {
    ...opts,
    headers: { ...staffHeaders(sub), ...((opts).headers || {}) },
  });
  try {
    // No JWT: locked out.
    assert.equal((await staffApp.request(req("/api/comment-reports", "nobody", {
      headers: { host: "staff.test", Origin: "https://staff.test" },
    }), undefined, env, executionCtx)).status, 403);

    // Admin sees the queue with blog and post context.
    const queue = await staffApp.request(req("/api/comment-reports", "staff-admin-1"), undefined, env, executionCtx);
    assert.equal(queue.status, 200);
    const queueJson = await queue.json();
    assert.equal(queueJson.reports.length, 1);
    assert.equal(queueJson.reports[0].reason, "spam");
    assert.equal(queueJson.reports[0].blog_title, "Comment Blog");

    // Read-only staff cannot resolve.
    assert.equal((await staffApp.request(req("/api/comment-reports/1/resolve", "staff-ro-1", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "dismissed" }),
    }), undefined, env, executionCtx)).status, 403);

    // Support resolves as dismissed.
    const resolved = await staffApp.request(req("/api/comment-reports/1/resolve", "staff-support-1", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "dismissed" }),
    }), undefined, env, executionCtx);
    assert.equal(resolved.status, 200);
    assert.equal(state.reports[0].status, "dismissed");

    // Support removes the comment outright (reason required).
    const noReason = await staffApp.request(req("/api/comments/remove", "staff-support-1", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: 1, comment_id: 1 }),
    }), undefined, env, executionCtx);
    assert.equal(noReason.status, 400);
    const removed = await staffApp.request(req("/api/comments/remove", "staff-support-1", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: 1, comment_id: 1, reason: "spam" }),
    }), undefined, env, executionCtx);
    assert.equal(removed.status, 200);
    assert.equal(state.comments[0].status, "removed");

    // Flag override is admin-only.
    assert.equal((await staffApp.request(req("/api/blogs/1/comments-enabled", "staff-support-1", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }),
    }), undefined, env, executionCtx)).status, 403);
    const toggled = await staffApp.request(req("/api/blogs/1/comments-enabled", "staff-admin-1", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }),
    }), undefined, env, executionCtx);
    assert.equal(toggled.status, 200);
    assert.equal(state.tenant.comments_enabled, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
