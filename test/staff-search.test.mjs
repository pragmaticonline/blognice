import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createSign, generateKeyPairSync } from "node:crypto";
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

// Mock D1 that enforces real D1 binding-count semantics: binding fewer or
// more args than there are `?` placeholders throws, exactly as D1 does.
// Records every prepared statement on `seen` for WHERE-clause assertions.
function strictDb(seen) {
  return {
    prepare(sql) {
      seen.push(sql);
      return {
        bind(...args) {
          const placeholders = (sql.match(/\?/g) || []).length;
          if (placeholders !== args.length) {
            throw new Error(`D1_ERROR: wrong number of bindings: expected ${placeholders} got ${args.length}`);
          }
          return {
            first: async () => {
              if (sql.includes("FROM staff_users")) {
                return { subject: "staff-admin-1", email: "admin@example.com", role: "admin", active: 1 };
              }
              return null;
            },
            all: async () => {
              if (sql.includes("FROM accounts a")) {
                return {
                  results: [
                    { id: 70, email: "brent@codeandsea.com", status: "active", created_at: NOW - 100, blog_count: 1, billing_status: "active", billing_price_id: null, crypto_paid_through: null, vip_granted_at: null, vip_expires_at: null },
                    { id: 71, email: "vip@example.com", status: "active", created_at: NOW - 200, blog_count: 2, billing_status: "inactive", billing_price_id: null, crypto_paid_through: null, vip_granted_at: NOW - 300, vip_expires_at: null },
                    { id: 72, email: "free@example.com", status: "active", created_at: NOW - 300, blog_count: 0, billing_status: "inactive", billing_price_id: null, crypto_paid_through: null, vip_granted_at: null, vip_expires_at: null },
                  ],
                };
              }
              return { results: [] };
            },
            run: async () => ({ success: true }),
          };
        },
      };
    },
  };
}

test("staff account search renders for ?q= (page and API)", async () => {
  const staffApp = (await import("../src/staff.ts")).default;
  const seen = [];
  const db = strictDb(seen);
  const env = { DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test", ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
  const executionCtx = { waitUntil() {}, passThroughOnException() {} };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/cdn-cgi/access/certs")) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  };
  const headers = { host: "staff.test", Origin: "https://staff.test", "Cf-Access-Jwt-Assertion": staffJwt("staff-admin-1") };
  const req = (path) => new Request(`https://staff.test${path}`, { headers });
  try {
    const page = await staffApp.request(req("/?q=brentvardy"), undefined, env, executionCtx);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /brent@codeandsea\.com/);

    const empty = await staffApp.request(req("/"), undefined, env, executionCtx);
    assert.equal(empty.status, 200);

    const api = await staffApp.request(req("/api/accounts?q=brentvardy"), undefined, env, executionCtx);
    assert.equal(api.status, 200);
    const json = await api.json();
    assert.equal(json.accounts.length, 3);
    assert.equal(json.plan, "all");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("staff accounts filter by plan (paying, vip, free)", async () => {
  const staffApp = (await import("../src/staff.ts")).default;
  const seen = [];
  const db = strictDb(seen);
  const env = { DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test", ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
  const executionCtx = { waitUntil() {}, passThroughOnException() {} };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/cdn-cgi/access/certs")) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  };
  const headers = { host: "staff.test", Origin: "https://staff.test", "Cf-Access-Jwt-Assertion": staffJwt("staff-admin-1") };
  const req = (path) => new Request(`https://staff.test${path}`, { headers });
  const lastSql = () => seen.filter((s) => s.includes("FROM accounts a")).at(-1);
  // Outer FROM clause only: the SELECT's COUNT subquery has its own WHERE.
  const lastFromClause = () => {
    const sql = lastSql();
    return sql.slice(sql.indexOf("FROM accounts a"), sql.indexOf("ORDER BY"));
  };
  const lastWhere = () => {
    const clause = lastFromClause();
    return clause.includes("WHERE") ? clause.slice(clause.indexOf("WHERE")) : "";
  };
  try {
    for (const [plan, needle] of [["paying", "billing_status"], ["vip", "vip_granted_at"], ["free", "NOT ("]]) {
      seen.length = 0;
      const res = await staffApp.request(req(`/?plan=${plan}`), undefined, env, executionCtx);
      assert.equal(res.status, 200);
      assert.match(lastWhere(), new RegExp(needle.replace(/[()]/g, "\\$&")));
    }

    // Paying + search combine: the search OR-chain is parenthesized under AND.
    seen.length = 0;
    const combined = await staffApp.request(req("/?q=brentvardy&plan=vip"), undefined, env, executionCtx);
    assert.equal(combined.status, 200);
    assert.match(lastWhere(), /\) AND \(/);

    // Unknown plan falls back to all: no WHERE at all without q.
    seen.length = 0;
    const bogus = await staffApp.request(req("/?plan=bogus"), undefined, env, executionCtx);
    assert.equal(bogus.status, 200);
    assert.equal(lastFromClause().includes("WHERE"), false);

    // Plan badges render per account kind and the filter preserves q.
    const html = await combined.text();
    assert.match(html, />Pro</);
    assert.match(html, />VIP</);
    assert.match(html, />Free</);
    assert.match(html, /\?q=brentvardy&plan=paying/);
    assert.match(html, /<strong>VIP<\/strong>/);

    // API honors the same filter and echoes it.
    seen.length = 0;
    const api = await staffApp.request(req("/api/accounts?plan=free"), undefined, env, executionCtx);
    assert.equal(api.status, 200);
    assert.equal((await api.json()).plan, "free");
    assert.match(lastWhere(), /NOT \(/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
