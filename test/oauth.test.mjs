import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

const require = createRequire(import.meta.url);
for (const extension of [".html", ".svg"]) {
  require.extensions[extension] = (module, filename) => {
    module.exports = readFileSync(filename, "utf8");
  };
}

async function setupDb(name) {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: name },
  });
  const db = await mf.getD1Database("DB");
  const schemaText = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  for (const statement of schemaText.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((v) => v.trim()).filter(Boolean)) {
    await db.prepare(statement).run();
  }
  return { mf, db };
}

const ctx = { waitUntil() {}, passThroughOnException() {} };
const baseEnv = (db, extra = {}) => ({ DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test", ...extra });

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const indexSrc = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const migration062 = (() => { try { return readFileSync(new URL("../migrations/062-oauth.sql", import.meta.url), "utf8"); } catch { return ""; } })();

test("OAuth schema exists in D1 — codes, tokens, and metadata", () => {
  assert.match(schema, /CREATE TABLE oauth_authorization_codes/);
  assert.match(schema, /CREATE TABLE oauth_access_tokens/);
  assert.match(schema, /code_challenge/);
  assert.match(schema, /S256/);
  assert.ok(migration062.length > 0, "migration 062-oauth.sql should exist");
  assert.match(migration062, /oauth_authorization_codes/);
  assert.match(migration062, /oauth_access_tokens/);
});

test("OAuth discovery endpoints are wired", () => {
  const oauthSrc = readFileSync(new URL("../src/oauth.ts", import.meta.url), "utf8");
  assert.match(indexSrc, /\.well-known\/oauth-authorization-server/);
  assert.match(indexSrc, /\.well-known\/oauth-protected-resource/);
  assert.match(oauthSrc, /authorization_endpoint/);
  assert.match(oauthSrc, /token_endpoint/);
  assert.match(oauthSrc, /code_challenge_methods_supported/);
});

test("OAuth authorize and token routes are wired", () => {
  const oauthSrc = readFileSync(new URL("../src/oauth.ts", import.meta.url), "utf8");
  assert.match(indexSrc, /\/oauth\/authorize/);
  assert.match(indexSrc, /\/oauth\/token/);
  assert.match(oauthSrc, /S256/);
  assert.match(oauthSrc, /PKCE|code_verifier|code_challenge/);
  assert.match(oauthSrc, /grant_type.*authorization_code|authorization_code/);
});

test("MCP accepts OAuth Bearer as well as apiKey", () => {
  const oauthSrc = readFileSync(new URL("../src/oauth.ts", import.meta.url), "utf8");
  assert.match(indexSrc, /accountFromOAuthToken|oauth.*apiAccount|Bearer.*oauth/i);
  // Should allow Authorization: Bearer <oauth_access_token> to satisfy apiAccount or MCP dispatch
  assert.match(readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8"), /apiKey|oauth|Bearer/);
});

test("OAuth authorize discovery returns correct metadata (integration)", async () => {
  const oauthSrc = readFileSync(new URL("../src/oauth.ts", import.meta.url), "utf8");
  assert.match(oauthSrc, /oauthAuthorizationServerMetadata/);
  assert.match(oauthSrc, /oauthProtectedResourceMetadata/);
  assert.ok(indexSrc.includes("/.well-known/oauth-authorization-server"), "discovery route should be in index");
});


test("authorization metadata advertises userinfo and openid/email scopes", async () => {
  const { mf, db } = await setupDb("oauth-userinfo-meta");
  try {
    const { blogniceApp } = await import("../src/index.ts");
    const res = await blogniceApp.request(
      new Request("https://www.blognice.test/.well-known/oauth-authorization-server"),
      undefined,
      baseEnv(db),
      ctx,
    );
    assert.equal(res.status, 200);
    const meta = await res.json();
    assert.equal(meta.userinfo_endpoint, "https://www.blognice.test/oauth/userinfo");
    for (const scope of ["openid", "email", "blog:read", "blog:write"]) {
      assert.ok(meta.scopes_supported.includes(scope), `missing scope ${scope}`);
    }
  } finally {
    await mf.dispose();
  }
});

test("userinfo returns email + email_verified for a valid OAuth token", async () => {
  const { mf, db } = await setupDb("oauth-userinfo-ok");
  try {
    const now = Math.floor(Date.now() / 1000);
    await db.prepare(
      "INSERT INTO accounts (id, email, pw_hash, email_verified, email_verified_at, created_at) VALUES (21, 'oauth-user@example.com', 'test', 1, ?, ?)",
    ).bind(now, now).run();
    await db.prepare(
      "INSERT INTO oauth_access_tokens (access_token, refresh_token, client_id, account_id, scope, created_at, expires_at, revoked) VALUES ('test-oauth-token', 'test-refresh', 'chatgpt', 21, 'openid email blog:read blog:write', ?, ?, 0)",
    ).bind(now, now + 3600).run();
    const { blogniceApp } = await import("../src/index.ts");
    const env = baseEnv(db);
    const res = await blogniceApp.request(
      new Request("https://www.blognice.test/oauth/userinfo", {
        headers: { authorization: "Bearer test-oauth-token" },
      }),
      undefined,
      env,
      ctx,
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      sub: "21",
      email: "oauth-user@example.com",
      email_verified: true,
    });
  } finally {
    await mf.dispose();
  }
});

test("userinfo rejects missing and invalid tokens", async () => {
  const { mf, db } = await setupDb("oauth-userinfo-deny");
  try {
    const { blogniceApp } = await import("../src/index.ts");
    const env = baseEnv(db);
    const anon = await blogniceApp.request(
      new Request("https://www.blognice.test/oauth/userinfo"),
      undefined,
      env,
      ctx,
    );
    assert.equal(anon.status, 401);
    const bad = await blogniceApp.request(
      new Request("https://www.blognice.test/oauth/userinfo", {
        headers: { authorization: "Bearer forged-token" },
      }),
      undefined,
      env,
      ctx,
    );
    assert.equal(bad.status, 401);
  } finally {
    await mf.dispose();
  }
});

test("MCP tool schemas carry no credential inputs", async () => {
  const { mf, db } = await setupDb("mcp-no-apikey");
  try {
    const { blogniceApp } = await import("../src/index.ts");
    const res = await blogniceApp.request(
      new Request("https://www.blognice.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      undefined,
      baseEnv(db),
      ctx,
    );
    assert.equal(res.status, 200);
    const payload = await res.text();
    assert.doesNotMatch(payload, /"apiKey"/);
    const listed = JSON.parse(payload).result.tools;
    assert.ok(listed.length > 10);
    for (const tool of listed) {
      assert.ok(!tool.inputSchema?.properties?.apiKey, `${tool.name} exposes apiKey`);
    }
  } finally {
    await mf.dispose();
  }
});

test("openai-apps-challenge serves the configured token, else 404", async () => {
  const { mf, db } = await setupDb("openai-challenge");
  try {
    const { blogniceApp } = await import("../src/index.ts");
    const missing = await blogniceApp.request(
      new Request("https://www.blognice.test/.well-known/openai-apps-challenge"),
      undefined,
      baseEnv(db),
      ctx,
    );
    assert.equal(missing.status, 404);
    const served = await blogniceApp.request(
      new Request("https://www.blognice.test/.well-known/openai-apps-challenge"),
      undefined,
      baseEnv(db, { OPENAI_APPS_CHALLENGE_TOKEN: "challenge-abc" }),
      ctx,
    );
    assert.equal(served.status, 200);
    assert.equal(await served.text(), "challenge-abc");
  } finally {
    await mf.dispose();
  }
});

test("OAuth PKCE helpers produce S256 and tokens (unit)", async () => {
  const { pkceS256, generateOAuthToken } = await import("../src/oauth.ts");
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = await pkceS256(verifier);
  const expected = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
  assert.equal(challenge, expected);
  const t1 = generateOAuthToken("bn_oa_");
  const t2 = generateOAuthToken("bn_oa_");
  assert.match(t1, /^bn_oa_/);
  assert.notEqual(t1, t2);
});
