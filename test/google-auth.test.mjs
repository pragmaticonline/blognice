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
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  for (const statement of schema.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((v) => v.trim()).filter(Boolean)) {
    await db.prepare(statement).run();
  }
  return { mf, db };
}

const ctx = { waitUntil() {}, passThroughOnException() {} };

function baseEnv(db) {
  return {
    DB: db,
    POSTS: db,
    ROOT_DOMAIN: "blognice.test",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
  };
}

test("GET /auth/google redirects to Google with client_id and state", async () => {
  const { mf, db } = await setupDb("google-auth-start");
  try {
    const { blogniceApp } = await import("../src/index.ts");
    const res = await blogniceApp.request(
      new Request("https://www.blognice.test/auth/google"),
      undefined,
      baseEnv(db),
      ctx,
    );
    assert.equal(res.status, 302);
    const location = res.headers.get("location");
    assert.match(location, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    assert.match(location, /client_id=test-client-id/);
    assert.match(location, /redirect_uri=/);
    assert.match(location, /state=/);
    const setCookie = res.headers.get("set-cookie") || "";
    assert.match(setCookie, /bn_google_state=/);
  } finally {
    await mf.dispose();
  }
});

async function startGoogleLogin(blogniceApp, db, env) {
  const res = await blogniceApp.request(
    new Request("https://www.blognice.test/auth/google"),
    undefined,
    env,
    ctx,
  );
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get("location"));
  const cookieHeader = res.headers.get("set-cookie") || "";
  const stateCookie = cookieHeader.split(";")[0];
  assert.match(stateCookie, /^bn_google_state=/);
  const cookieState = decodeURIComponent(stateCookie.slice("bn_google_state=".length));
  assert.equal(location.searchParams.get("state"), cookieState);
  return { state: location.searchParams.get("state"), cookie: stateCookie };
}

function mockGoogleFetch(profile = { sub: "google-123", email: "guser@example.com", email_verified: true }) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push(String(url));
    if (String(url).includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "google-access-token", expires_in: 3600, token_type: "Bearer" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (String(url).includes("userinfo")) {
      return new Response(JSON.stringify(profile), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return calls;
}

test("callback links an existing password account by verified email and starts a session", async () => {
  const { mf, db } = await setupDb("google-auth-link");
  const originalFetch = globalThis.fetch;
  try {
    const now = Math.floor(Date.now() / 1000);
    await db.prepare(
      "INSERT INTO accounts (id, email, pw_hash, email_verified, created_at) VALUES (11, 'guser@example.com', 'scrypt$1$2$3$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', 0, ?)",
    ).bind(now).run();
    const { blogniceApp } = await import("../src/index.ts");
    const env = baseEnv(db);
    const { state, cookie } = await startGoogleLogin(blogniceApp, db, env);
    mockGoogleFetch();
    const res = await blogniceApp.request(
      new Request(`https://www.blognice.test/auth/google/callback?code=authcode123&state=${encodeURIComponent(state)}`, {
        headers: { cookie },
      }),
      undefined,
      env,
      ctx,
    );
    assert.equal(res.status, 302);
    assert.equal(new URL(res.headers.get("location"), "https://www.blognice.test").pathname, "/admin");
    assert.match(res.headers.get("set-cookie") || "", /bn_session=/);
    const session = await db.prepare("SELECT account_id FROM sessions").first();
    assert.equal(session.account_id, 11);
    const account = await db.prepare("SELECT email_verified FROM accounts WHERE id = 11").first();
    assert.equal(account.email_verified, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});

test("callback creates an account for a new Google email and starts a session", async () => {
  const { mf, db } = await setupDb("google-auth-create");
  const originalFetch = globalThis.fetch;
  try {
    const { blogniceApp } = await import("../src/index.ts");
    const env = baseEnv(db);
    const { state, cookie } = await startGoogleLogin(blogniceApp, db, env);
    mockGoogleFetch({ sub: "google-999", email: "newguser@example.com", email_verified: true });
    const res = await blogniceApp.request(
      new Request(`https://www.blognice.test/auth/google/callback?code=authcode456&state=${encodeURIComponent(state)}`, {
        headers: { cookie },
      }),
      undefined,
      env,
      ctx,
    );
    assert.equal(res.status, 302);
    assert.match(res.headers.get("set-cookie") || "", /bn_session=/);
    const account = await db.prepare("SELECT id, email, email_verified FROM accounts WHERE email = 'newguser@example.com'").first();
    assert.equal(account.email, "newguser@example.com");
    assert.equal(account.email_verified, 1);
    const session = await db.prepare("SELECT account_id FROM sessions").first();
    assert.equal(session.account_id, account.id);
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});

test("callback rejects a mismatched state without creating a session", async () => {
  const { mf, db } = await setupDb("google-auth-bad-state");
  const originalFetch = globalThis.fetch;
  try {
    const { blogniceApp } = await import("../src/index.ts");
    const env = baseEnv(db);
    const { cookie } = await startGoogleLogin(blogniceApp, db, env);
    mockGoogleFetch();
    const res = await blogniceApp.request(
      new Request("https://www.blognice.test/auth/google/callback?code=authcode789&state=forged-state", {
        headers: { cookie },
      }),
      undefined,
      env,
      ctx,
    );
    assert.equal(res.status, 401);
    assert.equal(await db.prepare("SELECT count(*) AS n FROM sessions").first().then((r) => r.n), 0);
    assert.equal(await db.prepare("SELECT count(*) AS n FROM accounts").first().then((r) => r.n), 0);
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});

test("login and signup pages offer Continue with Google", async () => {
  const { mf, db } = await setupDb("google-auth-buttons");
  try {
    const { blogniceApp } = await import("../src/index.ts");
    const env = baseEnv(db);
    for (const path of ["/admin/login", "/signup"]) {
      const res = await blogniceApp.request(
        new Request(`https://www.blognice.test${path}`),
        undefined,
        env,
        ctx,
      );
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /href="\/auth\/google"/);
      assert.match(html, /Continue with Google/);
      assert.match(html, /viewBox="0 0 48 48"/);
    }
  } finally {
    await mf.dispose();
  }
});

test("GET /auth/google without a client ID returns 503", async () => {
  const { mf, db } = await setupDb("google-auth-unconfigured");
  try {
    const { blogniceApp } = await import("../src/index.ts");
    const env = baseEnv(db);
    delete env.GOOGLE_CLIENT_ID;
    const res = await blogniceApp.request(
      new Request("https://www.blognice.test/auth/google"),
      undefined,
      env,
      ctx,
    );
    assert.equal(res.status, 503);
  } finally {
    await mf.dispose();
  }
});
