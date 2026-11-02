// Landing pages v1 API: auth, roles, eligibility, CRUD, homepage-pointer
// safety, limits, and doc-sync assertions.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

// purgeTenant touches the Cache API; stub it outside workerd.
globalThis.caches = { default: { delete: async () => true, match: async () => undefined, put: async () => {} } };

const OWNER_KEY = "bnk_test0wner000000000000000000000001";
const EDITOR_KEY = "bnk_tested1tor00000000000000000000002";
const hash = (k) => createHash("sha256").update(k).digest("hex");

async function loadSchema(db, path) {
  const schema = readFileSync(new URL(path, import.meta.url), "utf8");
  const statements = schema
    .replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "")
    .split(/;\s*(?=\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const st of statements) await db.prepare(st).run();
}

async function setup() {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: ["DB", "POSTS"],
    r2Buckets: ["MEDIA"],
  });
  try {
    const indexDb = await mf.getD1Database("DB");
    const postsDb = await mf.getD1Database("POSTS");
    const media = await mf.getR2Bucket("MEDIA");
    await loadSchema(indexDb, "../schema.sql");
    await loadSchema(postsDb, "../schema-posts.sql");
    const now = Math.floor(Date.now() / 1000);
    await indexDb.prepare(
      "INSERT INTO accounts (id, email, pw_hash, billing_status, api_key_hash, created_at) VALUES (1, 'owner@example.com', 'x', 'active', ?, ?), (2, 'ed@example.com', 'x', 'active', ?, ?)",
    ).bind(hash(OWNER_KEY), now, hash(EDITOR_KEY), now).run();
    await indexDb.prepare(
      "INSERT INTO tenants (id, public_id, slug, title, created_at) VALUES (1, 'testblog12', 'testblog', 'Test Blog', ?)",
    ).bind(now).run();
    await indexDb.prepare(
      "INSERT INTO memberships (account_id, tenant_id, role, created_at) VALUES (1, 1, 'owner', ?), (2, 1, 'editor', ?)",
    ).bind(now, now).run();
    await indexDb.prepare(
      "INSERT INTO platform_settings (key, value, updated_at) VALUES ('landing.rollout', 'all', ?)",
    ).bind(now).run();
    await media.put("1/hero.jpg", new Uint8Array([1, 2, 3]).buffer);
    const env = { DB: indexDb, POSTS: postsDb, MEDIA: media, ROOT_DOMAIN: "blognice.test" };
    const ctx = { waitUntil() {}, passThroughOnException() {} };
    const { blogniceApp } = await import("../src/index.ts");
    const api = (path, key, init = {}) => blogniceApp.request(
      new Request(`https://www.blognice.test${path}`, {
        ...init,
        headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json", ...(init.headers || {}) },
      }),
      undefined, env, ctx,
    );
    return { mf, indexDb, postsDb, env, api, now };
  } catch (e) {
    await mf.dispose().catch(() => {});
    throw e;
  }
}

const CONTENT = {
  hero: { headline: "Hello headline", subheadline: "Hello sub" },
  ctas: [{ label: "Go", href: "/hello" }],
  intro_md: "Intro words",
  features: [{ title: "Fast", body_md: "Very fast" }],
  contact: { email: "hello@example.com" },
  show_latest_posts: false,
};

test("auth: 401 without key; editor reads but cannot write; rollout off closes all", async () => {
  const s = await setup();
  try {
    const anon = await s.api("/api/v1/blogs/testblog12/landing", null);
    assert.equal(anon.status, 401);

    const edRead = await s.api("/api/v1/blogs/testblog12/landing", EDITOR_KEY);
    assert.equal(edRead.status, 200);
    assert.deepEqual((await edRead.json()).landing_pages, []);

    const edWrite = await s.api("/api/v1/blogs/testblog12/landing", EDITOR_KEY, {
      method: "POST", body: JSON.stringify({ title: "Nope", content: CONTENT }),
    });
    assert.equal(edWrite.status, 403);

    await s.indexDb.prepare("UPDATE platform_settings SET value = 'off' WHERE key = 'landing.rollout'").run();
    const off = await s.api("/api/v1/blogs/testblog12/landing", OWNER_KEY);
    assert.equal(off.status, 403);
    assert.match((await off.json()).error, /not available/);
    const offWrite = await s.api("/api/v1/blogs/testblog12/landing", OWNER_KEY, {
      method: "POST", body: JSON.stringify({ title: "Nope", content: CONTENT }),
    });
    assert.equal(offWrite.status, 403);
  } finally {
    await s.mf.dispose().catch(() => {});
  }
});

test("create + read: draft defaults, slug from title, parsed content shape", async () => {
  const s = await setup();
  try {
    const created = await s.api("/api/v1/blogs/testblog12/landing", OWNER_KEY, {
      method: "POST", body: JSON.stringify({ title: "Welcome Page", content: CONTENT }),
    });
    assert.equal(created.status, 201);
    const page = (await created.json()).landing_page;
    assert.equal(page.slug, "welcome-page");
    assert.equal(page.design, "hero");
    assert.equal(page.published, false);
    assert.equal(page.content.hero.headline, "Hello headline");
    assert.equal(page.content.ctas.length, 1);
    assert.equal(page.content.contact.email, "hello@example.com");
    assert.ok(page.id > 0);

    const list = await s.api("/api/v1/blogs/testblog12/landing", OWNER_KEY);
    assert.equal((await list.json()).landing_pages.length, 1);

    const one = await s.api(`/api/v1/blogs/testblog12/landing/${page.id}`, OWNER_KEY);
    assert.equal(one.status, 200);
    assert.equal((await one.json()).landing_page.title, "Welcome Page");

    const missing = await s.api("/api/v1/blogs/testblog12/landing/999", OWNER_KEY);
    assert.equal(missing.status, 404);
  } finally {
    await s.mf.dispose().catch(() => {});
  }
});

test("validation: title, design, media library, 10-page cap", async () => {
  const s = await setup();
  try {
    const noTitle = await s.api("/api/v1/blogs/testblog12/landing", OWNER_KEY, {
      method: "POST", body: JSON.stringify({ content: CONTENT }),
    });
    assert.equal(noTitle.status, 400);

    const badDesign = await s.api("/api/v1/blogs/testblog12/landing", OWNER_KEY, {
      method: "POST", body: JSON.stringify({ title: "Bad", design: "spaceship", content: CONTENT }),
    });
    assert.equal(badDesign.status, 400);
    assert.match((await badDesign.json()).error, /unknown design/);

    const badImage = await s.api("/api/v1/blogs/testblog12/landing", OWNER_KEY, {
      method: "POST", body: JSON.stringify({
        title: "Bad image", content: { ...CONTENT, hero: { headline: "H", image_key: "1/missing.jpg" } },
      }),
    });
    assert.equal(badImage.status, 400);

    const goodImage = await s.api("/api/v1/blogs/testblog12/landing", OWNER_KEY, {
      method: "POST", body: JSON.stringify({
        title: "Good image", design: "business", published: true,
        content: { ...CONTENT, hero: { headline: "H", image_key: "1/hero.jpg" } },
      }),
    });
    assert.equal(goodImage.status, 201);
    const saved = (await goodImage.json()).landing_page;
    assert.equal(saved.design, "business");
    assert.equal(saved.published, true);
    assert.ok(saved.published_at > 0);
    assert.equal(saved.content.hero.image_key, "1/hero.jpg");

    for (let i = 0; i < 9; i++) {
      const r = await s.api("/api/v1/blogs/testblog12/landing", OWNER_KEY, {
        method: "POST", body: JSON.stringify({ title: `Filler ${i}`, content: CONTENT }),
      });
      assert.equal(r.status, 201);
    }
    const over = await s.api("/api/v1/blogs/testblog12/landing", OWNER_KEY, {
      method: "POST", body: JSON.stringify({ title: "One too many", content: CONTENT }),
    });
    assert.equal(over.status, 409);
  } finally {
    await s.mf.dispose().catch(() => {});
  }
});

test("patch: partial update, slug re-uniquified, unknown design rejected", async () => {
  const s = await setup();
  try {
    const a = (await (await s.api("/api/v1/blogs/testblog12/landing", OWNER_KEY, {
      method: "POST", body: JSON.stringify({ title: "Alpha", slug: "alpha", content: CONTENT }),
    })).json()).landing_page;
    const b = (await (await s.api("/api/v1/blogs/testblog12/landing", OWNER_KEY, {
      method: "POST", body: JSON.stringify({ title: "Beta", slug: "beta", content: CONTENT }),
    })).json()).landing_page;

    const patched = await s.api(`/api/v1/blogs/testblog12/landing/${a.id}`, OWNER_KEY, {
      method: "PATCH", body: JSON.stringify({ title: "Alpha edited", design: "shop", published: true }),
    });
    assert.equal(patched.status, 200);
    const p = (await patched.json()).landing_page;
    assert.equal(p.title, "Alpha edited");
    assert.equal(p.design, "shop");
    assert.equal(p.slug, "alpha");
    assert.equal(p.published, true);

    const clash = await s.api(`/api/v1/blogs/testblog12/landing/${b.id}`, OWNER_KEY, {
      method: "PATCH", body: JSON.stringify({ slug: "alpha" }),
    });
    assert.equal(clash.status, 200);
    const c = (await clash.json()).landing_page;
    assert.notEqual(c.slug, "alpha");
    assert.match(c.slug, /^alpha-/);

    const bad = await s.api(`/api/v1/blogs/testblog12/landing/${a.id}`, OWNER_KEY, {
      method: "PATCH", body: JSON.stringify({ design: "nope" }),
    });
    assert.equal(bad.status, 400);

    const edPatch = await s.api(`/api/v1/blogs/testblog12/landing/${a.id}`, EDITOR_KEY, {
      method: "PATCH", body: JSON.stringify({ title: "Hijack" }),
    });
    assert.equal(edPatch.status, 403);
  } finally {
    await s.mf.dispose().catch(() => {});
  }
});

test("homepage safety: unpublish and delete clear the pointer first", async () => {
  const s = await setup();
  try {
    const page = (await (await s.api("/api/v1/blogs/testblog12/landing", OWNER_KEY, {
      method: "POST", body: JSON.stringify({ title: "Home", slug: "home", published: true, content: CONTENT }),
    })).json()).landing_page;
    await s.indexDb.prepare("UPDATE tenants SET home_landing_page_id = ? WHERE id = 1").bind(page.id).run();

    const unpub = await s.api(`/api/v1/blogs/testblog12/landing/${page.id}`, OWNER_KEY, {
      method: "PATCH", body: JSON.stringify({ published: false }),
    });
    assert.equal(unpub.status, 200);
    assert.equal((await unpub.json()).landing_page.published, false);
    const cleared = await s.indexDb.prepare("SELECT home_landing_page_id AS h FROM tenants WHERE id = 1").first();
    assert.equal(cleared.h, null);

    await s.indexDb.prepare("UPDATE tenants SET home_landing_page_id = ? WHERE id = 1").bind(page.id).run();
    const del = await s.api(`/api/v1/blogs/testblog12/landing/${page.id}`, OWNER_KEY, { method: "DELETE" });
    assert.equal(del.status, 204);
    const gone = await s.postsDb.prepare("SELECT 1 AS ok FROM landing_pages WHERE id = ?").bind(page.id).first();
    assert.equal(gone, null);
    const cleared2 = await s.indexDb.prepare("SELECT home_landing_page_id AS h FROM tenants WHERE id = 1").first();
    assert.equal(cleared2.h, null);

    const edDel = await s.api(`/api/v1/blogs/testblog12/landing/${page.id}`, EDITOR_KEY, { method: "DELETE" });
    assert.equal([403, 404].includes(edDel.status), true);
  } finally {
    await s.mf.dispose().catch(() => {});
  }
});

test("docs: landing API documented in code, specs, and README", () => {
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const apiMd = readFileSync(new URL("../docs/API.md", import.meta.url), "utf8");
  const spec = readFileSync(new URL("../src/openapi-data.ts", import.meta.url), "utf8");
  const specFile = readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8");
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(index, /\/api\/v1\/blogs\/:blogId\/landing/);
  assert.match(index, /landingToJson/);
  assert.match(apiMd, /\/api\/v1\/blogs\/:blogId\/landing/);
  assert.match(spec, /\/api\/v1\/blogs\/{blogId}\/landing/);
  assert.match(spec, /LandingPage/);
  assert.match(specFile, /\/api\/v1\/blogs\/{blogId}\/landing/);
  assert.match(specFile, /LandingPage/);
  assert.match(readme, /landing pages, media/);
});
