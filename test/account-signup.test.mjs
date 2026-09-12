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
  return { DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test" };
}

function signupForm(email, password = "correct horse battery staple") {
  const body = new FormData();
  body.set("email", email);
  body.set("password", password);
  return body;
}

function postSignup(email, extra = {}) {
  const body = signupForm(email);
  for (const [k, v] of Object.entries(extra)) body.set(k, v);
  return new Request("https://www.blognice.test/signup", {
    method: "POST",
    body,
    headers: { "CF-Connecting-IP": "203.0.113.50" },
  });
}

test("signup page asks for account only, no blog fields", async () => {
  const { mf, db } = await setupDb("account-signup-page");
  try {
    const { blogniceApp } = await import("../src/index.ts");
    const res = await blogniceApp.request(
      new Request("https://www.blognice.test/signup"),
      undefined,
      baseEnv(db),
      ctx,
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Create your account/);
    assert.match(html, /Continue with Google/);
    assert.doesNotMatch(html, /name="slug"/);
    assert.doesNotMatch(html, /name="title"/);
    assert.doesNotMatch(html, /Blog address/);
  } finally {
    await mf.dispose();
  }
});

test("password signup creates an account with no blog and starts a session", async () => {
  const { mf, db } = await setupDb("account-signup-post");
  try {
    const { blogniceApp } = await import("../src/index.ts");
    const res = await blogniceApp.request(postSignup("fresh@example.com"), undefined, baseEnv(db), ctx);
    assert.equal(res.status, 302);
    assert.equal(new URL(res.headers.get("location"), "https://www.blognice.test").pathname, "/admin");
    assert.match(res.headers.get("set-cookie") || "", /bn_session=/);
    const account = await db.prepare("SELECT id FROM accounts WHERE email = 'fresh@example.com'").first();
    assert.ok(account);
    assert.equal(await db.prepare("SELECT count(*) AS n FROM tenants").first().then((r) => r.n), 0);
    assert.equal(await db.prepare("SELECT count(*) AS n FROM memberships").first().then((r) => r.n), 0);
    const session = await db.prepare("SELECT account_id FROM sessions").first();
    assert.equal(session.account_id, account.id);
  } finally {
    await mf.dispose();
  }
});

test("signup ignores legacy blog fields instead of creating a blog", async () => {
  const { mf, db } = await setupDb("account-signup-legacy");
  try {
    const { blogniceApp } = await import("../src/index.ts");
    const res = await blogniceApp.request(
      postSignup("legacy@example.com", { slug: "legacy-blog", title: "Legacy Blog" }),
      undefined,
      baseEnv(db),
      ctx,
    );
    assert.equal(res.status, 302);
    assert.equal(await db.prepare("SELECT count(*) AS n FROM tenants").first().then((r) => r.n), 0);
    assert.ok(await db.prepare("SELECT id FROM accounts WHERE email = 'legacy@example.com'").first());
  } finally {
    await mf.dispose();
  }
});

test("signup rejects a duplicate email without creating anything", async () => {
  const { mf, db } = await setupDb("account-signup-dupe");
  try {
    const now = Math.floor(Date.now() / 1000);
    await db.prepare(
      "INSERT INTO accounts (email, pw_hash, created_at) VALUES ('taken@example.com', 'test', ?)",
    ).bind(now).run();
    const { blogniceApp } = await import("../src/index.ts");
    const res = await blogniceApp.request(postSignup("taken@example.com"), undefined, baseEnv(db), ctx);
    assert.equal(res.status, 409);
    assert.equal(await db.prepare("SELECT count(*) AS n FROM sessions").first().then((r) => r.n), 0);
  } finally {
    await mf.dispose();
  }
});
