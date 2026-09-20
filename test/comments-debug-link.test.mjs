// TEMPORARY — reverted with the debug-link endpoint. Full loop:
// debug-link -> verify -> submit -> reply, all through HTTP.
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
const KEY = "ecbf9e166ebd3a7e8538de4d24ac42df";

function fakeDb(state) {
  const colsOf = (sql, from, to) => sql.slice(sql.indexOf(from) + from.length, sql.indexOf(to)).split(",").map((p) => p.trim().split(" ")[0]).filter(Boolean);
  return {
    prepare(sql) {
      return {
        bind(...args) {
          const first = async () => {
            if (sql.includes("FROM tenants")) return state.tenant;
            if (sql.includes("FROM posts")) return state.posts[args[args.length - 1]] ?? null;
            if (sql.includes("FROM comment_identities")) {
              const rows = Object.values(state.identities);
              if (sql.includes("token_hash")) {
                const h = args.find((a) => typeof a === "string" && /^[0-9a-f]{64}$/.test(a));
                return rows.find((r) => r.token_hash === h) ?? null;
              }
              if (sql.includes("email_hash")) return rows.find((r) => r.email_hash === args[args.length - 1]) ?? null;
              if (sql.includes("cookie_hash")) return rows.find((r) => r.cookie_hash === args[args.length - 1]) ?? null;
              return null;
            }
            if (sql.includes("FROM comments")) {
              return state.comments.find((c) => {
                if (c.tenant_id !== args[0]) return false;
                if (sql.includes("AND id = ?") && c.id !== args[args.length - 1]) return false;
                if (sql.includes("email_hash") && c.email_hash !== args[1]) return false;
                if (sql.includes("body") && c.body !== args[2]) return false;
                if (sql.includes("created_at >") && !(c.created_at > args[args.length - 1])) return false;
                return true;
              }) ?? null;
            }
            if (sql.includes("COUNT(*)")) return { count: 0 };
            return null;
          };
          return {
            first,
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
                const row = state.identities[args[args.length - 1]];
                if (row) {
                  if (sql.includes("cookie_hash = ?")) {
                    row.cookie_hash = args[0];
                    row.token_hash = null;
                    row.token_expires_at = null;
                    row.verified_at = args[1];
                  } else {
                    colsOf(sql, "SET", "WHERE").forEach((col, i) => { row[col] = args[i]; });
                  }
                }
                return { success: true };
              }
              if (sql.startsWith("INSERT INTO comment_attempts")) return { success: true };
              if (sql.startsWith("DELETE FROM comment_attempts")) return { success: true };
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

test("debug-link mints a link that verifies and posts end to end", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const state = {
    tenant: { id: 4, public_id: "b_test", slug: "test555", title: "Test", description: "", accent_color: "#1a8917", comments_enabled: 1, shard: "primary", created_at: NOW, deleted_at: null },
    posts: { "usa-politics-tlmcgb": { id: 11, tenant_id: 4, slug: "usa-politics-tlmcgb", title: "USA", body_md: "x", tags_json: "[]", published: 1, created_at: NOW, updated_at: NOW } },
    identities: {},
    comments: [],
  };
  const db = fakeDb(state);
  const env = { DB: db, POSTS: db, DEV_TENANT: "test555", ROOT_DOMAIN: "blognice.test" };
  const executionCtx = { waitUntil() {}, passThroughOnException() {} };
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => {} } };
  const req = (path, opts = {}) => new Request(`https://test555.blognice.test${path}`, {
    ...opts,
    headers: { host: "test555.blognice.test", ...(opts.headers || {}) },
  });
  try {
    const denied = await blogniceApp.request(req("/usa-politics-tlmcgb/comments/debug-link", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "qa@example.com", author_name: "QA", key: "wrong" }),
    }), undefined, env, executionCtx);
    assert.equal(denied.status, 404);

    const minted = await blogniceApp.request(req("/usa-politics-tlmcgb/comments/debug-link", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "qa@example.com", author_name: "QA", key: KEY }),
    }), undefined, env, executionCtx);
    assert.equal(minted.status, 200);
    const { verify_url } = await minted.json();
    assert.match(verify_url, /\/comments\/verify\?token=[0-9a-f]{32}/);
    const verifyPath = new URL(verify_url, "https://test555.blognice.test");

    const verify = await blogniceApp.request(req(`${verifyPath.pathname}${verifyPath.search}`), undefined, env, executionCtx);
    assert.equal(verify.status, 302);
    const cookie = (verify.headers.get("set-cookie") || "").match(/bn_comment=([^;]+)/)?.[1];
    assert.ok(cookie, "identity cookie set");

    const withCookie = (body) => req("/usa-politics-tlmcgb/comments", {
      method: "POST", headers: { "content-type": "application/json", cookie: `bn_comment=${cookie}` },
      body: JSON.stringify(body),
    });
    const posted = await blogniceApp.request(withCookie({ body: "Top-level from the loop." }), undefined, env, executionCtx);
    assert.equal(posted.status, 201);
    const reply = await blogniceApp.request(withCookie({ body: "A reply.", parent_id: 1 }), undefined, env, executionCtx);
    assert.equal(reply.status, 201);
    assert.equal((await reply.json()).comment.parent_id, 1);
    assert.equal(state.comments.length, 2);
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});
