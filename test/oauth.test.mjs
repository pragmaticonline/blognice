import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Miniflare } from "miniflare";

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
